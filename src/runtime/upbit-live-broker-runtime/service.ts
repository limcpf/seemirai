import {
  UpbitPrivateRestClient,
  createUpbitLiveBroker,
} from "../../infrastructure/upbit/index.js";
import type {
  UpbitPrivateCredentials,
} from "../../infrastructure/upbit/index.js";
import type {
  BrokerBalanceSnapshot,
  BrokerOrder,
  MarketCode,
  OrderSubmission,
} from "../../domain/index.js";
import type { BrokerPort } from "../../application/index.js";
import { parseFinancialDecimal } from "../../shared/index.js";
import {
  UPBIT_PILOT_IDENTIFIER_MAX_LENGTH,
  UPBIT_PILOT_ORDER_SMOKE_MAX_KRW_LIMIT,
  UPBIT_PILOT_ORDER_SMOKE_MIN_KRW_LIMIT,
} from "../pilot-config.js";
import type {
  EnabledPilotRuntimeConfig,
  PilotUpbitKeyScope,
} from "../pilot-config.js";
import {
  UnsafeUpbitLiveBrokerRuntimeError,
} from "./types.js";
import type {
  CreateGuardedUpbitLiveBrokerRuntimeInput,
  CreateUpbitLiveBrokerRuntimeSafeSummaryInput,
  GuardedUpbitLiveBrokerRuntime,
  UpbitLiveBrokerPrivateClientFactory,
  UpbitLiveBrokerRuntimeSafeSummary,
} from "./types.js";

const REQUIRED_LIVE_BROKER_SCOPES: readonly PilotUpbitKeyScope[] = ["자산조회", "주문조회", "주문하기"];
const ALLOWED_LIVE_BROKER_SCOPES: readonly string[] = ["자산조회", "주문조회", "주문하기"];
const FORBIDDEN_LIVE_BROKER_SCOPES: readonly string[] = ["출금조회", "출금하기", "입금조회", "입금하기", "선물", "레버리지"];
const KRW_MARKET_PATTERN = /^KRW-[A-Z0-9]+$/u;
const POSITIVE_DECIMAL_PATTERN = /^(?:0|[1-9]\d*)(?:\.\d+)?$/u;

/**
 * 명시 guard를 모두 통과한 경우에만 `UpbitLiveBroker`를 조립한다.
 *
 * 기본 `PAPER_NO_KEY` runtime은 이 factory를 호출하지 않는다. 이 함수는 live broker adapter와 private client 객체를 만들 수
 * 있지만, 생성 중에는 network 요청을 보내지 않으며 guard 위반 시 private client factory도 호출하지 않는다.
 */
export function createGuardedUpbitLiveBrokerRuntime(
  input: CreateGuardedUpbitLiveBrokerRuntimeInput,
): GuardedUpbitLiveBrokerRuntime {
  const violations = collectUpbitLiveBrokerRuntimeViolations(input);

  if (violations.length > 0 || !input.pilotConfig.enabled) {
    // credential이 일부 있어도 guard가 완성되지 않으면 private client 객체조차 만들지 않아 기본 runtime 경계를 보존한다.
    throw new UnsafeUpbitLiveBrokerRuntimeError(
      violations.length > 0 ? violations : ["PILOT_ORDER_SMOKE guard가 필요합니다"],
    );
  }

  const privateClientFactory = input.privateClientFactory ?? createDefaultUpbitLiveBrokerPrivateClient;
  const privateClient = privateClientFactory({
    accessKey: input.pilotConfig.upbitAccessKey,
    secretKey: input.pilotConfig.upbitSecretKey,
  });
  const liveBroker = createUpbitLiveBroker({
    privateClient,
    ...(input.exchangeId === undefined ? {} : { exchangeId: input.exchangeId }),
    ...(input.clock === undefined ? {} : { clock: input.clock }),
  });
  const broker = new OrderSmokeGuardedBroker(
    liveBroker,
    input.pilotConfig.orderSmokeMarket!,
    input.pilotConfig.orderSmokeMaxKrw!,
  );

  return {
    broker,
    summary: createUpbitLiveBrokerRuntimeSafeSummary(input),
  };
}

