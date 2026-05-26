import type { InfrastructureRiskSnapshot, JsonRecord, RiskGateEvaluation } from "../../../domain/index.js";
import { fail, pass, warn } from "./evaluation-factory.js";

/**
 * market data, DB, idempotency 같은 인프라 차단 신호를 RiskGate 평가로 변환한다.
 *
 * 신호가 없으면 명시적인 PASS evidence를 반환하고, 복구 전 재주문 위험이 큰 신호는 HARD_STOP/manual review로 승격한다.
 */
export function evaluateInfrastructureSignals(
  signals: readonly InfrastructureRiskSnapshot[],
): RiskGateEvaluation[] {
  if (signals.length === 0) {
    return [pass("infrastructure_signals_clear", "No infrastructure risk signal is active")];
  }

  return signals.map((signal) => {
    const metadata = createInfrastructureSignalMetadata(signal);

    // DB write/idempotency 위반은 상태 복구 전 재주문 위험이 커서 가장 강한 HARD_STOP으로 수렴한다.
    switch (signal.signal) {
      case "STALE_MARKET_DATA":
        return fail("stale_market_data", "Stale market data blocks new orders", "BLOCK_NEW_ORDER", metadata);
      case "WEBSOCKET_DISCONNECTED":
        return fail("websocket_disconnected", "Disconnected WebSocket blocks new orders", "BLOCK_NEW_ORDER", metadata);
      case "WEBSOCKET_RECONNECTING":
        return fail("websocket_reconnecting", "Reconnecting WebSocket blocks new orders", "BLOCK_NEW_ORDER", metadata);
      case "DB_WRITE_FAILURE":
        return fail("db_write_failure", "Database write failure triggers hard stop", "HARD_STOP", metadata);
      case "DUPLICATE_ORDER_IDEMPOTENCY_KEY":
        return fail("duplicate_order_idempotency_key", "Duplicate order idempotency key triggers hard stop", "HARD_STOP", metadata);
      case "BALANCE_POSITION_MISMATCH":
        return fail("balance_position_mismatch", "Balance/position mismatch requires manual review", "MANUAL_REVIEW_REQUIRED", metadata);
      case "NOTIFICATION_FAILURE":
        return warn("notification_failure", "Notification failure is audited but does not block RiskGate approval", metadata);
    }
  });
}

function createInfrastructureSignalMetadata(signal: InfrastructureRiskSnapshot): JsonRecord {
  const metadata: JsonRecord = {
    signal: signal.signal,
    observed_at: signal.observedAt,
  };
  assignIfDefined(metadata, "exchange_id", signal.exchangeId);
  assignIfDefined(metadata, "market", signal.market);
  assignIfDefined(metadata, "strategy_id", signal.strategyId);
  assignIfDefined(metadata, "order_id", signal.orderId);
  assignIfDefined(metadata, "idempotency_key", signal.idempotencyKey);
  assignIfDefined(metadata, "metadata", signal.metadata);
  return metadata;
}

function assignIfDefined(target: JsonRecord, key: string, value: unknown): void {
  if (value !== undefined) {
    target[key] = value;
  }
}
