import type { BrokerPort } from "../../../application/ports/index.js";
import type {
  BrokerBalance,
  BrokerBalanceSnapshot,
  BrokerOrder,
  JsonRecord,
  MarketCode,
  OrderSubmission,
  TimeInForce,
} from "../../../domain/index.js";
import type { UpbitRateLimitStatus } from "../rate-limit.js";
import {
  UPBIT_PRIVATE_ORDER_IDENTIFIER_MAX_LENGTH,
  UnsafeUpbitPrivateRequestError,
  UpbitPrivateRestClientError,
} from "../private-client.js";
import type { UpbitPrivateCreateLimitOrderInput, UpbitPrivateRestResponse } from "../private-client.js";
import {
  toBrokerBalanceSnapshot,
  toBrokerOrderFromCommand,
  toBrokerOrderFromLookup,
  toBrokerOrdersFromOpenOrders,
} from "../private-mappers.js";
import type { MapUpbitPrivatePayloadOptions } from "../private-mappers.js";
import { UPBIT_KRW_SPOT_EXCHANGE_ID } from "../policy-mapper.js";
import { parseFinancialDecimal } from "../../../shared/index.js";
import type {
  UpbitLiveBrokerOperation,
  UpbitLiveBrokerOptions,
} from "./types.js";

const UPBIT_OPEN_ORDERS_PAGE_LIMIT = 100;

/**
 * Upbit private REST client를 `BrokerPort`로 노출하는 live broker 구현체다.
 *
 * 이 class는 runtime guard를 직접 판단하지 않는다. 생성자는 이미 owner-operated live broker guard와 credential 주입을 통과한
 * 호출 경계에서만 사용해야 하며, 각 method는 실제 Upbit private API side effect를 만들 수 있다. 입력 invariant는 거래소
 * 호출 전에 fail-closed 하고, 반환 metadata에는 raw provider payload 대신 operation과 rate-limit trace만 남긴다.
 */
export class UpbitLiveBroker implements BrokerPort {
  private readonly privateClient: UpbitLiveBrokerOptions["privateClient"];
  private readonly exchangeId: string;
  private readonly clock: NonNullable<UpbitLiveBrokerOptions["clock"]>;

  public constructor(options: UpbitLiveBrokerOptions) {
    this.privateClient = options.privateClient;
    this.exchangeId = options.exchangeId ?? UPBIT_KRW_SPOT_EXCHANGE_ID;
    this.clock = options.clock ?? (() => new Date().toISOString());
  }

  /**
   * LIMIT 주문 제출 요청을 Upbit `POST /v1/orders`로 전달한다.
   *
   * `OrderIntent.idempotencyKey`는 자동 변경 없이 Upbit `identifier`가 되며, 길이/주문 유형/가격 invariant가 깨지면 외부
   * 주문 side effect를 만들기 전에 `UnsafeUpbitPrivateRequestError`로 닫는다.
   */
  public async submitOrder(submission: OrderSubmission): Promise<BrokerOrder> {
    const input = toCreateLimitOrderInput(submission, this.exchangeId);

    let response: UpbitPrivateRestResponse<unknown>;
    try {
      // 주문 생성은 실계좌 side effect이므로 live broker 경계에서 마지막 invariant를 통과한 뒤에만 호출한다.
      response = await this.privateClient.createLimitOrder(input);
    } catch (error) {
      if (isDuplicateIdentifierError(error)) {
        // 이전 생성 성공 후 응답만 잃은 재시도일 수 있으므로 새 주문 대신 identifier 조회로 기존 주문을 회수한다.
        const lookupResponse = await this.privateClient.getOrder({ identifier: input.identifier });
        const recoveredOrder = toBrokerOrderFromLookup(lookupResponse.payload, this.createMapperOptions());

        // 같은 identifier라도 stale intent 재사용이면 다른 주문을 현재 제출 성공처럼 처리할 수 있어 회수 결과를 대조한다.
        assertRecoveredOrderMatchesSubmission(recoveredOrder, submission);

        return this.withOrderMetadata(recoveredOrder, lookupResponse, "submitOrder", {
          upbitLiveBrokerRecovery: "duplicate_identifier_lookup",
        });
      }
      throw error;
    }
    const brokerOrder = toBrokerOrderFromCommand(response.payload, this.createMapperOptions());

    return this.withOrderMetadata(brokerOrder, response, "submitOrder");
  }

