import { z } from "zod";
import type {
  BrokerBalanceSnapshot,
  BrokerOrder,
  FeePolicy,
  JsonRecord,
  NumericString,
  OrderChancePolicy,
  OrderLifecycleStatus,
  OrderSide,
  OrderType,
  TimeInForce,
} from "../../../domain/index.js";
import { parseFinancialDecimal } from "../../../shared/index.js";
import {
  UnsafeUpbitPrivateRequestError,
  UpbitPrivateRestClientError,
} from "../private-client.js";
import { UPBIT_KRW_SPOT_EXCHANGE_ID } from "../policy-mapper.js";
import {
  UpbitPrivateAccountsResponseSchema,
  UpbitPrivateClosedOrdersResponseSchema,
  UpbitPrivateOpenOrdersResponseSchema,
  UpbitPrivateOrderChanceResponseSchema,
  UpbitPrivateOrderCommandResponseSchema,
  UpbitPrivateOrderLookupResponseSchema,
} from "./schemas.js";
import type {
  UpbitPrivateClosedOrderResponse,
  UpbitPrivateOpenOrderResponse,
  UpbitPrivateOrderCommandResponse,
  UpbitPrivateOrderChancePayload,
  UpbitPrivateOrderLookupResponse,
} from "./schemas.js";
import type {
  CreateUpbitPrivateErrorSummaryOptions,
  MapUpbitPrivatePayloadOptions,
  UpbitPrivateErrorSummaryTrace,
  UpbitPrivatePayloadMappingErrorOptions,
  UpbitPrivatePayloadSchemaName,
  UpbitPrivateUserActionErrorSummary,
} from "./types.js";

interface DomainOrderMapping {
  orderType: OrderType;
  requestedQuantity: NumericString;
  requestedPrice?: NumericString;
}

type UpbitPrivateOrderSummaryPayload =
  | UpbitPrivateOrderLookupResponse
  | UpbitPrivateOrderCommandResponse
  | UpbitPrivateOpenOrderResponse
  | UpbitPrivateClosedOrderResponse;

/**
 * Upbit private payload mapping 실패 오류다.
 *
 * 계정/주문 payload는 민감한 잔고와 주문 세부값을 포함할 수 있으므로 raw provider payload를 보존하지 않는다. 상위 runner는
 * `schema`, `issuePaths`, `userMessage`만 사용해 smoke를 fail-closed 하고 수동 확인 evidence를 만든다.
 */
export class UpbitPrivatePayloadMappingError extends Error {
  public readonly schema: UpbitPrivatePayloadSchemaName;
  public readonly userMessage: string;
  public readonly issuePaths: readonly string[];

  public constructor(options: UpbitPrivatePayloadMappingErrorOptions) {
    super(`Upbit private payload mapping failed: ${options.schema}`);
    this.name = "UpbitPrivatePayloadMappingError";
    this.schema = options.schema;
    this.userMessage = options.userMessage;
    this.issuePaths = options.issuePaths;
  }
}

/**
 * Upbit 계정 잔고 응답을 broker balance snapshot으로 변환한다.
 *
 * 이 mapper는 `/v1/accounts` raw payload를 검증한 뒤 RiskGate와 future live broker가 공유하는 잔고 contract로 정규화한다.
 * 입력/출력 모두 외부 side effect가 없으며, raw credential이나 Authorization header를 보존하지 않는 invariant를 유지한다.
 */
export function toBrokerBalanceSnapshot(
  payload: unknown,
  options: MapUpbitPrivatePayloadOptions,
): BrokerBalanceSnapshot {
  const accounts = parsePrivatePayload(UpbitPrivateAccountsResponseSchema, "ACCOUNTS", payload);
  const capturedAt = options.capturedAt;

  return {
    exchangeId: options.exchangeId ?? UPBIT_KRW_SPOT_EXCHANGE_ID,
    balances: accounts.map((account) => {
      const available = normalizeDecimalString(account.balance);
      const locked = normalizeDecimalString(account.locked);

      return {
        currency: normalizeCurrency(account.currency),
        available,
        locked,
        total: addDecimalStrings(available, locked),
        updatedAt: capturedAt,
        metadata: {
          source: "upbit_private_accounts",
          upbitAvgBuyPrice: normalizeDecimalString(account.avg_buy_price),
          upbitAvgBuyPriceModified: account.avg_buy_price_modified,
          upbitUnitCurrency: normalizeCurrency(account.unit_currency),
          raw: account as JsonRecord,
        },
      };
    }),
    capturedAt,
    metadata: {
      source: "upbit_private_accounts",
    },
  };
}

