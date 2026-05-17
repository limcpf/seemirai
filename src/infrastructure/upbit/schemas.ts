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

export type UpbitMarket = z.infer<typeof UpbitMarketSchema>;
export type UpbitMarketEvent = z.infer<typeof UpbitMarketEventSchema>;
export type UpbitOrderbookInstrument = z.infer<typeof UpbitOrderbookInstrumentSchema>;