/**
 * UpbitLiveBroker runtime guard 상태를 secret-safe 요약으로 변환한다.
 *
 * credential 원문은 boolean으로만 낮추며, 운영자에게는 profile/scope/evidence와 필요한 다음 조치만 보여준다. 이 함수는
 * 순수 변환 함수이며 private client나 broker를 만들지 않는다.
 */
export function createUpbitLiveBrokerRuntimeSafeSummary(
  input: CreateUpbitLiveBrokerRuntimeSafeSummaryInput,
): UpbitLiveBrokerRuntimeSafeSummary {
  if (!input.pilotConfig.enabled) {
    return {
      enabled: false,
      profile: null,
      privateSmokeEnabled: false,
      orderSmokeEnabled: false,
      credentialsConfigured: false,
      keyScopes: [],
      keyScopeEvidenceId: null,
      orderSmokeMarket: null,
      orderSmokeMaxKrw: null,
      statusLabel: "비활성",
      message: "Upbit live broker factory guard가 꺼져 있어 기본 PAPER_NO_KEY runtime이 실거래 broker를 조립하지 않는다.",
      action: "실거래 broker 검증이 필요할 때만 M15 live broker smoke guard와 pilot order-smoke profile을 함께 설정한다.",
      trace: {
        source: "upbit_live_broker_runtime",
        reason: "pilot_profile_disabled",
        liveBrokerEnabled: input.liveBrokerEnabled,
      },
    };
  }

  const violations = collectUpbitLiveBrokerRuntimeViolations(input);
  const ready = violations.length === 0;

  return {
    enabled: ready,
    profile: input.pilotConfig.profile,
    privateSmokeEnabled: input.pilotConfig.privateSmokeEnabled,
    orderSmokeEnabled: input.pilotConfig.orderSmokeEnabled,
    credentialsConfigured: input.pilotConfig.upbitAccessKey.length > 0 && input.pilotConfig.upbitSecretKey.length > 0,
    keyScopes: [...input.pilotConfig.keyScopes],
    keyScopeEvidenceId: input.pilotConfig.keyScopeEvidenceId,
    orderSmokeMarket: input.pilotConfig.orderSmokeMarket ?? null,
    orderSmokeMaxKrw: input.pilotConfig.orderSmokeMaxKrw ?? null,
    statusLabel: ready ? "live broker 조립 가능" : "live broker guard 미충족",
    message: ready
      ? "M15 Upbit live broker factory guard가 충족됐다. 실제 주문 제출은 별도 smoke/runner 경계에서만 수행한다."
      : "Upbit live broker factory guard가 완성되지 않아 private client를 만들 수 없다.",
    action: ready
      ? "실행 직전 대상 market, 소액 한도, identifier, key scope evidence를 다시 확인한다."
      : "추적 정보의 guard 위반 항목을 수정한 뒤 다시 조립한다.",
    trace: {
      source: "upbit_live_broker_runtime",
      reason: ready ? "guard_ready" : "guard_blocked",
      liveBrokerEnabled: input.liveBrokerEnabled,
      violations,
    },
  };
}

function collectUpbitLiveBrokerRuntimeViolations(
  input: CreateUpbitLiveBrokerRuntimeSafeSummaryInput,
): string[] {
  const violations: string[] = [];

  if (!input.liveBrokerEnabled) {
    violations.push("Upbit live broker runtime에는 liveBrokerEnabled=true guard가 필요합니다");
  }

  if (!input.pilotConfig.enabled) {
    violations.push("Upbit live broker runtime에는 활성화된 pilot config가 필요합니다");
    return violations;
  }

  validateEnabledPilotConfig(input.pilotConfig, violations);

  return violations;
}