  /**
   * Upbit 주문 UUID 기준으로 주문 취소를 요청한다.
   *
   * `BrokerPort`의 orderId는 이 구현에서 Upbit uuid로 해석한다. identifier 기반 취소는 future reconcile 설계에서 별도
   * contract로 열기 전까지 지원하지 않는다.
   */
  public async cancelOrder(orderId: string): Promise<BrokerOrder> {
    assertRequiredOrderId(orderId, "주문 취소");

    // 취소는 실계좌 상태를 바꾸므로 빈 식별자를 거래소에 보내지 않고 uuid 경계로만 제한한다.
    const response = await this.privateClient.cancelOrder({ uuid: orderId });
    const brokerOrder = toBrokerOrderFromCommand(response.payload, this.createMapperOptions());

    return this.withOrderMetadata(brokerOrder, response, "cancelOrder");
  }

  /**
   * Upbit 주문 UUID 기준으로 단일 주문 상태를 조회한다.
   *
   * 조회 실패 중 404는 `BrokerPort.getOrder` contract에 맞춰 `undefined`로 정규화하고, 인증/권한/rate-limit 오류는 그대로
   * 전파해 호출자가 smoke를 fail-closed 할 수 있게 한다.
   */
  public async getOrder(orderId: string): Promise<BrokerOrder | undefined> {
    assertRequiredOrderId(orderId, "주문 조회");

    let response: UpbitPrivateRestResponse<unknown>;
    try {
      response = await this.privateClient.getOrder({ uuid: orderId });
    } catch (error) {
      if (isOrderNotFoundError(error)) {
        // 없는 주문은 복구 가능한 조회 결과라서 추가 private 호출 없이 port의 optional 반환으로 맞춘다.
        return undefined;
      }
      throw error;
    }
    const brokerOrder = toBrokerOrderFromLookup(response.payload, this.createMapperOptions());

    return this.withOrderMetadata(brokerOrder, response, "getOrder");
  }

  /**
   * Upbit 미체결 주문 목록을 조회해 `BrokerOrder` 목록으로 정규화한다.
   *
   * private client wrapper의 기본 `wait`/`watch` 상태 조회를 사용하며, market이 주어지면 해당 market으로만 제한한다.
   */
  public async listOpenOrders(market?: MarketCode): Promise<readonly BrokerOrder[]> {
    const orders: BrokerOrder[] = [];
    let page = 1;

    while (true) {
      const response = await this.privateClient.listOpenOrders(
        market === undefined
          ? { page, limit: UPBIT_OPEN_ORDERS_PAGE_LIMIT, orderBy: "asc" }
          : { market, page, limit: UPBIT_OPEN_ORDERS_PAGE_LIMIT, orderBy: "asc" },
      );
      const pageOrders = toBrokerOrdersFromOpenOrders(response.payload, this.createMapperOptions());

      orders.push(...pageOrders.map((order) => this.withOrderMetadata(order, response, "listOpenOrders")));
      if (pageOrders.length < UPBIT_OPEN_ORDERS_PAGE_LIMIT) {
        break;
      }

      // limit과 같은 개수가 오면 뒤 페이지가 있을 수 있으므로 누락을 피하기 위해 다음 page를 계속 조회한다.
      page += 1;
    }

    return orders;
  }

