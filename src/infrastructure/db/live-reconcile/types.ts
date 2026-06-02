import type { Insertable, Selectable } from "kysely";
import type {
  DatabaseSchema,
  LiveReconcileBalanceSnapshotsTable,
  LiveReconcileExchangeOrderSnapshotsTable,
  LiveReconcileFillRecoveryKeysTable,
  LiveReconcileMismatchEvidenceTable,
  LiveReconcilePositionSnapshotsTable,
  LiveReconcileRunsTable,
} from "../schema.js";

/**
 * `live_reconcile_runs` 테이블에서 읽은 reconcile 실행 snapshot이다.
 *
 * repository가 DB write 후 반환하는 durable run 상태이며, 호출자는 이 값을 기준으로 후속 snapshot/evidence가
 * 같은 run에 속하는지 확인한다. 읽기 전용 record라 외부 side effect는 없다.
 */
export type LiveReconcileRunRecord = Selectable<LiveReconcileRunsTable>;

/**
 * `live_reconcile_balance_snapshots` 테이블에서 읽은 잔고 snapshot record다.
 *
 * reconcile run에 속한 통화별 잔고 조회 결과이며, diff engine의 입력으로 사용된다.
 */
export type LiveReconcileBalanceSnapshotRecord = Selectable<LiveReconcileBalanceSnapshotsTable>;

/**
 * `live_reconcile_exchange_order_snapshots` 테이블에서 읽은 주문 상태 snapshot record다.
 *
 * reconcile run에 속한 거래소 주문 상태 조회 결과이며, 로컬 주문과의 대조 입력으로 사용된다.
 */
export type LiveReconcileExchangeOrderSnapshotRecord = Selectable<LiveReconcileExchangeOrderSnapshotsTable>;

/**
 * `live_reconcile_mismatch_evidence` 테이블에서 읽은 불일치 증거 record다.
 *
 * reconcile run에서 발견한 mismatch 증거 조회 결과이며, append-only invariant로 중복 저장되지 않는다.
 */
export type LiveReconcileMismatchEvidenceRecord = Selectable<LiveReconcileMismatchEvidenceTable>;

/**
 * `live_reconcile_position_snapshots` 테이블에서 읽은 포지션 복구 후보 record다.
 *
 * reconcile run에서 관측한 포지션 수량과 평균단가 근거이며, domain `positions` 갱신 전 검증 입력으로 사용된다.
 */
export type LiveReconcilePositionSnapshotRecord = Selectable<LiveReconcilePositionSnapshotsTable>;

/**
 * `live_reconcile_fill_recovery_keys` 테이블에서 읽은 fill 복구 key record다.
 *
 * `fills` insert 전에 선점한 durable 중복 방지 key이며, 같은 거래소 체결 또는 fingerprint의 반복 insert를 차단한다.
 */
export type LiveReconcileFillRecoveryKeyRecord = Selectable<LiveReconcileFillRecoveryKeysTable>;

/**
 * `live_reconcile_runs`에 insert할 입력 타입이다.
 *
 * `id`, `started_at`, `metadata_json`은 DB 기본값으로 생성된다.
 */
export type LiveReconcileRunInsertInput = Insertable<LiveReconcileRunsTable>;

/**
 * `live_reconcile_balance_snapshots`에 insert할 입력 타입이다.
 *
 * `id`, `metadata_json`은 DB 기본값으로 생성된다.
 */
export type LiveReconcileBalanceSnapshotInsertInput = Insertable<LiveReconcileBalanceSnapshotsTable>;

/**
 * `live_reconcile_exchange_order_snapshots`에 insert할 입력 타입이다.
 *
 * `id`, `metadata_json`은 DB 기본값으로 생성된다.
 */
export type LiveReconcileExchangeOrderSnapshotInsertInput = Insertable<LiveReconcileExchangeOrderSnapshotsTable>;

/**
 * `live_reconcile_mismatch_evidence`에 insert할 입력 타입이다.
 *
 * `id`, `trace_json`은 DB 기본값으로 생성된다.
 */
export type LiveReconcileMismatchEvidenceInsertInput = Insertable<LiveReconcileMismatchEvidenceTable>;

/**
 * `live_reconcile_position_snapshots`에 insert할 입력 타입이다.
 *
 * `id`, `evidence_json`, `metadata_json`은 DB 기본값으로 생성된다.
 */
export type LiveReconcilePositionSnapshotInsertInput =
  Insertable<LiveReconcilePositionSnapshotsTable>;

/**
 * `live_reconcile_fill_recovery_keys`에 insert할 입력 타입이다.
 *
 * `id`, `reserved_at`, `metadata_json`은 DB 기본값으로 생성된다.
 */
export type LiveReconcileFillRecoveryKeyInsertInput =
  Insertable<LiveReconcileFillRecoveryKeysTable>;

/**
 * reconcile run을 시작하기 위한 입력이다.
 */
export interface BeginLiveReconcileRunInput {
  /** 중복 실행을 막는 idempotency key */
  idempotencyKey: string;
  /** reconcile을 시작한 guard 또는 profile 식별자 */
  guardProfile?: string;
  /** reconcile이 참조한 source 요약 */
  sourceSummary?: string;
  /** 여러 event를 하나의 업무 흐름으로 묶는 상관관계 ID */
  correlationId?: string;
  /** run metadata */
  metadata?: Record<string, unknown>;
}

/**
 * reconcile run을 완료하기 위한 입력이다.
 */
export interface CompleteLiveReconcileRunInput {
  /** run ID */
  runId: string;
  /** 최종 실행 상태 */
  status: "COMPLETED" | "FAILED" | "MANUAL_REVIEW_REQUIRED";
}

/**
 * 최신 reconcile run 요약 정보다.
 */
export interface LiveReconcileSummary {
  /** 마지막 reconcile run 정보 */
  run: LiveReconcileRunRecord | null;
  /** balance snapshot 개수 */
  balanceSnapshotCount: number;
  /** exchange order snapshot 개수 */
  exchangeOrderSnapshotCount: number;
  /** mismatch evidence 개수 */
  mismatchEvidenceCount: number;
  /** position snapshot 개수 */
  positionSnapshotCount: number;
  /** fill recovery key 개수 */
  fillRecoveryKeyCount: number;
}

/**
 * reconcile run 상태 업데이트 입력이다.
 */
export interface UpdateLiveReconcileRunInput {
  /** run ID */
  runId: string;
  /** 새 상태 */
  status: "RUNNING" | "COMPLETED" | "FAILED" | "MANUAL_REVIEW_REQUIRED";
}
