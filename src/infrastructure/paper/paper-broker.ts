import { simulatePaperFill } from "../../application/execution/index.js";
import type {
  PaperFillSimulationResult,
  PaperFillSimulatorOptions,
} from "../../application/execution/index.js";
import type { BrokerPort } from "../../application/ports/index.js";
import { parseFinancialDecimal } from "../../shared/index.js";
import type {
  BrokerBalance,
  BrokerBalanceSnapshot,
  BrokerOrder,
  ExchangeId,
  JsonRecord,
  MarketCode,
  NumericString,
  OrderIntent,
  OrderLifecycleStatus,
  OrderSubmission,
  OrderbookEvent,
  TimestampInput,
} from "../../domain/index.js";

export type PaperBrokerFillOptions = Omit<PaperFillSimulatorOptions, "submittedAt">;

export interface PaperBrokerBalanceInput {
  currency: string;
  available: NumericString;
  locked?: NumericString;
  total?: NumericString;
  updatedAt?: TimestampInput;
  metadata?: JsonRecord;
}

export interface PaperBrokerOptions {
  /**
   * 잔고 snapshot과 주문 결과에 찍을 거래소 식별자다.
   *
   * PaperBroker는 거래소별 client를 import하지 않으므로, runtime assembly가 선택한 paper profile의 exchange id를
   * 명시적으로 주입해야 한다.
   */
  exchangeId: ExchangeId;
  /** 테스트, backtest bridge, paper runtime이 시작 시점에 주입하는 가상 잔고다. */
  initialBalances?: readonly PaperBrokerBalanceInput[];
  /**
   * submit 시점에 사용할 호가 snapshot 묶음이다.
   *
   * BrokerPort에는 market data 조회 메서드가 없으므로, runtime은 주문 제출 전에 최신 snapshot을 broker에 기록해 둔다.
   */
  orderbookSnapshots?: OrderbookEvent | readonly OrderbookEvent[];
  /** latency, post-only 정책, 수수료처럼 fill simulator에 넘길 broker-local 옵션이다. */
  fillOptions?: PaperBrokerFillOptions;
  /** 사람이 로그에서 구분하기 쉬운 paper 주문 ID prefix다. */
  brokerOrderIdPrefix?: string;
  /** 테스트와 replay가 결정적 timestamp를 주입할 수 있게 하는 clock이다. */
  clock?: () => TimestampInput;
}

interface MarketCurrencies {
  quoteCurrency: string;
  baseCurrency: string;
}

interface PaperBrokerBalanceMutationSummary extends JsonRecord {
  base_currency: string;
  quote_currency: string;
  filled_quantity: NumericString;
  open_quantity: NumericString;
  canceled_quantity: NumericString;
  quote_available_delta: NumericString;
  quote_locked_delta: NumericString;
  base_available_delta: NumericString;
  base_locked_delta: NumericString;
}

interface PaperBrokerCancelMutationSummary extends JsonRecord {
  base_currency: string;
  quote_currency: string;
  released_currency: string;
  released_quantity: NumericString;
  canceled_quantity: NumericString;
}

interface PaperBrokerBalanceRejectionSummary extends JsonRecord {
  reason_code: "paper_balance_insufficient";
  currency: string;
  balance_field: "available";
  required_quantity: NumericString;
  available_quantity: NumericString;
  shortage_quantity: NumericString;
  attempted_delta: NumericString;
}

interface PaperBrokerExchangeRejectionSummary extends JsonRecord {
  reason_code: "paper_exchange_mismatch";
  broker_exchange_id: ExchangeId;
  intent_exchange_id: ExchangeId;
}

type PaperBrokerBalanceValidationResult =
  | {
      valid: true;
    }
  | {
      valid: false;
      rejection: PaperBrokerBalanceRejectionSummary;
    };

interface PaperBrokerFillSimulationRequest {
  orderbooks: readonly OrderbookEvent[];
  options: PaperFillSimulatorOptions;
}

interface PaperBrokerOrderState {
  status: OrderLifecycleStatus;
  remainingQuantity: NumericString;
  balanceMutationApplied: boolean;
  balanceRejection?: PaperBrokerBalanceRejectionSummary;
}