/**
 * Upbit 주문 가능 정보 응답을 계정 조건이 반영된 주문 가능 정책으로 변환한다.
 *
 * 수수료율은 decimal rate에서 bps로 변환하고, 주문 가능 유형은 deprecated `order_types` 대신 `bid_types`/`ask_types`를
 * 우선한다. 이 함수는 provider payload 검증과 정규화만 수행하며 외부 API 호출 side effect를 만들지 않는다.
 */
export function toOrderChancePolicy(
  payload: unknown,
  options: MapUpbitPrivatePayloadOptions,
): OrderChancePolicy {
  const orderChance = parseOrderChancePayload(payload);

  return {
    exchangeId: options.exchangeId ?? UPBIT_KRW_SPOT_EXCHANGE_ID,
    market: orderChance.market.id,
    allowedOrderTypes: toAllowedOrderTypes(orderChance),
    bidFeeBps: toFeeBps(orderChance.bid_fee),
    askFeeBps: toFeeBps(orderChance.ask_fee),
    makerBidFeeBps: toFeeBps(orderChance.maker_bid_fee),
    makerAskFeeBps: toFeeBps(orderChance.maker_ask_fee),
    bidAvailableBalance: normalizeDecimalString(orderChance.bid_account.balance),
    askAvailableBalance: normalizeDecimalString(orderChance.ask_account.balance),
    minimumBidNotional: normalizeDecimalString(orderChance.market.bid.min_total),
    maximumBidNotional: normalizeDecimalString(orderChance.market.max_total),
    capturedAt: options.capturedAt,
    raw: orderChance as JsonRecord,
  };
}

/**
 * Upbit 주문 가능 정보 응답에서 비용 계산용 수수료 정책만 추출한다.
 *
 * CostModel은 수수료를 bps 단위로 소비하므로 Upbit의 decimal rate 문자열을 정밀도 손실 없이 변환한다. 함수는 mapper 전용
 * 순수 변환이며 외부 side effect를 만들지 않는다.
 */
export function toFeePolicyFromOrderChance(
  payload: unknown,
  options: MapUpbitPrivatePayloadOptions,
): FeePolicy {
  const orderChance = parseOrderChancePayload(payload);

  return {
    exchangeId: options.exchangeId ?? UPBIT_KRW_SPOT_EXCHANGE_ID,
    market: orderChance.market.id,
    bidFeeBps: toFeeBps(orderChance.bid_fee),
    askFeeBps: toFeeBps(orderChance.ask_fee),
    makerBidFeeBps: toFeeBps(orderChance.maker_bid_fee),
    makerAskFeeBps: toFeeBps(orderChance.maker_ask_fee),
    updatedAt: options.capturedAt,
  };
}

/**
 * Upbit 개별 주문 조회 응답을 broker order contract로 변환한다.
 *
 * 주문 생성/취소가 아니라 read-only lookup 결과만 정규화한다. Upbit 고유 주문 유형, time_in_force, SMP, 체결 요약은
 * `metadata`에 보존하고, domain이 이해하는 주문 방향/상태/수량은 top-level 필드로 제공한다.
 */
export function toBrokerOrderFromLookup(
  payload: unknown,
  options: MapUpbitPrivatePayloadOptions,
): BrokerOrder {
  const order = parsePrivatePayload(UpbitPrivateOrderLookupResponseSchema, "ORDER_LOOKUP", payload);
  const brokerOrder = toBrokerOrderFromPrivateOrder(order, options, "upbit_private_order_lookup");

  return {
    ...brokerOrder,
    metadata: toOrderLookupMetadata(order, normalizeDecimalString(order.executed_volume)),
  };
}

