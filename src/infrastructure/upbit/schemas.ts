import { z } from "zod";

/**
 * Upbit 공개 API의 숫자 문자열 경계다.
 *
 * 거래소 payload는 가격, 호가 단위, 호가 level을 문자열로 전달한다. 이 schema는 외부 입력을
 * `number`로 변환하지 않고 후속 policy mapper가 정밀도를 보존한 채 domain contract로 넘기게 한다.
 */
const NumericStringSchema = z.string().regex(/^(?:0|[1-9]\d*)(?:\.\d+)?$/u, "numeric string is required");

/**
 * Upbit market code 형식 검증 schema다.
 *
 * 이 단계에서는 `KRW-BTC`뿐 아니라 Upbit가 반환할 수 있는 `BTC-*`, `USDT-*`도 파싱한다. MVP 범위
 * 차단은 schema가 아니라 policy mapper에서 `MarketStatus.reasonCodes`로 표현한다.
 */
const UpbitMarketCodeSchema = z
  .string()
  .regex(/^[A-Z0-9]+-[A-Z0-9]+$/u, "Upbit market code is required");

/**
 * Upbit WebSocket 숫자 payload schema다.
 *
 * WebSocket 문서는 가격과 수량을 JSON number로 설명하지만, fixture나 replay harness는 정밀도 보존을 위해
 * 문자열을 넣을 수 있다. mapper는 어느 입력이든 domain `NumericString`으로 변환한다.
 */
const UpbitWireNumericSchema = z.union([
  z.number().finite().nonnegative(),
  NumericStringSchema,
]);

/**
 * Upbit millisecond timestamp schema다.
 *
 * 거래소 시각과 수신 시각의 차이는 stale data 차단 입력으로 쓰이므로, 음수나 비정상 숫자는 schema에서
 * 먼저 거부한다.
 */
const UpbitMillisecondTimestampSchema = z.number().int().nonnegative();

/**
 * Upbit WebSocket 체결 순번 number 입력 schema다.
 *
 * `sequential_id`는 JS safe integer보다 클 수 있다. raw text decoder를 거치면 문자열로 보존되지만, 이미
 * JSON.parse된 unsafe number는 원본 정밀도가 깨졌을 수 있으므로 schema 단계에서 거부한다.
 */
const UpbitSafeSequentialIdNumberSchema = z
  .number()
  .int()
  .nonnegative()
  .refine(Number.isSafeInteger, "unsafe sequential_id number is not allowed; use raw text decoder");

/**
 * Upbit 시장경보 caution payload schema다.
 *
 * 과거 상세 reason object와 변경 후 boolean 표현을 모두 받아들인다. 업무 판단은 어느 표현이든
 * 하나라도 caution이면 신규 진입 차단 입력으로 정규화한다.
 */
const UpbitMarketEventCautionSchema = z.union([
  z.boolean(),
  z.record(z.string(), z.boolean()),
]);

/**
 * Upbit market event schema다.
 *
 * warning/caution은 universe manager와 risk gate가 신규 주문을 막는 핵심 외부 신호다. 알 수 없는
 * 필드는 `.passthrough()`로 보존해 정책 변경 시 fixture와 raw snapshot에서 원인을 추적할 수 있게 한다.
 */
export const UpbitMarketEventSchema = z
  .object({
    warning: z.boolean(),
    caution: UpbitMarketEventCautionSchema,
  })
  .passthrough();

/**
 * `GET /v1/market/all?is_details=true` 단일 market 응답 schema다.
 *
 * 이 schema는 외부 payload의 형태만 검증한다. `market_event` 누락, 비-KRW quote, MVP universe 밖
 * market 차단 같은 업무 규칙은 `toMarketStatus`에서 명시적 reason code로 처리한다.
 */
export const UpbitMarketSchema = z
  .object({
    market: UpbitMarketCodeSchema,
    korean_name: z.string().min(1),
    english_name: z.string().min(1),
    market_event: UpbitMarketEventSchema.optional(),
  })
  .passthrough();

/** Upbit public market list 전체 응답 schema다. */
export const UpbitMarketListResponseSchema = z.array(UpbitMarketSchema);

/**
 * `GET /v1/orderbook/instruments` 단일 market 응답 schema다.
 *
 * Upbit가 제공하는 `tick_size`는 조회 시점의 현재 호가 단위이며 전체 KRW 가격 구간표가 아니다.
 * 따라서 주문 검증용 가격 band는 mapper 호출자가 별도로 주입하고, 여기서는 원천 정책 payload만 검증한다.
 */
export const UpbitOrderbookInstrumentSchema = z
  .object({
    market: UpbitMarketCodeSchema,
    quote_currency: z.string().min(1),
    tick_size: NumericStringSchema,
    supported_levels: z.array(NumericStringSchema).min(1),
  })
  .passthrough();

/** Upbit orderbook instruments 전체 응답 schema다. */
export const UpbitOrderbookInstrumentsResponseSchema = z.array(UpbitOrderbookInstrumentSchema);

/**
 * Upbit WebSocket stream type schema다.
 *
 * snapshot과 realtime을 raw payload에 보존하면 fixture replay와 runtime 수집 결과를 같은 방식으로
 * 비교할 수 있다.
 */
