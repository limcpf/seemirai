import type {
  KillSwitchState,
  Phase15AltApprovalEvidenceSnapshot,
  PilotEvidenceSnapshot,
  PilotRuntimeSafeSummary,
} from "../../domain/index.js";
import type {
  KillSwitchControlProvider,
  LiveAutonomousExitStatusSummary,
  PnLAccountingStatusProvider,
  PnLAccountingStatusSummary,
} from "../../application/index.js";
import type { WhySummary, WhySummaryProvider } from "../../application/decision-ledger.js";
export type { WhySummary, WhySummaryProvider };
import type { Database } from "../../infrastructure/db/index.js";
import type {
  PilotRuntimeConfig,
  LiveAutonomousRuntimeSafeSummary,
  ReconcileStatusProvider,
  ReconcileStatusSummary,
  RuntimeConfig,
} from "../../runtime/index.js";

export const DEFAULT_HTTP_CONTROL_HOST = "127.0.0.1";
export const DEFAULT_HTTP_CONTROL_PORT = 8787;

export type ControlReadinessStatus = "ok" | "fail";
export type ControlOverallStatus = "ok" | "error";
/**
 * `/status` 하위 운영 영역의 요약 health code다.
 *
 * `ok`는 조회와 업무 상태가 정상 범위임을, `warning`은 조회는 됐지만 운영 확인이 필요함을, `unavailable`은 조회 자체를
 * 신뢰할 수 없음을 뜻한다. HTTP status code와 독립적으로 사용하며 외부 side effect는 없다.
 */
export type ControlOperationalStatusCode = "ok" | "warning" | "unavailable";

/**
 * `/readyz`를 구성하는 단일 점검 결과다.
 *
 * 이 payload는 orchestrator와 운영자가 장애 원인을 빠르게 식별하는 데 필요한 값만 담고,
 * credential, raw config, SQL payload처럼 외부로 노출되면 안 되는 값은 포함하지 않는다.
 */
export interface ControlReadinessCheckResult {
  name: string;
  status: ControlReadinessStatus;
  critical: boolean;
  checkedAt: string;
  message: string;
  observedValue: string | number | boolean | null;
}

/**
 * readiness endpoint의 최종 판단이다.
 *
 * `ready=false`는 프로세스가 살아 있어도 traffic 또는 worker 기동을 받으면 안 되는 상태를 뜻한다.
 * 거래 중지나 manual review처럼 비즈니스 상태가 막힌 경우는 `/status`가 표현하고,
 * 이 summary는 런타임 의존성 준비 여부에 집중한다.
 */
export interface ControlReadinessSummary {
  status: ControlOverallStatus;
  ready: boolean;
  checkedAt: string;
  checks: readonly ControlReadinessCheckResult[];
}

/**
 * 외부 의존성 readiness를 HTTP layer에 주입하기 위한 port다.
 *
 * Fastify route는 이 port만 알고 DB 구현, migration 방식, config loader 세부사항에는 직접 의존하지 않는다.
 */
export interface ControlReadinessProvider {
  check(): Promise<ControlReadinessSummary>;
}

/**
 * `/status` 하위 운영 영역의 사람이 읽는 상태 설명이다.
 *
 * 이 구조는 paper, alert, daily report처럼 조회 실패가 endpoint 실패로 번지면 안 되는 영역에 붙는다. 호출자는
 * `statusLabel/message/action`을 먼저 보여주고, stable code나 source 같은 내부 식별자는 `trace`에만 보존해야 한다.
 * 이 타입 자체는 외부 side effect가 없으며, invariant는 raw secret/raw provider payload를 포함하지 않는 것이다.
 */
export interface ControlOperationalStatusDetail {
  status: ControlOperationalStatusCode;
  statusLabel: string;
  message: string;
  action: string | null;
  trace: Record<string, unknown>;
}

/**
 * `/status`가 반환하는 운영 snapshot이다.
 *
 * 운영 판단에 필요한 runtime summary, trading state, lag, paper account 집계와 durable alert/daily report 상태만 제공한다.
 * DB 조회 실패는 하위 상태의 `unavailable`로 낮추고, secret과 원본 runtime config는 의도적으로 제외한다.
 */
