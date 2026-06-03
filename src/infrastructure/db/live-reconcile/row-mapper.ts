import type {
  BeginLiveReconcileRunInput,
  LiveReconcileBalanceSnapshotInsertInput,
  LiveReconcileExchangeOrderSnapshotInsertInput,
  LiveReconcileFillRecoveryKeyInsertInput,
  LiveReconcileMismatchEvidenceInsertInput,
  LiveReconcilePositionSnapshotInsertInput,
  LiveReconcileRunInsertInput,
} from "./types.js";
import { parseFinancialDecimal } from "../../../shared/decimal.js";

/**
 * Run 시작 입력을 `live_reconcile_runs` insert row로 변환한다.
 *
 * @param input run 시작 입력
 * @returns `live_reconcile_runs` insert row
 */
export function toLiveReconcileRunRowInput(
  input: BeginLiveReconcileRunInput,
): LiveReconcileRunInsertInput {
  return {
    idempotency_key: input.idempotencyKey,
    status: "RUNNING",
    guard_profile: input.guardProfile ?? null,
    source_summary: input.sourceSummary ?? null,
    correlation_id: input.correlationId ?? null,
    metadata_json: (input.metadata ?? {}) as Record<string, unknown>,
  };
}

/**
 * 잔고 snapshot 도메인 데이터를 `live_reconcile_balance_snapshots` insert row로 변환한다.
 *
 * @param runId 소속 run ID
 * @param snapshot 잔고 snapshot 도메인 데이터
 * @returns `live_reconcile_balance_snapshots` insert row
 */
export function toLiveReconcileBalanceSnapshotRowInput(
  runId: string,
  snapshot: {
    currency: string;
    available: string;
    locked: string;
    total: string;
    capturedAt: Date | string;
    source: "REST" | "WS";
    metadata?: Record<string, unknown>;
  },
): LiveReconcileBalanceSnapshotInsertInput {
  return {
    run_id: runId,
    currency: snapshot.currency,
    available: snapshot.available,
    locked: snapshot.locked,
    total: snapshot.total,
    captured_at: typeof snapshot.capturedAt === "string" ? snapshot.capturedAt : snapshot.capturedAt,
    source: snapshot.source,
    metadata_json: (snapshot.metadata ?? {}) as Record<string, unknown>,
  };
}

/**
 * 거래소 주문 snapshot 도메인 데이터를 `live_reconcile_exchange_order_snapshots` insert row로 변환한다.
 *
 * @param runId 소속 run ID
 * @param snapshot 거래소 주문 snapshot 도메인 데이터
 * @returns `live_reconcile_exchange_order_snapshots` insert row
 */
export function toLiveReconcileExchangeOrderSnapshotRowInput(
  runId: string,
  snapshot: {
    exchangeOrderId?: string;
    identifier?: string;
    market: string;
    side: "BUY" | "SELL";
    status: string;
    requestedQuantity: string;
    remainingQuantity?: string;
    requestedPrice?: string;
    source: "open" | "closed" | "lookup" | "ws";
    capturedAt: Date | string;
    metadata?: Record<string, unknown>;
  },
): LiveReconcileExchangeOrderSnapshotInsertInput {
  return {
    run_id: runId,
    exchange_order_id: snapshot.exchangeOrderId ?? null,
    identifier: snapshot.identifier ?? null,
    identity_fingerprint: buildLiveReconcileOrderIdentityFingerprint(snapshot),
    market: snapshot.market,
    side: snapshot.side,
    status: snapshot.status,
    requested_quantity: snapshot.requestedQuantity,
    remaining_quantity: snapshot.remainingQuantity ?? null,
    requested_price: snapshot.requestedPrice ?? null,
    source: snapshot.source,
    captured_at: typeof snapshot.capturedAt === "string" ? snapshot.capturedAt : snapshot.capturedAt,
    metadata_json: (snapshot.metadata ?? {}) as Record<string, unknown>,
  };
}

/**
 * DB에 저장할 거래소 주문 immutable identity fingerprint를 만든다.
 *
 * uuid/identifier가 없는 snapshot도 reconcile evidence로 보존해야 하므로
 * persistence boundary에서 market/side/수량/가격을 Decimal scale 차이 없이
 * 정규화한다. 이 함수는 순수 변환이며 DB write나 외부 API 호출을 하지 않는다.
 */
function buildLiveReconcileOrderIdentityFingerprint(snapshot: {
  market: string;
  side: "BUY" | "SELL";
  requestedQuantity: string;
  requestedPrice?: string;
}): string {
  return [
    snapshot.market,
    snapshot.side,
    parseFinancialDecimal(snapshot.requestedQuantity).toString(),
    snapshot.requestedPrice === undefined
      ? ""
      : parseFinancialDecimal(snapshot.requestedPrice).toString(),
  ].join("|");
}