/**
 * 동일 idempotency key가 서로 다른 주문 후보에 재사용됐을 때 발생하는 broker boundary 오류다.
 *
 * ExecutionEngine은 동시에 들어온 중복 요청만 억제하므로, PaperBroker는 이미 기록된 key가 다른 fingerprint로
 * 들어오면 durable broker state 오염을 막기 위해 side effect 없이 실패시킨다.
 */
export class PaperBrokerIdempotencyConflictError extends Error {
  public readonly idempotencyKey: string;

  public constructor(idempotencyKey: string) {
    super(`Paper broker idempotency key was reused with a different order fingerprint: ${idempotencyKey}`);
    this.name = "PaperBrokerIdempotencyConflictError";
    this.idempotencyKey = idempotencyKey;
  }
}

/**
 * 존재하지 않는 paper 주문을 취소하려고 할 때 발생하는 조회 오류다.
 *
 * BrokerPort는 취소 결과로 `BrokerOrder`를 돌려주므로, 알 수 없는 주문 ID를 조용히 성공 처리하면 runtime이
 * 실제 취소 여부를 오판할 수 있다.
 */
export class PaperBrokerOrderNotFoundError extends Error {
  public readonly brokerOrderId: string;

  public constructor(brokerOrderId: string) {
    super(`Paper broker order was not found: ${brokerOrderId}`);
    this.name = "PaperBrokerOrderNotFoundError";
    this.brokerOrderId = brokerOrderId;
  }
}

/**
 * MVP paper trading에서 사용하는 in-memory `BrokerPort` 구현체다.
 *
 * 이 class는 실제 주문 API, DB persistence, strategy 구현체를 알지 않는다. `OrderSubmission`을 받아 이미
 * 주입된 orderbook snapshot으로 paper fill을 계산하고, 그 결과를 broker 주문 상태와 가상 잔고 상태로 변환한다.
 * durable 저장소와 runtime worker 최종 조립은 후속 PR에서 붙이더라도, 여기서는 `BrokerPort` contract와
 * live-order side effect 없는 실행 경계를 먼저 고정한다.
 */
export class PaperBroker implements BrokerPort {
  private readonly exchangeId: ExchangeId;
  private readonly fillOptions: PaperBrokerFillOptions;
  private readonly brokerOrderIdPrefix: string;
  private readonly clock: () => TimestampInput;
  private readonly ordersById = new Map<string, BrokerOrder>();
  private readonly orderIdsByIdempotencyKey = new Map<string, string>();
  private readonly fingerprintsByIdempotencyKey = new Map<string, string>();
  private readonly balancesByCurrency = new Map<string, BrokerBalance>();
  private readonly orderbooksByMarket = new Map<string, OrderbookEvent[]>();
  private nextOrderSequence = 1;

  public constructor(options: PaperBrokerOptions) {
    this.exchangeId = options.exchangeId;
    this.fillOptions = options.fillOptions ?? {};
    this.brokerOrderIdPrefix = options.brokerOrderIdPrefix ?? "paper-order";
    this.clock = options.clock ?? (() => new Date().toISOString());

    const initializedAt = this.clock();
    for (const balance of options.initialBalances ?? []) {
      this.balancesByCurrency.set(normalizeCurrency(balance.currency), normalizeInitialBalance(balance, initializedAt));
    }

    for (const snapshot of normalizeOrderbookSnapshots(options.orderbookSnapshots)) {
      this.recordOrderbookSnapshot(snapshot);
    }
  }

  /**
   * 최신 호가 snapshot을 broker-local memory에 누적한다.
   *
   * `BrokerPort.submitOrder` 자체는 market data를 조회하지 않으므로, runtime은 market data worker가 받은 snapshot을
   * 이 메서드로 먼저 넘겨야 한다. 같은 market의 여러 snapshot은 latency 옵션이 선택할 수 있도록 수신 시각순으로
   * 정렬해 둔다.
   */
  public recordOrderbookSnapshot(snapshot: OrderbookEvent): void {
    const key = createOrderbookKey(snapshot.exchangeId, snapshot.market);
    const snapshots = this.orderbooksByMarket.get(key) ?? [];
    snapshots.push(snapshot);
    snapshots.sort((left, right) => readTimestampMillis(left.receivedAt) - readTimestampMillis(right.receivedAt));
    this.orderbooksByMarket.set(key, snapshots);
  }