function validateEnabledPilotConfig(config: EnabledPilotRuntimeConfig, violations: string[]): void {
  if (config.profile !== "PILOT_ORDER_SMOKE") {
    violations.push("Upbit live broker runtime에는 PILOT_ORDER_SMOKE profile이 필요합니다");
  }

  if (!config.privateSmokeEnabled || !config.orderSmokeEnabled) {
    // 주문 생성/취소 side effect는 read-only private smoke와 별도 order-smoke guard가 모두 켜져야만 열린다.
    violations.push("Upbit live broker runtime에는 private/order smoke guard가 모두 필요합니다");
  }

  if (config.upbitAccessKey.trim().length === 0 || config.upbitSecretKey.trim().length === 0) {
    violations.push("Upbit live broker runtime에는 Upbit credential 입력이 필요합니다");
  }

  if (config.keyScopeEvidenceId.trim().length === 0) {
    violations.push("Upbit live broker runtime에는 key scope evidence id가 필요합니다");
  }

  validateOrderSmokeMarket(config.orderSmokeMarket, violations);
  validateOrderSmokeMaxKrw(config.orderSmokeMaxKrw, violations);

  if (
    config.policySyncMarket !== undefined &&
    config.orderSmokeMarket !== undefined &&
    config.policySyncMarket !== config.orderSmokeMarket
  ) {
    violations.push("Upbit live broker runtime의 policy sync market과 order smoke market은 같아야 합니다");
  }

  for (const requiredScope of REQUIRED_LIVE_BROKER_SCOPES) {
    if (!config.keyScopes.includes(requiredScope)) {
      violations.push(`Upbit live broker runtime key scope에 ${requiredScope} 권한이 필요합니다`);
    }
  }

  validateLiveBrokerKeyScopes(config.keyScopes, violations);
}

function validateLiveBrokerKeyScopes(keyScopes: readonly string[], violations: string[]): void {
  for (const keyScope of keyScopes) {
    if (FORBIDDEN_LIVE_BROKER_SCOPES.includes(keyScope)) {
      violations.push(`Upbit live broker runtime에 금지된 key scope가 포함되어 있습니다: ${keyScope}`);
      continue;
    }

    if (!ALLOWED_LIVE_BROKER_SCOPES.includes(keyScope)) {
      violations.push(`Upbit live broker runtime에 알 수 없는 key scope가 포함되어 있습니다: ${keyScope}`);
    }
  }
}

function validateOrderSmokeMarket(market: string | undefined, violations: string[]): void {
  if (market === undefined) {
    violations.push("Upbit live broker runtime에는 order smoke market이 필요합니다");
    return;
  }

  if (!KRW_MARKET_PATTERN.test(market)) {
    violations.push("Upbit live broker runtime order smoke market은 KRW- 로 시작하는 Upbit KRW 현물 market이어야 합니다");
  }
}

function validateOrderSmokeMaxKrw(maxKrw: string | undefined, violations: string[]): void {
  if (maxKrw === undefined) {
    violations.push("Upbit live broker runtime에는 order smoke max KRW가 필요합니다");
    return;
  }

  if (!POSITIVE_DECIMAL_PATTERN.test(maxKrw) || Number(maxKrw) <= 0) {
    violations.push("Upbit live broker runtime order smoke max KRW는 양수 KRW 금액이어야 합니다");
    return;
  }

  if (Number(maxKrw) < UPBIT_PILOT_ORDER_SMOKE_MIN_KRW_LIMIT) {
    violations.push("Upbit live broker runtime order smoke max KRW는 5000 KRW 이상이어야 합니다");
  }

  if (Number(maxKrw) > UPBIT_PILOT_ORDER_SMOKE_MAX_KRW_LIMIT) {
    violations.push("Upbit live broker runtime order smoke max KRW는 50000 KRW 이하여야 합니다");
  }
}

/**
 * M15 live broker factory가 반환하는 order-smoke 전용 broker wrapper다.
 *
 * 조회/취소는 이미 만들어진 broker method로 위임하지만, 새 주문 제출은 M14 order-smoke env에 고정된 market과 소액 한도를
 * 다시 확인한 뒤에만 실제 `UpbitLiveBroker`에 전달한다. wrapper 자체는 외부 API를 호출하지 않으며 delegate method 호출만
 * side effect를 만들 수 있다.
 */
class OrderSmokeGuardedBroker implements BrokerPort {
  private readonly submittedOrderIds = new Set<string>();

  public constructor(
    private readonly delegate: BrokerPort,
    private readonly orderSmokeMarket: MarketCode,
    private readonly orderSmokeMaxKrw: string,
  ) {}

