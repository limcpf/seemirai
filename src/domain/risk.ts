import type { OrderIntent } from "./orders.js";
import type { ExchangeId, JsonRecord, MarketCode, NumericString, TimestampInput } from "./types.js";

export type RiskEvaluationStatus = "PASS" | "FAIL" | "WARN";

export type RiskEventSeverity = "INFO" | "WARN" | "BLOCKING" | "CRITICAL";

export type RiskBlockAction =
  | "ALLOW"
  | "BLOCK_NEW_ORDER"
  | "PAUSE_STRATEGY"
  | "HARD_STOP"
  | "MANUAL_REVIEW_REQUIRED";

export type InfrastructureRiskSignal =
  | "STALE_MARKET_DATA"
  | "WEBSOCKET_DISCONNECTED"
  | "WEBSOCKET_RECONNECTING"
  | "DB_WRITE_FAILURE"
  | "DUPLICATE_ORDER_IDEMPOTENCY_KEY"
  | "BALANCE_POSITION_MISMATCH"
  | "NOTIFICATION_FAILURE";

export interface RiskLimitThresholds {
  dailyLossLimitBps: NumericString;
  weeklyLossLimitBps: NumericString;
  maxDrawdownBps: NumericString;
  maxOrderNotionalBpsOfEquity: NumericString;
  maxExpectedLossBpsOfEquity: NumericString;
  btcEthMaxPositionBpsOfEquity: NumericString;
  altMaxPositionBpsOfEquity: NumericString;
  totalAltMaxPositionBpsOfEquity: NumericString;
  maxConsecutiveStrategyLosses: number;
}

export const defaultRiskLimitThresholds: RiskLimitThresholds = {
  dailyLossLimitBps: "100",
  weeklyLossLimitBps: "300",
  maxDrawdownBps: "500",
  maxOrderNotionalBpsOfEquity: "100",
  maxExpectedLossBpsOfEquity: "20",
  btcEthMaxPositionBpsOfEquity: "2000",
  altMaxPositionBpsOfEquity: "500",
  totalAltMaxPositionBpsOfEquity: "1500",
  maxConsecutiveStrategyLosses: 3,
};

export interface RiskThresholdSnapshot {
  thresholds: RiskLimitThresholds;
  capturedAt: TimestampInput;
  source: string;
}

export interface RiskGateEvaluation {
  status: RiskEvaluationStatus;
  reasonCode: string;
  message: string;
  severity: RiskEventSeverity;
  action: RiskBlockAction;
  thresholdSnapshot?: RiskThresholdSnapshot;
  metadata?: JsonRecord;
}

export interface RiskGateResult {
  status: RiskEvaluationStatus;
  approved: boolean;
  action: RiskBlockAction;
  evaluations: readonly RiskGateEvaluation[];
  failedEvaluations: readonly RiskGateEvaluation[];
  warningEvaluations: readonly RiskGateEvaluation[];
  thresholdSnapshot: RiskThresholdSnapshot;
}

export interface AccountRiskSnapshot {
  equityKrw: NumericString;
  dailyRealizedPnlBps: NumericString;
  weeklyRealizedPnlBps: NumericString;
  maxDrawdownBps: NumericString;
  capturedAt: TimestampInput;
  metadata?: JsonRecord;
}

export interface PositionRiskSnapshot {
  exchangeId: ExchangeId;
  market: MarketCode;
  strategyId?: string;
  notionalKrw: NumericString;
  notionalBpsOfEquity: NumericString;
  unrealizedPnlBps: NumericString;
  capturedAt: TimestampInput;
  metadata?: JsonRecord;
}

export interface StrategyRiskSnapshot {
  strategyId: string;
  consecutiveLosses: number;
  capturedAt: TimestampInput;
  metadata?: JsonRecord;
}

export interface InfrastructureRiskSnapshot {
  signal: InfrastructureRiskSignal;
  exchangeId?: ExchangeId;
  market?: MarketCode;
  strategyId?: string;
  orderId?: string;
  idempotencyKey?: string;
  observedAt: TimestampInput;
  metadata?: JsonRecord;
}

export interface RiskGateContext {
  orderIntent: OrderIntent;
  account: AccountRiskSnapshot;
  positions: readonly PositionRiskSnapshot[];
  strategy: StrategyRiskSnapshot;
  infrastructureSignals: readonly InfrastructureRiskSnapshot[];
  thresholdSnapshot: RiskThresholdSnapshot;
  observedAt: TimestampInput;
  metadata?: JsonRecord;
}

export function createRiskThresholdSnapshot(
  thresholds: RiskLimitThresholds,
  capturedAt: TimestampInput,
  source = "runtime.risk.thresholds",
): RiskThresholdSnapshot {
  return {
    thresholds,
    capturedAt,
    source,
  };
}
