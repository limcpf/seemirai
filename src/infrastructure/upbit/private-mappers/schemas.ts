import { z } from "zod";

/**
 * Upbit private API의 숫자 문자열 schema다.
 *
 * 잔고, 수수료율, 주문 수량, 잠금 금액은 정밀도 손실을 피하기 위해 number로 변환하지 않고 문자열 contract로만 받는다.
 */
const UpbitPrivateNumericStringSchema = z
  .string()
  .regex(/^(?:0|[1-9]\d*)(?:\.\d+)?$/u, "numeric string is required");

/**
 * Upbit private API market code schema다.
 *
 * mapper는 KRW 현물 범위 판단을 별도 guard와 policy에서 수행하므로, schema 단계에서는 Upbit 페어 코드 형태만 검증한다.
 */
const UpbitPrivateMarketCodeSchema = z
  .string()
  .regex(/^[A-Z0-9]+-[A-Z0-9]+$/u, "Upbit market code is required");

/** Upbit private 주문 방향 schema다. */
const UpbitPrivateOrderSideSchema = z.enum(["ask", "bid"]);

/** Upbit private 주문 유형 schema다. */
const UpbitPrivateOrderTypeSchema = z.enum(["limit", "price", "market", "best"]);

/** Upbit private 주문 상태 schema다. */
const UpbitPrivateOrderStateSchema = z.enum(["wait", "watch", "done", "cancel"]);

/** Upbit private 체결 대기 주문 목록 상태 schema다. */
const UpbitPrivateOpenOrderStateSchema = z.enum(["wait", "watch"]);

/** Upbit private 종료 주문 목록 상태 schema다. */
const UpbitPrivateClosedOrderStateSchema = z.enum(["done", "cancel"]);

/** Upbit private time_in_force schema다. */
const UpbitPrivateTimeInForceSchema = z.enum(["fok", "ioc", "post_only"]);

/** Upbit private self-match prevention schema다. */
const UpbitPrivateSmpTypeSchema = z.enum(["reduce", "cancel_maker", "cancel_taker"]);

/**
 * Upbit 계정 잔고 단일 row schema다.
 *
 * `/v1/accounts` 응답은 주문 가능 잔고와 잠김 잔고를 분리한다. mapper는 두 값을 더해 broker balance total을 만들지만,
 * 평균 매수가와 기준 통화는 audit metadata로만 보존한다.
 */
export const UpbitPrivateAccountBalanceSchema = z
  .object({
    currency: z.string().min(1),
    balance: UpbitPrivateNumericStringSchema,
    locked: UpbitPrivateNumericStringSchema,
    avg_buy_price: UpbitPrivateNumericStringSchema,
    avg_buy_price_modified: z.boolean(),
    unit_currency: z.string().min(1),
  })
  .passthrough();

/** `/v1/accounts` 전체 응답 schema다. */
export const UpbitPrivateAccountsResponseSchema = z.array(UpbitPrivateAccountBalanceSchema);

/**
 * `orders/chance` 계정 부분 schema다.
 *
 * Upbit OpenAPI의 주문 가능 정보 예시는 `unit_currency`를 제공하지만 required 목록에는 빠져 있을 수 있어 optional로 둔다.
 */
const UpbitPrivateOrderChanceAccountSchema = z
  .object({
    currency: z.string().min(1),
    balance: UpbitPrivateNumericStringSchema,
    locked: UpbitPrivateNumericStringSchema,
    avg_buy_price: UpbitPrivateNumericStringSchema,
    avg_buy_price_modified: z.boolean(),
    unit_currency: z.string().min(1).optional(),
  })
  .passthrough();

/**
 * `orders/chance` market bid/ask 제약 schema다.
 *
 * `price_unit`은 deprecated field라 업무 판단에 쓰지 않지만, `.passthrough()`로 raw 추적 가능성을 남긴다.
 */
const UpbitPrivateOrderChanceMarketConstraintSchema = z
  .object({
    currency: z.string().min(1),
    min_total: UpbitPrivateNumericStringSchema,
  })
  .passthrough();

