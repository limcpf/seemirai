import type { KillSwitchState } from "../../domain/index.js";
import type { KillSwitchControlProvider } from "../../application/index.js";
import type { Database } from "../../infrastructure/db/index.js";
import type { RuntimeConfig } from "../../runtime/index.js";

export const DEFAULT_HTTP_CONTROL_HOST = "127.0.0.1";
export const DEFAULT_HTTP_CONTROL_PORT = 8787;

export type ControlReadinessStatus = "ok" | "fail";
export type ControlOverallStatus = "ok" | "error";

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
 * `/status`가 반환하는 운영 snapshot이다.
 *
 * 운영 판단에 필요한 runtime summary, trading state, lag, paper account 집계만 제공하며,
 * secret과 원본 runtime config는 의도적으로 제외한다.
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
    };
    liveTradingEnabled: boolean;
    paperNoKey: boolean;
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
  paper: {
    pendingPaperOrderCount: number | null;
    openPositionCount: number | null;
  };
  database: ControlReadinessSummary;
  alerts: {
    lastSentAt: string | null;
    lastSkippedAt: string | null;
  };
  dailyReport: {
    lastStatus: string;
    reportDate: string | null;
    updatedAt: string | null;
  };
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
}

export interface CreateDatabaseReadinessProviderOptions {
  database?: Database;
  runtimeConfig?: RuntimeConfig;
  expectedMigrationVersion?: number;
  includeWriteCheck?: boolean;
  clock?: () => Date;
}

export type ReadinessCheck = () => Promise<ControlReadinessCheckResult>;
