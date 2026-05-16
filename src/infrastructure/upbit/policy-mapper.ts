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

export const UPBIT_KRW_SPOT_EXCHANGE_ID = "upbit_krw_spot" satisfies ExchangeId;

export interface UpbitOrderbookInstrumentPolicy {
  exchangeId: ExchangeId;
  market: MarketCode;
  quoteCurrency: string;
  tickSize: NumericString;
  supportedOrderbookLevels: readonly NumericString[];
  updatedAt: TimestampInput;
  raw: JsonRecord;
}

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

export interface MapUpbitPolicyOptions {
  exchangeId?: ExchangeId;
  observedAt: TimestampInput;
}

export interface MapUpbitOrderRuleOptions extends MapUpbitPolicyOptions {
  minimumOrderNotional: NumericString;
  priceTickPolicy: PriceTickPolicy;
}

export interface CreateUpbitPublicPolicySnapshotOptions extends MapUpbitOrderRuleOptions {
  rateLimits?: readonly RateLimitPolicy[];
  capturedAt?: TimestampInput;
}

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

export function toMarketStatus(market: UpbitMarket, options: MapUpbitPolicyOptions): MarketStatus {
  const [quoteCurrency] = splitUpbitMarketCode(market.market);
  const marketEventMissing = market.market_event === undefined;
  const unsupportedQuoteCurrency = quoteCurrency !== "KRW";
  const warning = market.market_event?.warning ?? false;
  const cautionReasonCodes = market.market_event?.caution
    ? normalizeCautionReasonCodes(market.market_event.caution)
    : [];
  const caution = cautionReasonCodes.length > 0;
  const reasonCodes = [
    ...(marketEventMissing ? ["market_event_missing"] : []),
    ...(unsupportedQuoteCurrency ? [`unsupported_quote_currency:${quoteCurrency}`] : []),
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
