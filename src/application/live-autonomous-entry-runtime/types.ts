import type {
  AccountRiskSnapshot,
  CostDecision,
  CostModelInput,
  InfrastructureRiskSnapshot,
  JsonRecord,
  LiveAutonomousBudgetSnapshot,
  LiveAutonomousOrderAttemptEvent,
  LiveAutonomousOrderAttemptStatus,
  MarketCode,
  NumericString,
  OrderIntent,
  OrderSubmission,
  PositionRiskSnapshot,
  RiskGateResult,
  RiskGateContext,
  RiskThresholdSnapshot,
  StrategyRiskSnapshot,
  TimestampInput,
} from "../../domain/index.js";
import type { AlertDispatchServiceOptions } from "../alerts/index.js";
import type { ExecutionEngine, ExecutionSubmitOrderResult } from "../execution/index.js";

/**
 * M22 autonomous entry runtime이 사용하는 config subset이다.
 *
 * `RuntimeConfig.live_autonomous`와 구조적으로 호환되지만 application layer가 runtime config module에 역참조하지 않도록 필요한
 * 필드만 둔다. caller는 startup guard를 통과한 config를 넘겨야 하며, 이 타입 자체는 side effect를 갖지 않는다.
 */
export interface LiveAutonomousEntryRuntimeConfig {
  enabled: boolean;
  allowed_markets: readonly string[];
  max_order_krw: NumericString;
  daily_autonomous_notional_limit_krw: NumericString;
  max_open_position_notional_krw: NumericString;
  max_daily_loss_krw: NumericString;
  max_weekly_loss_krw: NumericString;
  max_price_deviation_bps: NumericString;
  identifier_prefix: string;
  identifier_max_length: number;
}

/**
 * M22 autonomous entry 후보가 요청할 수 있는 order type 표현이다.
 *
 * Upbit `ord_type=price|market|best`는 M22 자동 entry에서 금지되며, runtime은 `LIMIT` 외 값을 broker 제출 전에 차단한다.
 */
export type LiveAutonomousEntryRequestedOrderType = "LIMIT" | "MARKET" | "PRICE" | "BEST";

/**
 * M22 autonomous entry 후보의 비용 입력이다.
 *
 * runtime이 exchange, market, evaluatedAt, attempt metadata를 덮어써 현재 주문 후보와 비용 snapshot을 같은 fingerprint로 묶는다.
 */
export type LiveAutonomousEntryCostInput = Omit<CostModelInput, "exchangeId" | "market" | "evaluatedAt">;

/**
 * M22 autonomous entry 후보의 RiskGate 입력이다.
 *
 * `orderIntent`, `observedAt`, `expectedLossBpsOfEquity`는 runtime이 생성한 identifier와 후보 값으로 채운다. caller는 최신
 * account/position/strategy/infrastructure snapshot만 제공해야 하며, 이 타입은 조회 side effect를 수행하지 않는다.
 */
export interface LiveAutonomousEntryRiskInput {
  account: AccountRiskSnapshot;
  positions: readonly PositionRiskSnapshot[];
  strategy: StrategyRiskSnapshot;
  infrastructureSignals: readonly InfrastructureRiskSnapshot[];
  thresholdSnapshot: RiskThresholdSnapshot;
  metadata?: JsonRecord;
}

/**
 * M22 autonomous entry가 broker 제출 전에 확인해야 하는 KRW 손실 snapshot이다.
 *
 * RiskGate의 bps 손실 한도와 별도로 M22 config의 소액 KRW 손실 한도를 적용하기 위한 입력이다. caller는 최신 PnL status provider
 * 결과를 이 구조로 낮춰 전달해야 하며, 이 타입 자체는 조회 side effect를 수행하지 않는다.
 */
export interface LiveAutonomousEntryLossSnapshot {
  dailyRealizedLossKrw: NumericString;
  weeklyRealizedLossKrw: NumericString;
  capturedAt: TimestampInput;
  metadata?: JsonRecord;
}