/**
 * Upbit 주문 생성/취소 응답을 broker order contract로 변환한다.
 *
 * command 응답은 실제 주문 생성/취소 side effect 직후의 provider payload이므로, 반환값에는 상태와 추적용 요약만 남기고
 * raw payload를 metadata에 보존하지 않는다. 이 함수는 이미 받은 payload 정규화만 수행하며 외부 API를 호출하지 않는다.
 */
export function toBrokerOrderFromCommand(
  payload: unknown,
  options: MapUpbitPrivatePayloadOptions,
): BrokerOrder {
  const order = parsePrivatePayload(UpbitPrivateOrderCommandResponseSchema, "ORDER_COMMAND", payload);

  return toBrokerOrderFromPrivateOrder(order, options, "upbit_private_order_command");
}

/**
 * Upbit 종료 주문 목록 응답을 broker order 목록으로 변환한다.
 *
 * closed order 목록은 M16 read-only reconcile의 조회 결과이며, raw provider payload를 strategy나 runtime으로 직접
 * 넘기지 않고 `BrokerOrder` contract로 정규화한다. raw provider payload는 metadata에 보존하지 않는다.
 * 입력/출력 모두 외부 side effect가 없다.
 */
export function toBrokerOrdersFromClosedOrders(
  payload: unknown,
  options: MapUpbitPrivatePayloadOptions,
): readonly BrokerOrder[] {
  const orders = parsePrivatePayload(UpbitPrivateClosedOrdersResponseSchema, "CLOSED_ORDERS", payload);

  return orders.flatMap((order) => {
    // closed snapshot은 일부 unsupported row가 있어도 나머지 주문 evidence를 잃지 않아야 하므로 표현 가능한 row만 정규화한다.
    if (!canMapClosedOrderToBrokerOrder(order)) {
      return [];
    }

    return [toBrokerOrderFromPrivateOrder(order, options, "upbit_private_closed_order")];
  });
}

/**
 * Upbit 체결 대기 주문 목록 응답을 broker order 목록으로 변환한다.
 *
 * open order 목록은 M15 live broker의 `listOpenOrders` 조회 결과이며, raw provider payload를 strategy나 runtime으로 직접
 * 넘기지 않고 `BrokerOrder` contract로 정규화한다. 입력/출력 모두 외부 side effect가 없다.
 */
export function toBrokerOrdersFromOpenOrders(
  payload: unknown,
  options: MapUpbitPrivatePayloadOptions,
): readonly BrokerOrder[] {
  const orders = parsePrivatePayload(UpbitPrivateOpenOrdersResponseSchema, "OPEN_ORDERS", payload);

  return orders.map((order) => toBrokerOrderFromPrivateOrder(order, options, "upbit_private_open_order"));
}

/**
 * Upbit private 오류를 사용자 행동 언어와 추적 정보로 분리한다.
 *
 * client 오류, 로컬 invariant 오류, payload mapper 오류를 같은 safe summary contract로 맞춰 `/status`, CLI, audit evidence가
 * raw provider body 없이도 운영자 조치를 안내할 수 있게 한다.
 */
export function toUpbitPrivateUserActionErrorSummary(
  error: unknown,
  options: CreateUpbitPrivateErrorSummaryOptions = {},
): UpbitPrivateUserActionErrorSummary {
  if (error instanceof UpbitPrivateRestClientError) {
    return summarizeRestClientError(error, options);
  }

  if (error instanceof UnsafeUpbitPrivateRequestError) {
    return {
      title: "거래소 호출 전에 요청을 중단했습니다.",
      message: "Upbit private 요청 입력이 안전 조건을 만족하지 않아 외부 호출을 만들지 않았습니다.",
      requiredAction: "추적 정보의 위반 항목을 수정한 뒤 같은 smoke를 처음부터 다시 실행하세요.",
      trace: withCorrelationId(
        {
          kind: "UNSAFE_REQUEST",
          violations: error.violations,
        },
        options,
      ),
    };
  }

  if (error instanceof UpbitPrivatePayloadMappingError) {
    return {
      title: "Upbit 응답 형식을 확인해야 합니다.",
      message: error.userMessage,
      requiredAction: "원문 응답을 저장하지 말고 공식 문서와 mapper schema를 확인한 뒤 수동 검토로 전환하세요.",
      trace: withCorrelationId(
        {
          kind: "PAYLOAD_MAPPING_FAILED",
          payloadSchema: error.schema,
          payloadIssuePaths: error.issuePaths,
        },
        options,
      ),
    };
  }

  return {
    title: "수동 확인이 필요합니다.",
    message: "분류되지 않은 Upbit private 처리 실패가 발생해 추가 요청을 중단했습니다.",
    requiredAction: "correlation id 기준으로 로컬 로그를 확인하고, secret 원문 없이 실패 조건을 재현하세요.",
    trace: withCorrelationId(
      {
        kind: "UNKNOWN",
      },
      options,
    ),
  };
}