/**
 * `orders/chance` market schema다.
 *
 * `order_types`는 deprecated 예정이므로 mapper는 `bid_types`/`ask_types`를 우선 사용하고, raw payload에는 그대로 보존한다.
 */
const UpbitPrivateOrderChanceMarketSchema = z
  .object({
    id: UpbitPrivateMarketCodeSchema,
    name: z.string().min(1),
    order_types: z.array(UpbitPrivateOrderTypeSchema).optional(),
    order_sides: z.array(UpbitPrivateOrderSideSchema),
    bid_types: z.array(z.enum(["best_fok", "best_ioc", "limit", "limit_fok", "limit_ioc", "price"])),
    ask_types: z.array(z.enum(["best_fok", "best_ioc", "limit", "limit_fok", "limit_ioc", "market"])),
    bid: UpbitPrivateOrderChanceMarketConstraintSchema,
    ask: UpbitPrivateOrderChanceMarketConstraintSchema,
    max_total: UpbitPrivateNumericStringSchema,
    state: z.string().min(1),
  })
  .passthrough();

/**
 * `orders/chance` 단일 주문 가능 정보 payload schema다.
 *
 * 수수료율, 주문 가능 유형, 계정 잔고를 함께 검증해 policy sync가 provider raw shape에 직접 의존하지 않게 한다.
 */
export const UpbitPrivateOrderChancePayloadSchema = z
  .object({
    bid_fee: UpbitPrivateNumericStringSchema,
    ask_fee: UpbitPrivateNumericStringSchema,
    maker_bid_fee: UpbitPrivateNumericStringSchema,
    maker_ask_fee: UpbitPrivateNumericStringSchema,
    market: UpbitPrivateOrderChanceMarketSchema,
    bid_account: UpbitPrivateOrderChanceAccountSchema,
    ask_account: UpbitPrivateOrderChanceAccountSchema,
  })
  .passthrough();

/**
 * `orders/chance` endpoint 응답 schema다.
 *
 * 현재 공식 OpenAPI는 배열 예시를 제공하지만 기존 client와 일부 SDK는 단일 object로 다룬 이력이 있어, mapper 경계에서는
 * 단일 payload로 정규화해 후속 domain contract를 안정화한다.
 */
export const UpbitPrivateOrderChanceResponseSchema = z.union([
  UpbitPrivateOrderChancePayloadSchema,
  z.array(UpbitPrivateOrderChancePayloadSchema).min(1).max(1).transform((payloads) => payloads[0]!),
]);

/**
 * 개별 주문 조회의 체결 단일 row schema다.
 *
 * 체결 목록은 주문 lookup evidence의 일부이며, broker order 상태는 요약 필드만 사용하고 체결 세부값은 metadata에 보존한다.
 */
export const UpbitPrivateOrderTradeSchema = z
  .object({
    market: UpbitPrivateMarketCodeSchema,
    uuid: z.string().min(1),
    price: UpbitPrivateNumericStringSchema,
    volume: UpbitPrivateNumericStringSchema,
    funds: UpbitPrivateNumericStringSchema,
    trend: z.enum(["up", "down"]).optional(),
    created_at: z.string().min(1),
    side: UpbitPrivateOrderSideSchema,
  })
  .passthrough();

/**
 * `/v1/order` 개별 주문 조회 응답 schema다.
 *
 * `price`, `volume`, `remaining_volume`, `identifier`, `time_in_force`는 주문 유형과 생성 시점에 따라 없을 수 있으므로
 * mapper가 optional 값을 명시적으로 보정한다.
 */
