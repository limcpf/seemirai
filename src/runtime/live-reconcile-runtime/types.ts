import type { JsonRecord, TimestampInput } from "../../domain/index.js";
import type {
  ReconcileEngineInput,
  ReconcileEngineOutput,
} from "../../domain/live-reconcile.js";
import type { KillSwitchControlProvider, KillSwitchControlResult } from "../../application/index.js";
import type {
  BeginLiveReconcileRunInput,
  CompleteLiveReconcileRunInput,
  LiveReconcileBalanceSnapshotRecord,
  LiveReconcileExchangeOrderSnapshotRecord,
  LiveReconcileMismatchEvidenceRecord,
  LiveReconcileRunRecord,
  LiveReconcileSummary,
} from "../../infrastructure/db/index.js";
import type { PilotUpbitKeyScope } from "../pilot-config.js";

/**
 * M16 read-only reconcile runtime이 인식하는 profile 식별자다.
 *
 * pilot smoke profile과 구분되는 reconcile 전용 label이며, env guard와 status summary에서 같은 값을 공유한다.
 * 이 type은 식별자를 표현할 뿐 외부 side effect를 만들지 않는다.
 */
export type LiveReconcileRuntimeProfile = "LIVE_READ_ONLY_RECONCILE";

/**
 * M16 reconcile runtime에서 허용되는 Upbit key 권한 이름이다.
 *
 * `자산조회`, `주문조회`만 허용하며, `주문하기`는 명시적으로 금지한다. 출금/입출금/레버리지 권한은
 * 기존 forbidden key scopes로 차단된다. 이 type은 검증 경계 외부 side effect가 없다.
 */
export const ALLOWED_RECONCILE_KEY_SCOPES: readonly PilotUpbitKeyScope[] = ["자산조회", "주문조회"];

/**
 * M16 reconcile runtime에서 금지되는 Upbit key 권한 이름이다.
 *
 * reconcile은 주문 side effect를 만들지 않으므로 `주문하기` 권한이 관찰되면 guard가 fail-closed 한다.
 */
export const FORBIDDEN_RECONCILE_KEY_SCOPES: readonly PilotUpbitKeyScope[] = ["주문하기"];

/**
 * reconcile guard env 해석 결과가 비활성인 기본 상태를 표현한다.
 *
 * `SEEMIRAI_RUN_UPBIT_LIVE_RECONCILE=1`이 없으면 이 상태로 반환되며, private API client 조립을
 * 수행하지 않는 invariant를 유지한다. 외부 side effect는 없다.
 */
export interface DisabledLiveReconcileRuntimeConfig {
  enabled: false;
}

/**
 * 명시 guard를 모두 통과한 reconcile runtime 입력을 표현한다.
 *
 * 호출자는 이 값이 있을 때만 후속 private API client와 reconcile worker를 조립할 수 있다.
 * access/secret key 원문을 포함하므로 로그, audit, status 응답에 직접 전달하면 안 된다.
 * 이 모듈은 검증만 수행하고 외부 API 호출 side effect를 만들지 않는다.
 */
export interface EnabledLiveReconcileRuntimeConfig {
  enabled: true;
  upbitAccessKey: string;
  upbitSecretKey: string;
  keyScopes: readonly PilotUpbitKeyScope[];
  keyScopeEvidenceId: string;
}

/**
 * reconcile runtime env 해석 결과의 public contract다.
 *
 * 호출자는 `enabled=false`이면 reconcile worker를 시작하지 않고, `enabled=true`이면 이미 env guard와
 * 권한 evidence 검증을 통과한 입력만 후속 wrapper에 넘긴다. 이 contract는 secret 원문을 포함할 수
 * 있으므로 로그/status에 직접 노출하지 않는 invariant를 유지해야 한다.
 */
export type LiveReconcileRuntimeConfig = DisabledLiveReconcileRuntimeConfig | EnabledLiveReconcileRuntimeConfig;

/**
 * reconcile runtime guard가 통과되지 않았을 때 던지는 오류다.
 *
 * violations는 운영자가 수정할 수 있는 한국어 원인 목록이며, credential 누락이나 금지 권한처럼
 * private API side effect를 만들기 전에 차단해야 하는 조건만 담는다. 외부 side effect는 없다.
 */
export class UnsafeLiveReconcileRuntimeError extends Error {
  public readonly violations: readonly string[];

  public constructor(violations: readonly string[]) {
    super(`안전하지 않은 live reconcile runtime 설정: ${violations.join(", ")}`);
    this.name = "UnsafeLiveReconcileRuntimeError";
    this.violations = violations;
  }
}

