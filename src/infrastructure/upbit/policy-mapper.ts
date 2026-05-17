import type {
  ExchangeId,
  JsonRecord,
  MarketCode,
  MarketPolicy,
  MarketStatus,
  NumericString,
  OrderRulePolicy,
  PriceTickPolicy,
  RateLimitPolicy,
  TimestampInput,
} from "../../domain/index.js";
import type { UpbitMarket, UpbitOrderbookInstrument } from "./schemas.js";

/** Seemirai MVP에서 Upbit KRW 현물 adapter를 식별하는 exchange id다. */
export const UPBIT_KRW_SPOT_EXCHANGE_ID = "upbit_krw_spot" satisfies ExchangeId;

/**
 * MVP phase 1 기본 universe다.
 *
 * Upbit market list는 전체 KRW/BTC/USDT 페어를 반환하므로, 공개 정책 정규화 단계부터 기본 universe 밖
 * market은 tradable=false로 표시한다. phase 1.5 알트 편입은 caller가 `allowedMarkets`로 명시한다.
 */
export const DEFAULT_UPBIT_MVP_MARKETS = ["KRW-BTC", "KRW-ETH"] as const satisfies readonly MarketCode[];

/**
 * Upbit orderbook instruments endpoint에서 얻은 공개 호가 정책 근거다.
 *
 * `tickSize`와 `supportedOrderbookLevels`는 raw 정책 snapshot과 후속 WebSocket/orderbook 구독 검증에
 * 쓰고, 주문 가격 검증은 별도 `OrderRulePolicy.priceTickPolicy`를 따른다.
 */
export interface UpbitOrderbookInstrumentPolicy {
  exchangeId: ExchangeId;
  market: MarketCode;
  quoteCurrency: string;
  tickSize: NumericString;
  supportedOrderbookLevels: readonly NumericString[];
  updatedAt: TimestampInput;
  raw: JsonRecord;
}

/**
 * Upbit public policy snapshot의 PR1 기준 payload다.
 *
 * 이 snapshot은 인증 없이 수집 가능한 market status, orderbook instrument, rate-limit 근거만 포함한다.
 * 수수료, 잔고, 주문 가능 금액처럼 인증 API가 필요한 값은 후속 policy-sync profile에서 분리한다.
 */
export interface UpbitPublicPolicySnapshot {
  exchangeId: ExchangeId;
  market: MarketCode;
  marketPolicy: MarketPolicy;
  orderRules: OrderRulePolicy;
  orderbookInstrument: UpbitOrderbookInstrumentPolicy;
  rateLimits: readonly RateLimitPolicy[];
  capturedAt: TimestampInput;
  raw: JsonRecord;
}

/**
 * Upbit market policy mapper 공통 옵션이다.
 *
 * `allowedMarkets`를 생략하면 MVP phase 1 universe만 거래 가능 후보로 본다. 후속 phase 1.5 알트 편입은
 * 호출자가 승인된 market 목록을 주입해야 한다.
 */
export interface MapUpbitPolicyOptions {
  exchangeId?: ExchangeId;
  allowedMarkets?: readonly MarketCode[];
  observedAt: TimestampInput;
}

/**
 * 주문 규칙 정규화 옵션이다.
 *
 * Upbit public instruments는 최소 주문금액과 전체 KRW 가격 band를 제공하지 않으므로, caller가 정책
 * snapshot 또는 설정에서 검증 가능한 값을 주입한다.
 */
export interface MapUpbitOrderRuleOptions extends MapUpbitPolicyOptions {
  minimumOrderNotional: NumericString;
  priceTickPolicy: PriceTickPolicy;
}

/** public policy snapshot 생성 옵션이다. */
export interface CreateUpbitPublicPolicySnapshotOptions extends MapUpbitOrderRuleOptions {
  rateLimits?: readonly RateLimitPolicy[];
  capturedAt?: TimestampInput;
}

/**
 * Upbit market 응답을 domain `MarketPolicy`로 변환한다.
 *
 * 흐름은 market code 분해, market status 판정, base/quote 보존 순서다. 거래 가능 여부는 Upbit 경보와
 * Seemirai MVP universe 정책을 함께 반영한 `MarketStatus`에만 담는다.
 */
export function toMarketPolicy(market: UpbitMarket, options: MapUpbitPolicyOptions): MarketPolicy {
  const [quoteCurrency, baseCurrency] = splitUpbitMarketCode(market.market);
  const status = toMarketStatus(market, options);

  return {
    exchangeId: options.exchangeId ?? UPBIT_KRW_SPOT_EXCHANGE_ID,
    market: market.market,
    baseCurrency,
    quoteCurrency,
    status,
  };
}

/**
 * Upbit market의 신규 진입 가능 상태를 계산한다.
 *
 * `market_event`가 없으면 안전하게 차단하고, 비-KRW quote와 기본 universe 밖 KRW market도 차단한다.
 * 이렇게 해야 전체 `/v1/market/all` 응답을 처리해도 MVP 범위 밖 market이 risk gate로 통과하지 않는다.
 */