export const UpbitPrivateOrderLookupResponseSchema = z
  .object({
    market: UpbitPrivateMarketCodeSchema,
    uuid: z.string().min(1),
    side: UpbitPrivateOrderSideSchema,
    ord_type: UpbitPrivateOrderTypeSchema,
    price: UpbitPrivateNumericStringSchema.nullish(),
    state: UpbitPrivateOrderStateSchema,
    created_at: z.string().min(1),
    volume: UpbitPrivateNumericStringSchema.nullish(),
    remaining_volume: UpbitPrivateNumericStringSchema.nullish(),
    executed_volume: UpbitPrivateNumericStringSchema,
    reserved_fee: UpbitPrivateNumericStringSchema,
    remaining_fee: UpbitPrivateNumericStringSchema,
    paid_fee: UpbitPrivateNumericStringSchema,
    locked: UpbitPrivateNumericStringSchema,
    time_in_force: UpbitPrivateTimeInForceSchema.optional(),
    smp_type: UpbitPrivateSmpTypeSchema.optional(),
    prevented_volume: UpbitPrivateNumericStringSchema.optional(),
    prevented_locked: UpbitPrivateNumericStringSchema.optional(),
    identifier: z.string().min(1).optional(),
    trades_count: z.number().int().nonnegative(),
    trades: z.array(UpbitPrivateOrderTradeSchema),
  })
  .passthrough();

/**
 * `/v1/orders` 생성과 `/v1/order` 취소 응답의 주문 요약 schema다.
 *
 * command 응답은 개별 주문 조회와 달리 체결 row 배열을 포함하지 않는다. live broker는 이 payload를 즉시 `BrokerOrder`
 * contract로 정규화하되, raw provider payload는 반환 metadata에 보존하지 않는다.
 */
export const UpbitPrivateOrderCommandResponseSchema = z
  .object({
    market: UpbitPrivateMarketCodeSchema,
    uuid: z.string().min(1),
    side: UpbitPrivateOrderSideSchema,
    ord_type: UpbitPrivateOrderTypeSchema,
    price: UpbitPrivateNumericStringSchema.nullish(),
    state: UpbitPrivateOrderStateSchema,
    created_at: z.string().min(1),
    volume: UpbitPrivateNumericStringSchema.nullish(),
    remaining_volume: UpbitPrivateNumericStringSchema,
    executed_volume: UpbitPrivateNumericStringSchema,
    reserved_fee: UpbitPrivateNumericStringSchema,
    remaining_fee: UpbitPrivateNumericStringSchema,
    paid_fee: UpbitPrivateNumericStringSchema,
    locked: UpbitPrivateNumericStringSchema,
    time_in_force: UpbitPrivateTimeInForceSchema.optional(),
    smp_type: UpbitPrivateSmpTypeSchema.optional(),
    prevented_volume: UpbitPrivateNumericStringSchema.optional(),
    prevented_locked: UpbitPrivateNumericStringSchema.optional(),
    identifier: z.string().min(1).optional(),
    trades_count: z.number().int().nonnegative().optional(),
  })
  .passthrough();

/**
 * `/v1/orders/open` 체결 대기 주문 단일 row schema다.
 *
 * open order 목록은 개별 주문 조회와 달리 체결 목록을 포함하지 않으므로, broker order 요약에 필요한 주문 상태와 잔량
 * 필드만 검증한다. raw provider payload는 mapper metadata 안에만 보존한다.
 */
export const UpbitPrivateOpenOrderResponseSchema = z
  .object({
    market: UpbitPrivateMarketCodeSchema,
    uuid: z.string().min(1),
    side: UpbitPrivateOrderSideSchema,
    ord_type: UpbitPrivateOrderTypeSchema,
    price: UpbitPrivateNumericStringSchema.nullish(),
    state: UpbitPrivateOpenOrderStateSchema,
    created_at: z.string().min(1),
    volume: UpbitPrivateNumericStringSchema.nullish(),
    remaining_volume: UpbitPrivateNumericStringSchema,
    executed_volume: UpbitPrivateNumericStringSchema,
    executed_funds: UpbitPrivateNumericStringSchema.optional(),
    reserved_fee: UpbitPrivateNumericStringSchema,
    remaining_fee: UpbitPrivateNumericStringSchema,
    paid_fee: UpbitPrivateNumericStringSchema,
    locked: UpbitPrivateNumericStringSchema,
    time_in_force: UpbitPrivateTimeInForceSchema.optional(),
    smp_type: UpbitPrivateSmpTypeSchema.optional(),
    prevented_volume: UpbitPrivateNumericStringSchema.optional(),
    prevented_locked: UpbitPrivateNumericStringSchema.optional(),
    identifier: z.string().min(1).optional(),
    trades_count: z.number().int().nonnegative().optional(),
  })
  .passthrough();