  /**
   * 테스트나 replay가 전체 snapshot window를 명확히 교체할 때 사용한다.
   *
   * 운영 runtime에서는 보통 `recordOrderbookSnapshot`을 사용하고, 오래된 snapshot pruning은 후속 runtime 조립
   * 범위에서 다룬다.
   */
  public replaceOrderbookSnapshots(snapshots: OrderbookEvent | readonly OrderbookEvent[]): void {
    const normalizedSnapshots = normalizeOrderbookSnapshots(snapshots);
    // replay나 테스트가 snapshot window를 교체할 때 이전 호가가 latency 선택에 섞이지 않도록 전체 window를 비운다.
    this.orderbooksByMarket.clear();
    for (const snapshot of normalizedSnapshots) {
      this.recordOrderbookSnapshot(snapshot);
    }
  }

  /**
   * 비용/리스크 검증을 통과한 주문을 paper broker state에 반영한다.
   *
   * 중복 idempotency key는 기존 주문을 그대로 반환해 broker side effect를 한 번으로 제한한다. 새 주문이면
   * fill simulator 결과를 주문 상태로 변환하고, 체결·미체결 open 수량에 따른 가상 잔고 변화를 같은 critical
   * section 안에서 적용한다.
   */
  public async submitOrder(submission: OrderSubmission): Promise<BrokerOrder> {
    const fingerprint = createSubmissionFingerprint(submission.intent);
    const existingOrderId = this.orderIdsByIdempotencyKey.get(submission.intent.idempotencyKey);
    if (existingOrderId !== undefined) {
      const existingFingerprint = this.fingerprintsByIdempotencyKey.get(submission.intent.idempotencyKey);
      if (existingFingerprint !== fingerprint) {
        // 같은 idempotency key가 다른 주문으로 재사용되면 잔고/주문 상태를 덮어쓰지 않고 즉시 차단한다.
        throw new PaperBrokerIdempotencyConflictError(submission.intent.idempotencyKey);
      }

      return cloneBrokerOrder(this.readExistingOrder(existingOrderId));
    }

    const brokerOrderId = this.createBrokerOrderId();
    const updatedAt = this.clock();
    const exchangeRejection = this.createExchangeRejection(submission.intent);
    if (exchangeRejection !== undefined) {
      // broker instance의 exchange와 다른 intent는 호가와 잔고를 섞어 상태를 오염시키므로 fill 계산 전에 거부한다.
      const order = createRejectedBrokerOrder(submission, brokerOrderId, exchangeRejection, updatedAt);
      this.ordersById.set(order.brokerOrderId, order);
      this.orderIdsByIdempotencyKey.set(order.idempotencyKey, order.brokerOrderId);
      this.fingerprintsByIdempotencyKey.set(order.idempotencyKey, fingerprint);

      return cloneBrokerOrder(order);
    }

    const simulationRequest = this.createFillSimulationRequest(submission);
    const simulation = simulatePaperFill({
      intent: submission.intent,
      orderbooks: simulationRequest.orderbooks,
      options: simulationRequest.options,
    });
    const balanceMutation = createSubmissionBalanceMutation(submission.intent, simulation);
    const balanceValidation = this.validateBalanceMutation(balanceMutation);
    const orderState = createOrderStateFromSimulation(simulation, balanceValidation);

    if (balanceValidation.valid) {
      // 잔고가 충분한 경우에만 체결/lock delta를 반영해 rejected 주문이 paper 잔고를 오염시키지 않게 한다.
      this.applySubmissionBalanceMutation(balanceMutation, updatedAt);
    }

    const order = this.createBrokerOrder(submission, brokerOrderId, simulation, balanceMutation, orderState, updatedAt);

    // 주문 저장과 idempotency index 갱신은 같은 submit side effect로 취급해 중복 재진입이 새 주문을 만들지 못하게 한다.
    this.ordersById.set(order.brokerOrderId, order);
    this.orderIdsByIdempotencyKey.set(order.idempotencyKey, order.brokerOrderId);
    this.fingerprintsByIdempotencyKey.set(order.idempotencyKey, fingerprint);

    return cloneBrokerOrder(order);
  }