  public async submitOrder(submission: OrderSubmission): Promise<BrokerOrder> {
    assertOrderSmokeSubmissionWithinGuard(submission, this.orderSmokeMarket, this.orderSmokeMaxKrw);

    const brokerOrder = await this.delegate.submitOrder(submission);

    // 같은 smoke run에서 생성된 주문만 이후 취소할 수 있도록 성공한 broker order id만 로컬 evidence로 기록한다.
    this.submittedOrderIds.add(brokerOrder.brokerOrderId);

    return brokerOrder;
  }

  public async cancelOrder(orderId: string): Promise<BrokerOrder> {
    if (!this.submittedOrderIds.has(orderId)) {
      // 임의 UUID 취소는 smoke market/budget guard를 우회하는 실계좌 side effect이므로 wrapper 경계에서 차단한다.
      throw new UnsafeUpbitLiveBrokerRuntimeError([
        "Upbit live broker order smoke는 같은 runtime이 생성한 주문만 취소할 수 있습니다",
      ]);
    }

    return this.delegate.cancelOrder(orderId);
  }

  public async getOrder(orderId: string): Promise<BrokerOrder | undefined> {
    return this.delegate.getOrder(orderId);
  }

  public async listOpenOrders(market?: MarketCode): Promise<readonly BrokerOrder[]> {
    return this.delegate.listOpenOrders(market);
  }

  public async getBalances(): Promise<BrokerBalanceSnapshot> {
    return this.delegate.getBalances();
  }
}

function assertOrderSmokeSubmissionWithinGuard(
  submission: OrderSubmission,
  orderSmokeMarket: MarketCode,
  orderSmokeMaxKrw: string,
): void {
  const violations: string[] = [];

  if (submission.intent.market !== orderSmokeMarket) {
    violations.push(`Upbit live broker order smoke market은 ${orderSmokeMarket}만 허용합니다`);
  }

  if (submission.intent.idempotencyKey.length === 0 || submission.intent.idempotencyKey.length > UPBIT_PILOT_IDENTIFIER_MAX_LENGTH) {
    violations.push(`Upbit live broker order smoke identifier는 1자 이상 ${UPBIT_PILOT_IDENTIFIER_MAX_LENGTH}자 이하여야 합니다`);
  }

  if (submission.intent.side !== "BUY") {
    violations.push("Upbit live broker order smoke는 지정가 매수만 허용합니다");
  }

  if (submission.intent.orderType !== "LIMIT") {
    violations.push("Upbit live broker order smoke는 LIMIT 주문만 허용합니다");
  } else {
    if (submission.intent.postOnly !== true || submission.intent.timeInForce !== "POST_ONLY") {
      violations.push("Upbit live broker order smoke는 post-only 지정가만 허용합니다");
    }

    collectOrderSmokeNotionalViolations(
      submission.intent.requestedPrice,
      submission.intent.requestedQuantity,
      orderSmokeMaxKrw,
      violations,
    );
  }

  if (violations.length > 0) {
    // 주문 smoke guard를 벗어난 submit은 live broker에 위임하기 전에 닫아 실제 주문 side effect를 만들지 않는다.
    throw new UnsafeUpbitLiveBrokerRuntimeError(violations);
  }
}

function collectOrderSmokeNotionalViolations(
  price: string,
  quantity: string,
  maxKrw: string,
  violations: string[],
): void {
  try {
    const notional = parseFinancialDecimal(price).mul(parseFinancialDecimal(quantity));
    if (notional.lessThan(UPBIT_PILOT_ORDER_SMOKE_MIN_KRW_LIMIT)) {
      violations.push(`Upbit live broker order smoke 주문 금액은 ${UPBIT_PILOT_ORDER_SMOKE_MIN_KRW_LIMIT} KRW 이상이어야 합니다`);
    }

    if (notional.greaterThan(parseFinancialDecimal(maxKrw))) {
      violations.push(`Upbit live broker order smoke 주문 금액은 ${maxKrw} KRW 이하여야 합니다`);
    }
  } catch {
    violations.push("Upbit live broker order smoke 주문 가격과 수량은 decimal 문자열이어야 합니다");
  }
}

function createDefaultUpbitLiveBrokerPrivateClient(
  credentials: UpbitPrivateCredentials,
): ReturnType<UpbitLiveBrokerPrivateClientFactory> {
  return new UpbitPrivateRestClient({ credentials });
}