  /**
   * Upbit 계정 잔고를 broker balance snapshot으로 조회한다.
   *
   * 잔고 payload는 주문 한도/리스크 검증의 입력이 되므로 capturedAt과 rate-limit trace를 함께 남기되 raw provider row는
   * live broker 반환 metadata에서 제거한다.
   */
  public async getBalances(): Promise<BrokerBalanceSnapshot> {
    const response = await this.privateClient.getAccounts();
    const snapshot = toBrokerBalanceSnapshot(response.payload, this.createMapperOptions());

    return {
      ...snapshot,
      balances: snapshot.balances.map((balance) => this.withBalanceMetadata(balance)),
      metadata: withLiveBrokerMetadata(snapshot.metadata, response.rateLimitStatus, "getBalances"),
    };
  }

  private createMapperOptions(): MapUpbitPrivatePayloadOptions {
    return {
      exchangeId: this.exchangeId,
      capturedAt: this.clock(),
    };
  }

  private withOrderMetadata(
    order: BrokerOrder,
    response: UpbitPrivateRestResponse<unknown>,
    operation: UpbitLiveBrokerOperation,
    extraMetadata: JsonRecord = {},
  ): BrokerOrder {
    return {
      ...order,
      metadata: withLiveBrokerMetadata(order.metadata, response.rateLimitStatus, operation, extraMetadata),
    };
  }

  private withBalanceMetadata(balance: BrokerBalance): BrokerBalance {
    return {
      ...balance,
      metadata: withoutRawPayload(balance.metadata),
    };
  }
}

/**
 * UpbitLiveBroker를 생성한다.
 *
 * 이 factory는 guard 판단을 하지 않는 얇은 생성 helper다. runtime guard와 credential evidence는 caller가 먼저 통과시켜야 하며,
 * 반환된 broker는 호출 즉시 private API side effect를 만들 수 있다.
 */
export function createUpbitLiveBroker(options: UpbitLiveBrokerOptions): UpbitLiveBroker {
  return new UpbitLiveBroker(options);
}

function toCreateLimitOrderInput(
  submission: OrderSubmission,
  expectedExchangeId: string,
): UpbitPrivateCreateLimitOrderInput {
  const violations: string[] = [];
  const intent = submission.intent;
  const requestedPrice = intent.orderType === "LIMIT" ? intent.requestedPrice : "";
  const timeInForce = intent.orderType === "LIMIT" ? intent.timeInForce : undefined;
  const postOnly = intent.orderType === "LIMIT" ? intent.postOnly : undefined;
  const privateSide = toPrivateOrderSide(intent.side, violations);

  if (intent.exchangeId !== expectedExchangeId) {
    // 승인 증거의 거래소와 실제 broker가 다르면 다른 계정/거래소 주문 side effect로 이어질 수 있어 즉시 차단한다.
    violations.push("Upbit live broker 주문 exchangeId가 broker exchangeId와 일치해야 합니다");
  }
  if (intent.orderType !== "LIMIT") {
    violations.push("Upbit live broker는 LIMIT 주문만 제출할 수 있습니다");
  }
  if (intent.idempotencyKey.trim().length === 0) {
    violations.push("Upbit live broker identifier는 비어 있을 수 없습니다");
  }
  if (intent.idempotencyKey.length > UPBIT_PRIVATE_ORDER_IDENTIFIER_MAX_LENGTH) {
    // identifier를 자동 축약하면 중복 주문 충돌을 숨길 수 있으므로 거래소 호출 전에 닫는다.
    violations.push(`Upbit live broker identifier는 ${UPBIT_PRIVATE_ORDER_IDENTIFIER_MAX_LENGTH}자 이하여야 합니다`);
  }
  if (intent.orderType === "LIMIT") {
    if (requestedPrice.trim().length === 0) {
      violations.push("Upbit live broker LIMIT 주문에는 requestedPrice가 필요합니다");
    } else {
      validatePositiveDecimalString(requestedPrice, "Upbit live broker LIMIT 주문 가격", violations);
    }
  }
  if (postOnly === true && (timeInForce === "IOC" || timeInForce === "FOK")) {
    // post-only와 IOC/FOK는 체결 조건이 상충하므로 우선순위로 덮어쓰지 않고 증거 불일치를 차단한다.
    violations.push("Upbit live broker postOnly 주문은 IOC/FOK timeInForce와 함께 사용할 수 없습니다");
  }
  if (intent.requestedQuantity.trim().length === 0) {
    violations.push("Upbit live broker 주문 수량이 필요합니다");
  } else {
    validatePositiveDecimalString(intent.requestedQuantity, "Upbit live broker 주문 수량", violations);
  }

  if (violations.length > 0 || privateSide === undefined) {
    throw new UnsafeUpbitPrivateRequestError({ violations });
  }

  const privateTimeInForce = toPrivateTimeInForce(timeInForce, postOnly);

  return {
    market: intent.market,
    side: privateSide,
    volume: intent.requestedQuantity,
    price: requestedPrice,
    identifier: intent.idempotencyKey,
    ...(privateTimeInForce === undefined ? {} : { timeInForce: privateTimeInForce }),
  };
}