/** `/v1/orders/open` 전체 응답 schema다. */
export const UpbitPrivateOpenOrdersResponseSchema = z.array(UpbitPrivateOpenOrderResponseSchema);

/**
 * `/v1/orders/closed` 종료 주문 단일 row schema다.
 *
 * closed order 목록은 개별 주문 조회와 달리 체결 목록을 포함하지 않는다. `state`는 `done` 또는 `cancel`만 허용하며,
 * broker order 요약에 필요한 주문 상태와 잔량 필드만 검증한다. raw provider payload는 mapper metadata 안에서
 * 보존하지 않고 safe 요약만 포함한다.
 */
export const UpbitPrivateClosedOrderResponseSchema = z
  .object({
    market: UpbitPrivateMarketCodeSchema,
    uuid: z.string().min(1),
    side: UpbitPrivateOrderSideSchema,
    ord_type: UpbitPrivateOrderTypeSchema,
    price: UpbitPrivateNumericStringSchema.nullish(),
    state: UpbitPrivateClosedOrderStateSchema,
    created_at: z.string().min(1),
    volume: UpbitPrivateNumericStringSchema.nullish(),
    remaining_volume: UpbitPrivateNumericStringSchema,
    executed_volume: UpbitPrivateNumericStringSchema,
    executed_funds: UpbitPrivateNumericStringSchema.optional(),
    reserved_fee: UpbitPrivateNumericStringSchema,
    remaining_fee: UpbitPrivateNumericStringSchema,
    paid_fee: UpbitPrivateNumericStringSchema,
    locked: UpbitPrivateNumericStringSchema,
    time_in_force: UpbitPrivateTimeInForceSchema.optional(),
    smp_type: UpbitPrivateSmpTypeSchema.optional(),
    prevented_volume: UpbitPrivateNumericStringSchema.optional(),
    prevented_locked: UpbitPrivateNumericStringSchema.optional(),
    identifier: z.string().min(1).optional(),
    trades_count: z.number().int().nonnegative().optional(),
  })
  .passthrough();

/** `/v1/orders/closed` 전체 응답 schema다. */
export const UpbitPrivateClosedOrdersResponseSchema = z.array(UpbitPrivateClosedOrderResponseSchema);

export type UpbitPrivateAccountBalance = z.infer<typeof UpbitPrivateAccountBalanceSchema>;
export type UpbitPrivateAccountsResponse = z.infer<typeof UpbitPrivateAccountsResponseSchema>;
export type UpbitPrivateOrderChancePayload = z.infer<typeof UpbitPrivateOrderChancePayloadSchema>;
export type UpbitPrivateOrderChanceResponse = z.infer<typeof UpbitPrivateOrderChanceResponseSchema>;
export type UpbitPrivateOrderTrade = z.infer<typeof UpbitPrivateOrderTradeSchema>;
export type UpbitPrivateOrderLookupResponse = z.infer<typeof UpbitPrivateOrderLookupResponseSchema>;
export type UpbitPrivateOrderCommandResponse = z.infer<typeof UpbitPrivateOrderCommandResponseSchema>;
export type UpbitPrivateOpenOrderResponse = z.infer<typeof UpbitPrivateOpenOrderResponseSchema>;
export type UpbitPrivateOpenOrdersResponse = z.infer<typeof UpbitPrivateOpenOrdersResponseSchema>;
export type UpbitPrivateClosedOrderResponse = z.infer<typeof UpbitPrivateClosedOrderResponseSchema>;
export type UpbitPrivateClosedOrdersResponse = z.infer<typeof UpbitPrivateClosedOrdersResponseSchema>;
