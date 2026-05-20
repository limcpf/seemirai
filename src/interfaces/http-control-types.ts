import type { KillSwitchState } from "../domain/index.js";
import type { Database } from "../infrastructure/db/index.js";
import type { RuntimeConfig } from "../runtime/index.js";

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
 * POST control endpoint는 후속 PR에서 활성화될 예정이므로,
 * foundation 단계에서도 token 설정과 guard 경계를 같은 옵션에 고정한다.
 */
export interface HttpControlServerOptions {
  readinessProvider: ControlReadinessProvider;
  statusProvider: ControlStatusProvider;
  logger?: boolean;
  localControlToken?: string;
  controlPostEndpointsEnabled?: boolean;
}

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
  readinessProvider: ControlReadinessProvider;
  database?: Database;
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
  clock?: () => Date;
}

export type ReadinessCheck = () => Promise<ControlReadinessCheckResult>;