export const UpbitWebSocketStreamTypeSchema = z.enum(["SNAPSHOT", "REALTIME"]);

/**
 * Upbit WebSocket 체결 payload schema다.
 *
 * 이 schema는 기본 `DEFAULT`/`JSON_LIST` 포맷의 `trade` 응답만 검증한다. `SIMPLE` 축약 포맷은 PR2
 * 범위에서 사용하지 않아 fail-fast하고, 후속 최적화가 필요할 때 별도 mapper로 추가한다.
 */
export const UpbitWebSocketTradeSchema = z
  .object({
    type: z.literal("trade"),
    code: UpbitMarketCodeSchema,
    trade_price: UpbitWireNumericSchema,
    trade_volume: UpbitWireNumericSchema,
    ask_bid: z.enum(["ASK", "BID"]),
    trade_timestamp: UpbitMillisecondTimestampSchema,
    timestamp: UpbitMillisecondTimestampSchema,
    sequential_id: z.union([z.string().regex(/^\d+$/u), UpbitSafeSequentialIdNumberSchema]),
    stream_type: UpbitWebSocketStreamTypeSchema,
    best_ask_price: UpbitWireNumericSchema.optional(),
    best_ask_size: UpbitWireNumericSchema.optional(),
    best_bid_price: UpbitWireNumericSchema.optional(),
    best_bid_size: UpbitWireNumericSchema.optional(),
  })
  .passthrough();

/**
 * Upbit WebSocket 호가 단일 level schema다.
 *
 * ask/bid 가격과 잔량은 paper fill model과 orderbook metric 입력이므로, 각 level에서 모두 존재해야 한다.
 */
export const UpbitWebSocketOrderbookUnitSchema = z
  .object({
    ask_price: UpbitWireNumericSchema,
    bid_price: UpbitWireNumericSchema,
    ask_size: UpbitWireNumericSchema,
    bid_size: UpbitWireNumericSchema,
  })
  .passthrough();

/**
 * Upbit WebSocket 호가 payload schema다.
 *
 * 호가 모아보기 `level`은 KRW market에서만 의미가 있고, 지원하지 않는 level은 수신 자체가 안 될 수 있다.
 * 따라서 payload에 포함된 값을 raw와 함께 보존해 후속 저장/metric PR이 같은 근거를 쓰게 한다.
 */
export const UpbitWebSocketOrderbookSchema = z
  .object({
    type: z.literal("orderbook"),
    code: UpbitMarketCodeSchema,
    total_ask_size: UpbitWireNumericSchema,
    total_bid_size: UpbitWireNumericSchema,
    orderbook_units: z.array(UpbitWebSocketOrderbookUnitSchema).min(1),
    timestamp: UpbitMillisecondTimestampSchema,
    level: UpbitWireNumericSchema,
    stream_type: UpbitWebSocketStreamTypeSchema,
  })
  .passthrough();

/**
 * Upbit WebSocket PING 문자열 응답 schema다.
 *
 * `PING` 메시지 기반 keepalive를 쓰면 서버가 `{"status":"UP"}`를 주기적으로 보낸다. 이 값은 거래 이벤트가
 * 아니라 연결 생존 신호이므로 `MarketDataStatusEvent.CONNECTED`로만 정규화한다.
 */
export const UpbitWebSocketStatusSchema = z
  .object({
    status: z.literal("UP"),
  })
  .passthrough();

/**
 * Upbit WebSocket 에러 응답 schema다.
 *
 * 요청 형식 위반이나 인증 경계 침범 같은 문제를 상태 이벤트로 남길 수 있게 error name/message를 보존한다.
 */
export const UpbitWebSocketErrorResponseSchema = z
  .object({
    error: z
      .object({
        name: z.string().min(1),
        message: z.string().min(1),
      })
      .passthrough(),
  })
  .passthrough();

/** Upbit WebSocket market-data payload 전체 schema다. */
export const UpbitWebSocketMarketDataPayloadSchema = z.union([
  UpbitWebSocketTradeSchema,
  UpbitWebSocketOrderbookSchema,
]);

export type UpbitMarket = z.infer<typeof UpbitMarketSchema>;
export type UpbitMarketEvent = z.infer<typeof UpbitMarketEventSchema>;
export type UpbitOrderbookInstrument = z.infer<typeof UpbitOrderbookInstrumentSchema>;
export type UpbitWebSocketStreamType = z.infer<typeof UpbitWebSocketStreamTypeSchema>;
export type UpbitWebSocketTrade = z.infer<typeof UpbitWebSocketTradeSchema>;
export type UpbitWebSocketOrderbookUnit = z.infer<typeof UpbitWebSocketOrderbookUnitSchema>;
export type UpbitWebSocketOrderbook = z.infer<typeof UpbitWebSocketOrderbookSchema>;
export type UpbitWebSocketStatus = z.infer<typeof UpbitWebSocketStatusSchema>;
export type UpbitWebSocketErrorResponse = z.infer<typeof UpbitWebSocketErrorResponseSchema>;
export type UpbitWebSocketMarketDataPayload = z.infer<typeof UpbitWebSocketMarketDataPayloadSchema>;