  /**
   * open 상태의 paper 주문을 취소하고, 주문 제출 때 잠근 가상 잔고를 해제한다.
   *
   * 이미 종료된 주문은 취소 side effect를 반복하지 않고 기존 상태를 반환한다. 알 수 없는 주문 ID는 실거래 broker와
   * 같은 운영 위험을 만들 수 있으므로 명시적인 오류로 처리한다.
   */
  public async cancelOrder(orderId: string): Promise<BrokerOrder> {
    const existingOrder = this.ordersById.get(orderId);
    if (existingOrder === undefined) {
      throw new PaperBrokerOrderNotFoundError(orderId);
    }

    if (!isOpenBrokerOrder(existingOrder)) {
      // 종료된 주문의 cancel 재시도는 idempotent 조회로 취급해 잔고를 다시 움직이지 않는다.
      return cloneBrokerOrder(existingOrder);
    }

    const canceledAt = this.clock();
    const cancelMutation = this.releaseOpenBalance(existingOrder, canceledAt);
    const canceledOrder = createCanceledOrder(existingOrder, cancelMutation, canceledAt);
    this.ordersById.set(canceledOrder.brokerOrderId, canceledOrder);

    return cloneBrokerOrder(canceledOrder);
  }

  /** broker 주문 ID로 현재 in-memory 주문 상태를 조회한다. */
  public async getOrder(orderId: string): Promise<BrokerOrder | undefined> {
    const order = this.ordersById.get(orderId);
    return order === undefined ? undefined : cloneBrokerOrder(order);
  }

  /**
   * 아직 broker에 open 수량이 남아 있는 주문을 조회한다.
   *
   * `remainingQuantity > 0`과 open lifecycle status를 함께 확인해 부분체결 후 미체결 수량이 있는 주문만 runtime
   * cancel/requote 후보로 노출한다.
   */
  public async listOpenOrders(market?: MarketCode): Promise<readonly BrokerOrder[]> {
    const orders: BrokerOrder[] = [];
    for (const order of this.ordersById.values()) {
      if (market !== undefined && order.market !== market) {
        continue;
      }
      if (isOpenBrokerOrder(order)) {
        orders.push(cloneBrokerOrder(order));
      }
    }

    return orders;
  }

  /**
   * 현재 paper broker가 관리하는 가상 잔고 snapshot을 반환한다.
   *
   * 잔고는 체결과 open 주문 lock을 즉시 반영한 in-memory 값이며, 후속 persistence PR에서는 이 snapshot이
   * DB-backed balance event로 내려갈 수 있다.
   */
  public async getBalances(): Promise<BrokerBalanceSnapshot> {
    return {
      exchangeId: this.exchangeId,
      balances: [...this.balancesByCurrency.values()].map(cloneBrokerBalance),
      capturedAt: this.clock(),
      metadata: {
        source: "paper_broker_memory",
        open_order_count: [...this.ordersById.values()].filter((order) => isOpenBrokerOrder(order)).length,
      },
    };
  }

  private createBrokerOrderId(): string {
    const orderId = `${this.brokerOrderIdPrefix}-${this.nextOrderSequence}`;
    this.nextOrderSequence += 1;
    return orderId;
  }

  private readExistingOrder(orderId: string): BrokerOrder {
    const order = this.ordersById.get(orderId);
    if (order === undefined) {
      throw new PaperBrokerOrderNotFoundError(orderId);
    }
    return order;
  }

  private readOrderbooksForIntent(intent: OrderIntent): readonly OrderbookEvent[] {
    const key = createOrderbookKey(intent.exchangeId, intent.market);
    return [...(this.orderbooksByMarket.get(key) ?? [])];
  }

  private createExchangeRejection(intent: OrderIntent): PaperBrokerExchangeRejectionSummary | undefined {
    if (intent.exchangeId === this.exchangeId) {
      return undefined;
    }

    return {
      reason_code: "paper_exchange_mismatch",
      broker_exchange_id: this.exchangeId,
      intent_exchange_id: intent.exchangeId,
    };
  }