function parseOrderChancePayload(payload: unknown): UpbitPrivateOrderChancePayload {
  return parsePrivatePayload(UpbitPrivateOrderChanceResponseSchema, "ORDER_CHANCE", payload);
}

function parsePrivatePayload<TPayload>(
  schema: z.ZodType<TPayload, z.ZodTypeDef, unknown>,
  schemaName: UpbitPrivatePayloadSchemaName,
  payload: unknown,
): TPayload {
  try {
    return schema.parse(payload);
  } catch (error) {
    if (error instanceof z.ZodError) {
      // provider payload에는 계정/주문 세부값이 들어가므로 raw 값 대신 실패 path만 남기고 smoke를 닫는다.
      throw new UpbitPrivatePayloadMappingError({
        schema: schemaName,
        userMessage: "Upbit private 응답이 예상 schema와 달라 후속 정책/주문 증거로 사용할 수 없습니다.",
        issuePaths: error.issues.map((issue) => formatIssuePath(issue.path)),
      });
    }

    throw error;
  }
}

function toAllowedOrderTypes(orderChance: UpbitPrivateOrderChancePayload): readonly ("LIMIT" | "MARKET")[] {
  const wireOrderTypes = new Set<string>([
    ...orderChance.market.bid_types,
    ...orderChance.market.ask_types,
    ...(orderChance.market.order_types ?? []),
  ]);
  const allowedOrderTypes: ("LIMIT" | "MARKET")[] = [];

  if ([...wireOrderTypes].some((orderType) => orderType.startsWith("limit"))) {
    allowedOrderTypes.push("LIMIT");
  }

  if ([...wireOrderTypes].some((orderType) => orderType === "price" || orderType === "market")) {
    allowedOrderTypes.push("MARKET");
  }

  return allowedOrderTypes;
}

function toDomainOrderSide(side: UpbitPrivateOrderSummaryPayload["side"]): OrderSide {
  return side === "bid" ? "BUY" : "SELL";
}

function toDomainOrderMapping(
  order: UpbitPrivateOrderSummaryPayload,
  executedVolume: NumericString,
  remainingQuantity: NumericString,
): DomainOrderMapping {
  if (order.ord_type === "best") {
    // 최유리 주문은 domain 주문 유형에 정확한 표현이 없어 잘못된 시장가 evidence로 남기지 않는다.
    throw createUnsupportedOrderLookupMappingError(
      "Upbit 최유리 주문은 현재 broker order contract로 안전하게 표현할 수 없어 수동 확인이 필요합니다.",
      ["ord_type"],
    );
  }

  if (order.ord_type === "price") {
    // 시장가 매수는 quote 주문금액이 핵심 입력이라 base 수량 필드에 대체 저장하면 감사 근거가 틀어진다.
    throw createUnsupportedOrderLookupMappingError(
      "Upbit 시장가 매수 주문금액은 broker order의 요청 수량으로 안전하게 표현할 수 없어 수동 확인이 필요합니다.",
      ["ord_type", "price"],
    );
  }

  if (order.ord_type === "market" && order.volume === null) {
    // 시장가 매도에서 원 요청 수량이 없으면 체결 수량을 요청 수량으로 둔갑시키지 않고 lookup을 닫는다.
    throw createUnsupportedOrderLookupMappingError(
      "Upbit 시장가 매도 주문의 원 요청 수량이 없어 broker order contract로 안전하게 표현할 수 없습니다.",
      ["volume"],
    );
  }

  const requestedQuantity = normalizeDecimalString(
    order.volume ?? addDecimalStrings(executedVolume, remainingQuantity),
  );

  if (order.ord_type === "limit") {
    const requestedPrice = order.price;
    if (requestedPrice === null || requestedPrice === undefined) {
      // 지정가 주문은 요청 가격이 감사 핵심값이므로 누락된 응답을 정상 주문 evidence로 사용하지 않는다.
      throw createUnsupportedOrderLookupMappingError(
        "Upbit 지정가 주문 조회 응답에 요청 가격이 없어 broker order contract로 안전하게 표현할 수 없습니다.",
        ["price"],
      );
    }

    return {
      orderType: "LIMIT",
      requestedQuantity,
      requestedPrice: normalizeDecimalString(requestedPrice),
    };
  }

  return {
    orderType: "MARKET",
    requestedQuantity,
  };
}