export function toMarketStatus(market: UpbitMarket, options: MapUpbitPolicyOptions): MarketStatus {
  const [quoteCurrency] = splitUpbitMarketCode(market.market);
  const allowedMarkets = options.allowedMarkets ?? DEFAULT_UPBIT_MVP_MARKETS;
  const marketEventMissing = market.market_event === undefined;
  const unsupportedQuoteCurrency = quoteCurrency !== "KRW";
  const marketNotInUniverse = !allowedMarkets.includes(market.market);
  const warning = market.market_event?.warning ?? false;
  const cautionReasonCodes = market.market_event?.caution
    ? normalizeCautionReasonCodes(market.market_event.caution)
    : [];
  const caution = cautionReasonCodes.length > 0;
  const reasonCodes = [
    ...(marketEventMissing ? ["market_event_missing"] : []),
    ...(unsupportedQuoteCurrency ? [`unsupported_quote_currency:${quoteCurrency}`] : []),
    ...(marketNotInUniverse ? [`market_not_in_mvp_universe:${market.market}`] : []),
    ...(warning ? ["market_warning"] : []),
    ...cautionReasonCodes.map((reasonCode) => `market_caution:${reasonCode}`),
  ];

  return {
    exchangeId: options.exchangeId ?? UPBIT_KRW_SPOT_EXCHANGE_ID,
    market: market.market,
    tradable: reasonCodes.length === 0,
    warning,
    caution,
    reasonCodes,
    updatedAt: options.observedAt,
  };
}

/**
 * Upbit orderbook instrument를 주문 전 검증용 `OrderRulePolicy`로 변환한다.
 *
 * public endpoint가 제공하지 않는 최소 주문금액과 전체 가격 band는 caller가 넣는다. MVP 기본 정책상
 * public contract는 시장가 주문을 노출하지 않고 `LIMIT`만 허용한다.
 */
export function toOrderRulePolicy(
  instrument: UpbitOrderbookInstrument,
  options: MapUpbitOrderRuleOptions,
): OrderRulePolicy {
  return {
    exchangeId: options.exchangeId ?? UPBIT_KRW_SPOT_EXCHANGE_ID,
    market: instrument.market,
    minimumOrderNotional: options.minimumOrderNotional,
    priceTickPolicy: options.priceTickPolicy,
    supportedOrderbookLevels: instrument.supported_levels,
    allowedOrderTypes: ["LIMIT"],
    updatedAt: options.observedAt,
  };
}

/**
 * Upbit orderbook instrument 원천 정책을 보존용 payload로 변환한다.
 *
 * 후속 persistence PR은 이 값을 `policy_snapshots.payload_json`에 저장해 어떤 Upbit 응답을 근거로
 * orderbook level과 tick size를 판단했는지 재현한다.
 */
export function toOrderbookInstrumentPolicy(
  instrument: UpbitOrderbookInstrument,
  options: MapUpbitPolicyOptions,
): UpbitOrderbookInstrumentPolicy {
  return {
    exchangeId: options.exchangeId ?? UPBIT_KRW_SPOT_EXCHANGE_ID,
    market: instrument.market,
    quoteCurrency: instrument.quote_currency,
    tickSize: instrument.tick_size,
    supportedOrderbookLevels: instrument.supported_levels,
    updatedAt: options.observedAt,
    raw: instrument,
  };
}

/**
 * market list와 orderbook instrument 응답을 하나의 public policy snapshot으로 묶는다.
 *
 * 후속 runtime은 이 단위를 저장하고 주문 후보 검증 시 같은 market status와 rate-limit 근거를 참조한다.
 * market/instrument가 어긋나면 정책 snapshot의 감사 가치가 없어지므로 fail-fast한다.
 */
export function createUpbitPublicPolicySnapshot(
  market: UpbitMarket,
  instrument: UpbitOrderbookInstrument,
  options: CreateUpbitPublicPolicySnapshotOptions,
): UpbitPublicPolicySnapshot {
  if (market.market !== instrument.market) {
    throw new Error(`Upbit market/instrument mismatch: ${market.market} !== ${instrument.market}`);
  }

  const marketPolicy = toMarketPolicy(market, options);
  const orderRules = toOrderRulePolicy(instrument, options);
  const orderbookInstrument = toOrderbookInstrumentPolicy(instrument, options);

  return {
    exchangeId: options.exchangeId ?? UPBIT_KRW_SPOT_EXCHANGE_ID,
    market: market.market,
    marketPolicy,
    orderRules,
    orderbookInstrument,
    rateLimits: options.rateLimits ?? [],
    capturedAt: options.capturedAt ?? options.observedAt,
    raw: {
      market,
      orderbookInstrument: instrument,
    },
  };
}

function splitUpbitMarketCode(market: string): readonly [string, string] {
  const [quoteCurrency, baseCurrency] = market.split("-");

  if (quoteCurrency === undefined || baseCurrency === undefined) {
    throw new Error(`Invalid Upbit market code: ${market}`);
  }

  return [quoteCurrency, baseCurrency];
}

function normalizeCautionReasonCodes(caution: boolean | Record<string, boolean>): readonly string[] {
  if (typeof caution === "boolean") {
    return caution ? ["ANY"] : [];
  }

  return Object.entries(caution)
    .filter(([, active]) => active)
    .map(([reasonCode]) => reasonCode)
    .sort();
}