/**
 * M22 autonomous entry runtime에 들어오는 단일 후보다.
 *
 * 후보는 BUY entry만 표현하며 runtime이 random identifier, LIMIT+POST_ONLY 정책, 비용/RiskGate evidence, budget reservation을
 * 조립한다. `referencePrice`는 가격 이탈 재검증 기준이며 없거나 손상되면 broker 제출 전에 차단해야 한다.
 */
export interface LiveAutonomousEntryCandidate {
  exchangeId: string;
  market: MarketCode;
  strategyId: string;
  requestedQuantity: NumericString;
  requestedNotional: NumericString;
  requestedPrice: NumericString;
  referencePrice: NumericString;
  reason: string;
  expectedLossBpsOfEquity: NumericString;
  costInput: LiveAutonomousEntryCostInput;
  risk: LiveAutonomousEntryRiskInput;
  orderType?: LiveAutonomousEntryRequestedOrderType;
  postOnly?: boolean;
  metadata?: JsonRecord;
}

/**
 * M22 autonomous budget reservation 요청이다.
 *
 * runtime precheck를 통과한 후보만 durable reservation store로 넘어간다. store는 DB transaction이나 외부 durable lock을 구현할 수
 * 있지만, application service는 이 port 너머의 저장 방식을 알지 않는다.
 */
export interface LiveAutonomousBudgetReservationRequest {
  attemptId: string;
  idempotencyKey: string;
  market: MarketCode;
  strategyId: string;
  requestedNotionalKrw: NumericString;
  budgetSnapshot: LiveAutonomousBudgetSnapshot;
  observedAt: TimestampInput;
  metadata?: JsonRecord;
}

/**
 * M22 autonomous budget reservation 성공 결과다.
 *
 * `reservationId`는 broker 제출 이후 audit/reconcile에서 예산 선점과 주문을 연결하는 durable key다.
 */
export interface LiveAutonomousBudgetReservation {
  reservationId: string;
  attemptId: string;
  idempotencyKey: string;
  reservedNotionalKrw: NumericString;
  budgetSnapshot: LiveAutonomousBudgetSnapshot;
  reservedAt: TimestampInput;
  expiresAt?: TimestampInput;
  metadata?: JsonRecord;
}

/**
 * M22 autonomous budget reservation 결과다.
 *
 * `reserved=false`는 다른 runtime instance나 최신 예산 상태가 후보를 거부했다는 뜻이며, runtime은 broker side effect 없이
 * attempt를 `BLOCKED`로 끝내야 한다.
 */
export type LiveAutonomousBudgetReservationResult =
  | {
      reserved: true;
      reservation: LiveAutonomousBudgetReservation;
    }
  | {
      reserved: false;
      reasonCode: string;
      message: string;
      metadata?: JsonRecord;
    };

/**
 * M22 autonomous budget reservation port다.
 *
 * `reserve`는 durable write/lock side effect가 있을 수 있는 유일한 예산 경계다. ExecutionEngine이 broker 제출 전 거부한 경우
 * optional `release`로 선점을 해제할 수 있지만, broker 예외처럼 side effect 여부가 불명확한 경우 runtime은 보수적으로 release하지 않는다.
 */
export interface LiveAutonomousBudgetReservationPort {
  reserve(request: LiveAutonomousBudgetReservationRequest): Promise<LiveAutonomousBudgetReservationResult>;
  release?(reservation: LiveAutonomousBudgetReservation, reasonCode: string): Promise<void>;
}

/**
 * M22 autonomous entry runtime이 사용하는 CostModel port다.
 *
 * 기본 구현은 domain `CostModel`이지만 테스트와 후속 live adapter는 같은 입력/출력 계약으로 교체할 수 있다.
 */
export interface LiveAutonomousEntryCostModelPort {
  evaluate(input: CostModelInput): CostDecision;
}