function toDomainOrderStatus(
  order: UpbitPrivateOrderSummaryPayload,
  executedVolume: NumericString,
): OrderLifecycleStatus {
  if (order.state === "done") {
    return "FILLED";
  }

  if (order.state === "cancel") {
    return "CANCELED";
  }

  if (isPositiveDecimalString(executedVolume)) {
    return "PARTIALLY_FILLED";
  }

  return "ACCEPTED";
}

/**
 * closed order row를 현재 broker order contract로 표현할 수 있는지 판정한다.
 *
 * 이 helper는 M16 REST snapshot에서 지원 불가 주문 한 건이 전체 window 정규화를 깨뜨리지 않게 하는 mapper 내부 경계다.
 * 입력은 schema를 통과한 closed order row이고, 출력은 정규화 가능 여부다. 외부 side effect는 없으며, false row는 후속
 * reconcile 단계에서 manual-review evidence 대상으로 남겨야 한다.
 */
function canMapClosedOrderToBrokerOrder(order: UpbitPrivateClosedOrderResponse): boolean {
  if (order.ord_type === "best" || order.ord_type === "price") {
    return false;
  }

  if (order.ord_type === "market" && order.volume === null) {
    return false;
  }

  if (order.ord_type === "limit" && (order.price === null || order.price === undefined)) {
    return false;
  }

  return true;
}

function toBrokerOrderFromPrivateOrder(
  order: UpbitPrivateOrderSummaryPayload,
  options: MapUpbitPrivatePayloadOptions,
  source: "upbit_private_order_lookup" | "upbit_private_order_command" | "upbit_private_open_order" | "upbit_private_closed_order",
): BrokerOrder {
  const executedVolume = normalizeDecimalString(order.executed_volume);
  const remainingQuantity = normalizeDecimalString(order.remaining_volume ?? "0");
  const domainOrder = toDomainOrderMapping(order, executedVolume, remainingQuantity);
  // open order 목록은 status/audit에 반복 노출되므로 raw provider payload를 safe 요약 metadata에서 제외한다.
  const includeRawPayload = source === "upbit_private_order_lookup";

  return {
    brokerOrderId: order.uuid,
    idempotencyKey: order.identifier ?? order.uuid,
    exchangeId: options.exchangeId ?? UPBIT_KRW_SPOT_EXCHANGE_ID,
    market: order.market,
    side: toDomainOrderSide(order.side),
    orderType: domainOrder.orderType,
    status: toDomainOrderStatus(order, executedVolume),
    requestedQuantity: domainOrder.requestedQuantity,
    remainingQuantity,
    ...(domainOrder.requestedPrice === undefined ? {} : { requestedPrice: domainOrder.requestedPrice }),
    acceptedAt: order.created_at,
    updatedAt: options.capturedAt,
    metadata: toOrderMetadata(order, source, executedVolume, includeRawPayload),
  };
}