/**
 * guarded reconcile runtime을 생성할 때 필요한 입력이다.
 *
 * `liveReconcileEnabled=true`와 개별 env guard가 모두 있어야만 reconcile runtime이 활성화된다.
 * credential 원문은 factory 내부 client 생성에만 사용하고 summary/log/status로 반환하지 않는다.
 */
export interface CreateGuardedLiveReconcileRuntimeInput {
  liveReconcileEnabled: boolean;
  reconcileConfig: LiveReconcileRuntimeConfig;
  worker: LiveReconcileRuntimeWorker;
  clock?: () => TimestampInput;
}

/**
 * guarded reconcile runtime factory의 반환 contract다.
 *
 * `summary`는 운영자 표면에 노출 가능한 secret-safe 상태이고, 호출자는 summary만 log/status/report에
 * 전달해야 하며 credential은 runtime 내부에만 둔다.
 */
export interface GuardedLiveReconcileRuntime {
  summary: LiveReconcileRuntimeSafeSummary;
  worker: LiveReconcileRuntimeWorker;
}

/**
 * reconcile runtime safe summary 생성 입력이다.
 *
 * factory 성공/실패와 무관하게 현재 guard 상태를 secret 없이 설명하기 위한 순수 변환 입력이며,
 * 외부 API 호출 side effect는 없다.
 */
export interface CreateLiveReconcileRuntimeSafeSummaryInput {
  liveReconcileEnabled: boolean;
  reconcileConfig: LiveReconcileRuntimeConfig;
}

/**
 * private WebSocket 연결 상태를 표현하는 enum이다.
 *
 * status/CLI summary에서 한국어 label로 변환해 운영자에게 보여준다.
 */
export type ReconcileWebSocketStatus = "CONNECTED" | "DISCONNECTED" | "RECONNECTING" | "DEGRADED";

/**
 * reconcile runtime 상태를 사용자 표면에 노출하기 위한 secret-safe 요약이다.
 *
 * access key, secret key, JWT, Authorization header는 포함하지 않고, 필요한 조치와 추적 가능한
 * guard evidence id만 남긴다. 이 contract 자체는 외부 side effect가 없다.
 */
export interface LiveReconcileRuntimeSafeSummary {
  enabled: boolean;
  profile: LiveReconcileRuntimeProfile | null;
  credentialsConfigured: boolean;
  keyScopes: readonly PilotUpbitKeyScope[];
  keyScopeEvidenceId: string | null;
  statusLabel: string;
  message: string;
  action: string | null;
  trace: JsonRecord;
}

/**
 * `/status`와 CLI에 노출할 reconcile 실행 결과 summary다.
 *
 * 내부 식별자(run id, mismatch id, correlation id)는 `trace` 하위 객체에 분리하고,
 * mismatch trace detail, raw order detail, fingerprint는 노출하지 않는다.
 */
export interface ReconcileStatusSummary {
  /** 마지막 reconcile 실행 시각 (ISO 8601). 실행 기록이 없으면 null */
  lastReconcileAt: string | null;
  /** reconcile 결과 */
  result: "SUCCESS" | "MISMATCH_DETECTED" | "FAILED" | "SKIPPED" | "UNAVAILABLE";
  /** 감지된 mismatch 수 */
  mismatchCount: number | null;
  /** 거래소 기준 open order 수 */
  openOrderCount: number | null;
  /** balance snapshot 상태 */
  balanceStatus: "OK" | "STALE" | "UNAVAILABLE";
  /** private WebSocket 연결 상태 */
  websocketStatus: ReconcileWebSocketStatus;
  /** 한국어로 표시된 필요 조치 */
  actionRequired: string;
  /** 한국어 사용자 메시지 */
  message: string;
  /** 안정적인 내부 식별자와 진단 정보 */
  trace: Record<string, unknown>;
}

/**
 * live reconcile worker가 외부 snapshot을 읽을 때 전달하는 실행 context다.
 *
 * correlationId와 observedAt은 API 조회, DB evidence, kill switch 전이를 같은 운영 사건으로 묶기 위한 값이다.
 * provider 구현은 이 값을 raw credential이나 Authorization header와 섞어 반환하면 안 된다.
 */
export interface LiveReconcileSnapshotRequest {
  observedAt: TimestampInput;
  correlationId: string;
}

/**
 * read-only provider가 worker에 넘기는 reconcile snapshot이다.
 *
 * provider는 Upbit REST/WebSocket이나 테스트 fixture에서 읽은 값을 domain engine 입력으로 정규화한다. 이 contract에는
 * 주문 생성/취소 함수가 없으며, runtime worker는 이 snapshot으로만 DB evidence와 fail-closed 전이를 만든다.
 */