  private createFillSimulationRequest(submission: OrderSubmission): PaperBrokerFillSimulationRequest {
    const orderbooks = this.readOrderbooksForIntent(submission.intent);
    if (shouldWaitForPostSubmitSnapshot(this.fillOptions)) {
      return {
        orderbooks,
        options: {
          ...this.fillOptions,
          submittedAt: submission.submittedAt,
        },
      };
    }

    const immediateOrderbook = selectImmediateExecutionOrderbook(orderbooks, submission.submittedAt);
    return {
      orderbooks: immediateOrderbook === undefined ? [] : [immediateOrderbook],
      options: {
        ...this.fillOptions,
      },
    };
  }

  private createBrokerOrder(
    submission: OrderSubmission,
    brokerOrderId: string,
    simulation: PaperFillSimulationResult,
    balanceMutation: PaperBrokerBalanceMutationSummary,
    orderState: PaperBrokerOrderState,
    updatedAt: TimestampInput,
  ): BrokerOrder {
    const metadata: JsonRecord = {
      source: "paper_broker_memory",
      submitted_at: submission.submittedAt,
      paper_fill_simulation: simulation,
      balance_mutation: balanceMutation,
      balance_mutation_applied: orderState.balanceMutationApplied,
    };
    if (orderState.balanceRejection !== undefined) {
      metadata.paper_balance_rejection = orderState.balanceRejection;
    }

    const baseOrder: BrokerOrder = {
      brokerOrderId,
      idempotencyKey: submission.intent.idempotencyKey,
      exchangeId: submission.intent.exchangeId,
      market: submission.intent.market,
      side: submission.intent.side,
      orderType: submission.intent.orderType,
      status: orderState.status,
      requestedQuantity: simulation.requestedQuantity,
      remainingQuantity: orderState.remainingQuantity,
      updatedAt,
      metadata,
    };

    const orderWithPrice =
      submission.intent.orderType === "LIMIT"
        ? {
            ...baseOrder,
            requestedPrice: submission.intent.requestedPrice,
          }
        : baseOrder;

    if (isAcceptedBrokerStatus(orderWithPrice.status)) {
      return {
        ...orderWithPrice,
        acceptedAt: updatedAt,
      };
    }

    return orderWithPrice;
  }

  private applySubmissionBalanceMutation(
    mutation: PaperBrokerBalanceMutationSummary,
    updatedAt: TimestampInput,
  ): void {
    // 체결과 open 주문 lock을 같은 submit 처리 안에서 반영해 주문 상태와 잔고 snapshot이 서로 어긋나지 않게 한다.
    this.applyBalanceDelta(mutation.quote_currency, mutation.quote_available_delta, mutation.quote_locked_delta, updatedAt);
    this.applyBalanceDelta(mutation.base_currency, mutation.base_available_delta, mutation.base_locked_delta, updatedAt);
  }

  private validateBalanceMutation(mutation: PaperBrokerBalanceMutationSummary): PaperBrokerBalanceValidationResult {
    const quoteValidation = this.validateAvailableBalance(mutation.quote_currency, mutation.quote_available_delta);
    if (!quoteValidation.valid) {
      return quoteValidation;
    }

    return this.validateAvailableBalance(mutation.base_currency, mutation.base_available_delta);
  }

  private validateAvailableBalance(currency: string, availableDelta: NumericString): PaperBrokerBalanceValidationResult {
    if (!isNegativeDecimalString(availableDelta)) {
      return {
        valid: true,
      };
    }

    const normalizedCurrency = normalizeCurrency(currency);
    const available = this.balancesByCurrency.get(normalizedCurrency)?.available ?? "0";
    const required = absDecimalString(availableDelta);
    if (parseFinancialDecimal(available).greaterThanOrEqualTo(parseFinancialDecimal(required))) {
      return {
        valid: true,
      };
    }

    return {
      valid: false,
      rejection: {
        reason_code: "paper_balance_insufficient",
        currency: normalizedCurrency,
        balance_field: "available",
        required_quantity: required,
        available_quantity: available,
        shortage_quantity: subtractDecimalStrings(required, available),
        attempted_delta: availableDelta,
      },
    };
  }