/**
 * broker 제출 직전 주문 방향을 Upbit private API 방향으로 변환한다.
 *
 * 타입 경계 밖 JSON이 들어와도 BUY/SELL 외 값은 매도 주문으로 fallback하지 않고 violations에 보존한다. 외부 side effect는
 * caller가 violations를 확인한 뒤에만 만들 수 있다.
 */
function toPrivateOrderSide(
  side: unknown,
  violations: string[],
): UpbitPrivateCreateLimitOrderInput["side"] | undefined {
  if (side === "BUY") {
    return "bid";
  }

  if (side === "SELL") {
    return "ask";
  }

  // 런타임 역직렬화 경계에서 타입이 깨지면 반대 방향 실주문으로 이어질 수 있어 fallback하지 않는다.
  violations.push("Upbit live broker 주문 방향은 BUY 또는 SELL이어야 합니다");

  return undefined;
}

/**
 * 거래소 호출 전에 가격/수량 문자열이 양수 decimal인지 검증한다.
 *
 * `parseFinancialDecimal`의 provider 비의존 검증을 재사용하되, broker 경계에서는 사용자 행동 언어의 violation으로 정규화한다.
 */
function validatePositiveDecimalString(value: string, label: string, violations: string[]): void {
  try {
    if (parseFinancialDecimal(value).greaterThan(0)) {
      return;
    }
  } catch {
    violations.push(`${label}은 0보다 큰 decimal 문자열이어야 합니다`);

    return;
  }

  violations.push(`${label}은 0보다 큰 decimal 문자열이어야 합니다`);
}

/**
 * 중복 identifier 복구 조회 결과가 현재 제출 intent와 같은 주문인지 확인한다.
 *
 * 입력 identifier가 stale retry나 운영자 실수로 재사용되면 live broker가 다른 주문을 현재 주문 성공으로 기록할 수 있으므로,
 * 주문의 핵심 fingerprint가 모두 일치할 때만 복구 결과를 반환한다.
 */