function toOrderLookupMetadata(
  order: UpbitPrivateOrderLookupResponse,
  executedVolume: NumericString,
): JsonRecord {
  return {
    ...toOrderMetadata(order, "upbit_private_order_lookup", executedVolume, true),
    trades: order.trades.map((trade) => ({
      uuid: trade.uuid,
      market: trade.market,
      price: normalizeDecimalString(trade.price),
      volume: normalizeDecimalString(trade.volume),
      funds: normalizeDecimalString(trade.funds),
      ...(trade.trend === undefined ? {} : { trend: trade.trend }),
      createdAt: trade.created_at,
      side: trade.side,
    })),
  };
}

function toOrderMetadata(
  order: UpbitPrivateOrderSummaryPayload,
  source: "upbit_private_order_lookup" | "upbit_private_order_command" | "upbit_private_open_order" | "upbit_private_closed_order",
  executedVolume: NumericString,
  includeRawPayload: boolean,
): JsonRecord {
  const executedFunds =
    "executed_funds" in order && typeof order.executed_funds === "string" ? order.executed_funds : undefined;

  return {
    source,
    upbitUuid: order.uuid,
    ...(order.identifier === undefined ? {} : { upbitIdentifier: order.identifier }),
    upbitSide: order.side,
    upbitOrderType: order.ord_type,
    upbitState: order.state,
    ...(order.time_in_force === undefined ? {} : { upbitTimeInForce: toDomainTimeInForce(order.time_in_force) }),
    ...(order.smp_type === undefined ? {} : { upbitSmpType: order.smp_type }),
    executedVolume,
    reservedFee: normalizeDecimalString(order.reserved_fee),
    remainingFee: normalizeDecimalString(order.remaining_fee),
    paidFee: normalizeDecimalString(order.paid_fee),
    locked: normalizeDecimalString(order.locked),
    ...(order.prevented_volume === undefined ? {} : { preventedVolume: normalizeDecimalString(order.prevented_volume) }),
    ...(order.prevented_locked === undefined ? {} : { preventedLocked: normalizeDecimalString(order.prevented_locked) }),
    ...(executedFunds === undefined ? {} : { executedFunds: normalizeDecimalString(executedFunds) }),
    ...(order.trades_count === undefined ? {} : { tradesCount: order.trades_count }),
    ...(includeRawPayload ? { raw: order as JsonRecord } : {}),
  };
}

function toDomainTimeInForce(timeInForce: UpbitPrivateOrderLookupResponse["time_in_force"]): TimeInForce | undefined {
  if (timeInForce === "post_only") {
    return "POST_ONLY";
  }

  if (timeInForce === "ioc") {
    return "IOC";
  }

  if (timeInForce === "fok") {
    return "FOK";
  }

  return undefined;
}

function createUnsupportedOrderLookupMappingError(
  userMessage: string,
  issuePaths: readonly string[],
): UpbitPrivatePayloadMappingError {
  return new UpbitPrivatePayloadMappingError({
    schema: "ORDER_LOOKUP",
    userMessage,
    issuePaths,
  });
}