  private releaseOpenBalance(order: BrokerOrder, canceledAt: TimestampInput): PaperBrokerCancelMutationSummary {
    const { baseCurrency, quoteCurrency } = parseMarketCurrencies(order.market);
    const canceledQuantity = order.remainingQuantity;

    if (order.orderType === "LIMIT" && order.requestedPrice !== undefined && isPositiveDecimalString(canceledQuantity)) {
      if (order.side === "BUY") {
        const releasedQuote = multiplyDecimalStrings(canceledQuantity, order.requestedPrice);
        // BUY open 주문 취소는 quote lock을 available로 되돌려 다음 주문 한도 계산이 stale lock에 막히지 않게 한다.
        this.applyBalanceDelta(quoteCurrency, releasedQuote, negateDecimalString(releasedQuote), canceledAt);
        return {
          base_currency: baseCurrency,
          quote_currency: quoteCurrency,
          released_currency: quoteCurrency,
          released_quantity: releasedQuote,
          canceled_quantity: canceledQuantity,
        };
      }

      // SELL open 주문 취소는 base lock을 available로 되돌려 paper position snapshot을 복구한다.
      this.applyBalanceDelta(baseCurrency, canceledQuantity, negateDecimalString(canceledQuantity), canceledAt);
      return {
        base_currency: baseCurrency,
        quote_currency: quoteCurrency,
        released_currency: baseCurrency,
        released_quantity: canceledQuantity,
        canceled_quantity: canceledQuantity,
      };
    }

    return {
      base_currency: baseCurrency,
      quote_currency: quoteCurrency,
      released_currency: "",
      released_quantity: "0",
      canceled_quantity: canceledQuantity,
    };
  }

  private applyBalanceDelta(
    currency: string,
    availableDelta: NumericString,
    lockedDelta: NumericString,
    updatedAt: TimestampInput,
  ): void {
    const normalizedCurrency = normalizeCurrency(currency);
    if (isZeroDecimalString(availableDelta) && isZeroDecimalString(lockedDelta)) {
      return;
    }

    const current = this.balancesByCurrency.get(normalizedCurrency) ?? createZeroBalance(normalizedCurrency, updatedAt);
    const available = addDecimalStrings(current.available, availableDelta);
    const locked = addDecimalStrings(current.locked, lockedDelta);
    const nextBalance: BrokerBalance = {
      ...current,
      available,
      locked,
      total: addDecimalStrings(available, locked),
      updatedAt,
    };

    this.balancesByCurrency.set(normalizedCurrency, nextBalance);
  }
}

function createRejectedBrokerOrder(
  submission: OrderSubmission,
  brokerOrderId: string,
  rejection: PaperBrokerExchangeRejectionSummary,
  updatedAt: TimestampInput,
): BrokerOrder {
  const baseOrder: BrokerOrder = {
    brokerOrderId,
    idempotencyKey: submission.intent.idempotencyKey,
    exchangeId: submission.intent.exchangeId,
    market: submission.intent.market,
    side: submission.intent.side,
    orderType: submission.intent.orderType,
    status: "REJECTED",
    requestedQuantity: normalizeDecimalString(submission.intent.requestedQuantity),
    remainingQuantity: "0",
    updatedAt,
    metadata: {
      source: "paper_broker_memory",
      submitted_at: submission.submittedAt,
      paper_broker_rejection: rejection,
    },
  };

  if (submission.intent.orderType === "LIMIT") {
    return {
      ...baseOrder,
      requestedPrice: submission.intent.requestedPrice,
    };
  }

  return baseOrder;
}

function createSubmissionBalanceMutation(
  intent: OrderIntent,
  simulation: PaperFillSimulationResult,
): PaperBrokerBalanceMutationSummary {
  const { baseCurrency, quoteCurrency } = parseMarketCurrencies(intent.market);
  const filledQuantity = simulation.filledQuantity;
  const openQuantity = simulation.openQuantity;
  const totalFillNotional = simulation.totalFillNotional ?? "0";
  const totalFee = simulation.totalFee ?? "0";
  let quoteAvailableDelta = "0";
  let quoteLockedDelta = "0";
  let baseAvailableDelta = "0";
  let baseLockedDelta = "0";

  if (intent.side === "BUY") {
    const fillQuoteDebit = addDecimalStrings(totalFillNotional, totalFee);
    const openQuoteLock = calculateOpenQuoteLock(intent, openQuantity);

    quoteAvailableDelta = negateDecimalString(addDecimalStrings(fillQuoteDebit, openQuoteLock));
    quoteLockedDelta = openQuoteLock;
    baseAvailableDelta = filledQuantity;
  } else {
    const fillQuoteCredit = subtractDecimalStrings(totalFillNotional, totalFee);

    quoteAvailableDelta = fillQuoteCredit;
    baseAvailableDelta = negateDecimalString(addDecimalStrings(filledQuantity, openQuantity));
    baseLockedDelta = openQuantity;
  }

  return {
    base_currency: baseCurrency,
    quote_currency: quoteCurrency,
    filled_quantity: filledQuantity,
    open_quantity: openQuantity,
    canceled_quantity: simulation.canceledQuantity,
    quote_available_delta: quoteAvailableDelta,
    quote_locked_delta: quoteLockedDelta,
    base_available_delta: baseAvailableDelta,
    base_locked_delta: baseLockedDelta,
  };
}