export interface ControlStatusSnapshot {
  generatedAt: string;
  runtime: {
    exchange: RuntimeConfig["exchange"];
    market: RuntimeConfig["market"];
    mode: RuntimeConfig["mode"];
    universe: {
      phase1: readonly string[];
      phase1Count: number;
      phase15: {
        enabled: boolean;
        approvedAltMarkets: readonly string[];
        approvedAltCount: number;
        candidateMarkets: readonly string[];
        candidateMarketCount: number;
        maxManualApprovals: number;
      };
    };
    liveTradingEnabled: boolean;
    paperNoKey: boolean;
    pilot: PilotRuntimeSafeSummary;
    /** M22 제한적 완전 자동매매 startup guard safe summary다. private client/raw evidence는 포함하지 않는다. */
    liveAutonomous: LiveAutonomousRuntimeSafeSummary;
  };
  tradingState: {
    state: KillSwitchState;
    killSwitchState: KillSwitchState;
    blockedReason: string | null;
    newOrdersBlocked: boolean;
    requiresManualReview: boolean;
  };
  marketData: {
    connectionStatus: string;
    lagMs: number | null;
    updatedAt: string | null;
  };
  paper: ControlOperationalStatusDetail & {
    pendingPaperOrderCount: number | null;
    openPositionCount: number | null;
  };
  database: ControlReadinessSummary;
  alerts: ControlOperationalStatusDetail & {
    lastSentAt: string | null;
    lastSkippedAt: string | null;
  };
  dailyReport: ControlOperationalStatusDetail & {
    lastStatus: string;
    reportDate: string | null;
    nextRunAfter: string | null;
    updatedAt: string | null;
  };
  /** M17 PnL 회계 safe summary다. 원천 상태 code는 trace에 두고 운영자는 한국어 상태/조치 문구를 먼저 본다. */
  pnl: ControlOperationalStatusDetail & {
    latestCapturedAt: string | null;
    latestEquityKrw: string | null;
    latestRealizedPnlKrw: string | null;
    latestUnrealizedPnlKrw: string | null;
    latestDrawdownBps: string | null;
    latestSource: string | null;
    snapshotCount: number;
  };
  /** M16 read-only reconcile 상태 summary다. reconcile worker가 비활성이면 SKIPPED/UNAVAILABLE로 표시한다. */
  reconcile: ReconcileStatusSummary;
  /** M22 live autonomous exit 연결 상태 summary다. 부분 체결, cancel/requote, reconcile mismatch를 한국어 조치로 낮춘다. */
  liveAutonomousExit: LiveAutonomousExitStatusSummary;
  /** M18 판단 이유 ledger 기반 `/status.why` safe summary다. 별도 write/control endpoint는 없다. */
  why: WhySummary | null;
}

export interface ControlStatusProvider {
  getStatus(): Promise<ControlStatusSnapshot>;
}

/**
 * HTTP control server 조립 옵션이다.
 *
 * 읽기 전용 endpoint는 readiness/status provider만 있으면 열 수 있지만, 쓰기형 control endpoint는 provider와 local token이
 * 함께 있어야 한다. 이 옵션은 server 조립 시점에 fail-closed invariant를 검사할 수 있도록 route provider와 token을 같은
 * boundary에 둔다.
 */
export interface HttpControlServerOptions {
  readinessProvider: ControlReadinessProvider;
  statusProvider: ControlStatusProvider;
  /**
   * `/kill-switch` 상태 전이를 실제 durable evidence와 후속 job으로 연결하는 provider다.
   *
   * 값이 있으면 route가 등록되고, 없으면 쓰기형 route는 열리지 않는다.
   */
  killSwitchControlProvider?: KillSwitchControlProvider;
  logger?: boolean;
  /**
   * 로컬 운영 control route를 보호하는 bearer token이다.
   *
   * POST control endpoint가 활성화된 상태에서 비어 있으면 startup guard가 부팅을 거부한다.
   */
  localControlToken?: string;
  /**
   * provider 등록 전에 POST control guard만 검증해야 하는 테스트/조립 경계를 위한 명시 flag다.
   */
  controlPostEndpointsEnabled?: boolean;
}

/**
 * HTTP control server listen 주소다.
 *
 * 기본값은 loopback이며, 외부 노출은 배포/reverse proxy가 별도로 책임진다.
 */
export interface HttpControlListenOptions {
  host?: string;
  port?: number;
}

export class UnsafeHttpControlConfigError extends Error {
  public readonly violations: readonly string[];

  public constructor(violations: readonly string[]) {
    super(`Unsafe HTTP control config: ${violations.join(", ")}`);
    this.name = "UnsafeHttpControlConfigError";
    this.violations = violations;
  }
}

