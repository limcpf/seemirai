import type { ExchangePolicySnapshot, MarketDataEvent, MarketStatus } from "./market.js";
import type { OrderIntent } from "./orders.js";
import type { ExchangeId, JsonRecord, MarketCode, TimestampInput } from "./types.js";

export type RuleEvaluationStatus = "PASS" | "FAIL" | "WARN";

export interface RuleEvaluation {
  status: RuleEvaluationStatus;
  reasonCode: string;
  message: string;
  metadata?: JsonRecord;
}

export interface RuleContext {
  exchangeId: ExchangeId;
  market: MarketCode;
  observedAt: TimestampInput;
  marketStatus?: MarketStatus;
  policySnapshot?: ExchangePolicySnapshot;
  latestEvents?: readonly MarketDataEvent[];
  orderIntent?: OrderIntent;
  accountState?: JsonRecord;
  metadata?: JsonRecord;
}

export interface Rule {
  id: string;
  evaluate(context: RuleContext): RuleEvaluation | Promise<RuleEvaluation>;
}