function createOrderStateFromSimulation(
  simulation: PaperFillSimulationResult,
  balanceValidation: PaperBrokerBalanceValidationResult,
): PaperBrokerOrderState {
  if (!balanceValidation.valid) {
    return {
      status: "REJECTED",
      remainingQuantity: "0",
      balanceMutationApplied: false,
      balanceRejection: balanceValidation.rejection,
    };
  }

  return {
    status: simulation.orderStatus,
    remainingQuantity: simulation.openQuantity,
    balanceMutationApplied: true,
  };
}

function createCanceledOrder(
  order: BrokerOrder,
  cancelMutation: PaperBrokerCancelMutationSummary,
  canceledAt: TimestampInput,
): BrokerOrder {
  return {
    ...order,
    status: "CANCELED",
    remainingQuantity: "0",
    updatedAt: canceledAt,
    metadata: {
      ...(order.metadata ?? {}),
      paper_cancel: {
        canceled_at: canceledAt,
        balance_mutation: cancelMutation,
      },
    },
  };
}

function normalizeInitialBalance(input: PaperBrokerBalanceInput, fallbackUpdatedAt: TimestampInput): BrokerBalance {
  const locked = input.locked ?? "0";
  const total = input.total ?? addDecimalStrings(input.available, locked);
  const balance: BrokerBalance = {
    currency: normalizeCurrency(input.currency),
    available: normalizeDecimalString(input.available),
    locked: normalizeDecimalString(locked),
    total: normalizeDecimalString(total),
    updatedAt: input.updatedAt ?? fallbackUpdatedAt,
  };
  if (input.metadata !== undefined) {
    balance.metadata = { ...input.metadata };
  }

  return balance;
}

function createZeroBalance(currency: string, updatedAt: TimestampInput): BrokerBalance {
  return {
    currency: normalizeCurrency(currency),
    available: "0",
    locked: "0",
    total: "0",
    updatedAt,
  };
}

function normalizeOrderbookSnapshots(
  snapshots: OrderbookEvent | readonly OrderbookEvent[] | undefined,
): readonly OrderbookEvent[] {
  if (snapshots === undefined) {
    return [];
  }

  if (isOrderbookSnapshotArray(snapshots)) {
    return snapshots;
  }

  return [snapshots];
}

function isOrderbookSnapshotArray(
  snapshots: OrderbookEvent | readonly OrderbookEvent[],
): snapshots is readonly OrderbookEvent[] {
  return Array.isArray(snapshots);
}

function shouldWaitForPostSubmitSnapshot(options: PaperBrokerFillOptions): boolean {
  return (options.latencyMs ?? 0) > 0;
}

function selectImmediateExecutionOrderbook(
  orderbooks: readonly OrderbookEvent[],
  submittedAt: TimestampInput,
): OrderbookEvent | undefined {
  const submittedAtMillis = readTimestampMillis(submittedAt);
  let latestPreSubmitSnapshot: OrderbookEvent | undefined;
  let earliestPostSubmitSnapshot: OrderbookEvent | undefined;

  for (const orderbook of orderbooks) {
    const receivedAtMillis = readTimestampMillis(orderbook.receivedAt);
    if (receivedAtMillis <= submittedAtMillis) {
      // latency가 없는 paper submit은 주문 직전에 관측한 최신 snapshot을 즉시 체결 근거로 사용할 수 있어야 한다.
      latestPreSubmitSnapshot = orderbook;
      continue;
    }

    earliestPostSubmitSnapshot ??= orderbook;
  }

  return latestPreSubmitSnapshot ?? earliestPostSubmitSnapshot;
}