function assertRecoveredOrderMatchesSubmission(order: BrokerOrder, submission: OrderSubmission): void {
  const intent = submission.intent;
  const violations: string[] = [];

  if (intent.orderType !== "LIMIT" || order.orderType !== "LIMIT") {
    violations.push("Upbit live broker duplicate identifier 조회 결과는 LIMIT 주문이어야 합니다");
  }
  if (order.exchangeId !== intent.exchangeId) {
    violations.push("Upbit live broker duplicate identifier 조회 결과의 exchangeId가 현재 주문과 일치해야 합니다");
  }
  if (order.market !== intent.market) {
    violations.push("Upbit live broker duplicate identifier 조회 결과의 market이 현재 주문과 일치해야 합니다");
  }
  if (order.side !== intent.side) {
    violations.push("Upbit live broker duplicate identifier 조회 결과의 주문 방향이 현재 주문과 일치해야 합니다");
  }
  if (order.idempotencyKey !== intent.idempotencyKey) {
    violations.push("Upbit live broker duplicate identifier 조회 결과의 identifier가 현재 주문과 일치해야 합니다");
  }
  if (!areSameDecimalStrings(order.requestedQuantity, intent.requestedQuantity)) {
    violations.push("Upbit live broker duplicate identifier 조회 결과의 수량이 현재 주문과 일치해야 합니다");
  }
  if (
    intent.orderType !== "LIMIT" ||
    order.requestedPrice === undefined ||
    !areSameDecimalStrings(order.requestedPrice, intent.requestedPrice)
  ) {
    violations.push("Upbit live broker duplicate identifier 조회 결과의 가격이 현재 주문과 일치해야 합니다");
  }

  if (violations.length > 0) {
    throw new UnsafeUpbitPrivateRequestError({ violations });
  }
}

/**
 * decimal 표현 차이만 있는 주문 fingerprint를 같은 값으로 비교한다.
 *
 * 비교 중 파싱 오류가 나면 복구 경계에서는 일치 실패로 다뤄 stale identifier 사용을 차단한다.
 */
function areSameDecimalStrings(left: string, right: string): boolean {
  try {
    return parseFinancialDecimal(left).equals(parseFinancialDecimal(right));
  } catch {
    return false;
  }
}

function toPrivateTimeInForce(
  timeInForce: TimeInForce | undefined,
  postOnly: boolean | undefined,
): UpbitPrivateCreateLimitOrderInput["timeInForce"] | undefined {
  if (postOnly === true || timeInForce === "POST_ONLY") {
    return "post_only";
  }

  if (timeInForce === "IOC") {
    return "ioc";
  }

  if (timeInForce === "FOK") {
    return "fok";
  }

  return undefined;
}

function assertRequiredOrderId(orderId: string, operationLabel: string): void {
  if (typeof orderId !== "string" || orderId.trim().length === 0) {
    throw new UnsafeUpbitPrivateRequestError({
      violations: [`${operationLabel}에는 brokerOrderId가 필요합니다`],
    });
  }
}

function isOrderNotFoundError(error: unknown): boolean {
  if (!(error instanceof UpbitPrivateRestClientError) || error.trace.httpStatus !== 404) {
    return false;
  }

  return isKnownOrderNotFoundErrorName(error.trace.upbitErrorName);
}

function isDuplicateIdentifierError(error: unknown): boolean {
  if (!(error instanceof UpbitPrivateRestClientError)) {
    return false;
  }

  return isKnownDuplicateIdentifierErrorName(error.trace.upbitErrorName);
}

function isKnownOrderNotFoundErrorName(upbitErrorName: string | undefined): boolean {
  return upbitErrorName === "order_not_found" || upbitErrorName === "not_found_order";
}

function isKnownDuplicateIdentifierErrorName(upbitErrorName: string | undefined): boolean {
  return (
    upbitErrorName === "duplicate_identifier" ||
    upbitErrorName === "identifier_already_used" ||
    upbitErrorName === "used_identifier"
  );
}

function withLiveBrokerMetadata(
  metadata: JsonRecord | undefined,
  rateLimitStatus: UpbitRateLimitStatus,
  operation: UpbitLiveBrokerOperation,
  extraMetadata: JsonRecord = {},
): JsonRecord {
  return {
    ...withoutRawPayload(metadata),
    ...extraMetadata,
    upbitLiveBrokerOperation: operation,
    rateLimitStatus,
  };
}

function withoutRawPayload(metadata: JsonRecord | undefined): JsonRecord {
  const { raw: _raw, ...safeMetadata } = metadata ?? {};

  return safeMetadata;
}
