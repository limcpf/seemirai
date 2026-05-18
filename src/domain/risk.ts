import type { OrderIntent } from "./orders.js";
import type { ExchangeId, JsonRecord, MarketCode, NumericString, TimestampInput } from "./types.js";

/**
 * RiskGate 개별 평가와 전체 결과의 상태다.
 */
export type RiskEvaluationStatus = "PASS" | "FAIL" | "WARN";

/**
 * risk event로 저장될 심각도다.
 */
export type RiskEventSeverity = "INFO" | "WARN" | "BLOCKING" | "CRITICAL";

/**
 * RiskGate 판단이 runtime에 요구하는 차단 action이다.
 */
export type RiskBlockAction =
  | "ALLOW"
  | "BLOCK_NEW_ORDER"
  | "PAUSE_STRATEGY"
  | "HARD_STOP"
  | "MANUAL_REVIEW_REQUIRED";

/**
 * 인프라 상태에서 RiskGate로 들어오는 신규 주문 차단 후보 신호다.
 */
export type InfrastructureRiskSignal =
  | "STALE_MARKET_DATA"
  | "WEBSOCKET_DISCONNECTED"
  | "WEBSOCKET_RECONNECTING"
  | "DB_WRITE_FAILURE"
  | "DUPLICATE_ORDER_IDEMPOTENCY_KEY"
  | "BALANCE_POSITION_MISMATCH"
  | "NOTIFICATION_FAILURE";

/**
 * M5에서 확정한 계정 손실, 주문 크기, 포지션 노출, 연속 손실 한도다.
 */
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

/**
 * paper trading 기본 profile이 사용하는 보수적 RiskGate threshold다.
 */
// 모든 비율 threshold는 bps 단위 문자열로 유지해 Decimal 경계를 잃지 않는다.
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

/**
 * 어떤 threshold 기준으로 리스크를 평가했는지 audit/risk event에 남기는 snapshot이다.
 */
export interface RiskThresholdSnapshot {
  thresholds: RiskLimitThresholds;
  capturedAt: TimestampInput;
  source: string;
}

/**
 * RiskGate가 단일 risk rule 또는 signal을 평가한 결과다.
 */
export interface RiskGateEvaluation {
  status: RiskEvaluationStatus;
  reasonCode: string;
  message: string;
  severity: RiskEventSeverity;
  action: RiskBlockAction;
  thresholdSnapshot?: RiskThresholdSnapshot;
  metadata?: JsonRecord;
}

/**
 * 주문 후보 하나에 대한 RiskGate 전체 승인/거부 결과다.
 */
export interface RiskGateResult {
  status: RiskEvaluationStatus;
  approved: boolean;
  action: RiskBlockAction;
  evaluations: readonly RiskGateEvaluation[];
  failedEvaluations: readonly RiskGateEvaluation[];
  warningEvaluations: readonly RiskGateEvaluation[];
  thresholdSnapshot: RiskThresholdSnapshot;
}

/**
 * 계정 단위 손실과 평가액을 RiskGate 입력으로 고정한 snapshot이다.
 */
export interface AccountRiskSnapshot {
  equityKrw: NumericString;
  dailyRealizedPnlBps: NumericString;
  weeklyRealizedPnlBps: NumericString;
  maxDrawdownBps: NumericString;
  capturedAt: TimestampInput;
  metadata?: JsonRecord;
}

/**
 * 단일 market/strategy 포지션 노출을 RiskGate 입력으로 고정한 snapshot이다.
 */
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

/**
 * 전략별 연속 손실 같은 strategy-level 중지 기준 입력이다.
 */
export interface StrategyRiskSnapshot {
  strategyId: string;
  consecutiveLosses: number;
  capturedAt: TimestampInput;
  metadata?: JsonRecord;
}

/**
 * market data, DB, idempotency, balance mismatch 같은 인프라 리스크 입력이다.
 */
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

/**
 * CostModel과 rule을 통과한 주문 후보를 RiskGate가 평가할 때 필요한 전체 context다.
 */
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

/**
 * 현재 runtime 설정으로 적용한 리스크 threshold snapshot을 만든다.
 */
export function createRiskThresholdSnapshot(
  thresholds: RiskLimitThresholds,
  capturedAt: TimestampInput,
  source = "runtime.risk.thresholds",
): RiskThresholdSnapshot {
  // 후속 risk rejection event가 어떤 설정값으로 판단됐는지 추적할 수 있게 source를 함께 남긴다.
  return {
    thresholds,
    capturedAt,
    source,
  };
}
