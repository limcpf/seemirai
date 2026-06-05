import type { Insertable, Selectable } from "kysely";
import type { PnlSnapshotsTable } from "../schema.js";
import type { PnLAccountingOutput } from "../../../application/pnl-accounting.js";

/**
 * `pnl_snapshots` 테이블에서 읽은 PnL snapshot record다.
 *
 * repository가 DB write 후 반환하는 durable snapshot이며, 읽기 전용 record라 외부 side effect는 없다.
 */
export type PnlSnapshotRecord = Selectable<PnlSnapshotsTable>;

/**
 * `pnl_snapshots`에 insert할 입력 타입이다.
 *
 * `payload_json`은 DB 기본값 `{}`로 생성된다.
 */
export type PnlSnapshotInsertInput = Insertable<PnlSnapshotsTable>;

/**
 * PnL snapshot persistence의 입력이다.
 *
 * `output`은 calculator가 생성한 계산 결과이고, `sourceFingerprint`는 payload에 보존되어
 * `captured_at` + scope와 함께 중복 insert 방지의 idempotency key로 사용된다.
 */
export interface PersistPnlSnapshotInput {
  /** calculator 출력 */
  output: PnLAccountingOutput;
  /** snapshot 캡처 시각. `captured_at` 컬럼에 기록된다. */
  capturedAt: Date | string;
  /** 중복 감지 source fingerprint. captured_at + strategy/market/scope 조합의 hash */
  sourceFingerprint: string;
}

/**
 * PnL snapshot persistence 완료 결과다.
 *
 * `inserted=true`이면 이번 호출에서 새 snapshot이 DB에 기록됐고,
 * `inserted=false`이면 source fingerprint 충돌로 중복이 차단됐거나 계산 가능한 snapshot row가 없었다.
 */
export interface PersistPnlSnapshotResult {
  /** 실제 insert가 발생했는지 여부 */
  inserted: boolean;
  /** insert됐거나 기존에 존재하는 snapshot record 목록 */
  snapshots: readonly PnlSnapshotRecord[];
}

/**
 * reconcile source 로딩 입력이다.
 *
 * `strategyId`와 `market`은 선택적 필터이며, 둘 다 없으면 전체 RECOVERABLE snapshot을 조회한다.
 */
export interface LoadReconcileFactsInput {
  /** 조회 대상 전략 ID. 없으면 전체 */
  strategyId?: string;
  /** 조회 대상 market code. 없으면 전체 */
  market?: string;
  /** `capturedAt` 이후의 snapshot만 조회 */
  since?: Date | string;
}

/**
 * `live_reconcile_position_snapshots` 테이블에서 읽은 reconcile position snapshot record다.
 *
 * RECOVERABLE snapshot은 평균단가 근거가 있을 때 계산 source 후보가 되고, MANUAL_REVIEW_REQUIRED snapshot은
 * calculator가 계산 불가 원인과 수동 검토 evidence를 표시할 수 있게 함께 전달된다.
 */
export interface ReconcilePositionSnapshotRecord {
  /** snapshot ID */
  id: string;
  /** 소속 run ID */
  runId: string;
  /** 거래소 식별자 */
  exchange: string;
  /** market code */
  market: string;
  /** 전략 식별자 */
  strategyId: string;
  /** 보유 수량 */
  quantity: string;
  /** 평균 진입 단가. MANUAL_REVIEW_REQUIRED거나 근거가 없으면 null */
  averageEntryPrice: string | null;
  /** 복구 상태 */
  recoveryStatus: "RECOVERABLE" | "MANUAL_REVIEW_REQUIRED";
  /** 산출 source */
  source: "fills" | "balances" | "local" | "manual_review";
  /** snapshot 캡처 시각 */
  capturedAt: Date | string;
  /** 추가 증거 payload */
  evidence: Record<string, unknown>;
}

/**
 * reconcile source 로딩 결과다.
 *
 * `reconcileFacts`는 RECOVERABLE과 MANUAL_REVIEW_REQUIRED position snapshot을 calculator 입력 계약에 맞게
 * 정규화한 목록이다.
 */
export interface LoadReconcileFactsResult {
  /** reconcile position snapshot record 목록 */
  records: readonly ReconcilePositionSnapshotRecord[];
  /** calculator에 전달할 reconcile fact로 승격된 목록 */
  reconcileFacts: ReadonlyArray<{
    strategyId: string;
    market: string;
    recoveryStatus: string;
    averageEntryPrice: string | null;
    reconciledAt: Date | string;
    averageEntrySource?: string;
    manualReviewEvidenceId?: string;
  }>;
}