/**
 * mismatch evidence 도메인 데이터를 `live_reconcile_mismatch_evidence` insert row로 변환한다.
 *
 * `message`와 `action`은 한국어 사용자 문구를 받고, 안정적인 내부 코드는 `trace_json`에 분리한다.
 *
 * @param runId 소속 run ID
 * @param evidence mismatch evidence 도메인 데이터
 * @returns `live_reconcile_mismatch_evidence` insert row
 */
export function toLiveReconcileMismatchEvidenceRowInput(
  runId: string,
  evidence: {
    mismatchType: string;
    severity: "INFO" | "WARN" | "ERROR" | "CRITICAL";
    market?: string;
    orderIdentity?: string;
    currency?: string;
    message: string;
    action: string;
    evidenceFingerprint: string;
    trace?: Record<string, unknown>;
    occurredAt: Date | string;
  },
): LiveReconcileMismatchEvidenceInsertInput {
  return {
    run_id: runId,
    mismatch_type: evidence.mismatchType as LiveReconcileMismatchEvidenceInsertInput["mismatch_type"],
    severity: evidence.severity,
    market: evidence.market ?? null,
    order_identity: evidence.orderIdentity ?? null,
    currency: evidence.currency ?? null,
    message: evidence.message,
    action: evidence.action,
    evidence_fingerprint: evidence.evidenceFingerprint,
    trace_json: (evidence.trace ?? {}) as Record<string, unknown>,
    occurred_at: typeof evidence.occurredAt === "string" ? evidence.occurredAt : evidence.occurredAt,
  };
}

/**
 * 포지션 복구 후보 snapshot을 `live_reconcile_position_snapshots` insert row로 변환한다.
 *
 * 평균단가가 없으면 호출자는 `MANUAL_REVIEW_REQUIRED`로 저장해야 하며, 이 mapper는 domain `positions`를 직접 갱신하지 않는다.
 *
 * @param runId 소속 run ID
 * @param snapshot 포지션 복구 후보 snapshot
 * @returns `live_reconcile_position_snapshots` insert row
 */
export function toLiveReconcilePositionSnapshotRowInput(
  runId: string,
  snapshot: {
    exchange: string;
    market: string;
    strategyId: string;
    quantity: string;
    averageEntryPrice?: string;
    recoveryStatus: "RECOVERABLE" | "MANUAL_REVIEW_REQUIRED";
    source: "fills" | "balances" | "local" | "manual_review";
    capturedAt: Date | string;
    evidence?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
  },
): LiveReconcilePositionSnapshotInsertInput {
  return {
    run_id: runId,
    exchange: snapshot.exchange,
    market: snapshot.market,
    strategy_id: snapshot.strategyId,
    quantity: snapshot.quantity,
    average_entry_price: snapshot.averageEntryPrice ?? null,
    recovery_status: snapshot.recoveryStatus,
    source: snapshot.source,
    captured_at: typeof snapshot.capturedAt === "string" ? snapshot.capturedAt : snapshot.capturedAt,
    evidence_json: (snapshot.evidence ?? {}) as Record<string, unknown>,
    metadata_json: (snapshot.metadata ?? {}) as Record<string, unknown>,
  };
}

/**
 * fill 복구 unique key 선점 입력을 `live_reconcile_fill_recovery_keys` insert row로 변환한다.
 *
 * 이 row는 `fills` insert 전에 중복 체결을 durable하게 차단하기 위한 선행 write이며, domain fill record를 만들지 않는다.
 *
 * @param runId 소속 run ID
 * @param key fill 복구 key 선점 입력
 * @returns `live_reconcile_fill_recovery_keys` insert row
 */
export function toLiveReconcileFillRecoveryKeyRowInput(
  runId: string,
  key: {
    exchange: string;
    market: string;
    orderId?: string;
    exchangeOrderId?: string;
    exchangeFillId?: string;
    fillFingerprint: string;
    side: "BUY" | "SELL";
    price: string;
    quantity: string;
    filledAt: Date | string;
    metadata?: Record<string, unknown>;
  },
): LiveReconcileFillRecoveryKeyInsertInput {
  return {
    run_id: runId,
    exchange: key.exchange,
    market: key.market,
    order_id: key.orderId ?? null,
    exchange_order_id: key.exchangeOrderId ?? null,
    exchange_fill_id: key.exchangeFillId ?? null,
    fill_fingerprint: key.fillFingerprint,
    side: key.side,
    price: key.price,
    quantity: key.quantity,
    filled_at: typeof key.filledAt === "string" ? key.filledAt : key.filledAt,
    metadata_json: (key.metadata ?? {}) as Record<string, unknown>,
  };
}