function parseMarketCurrencies(market: MarketCode): MarketCurrencies {
  const separatorIndex = market.indexOf("-");
  if (separatorIndex <= 0 || separatorIndex === market.length - 1) {
    throw new Error(`Paper broker requires market codes in QUOTE-BASE format: ${market}`);
  }

  return {
    quoteCurrency: normalizeCurrency(market.slice(0, separatorIndex)),
    baseCurrency: normalizeCurrency(market.slice(separatorIndex + 1)),
  };
}

function createOrderbookKey(exchangeId: ExchangeId, market: MarketCode): string {
  return `${exchangeId}:${market}`;
}

function createSubmissionFingerprint(intent: OrderIntent): string {
  const commonFingerprint = {
    exchange_id: intent.exchangeId,
    market: intent.market,
    strategy_id: intent.strategyId,
    side: intent.side,
    order_type: intent.orderType,
    requested_quantity: normalizeDecimalString(intent.requestedQuantity),
    requested_notional: normalizeDecimalString(intent.requestedNotional),
    idempotency_key: intent.idempotencyKey,
  };

  if (intent.orderType === "LIMIT") {
    return JSON.stringify({
      ...commonFingerprint,
      requested_price: normalizeDecimalString(intent.requestedPrice),
      post_only: intent.postOnly === true,
      time_in_force: intent.timeInForce ?? "GTC",
    });
  }

  return JSON.stringify(commonFingerprint);
}

function calculateOpenQuoteLock(intent: OrderIntent, openQuantity: NumericString): NumericString {
  if (intent.orderType !== "LIMIT" || !isPositiveDecimalString(openQuantity)) {
    return "0";
  }

  return multiplyDecimalStrings(openQuantity, intent.requestedPrice);
}

function isAcceptedBrokerStatus(status: OrderLifecycleStatus): boolean {
  return status !== "REJECTED" && status !== "FAILED";
}

function isOpenBrokerOrder(order: BrokerOrder): boolean {
  return (
    (order.status === "SUBMITTED" || order.status === "ACCEPTED" || order.status === "PARTIALLY_FILLED") &&
    isPositiveDecimalString(order.remainingQuantity)
  );
}

function cloneBrokerOrder(order: BrokerOrder): BrokerOrder {
  const clonedOrder: BrokerOrder = { ...order };
  if (order.metadata !== undefined) {
    clonedOrder.metadata = { ...order.metadata };
  }

  return clonedOrder;
}

function cloneBrokerBalance(balance: BrokerBalance): BrokerBalance {
  const clonedBalance: BrokerBalance = { ...balance };
  if (balance.metadata !== undefined) {
    clonedBalance.metadata = { ...balance.metadata };
  }

  return clonedBalance;
}

function normalizeCurrency(currency: string): string {
  return currency.trim().toUpperCase();
}

function normalizeDecimalString(value: NumericString): NumericString {
  return parseFinancialDecimal(value).toFixed();
}

function addDecimalStrings(left: NumericString, right: NumericString): NumericString {
  return parseFinancialDecimal(left).add(parseFinancialDecimal(right)).toFixed();
}

function subtractDecimalStrings(left: NumericString, right: NumericString): NumericString {
  return parseFinancialDecimal(left).sub(parseFinancialDecimal(right)).toFixed();
}

function multiplyDecimalStrings(left: NumericString, right: NumericString): NumericString {
  return parseFinancialDecimal(left).mul(parseFinancialDecimal(right)).toFixed();
}

function negateDecimalString(value: NumericString): NumericString {
  return parseFinancialDecimal(value).negated().toFixed();
}

function absDecimalString(value: NumericString): NumericString {
  return parseFinancialDecimal(value).abs().toFixed();
}

function isPositiveDecimalString(value: NumericString): boolean {
  return parseFinancialDecimal(value).greaterThan(0);
}

function isNegativeDecimalString(value: NumericString): boolean {
  return parseFinancialDecimal(value).lessThan(0);
}

function isZeroDecimalString(value: NumericString): boolean {
  return parseFinancialDecimal(value).equals(0);
}

function readTimestampMillis(value: TimestampInput): number {
  return value instanceof Date ? value.getTime() : new Date(value).getTime();
}
