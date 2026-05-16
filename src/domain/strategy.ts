import type { MarketDataEvent } from "./market.js";
import type { OrderIntent } from "./orders.js";
import type { JsonRecord, TimestampInput } from "./types.js";

export type StrategyDecisionKind = "HOLD" | "BLOCK" | "ORDER_INTENT";

export interface StrategyContext {
  strategyId: string;
  observedAt: TimestampInput;
  marketEvents: readonly MarketDataEvent[];
  features: Readonly<Record<string, unknown>>;
  positions?: JsonRecord;
  metadata?: JsonRecord;
}

export interface HoldStrategyDecision {
  kind: "HOLD";
  strategyId: string;
  reason: string;
  metadata?: JsonRecord;
}

export interface BlockStrategyDecision {
  kind: "BLOCK";
  strategyId: string;
  reason: string;
  reasonCode: string;
  metadata?: JsonRecord;
}

export interface OrderIntentStrategyDecision {
  kind: "ORDER_INTENT";
  strategyId: string;
  reason: string;
  orderIntents: readonly OrderIntent[];
  metadata?: JsonRecord;
}

export type StrategyDecision =
  | HoldStrategyDecision
  | BlockStrategyDecision
  | OrderIntentStrategyDecision;

export interface Strategy {
  id: string;
  version: string;
  requiredFeatures: readonly string[];
  evaluate(context: StrategyContext): StrategyDecision | Promise<StrategyDecision>;
}