export interface LocalControlAuthInput {
  authorizationHeader: string | undefined;
  expectedToken: string | undefined;
  correlationId: string;
}

export type LocalControlAuthResult =
  | {
      ok: true;
      correlationId: string;
    }
  | {
      ok: false;
      statusCode: 401 | 403 | 500;
      correlationId: string;
      code: string;
      message: string;
    };

export interface CreateDatabaseControlStatusProviderOptions {
  runtimeConfig: RuntimeConfig;
  /**
   * `/status` 전용 readiness provider다.
   *
   * 지정하지 않으면 DB write check를 제외한 경량 provider를 내부에서 만든다.
   */
  statusReadinessProvider?: ControlReadinessProvider;
  /**
   * 기존 호출부 호환을 위한 필드다.
   *
   * `/status`는 부작용 없는 관측 endpoint로 유지해야 하므로 이 provider를 직접 호출하지 않는다.
   */
  readinessProvider?: ControlReadinessProvider;
  database?: Database;
  phase15ApprovalEvidence?: readonly Phase15AltApprovalEvidenceSnapshot[];
  pilotConfig?: PilotRuntimeConfig;
  pilotEvidence?: PilotEvidenceSnapshot | null;
  /**
   * `/status.runtime.liveAutonomous`에 노출할 M22 startup guard safe summary다.
   *
   * 지정하지 않으면 현재 config와 보수적 readiness 기본값으로 fail-closed summary를 만든다.
   */
  liveAutonomousRuntime?: LiveAutonomousRuntimeSafeSummary;
  /**
   * `/status.liveAutonomousExit`에 노출할 M22 exit 연결 safe summary다.
   *
   * 실제 exit worker나 테스트 fixture가 최근 실행 결과를 이미 요약한 경우 이 값을 그대로 사용한다.
   */
  liveAutonomousExit?: LiveAutonomousExitStatusSummary;
  expectedMigrationVersion?: number;
  clock?: () => Date;
  marketData?: {
    connectionStatus?: string;
    lagMs?: number | null;
    updatedAt?: string | null;
  };
  alerts?: {
    lastSentAt?: string | null;
    lastSkippedAt?: string | null;
  };
  dailyReport?: {
    lastStatus?: string;
    reportDate?: string | null;
    updatedAt?: string | null;
  };
  /**
   * `/status`에 노출할 PnL 회계 상태 summary다.
   *
   * 테스트 fixture나 수동 조립에서만 사용한다. 운영 조립에서는 `pnlAccountingStatusProvider` 또는 DB 기반 provider를 사용한다.
   */
  pnlAccounting?: PnLAccountingStatusSummary;
  /**
   * `/status` 호출 시점에 최신 PnL snapshot 상태를 읽는 provider다.
   *
   * 지정하지 않고 DB가 있으면 `pnl_snapshots`에서 최신 safe summary를 읽는다. provider 실패는 endpoint 실패가 아니라
   * `pnl.status=unavailable`로 낮춘다.
   */
  pnlAccountingStatusProvider?: PnLAccountingStatusProvider;
  /**
   * `/status`에 노출할 reconcile 상태 summary다.
   *
   * 지정하지 않으면 SKIPPED 상태로 표시한다. 테스트 fixture나 수동 status 조립에서만 사용한다.
   */
  reconcile?: ReconcileStatusSummary;
  /**
   * `/status` 호출 시점에 최신 reconcile 상태를 읽는 provider다.
   *
   * runtime worker가 활성화된 운영 조립에서는 정적 `reconcile` 대신 이 provider를 주입해 최신 DB/worker 상태를 노출한다.
   */
  reconcileStatusProvider?: ReconcileStatusProvider;
  /**
   * `/status` 호출 시점에 M18 decision ledger why summary를 읽는 provider다.
   *
   * 지정하지 않으면 `/status` 응답에서 `why`는 `null`로 표시한다.
   * DB-backed 구현은 `createDatabaseWhySummaryProvider`를 사용한다.
   */
  whySummaryProvider?: WhySummaryProvider;
}

export interface CreateDatabaseReadinessProviderOptions {
  database?: Database;
  runtimeConfig?: RuntimeConfig;
  expectedMigrationVersion?: number;
  includeWriteCheck?: boolean;
  clock?: () => Date;
}

export type ReadinessCheck = () => Promise<ControlReadinessCheckResult>;