/**
 * M22 autonomous entry runtime이 사용하는 RiskGate evaluator다.
 *
 * evaluator는 순수 함수여야 하며 DB write, broker 호출, notification 같은 side effect는 이 경계에 넣지 않는다.
 */
export type LiveAutonomousEntryRiskGateEvaluator = (context: RiskGateContext) => RiskGateResult;

/**
 * M22/M23 live autonomous entry runtime에서 발생한 trade event를 live ops alert로 전송하기 위한 옵션이다.
 *
 * `environment`와 `runMode`는 alert fingerprint와 Telegram 추적 정보의 상위 운영 차원이며, `alertDispatch`는 provider,
 * cooldown, retry, audit side effect를 소유하는 application service 의존성이다. 이 옵션은 주문 판단 입력이나 broker 제출
 * 결과를 바꾸지 않아야 하며, caller는 같은 runtime process 안에서 같은 객체를 재사용해 notification failure state가 누적되게
 * 해야 한다.
 */
export interface LiveAutonomousEntryAlertDispatchOptions {
  environment: string;
  runMode: string;
  alertDispatch: AlertDispatchServiceOptions;
}

/**
 * M22 autonomous entry runtime port 묶음이다.
 *
 * 실제 broker, durable budget store, CostModel/RiskGate implementation은 모두 주입받는다. 기본 구현을 쓰더라도 runtime service는
 * Upbit private client를 직접 생성하지 않는다.
 */
export interface LiveAutonomousEntryRuntimePorts {
  executionEngine: Pick<ExecutionEngine, "submitOrder">;
  budgetReservation: LiveAutonomousBudgetReservationPort;
  liveOpsAlerts?: LiveAutonomousEntryAlertDispatchOptions;
  costModel?: LiveAutonomousEntryCostModelPort;
  evaluateRiskGate?: LiveAutonomousEntryRiskGateEvaluator;
  randomHex?: (bytes: number) => string;
  clock?: () => TimestampInput;
}

/**
 * M22 autonomous entry runtime 실행 요청이다.
 *
 * `killSwitchActive=false`, `reconcileFresh=true`, 최신 budget snapshot이 모두 충족돼야 budget reservation과 broker 제출로 전진한다.
 */
export interface LiveAutonomousEntryRuntimeRequest {
  config: LiveAutonomousEntryRuntimeConfig;
  candidate: LiveAutonomousEntryCandidate;
  budgetSnapshot: LiveAutonomousBudgetSnapshot;
  lossSnapshot: LiveAutonomousEntryLossSnapshot;
  killSwitchActive: boolean;
  reconcileFresh: boolean;
  /**
   * 기존 attempt 재시도에 사용할 Upbit identifier/ExecutionEngine idempotency key다.
   *
   * 값이 없으면 runtime이 새 random identifier를 만들지만, broker 제출 결과가 불확실한 retry는 반드시 기존 값을 주입해야 한다.
   */
  idempotencyKey?: string;
  observedAt?: TimestampInput;
}

/**
 * M22 autonomous entry runtime 실행 결과다.
 *
 * `status`는 attempt state machine의 최종 상태이며, `events`는 runtime 내부 전이 순서를 보존한다. 사용자-facing message/action은
 * 한국어로 제공하고 내부 원인은 `violations`와 `trace`에 분리한다.
 */
export interface LiveAutonomousEntryAttemptResult {
  attemptId: string;
  idempotencyKey: string;
  status: LiveAutonomousOrderAttemptStatus;
  message: string;
  action: string;
  violations: readonly string[];
  events: readonly LiveAutonomousOrderAttemptEvent[];
  trace: JsonRecord;
  intent?: OrderIntent;
  costDecision?: CostDecision;
  riskGateResult?: RiskGateResult;
  budgetReservation?: LiveAutonomousBudgetReservation;
  submission?: OrderSubmission;
  executionResult?: ExecutionSubmitOrderResult;
}