export interface LiveReconcileRuntimeSnapshot {
  engineInput: ReconcileEngineInput;
  idempotencyKey?: string;
  sourceSummary?: string;
  metadata?: JsonRecord;
}

/**
 * live reconcile worker가 의존하는 read-only snapshot provider port다.
 *
 * 구현체는 `GET /v1/accounts`, 주문 조회, private WebSocket buffer 같은 읽기 전용 경계만 사용해야 한다.
 * POST/DELETE 주문 API side effect는 이 port의 책임 밖이다.
 */
export interface LiveReconcileSnapshotProvider {
  loadSnapshot(request: LiveReconcileSnapshotRequest): Promise<LiveReconcileRuntimeSnapshot>;
}

/**
 * live reconcile append-only persistence에 필요한 repository port다.
 *
 * runtime worker는 concrete PostgreSQL class가 아니라 이 port만 사용한다. 모든 write는 run idempotency와 append-only
 * invariant를 repository가 보존한다는 전제에서 수행한다.
 */
export interface LiveReconcileRuntimeRepository {
  beginLiveReconcileRun(input: BeginLiveReconcileRunInput): Promise<{ created: boolean; run: LiveReconcileRunRecord }>;
  appendLiveReconcileBalanceSnapshots(
    runId: string,
    snapshots: Array<{
      currency: string;
      available: string;
      locked: string;
      total: string;
      capturedAt: Date | string;
      source: "REST" | "WS";
      metadata?: Record<string, unknown>;
    }>,
  ): Promise<LiveReconcileBalanceSnapshotRecord[]>;
  appendLiveReconcileExchangeOrderSnapshots(
    runId: string,
    snapshots: Array<{
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
    }>,
  ): Promise<LiveReconcileExchangeOrderSnapshotRecord[]>;
  appendLiveReconcileMismatchEvidence(
    runId: string,
    evidenceList: Array<{
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
    }>,
  ): Promise<LiveReconcileMismatchEvidenceRecord[]>;
  completeLiveReconcileRun(input: CompleteLiveReconcileRunInput): Promise<LiveReconcileRunRecord>;
  getLatestLiveReconcileSummary(): Promise<LiveReconcileSummary>;
}

/**
 * live reconcile worker 생성 입력이다.
 *
 * snapshotProvider는 읽기 전용 외부 조회를, repository는 append-only evidence 저장을, killSwitchControlProvider는
 * mismatch fail-closed 상태 전이를 담당한다. kill switch provider가 없으면 worker는 evidence만 저장하고 주문 경로 차단은
 * 호출자가 별도 경계에서 처리해야 한다.
 */
export interface CreateLiveReconcileRuntimeWorkerInput {
  snapshotProvider: LiveReconcileSnapshotProvider;
  repository: LiveReconcileRuntimeRepository;
  killSwitchControlProvider?: KillSwitchControlProvider;
  clock?: () => Date;
  actor?: string;
}

/**
 * live reconcile worker의 단일 실행 옵션이다.
 *
 * correlationId는 HTTP/CLI/worker scheduler가 넘길 수 있고, 없으면 worker가 결정론적 prefix를 가진 값을 생성한다.
 */
export interface RunLiveReconcileOnceOptions {
  correlationId?: string;
  observedAt?: TimestampInput;
}

/**
 * live reconcile worker 단일 실행 결과다.
 *
 * engineOutput은 순수 diff 결과, statusSummary는 `/status`와 CLI에 노출 가능한 secret-safe 요약, killSwitchResult는
 * fail-closed 전이가 실제 durable control plane에 전달됐을 때만 채워진다.
 */
export interface LiveReconcileRuntimeRunResult {
  run: LiveReconcileRunRecord;
  engineOutput: ReconcileEngineOutput;
  statusSummary: ReconcileStatusSummary;
  killSwitchResult?: KillSwitchControlResult;
}

/**
 * runtime scheduler 또는 CLI가 호출하는 live reconcile worker contract다.
 *
 * 장시간 loop 자체는 상위 process manager가 책임지고, 이 worker는 한 번의 read-only snapshot 대조와 durable evidence
 * 저장을 원자적인 업무 단위로 제공한다.
 */
export interface LiveReconcileRuntimeWorker {
  runOnce(options?: RunLiveReconcileOnceOptions): Promise<LiveReconcileRuntimeRunResult>;
}

/**
 * `/status`가 최신 reconcile 상태를 조회할 때 의존하는 provider contract다.
 *
 * provider는 DB 또는 in-memory worker state를 읽어 secret-safe summary만 반환한다.
 */
export interface ReconcileStatusProvider {
  getReconcileStatus(): Promise<ReconcileStatusSummary>;
}
