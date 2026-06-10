import type {
  ExchangeId,
  JsonRecord,
  MarketCode,
  NumericString,
  OrderSide,
  TimestampInput,
} from "../index.js";

export const LIVE_ARMED_MANUAL_APPROVAL_MODE = "LIVE_ARMED_MANUAL_APPROVAL";

/**
 * M21 수동 승인 live pilot에서 proposal이 가질 수 있는 canonical 상태 목록이다.
 *
 * proposal은 `PROPOSED`에서 시작해 운영자 승인/거부/만료로 닫히고, 승인된 proposal만 broker 제출 단계로 넘어간다.
 * 이 값은 Telegram approval runtime, audit evidence, persistence가 공유하는 안정 contract이며 자체 side effect는 없다.
 */
export const liveOrderProposalStatuses = [
  "PROPOSED",
  "APPROVED",
  "REJECTED",
  "EXPIRED",
  "SUBMITTED",
  "SUBMISSION_FAILED",
] as const;

/**
 * M21 proposal의 canonical 상태 code다.
 *
 * 사용자-facing 응답에서는 한국어 상태 설명을 먼저 보여주고, 이 code는 audit/debug trace와 state machine 입력으로 보존한다.
 */
export type LiveOrderProposalStatus = (typeof liveOrderProposalStatuses)[number];

/**
 * M21 approval workflow가 append-only evidence로 남기는 사건 종류다.
 *
 * 각 evidence는 proposal 상태와 fingerprint를 함께 기록해 승인 없는 주문, 중복 승인, stale proposal 재사용을 broker 호출 전에
 * 차단할 수 있어야 한다. 이 type 자체는 저장이나 외부 API 호출 side effect를 만들지 않는다.
 */
export type LiveOrderApprovalEvidenceKind =
  | "PROPOSAL_CREATED"
  | "APPROVAL_RECORDED"
  | "REJECTION_RECORDED"
  | "EXPIRATION_RECORDED"
  | "SUBMISSION_RECHECK_PASSED"
  | "BROKER_SUBMISSION_RECORDED"
  | "SUBMISSION_FAILURE_RECORDED";

/**
 * proposal 생성 시점의 승인 예산 snapshot이다.
 *
 * `configuredMaxOrderKrw`는 단일 주문 상한, `dailyApprovedNotionalLimitKrw`와 `dailyApprovedNotionalUsedKrw`는 같은 영업일
 * 승인 예산 소진 여부를 broker 제출 직전 다시 확인하기 위한 입력이다. 모든 금액은 Decimal 정밀도 보존을 위해 문자열로 둔다.
 */
export interface LiveOrderApprovalBudgetSnapshot {
  configuredMaxOrderKrw: NumericString;
  dailyApprovedNotionalLimitKrw: NumericString;
  dailyApprovedNotionalUsedKrw: NumericString;
  capturedAt: TimestampInput;
}

/**
 * Telegram 운영자에게 보여줄 proposal 요약이다.
 *
 * title/body/action은 한국어 행동 문구를 담고, 내부 id와 fingerprint는 `trace`에 분리한다. raw Telegram text, provider body,
 * token, API key, JWT는 이 구조에 넣지 않는 것이 invariant다.
 */
export interface LiveOrderProposalOperatorSummary {
  title: string;
  body: string;
  action: string;
  trace?: JsonRecord;
}

/**
 * M21 approval workflow가 생성하는 live 주문 proposal contract다.
 *
 * strategy/cost/risk 단계는 자동으로 proposal 후보를 만들 수 있지만, 이 contract만으로는 broker side effect가 발생하지 않는다.
 * 후속 runtime은 `status=PROPOSED`, TTL, budget, market allowlist, risk decision, idempotency key, fingerprint를 모두 다시 검증한
 * 뒤에만 approval을 기록할 수 있다.
 */
export interface LiveOrderProposalContract {
  proposalId: string;
  status: LiveOrderProposalStatus;
  exchangeId: ExchangeId;
  market: MarketCode;
  side: OrderSide;
  orderType: "LIMIT";
  requestedPrice: NumericString;
  requestedVolume: NumericString;
  expectedNotionalKrw: NumericString;
  idempotencyKey: string;
  decisionLedgerId: string;
  riskDecisionId: string;
  costSnapshot: JsonRecord;
  budget: LiveOrderApprovalBudgetSnapshot;
  operatorFacingSummary: LiveOrderProposalOperatorSummary;
  proposedAt: TimestampInput;
  expiresAt: TimestampInput;
  metadata?: JsonRecord;
}

/**
 * M21 approval/reject/submission 단계에서 남기는 append-only evidence snapshot이다.
 *
 * proposal fingerprint와 idempotency key를 함께 남겨 같은 proposal id 또는 같은 broker identifier가 중복 live 주문으로 이어지지
 * 않게 한다. 이 구조는 안전한 projection만 담으며 DB write나 broker 호출은 별도 application/infrastructure layer가 수행한다.
 */
export interface LiveOrderApprovalEvidenceSnapshot {
  auditKind: "LIVE_ORDER_APPROVAL";
  evidenceKind: LiveOrderApprovalEvidenceKind;
  proposalId: string;
  proposalStatus: LiveOrderProposalStatus;
  proposalFingerprint: string;
  exchangeId: ExchangeId;
  market: MarketCode;
  side: OrderSide;
  orderType: "LIMIT";
  expectedNotionalKrw: NumericString;
  configuredMaxOrderKrw: NumericString;
  dailyApprovedNotionalLimitKrw: NumericString;
  dailyApprovedNotionalUsedKrw: NumericString;
  decisionLedgerId: string;
  riskDecisionId: string;
  idempotencyKey: string;
  occurredAt: string;
  reasonCode: string;
  actorHash?: string;
  brokerOrderId?: string;
  metadata?: JsonRecord;
}