function summarizeRestClientError(
  error: UpbitPrivateRestClientError,
  options: CreateUpbitPrivateErrorSummaryOptions,
): UpbitPrivateUserActionErrorSummary {
  const trace = withCorrelationId(
    {
      kind: error.kind,
      ...(error.trace.httpStatus === undefined ? {} : { httpStatus: error.trace.httpStatus }),
      ...(error.trace.upbitErrorName === undefined ? {} : { upbitErrorName: error.trace.upbitErrorName }),
      ...(error.trace.rateLimitStatus === undefined ? {} : { rateLimitStatus: error.trace.rateLimitStatus }),
    },
    options,
  );

  if (error.kind === "AUTHENTICATION_FAILED") {
    // 인증 실패는 재시도보다 key/allowlist/nonce 확인이 먼저라 operator 조치로 분리한다.
    return {
      title: "Upbit 인증 정보를 확인해야 합니다.",
      message: "API key, IP allowlist 또는 인증 nonce 조건이 맞지 않아 private 조회를 중단했습니다.",
      requiredAction: "secret 파일과 Upbit Open API 관리 화면의 IP allowlist를 확인한 뒤 smoke를 처음부터 다시 실행하세요.",
      trace,
    };
  }

  if (error.kind === "PERMISSION_DENIED") {
    // 권한 부족은 코드 재시도로 해결되지 않으므로 필요한 권한 증거 확인을 먼저 안내한다.
    return {
      title: "Upbit API 권한을 다시 확인해야 합니다.",
      message: "현재 API key 권한으로 요청한 private endpoint를 사용할 수 없어 추가 호출을 중단했습니다.",
      requiredAction: "자산조회/주문조회 권한과 저장소 밖 redacted 권한 증거를 확인하고, 출금 권한이 없는 key로 재실행하세요.",
      trace,
    };
  }

  if (error.kind === "RATE_LIMIT_THROTTLED") {
    // 요청 한도 소진 상태에서는 추가 조회가 smoke evidence를 오염시키므로 지연 또는 중단을 명시한다.
    return {
      title: "Upbit 요청 한도에 도달했습니다.",
      message: "현재 요청 bucket의 남은 횟수가 부족해 같은 smoke에서 추가 private 요청을 이어갈 수 없습니다.",
      requiredAction: "rate-limit trace를 확인하고 요청 간격을 늘리거나 다음 smoke run에서 다시 시작하세요.",
      trace,
    };
  }

  if (error.kind === "RATE_LIMIT_BLOCKED") {
    // 일시 차단은 자동 복구보다 manual review가 우선이라 retry-after 근거를 trace에만 둔다.
    return {
      title: "Upbit 요청이 일시 차단되었습니다.",
      message: "거래소가 private 요청을 일시 차단해 주문 smoke를 계속 진행하면 안 됩니다.",
      requiredAction: "retry-after와 요청 패턴을 확인하고, 차단 해제 후 운영자 승인 아래에서 새 smoke를 실행하세요.",
      trace,
    };
  }

  if (error.kind === "PROVIDER_UNAVAILABLE") {
    return {
      title: "Upbit 응답이 불안정합니다.",
      message: "거래소 서버 오류 가능성이 있어 현재 smoke evidence로 정책이나 주문 상태를 확정하지 않습니다.",
      requiredAction: "추가 주문 없이 수동 확인으로 전환하고, 안정화 후 private read smoke부터 다시 실행하세요.",
      trace,
    };
  }

  if (error.kind === "INVALID_PROVIDER_RESPONSE") {
    return {
      title: "Upbit 응답을 해석하지 못했습니다.",
      message: error.userMessage,
      requiredAction: "원문 응답을 저장하지 말고 공식 문서와 schema 변경 여부를 확인한 뒤 mapper를 보강하세요.",
      trace,
    };
  }

  return {
    title: "Upbit private 요청이 실패했습니다.",
    message: error.userMessage,
    requiredAction: "추적 정보를 기준으로 원인을 확인하고, 주문 side effect 없이 read-only 단계부터 재시도하세요.",
    trace,
  };
}

function withCorrelationId(
  trace: Omit<UpbitPrivateErrorSummaryTrace, "correlationId">,
  options: CreateUpbitPrivateErrorSummaryOptions,
): UpbitPrivateErrorSummaryTrace {
  return {
    ...trace,
    ...(options.correlationId === undefined ? {} : { correlationId: options.correlationId }),
  };
}

function toFeeBps(rate: NumericString): NumericString {
  return parseFinancialDecimal(rate).mul(10000).toFixed();
}

function normalizeDecimalString(value: NumericString): NumericString {
  return parseFinancialDecimal(value).toFixed();
}

function addDecimalStrings(left: NumericString, right: NumericString): NumericString {
  return parseFinancialDecimal(left).add(parseFinancialDecimal(right)).toFixed();
}

function isPositiveDecimalString(value: NumericString): boolean {
  return parseFinancialDecimal(value).greaterThan(0);
}

function normalizeCurrency(currency: string): string {
  return currency.trim().toUpperCase();
}

function formatIssuePath(path: readonly (string | number)[]): string {
  return path.length === 0 ? "<root>" : path.join(".");
}
