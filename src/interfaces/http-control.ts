import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import Fastify from "fastify";
import type { FastifyInstance, FastifyReply, FastifyRequest, RouteShorthandOptions } from "fastify";
import { sql } from "kysely";
import type { RuntimeConfig } from "../runtime/index.js";
import type { Database } from "../infrastructure/db/index.js";
import type { KillSwitchState } from "../domain/index.js";
import { getKillSwitchActionPlan } from "../domain/index.js";

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

class ReadinessWriteRollback extends Error {
  public constructor() {
    super("readyz write check rollback");
    this.name = "ReadinessWriteRollback";
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

type ReadinessCheck = () => Promise<ControlReadinessCheckResult>;

const readinessCheckSchema = {
  type: "object",
  required: ["name", "status", "critical", "checkedAt", "message", "observedValue"],
  properties: {
    name: { type: "string" },
    status: { enum: ["ok", "fail"] },
    critical: { type: "boolean" },
    checkedAt: { type: "string" },
    message: { type: "string" },
    observedValue: { type: ["string", "number", "boolean", "null"] },
  },
} as const;

const readinessResponseSchema = {
  type: "object",
  required: ["status", "ready", "checkedAt", "checks"],
  properties: {
    status: { enum: ["ok", "error"] },
    ready: { type: "boolean" },
    checkedAt: { type: "string" },
    checks: {
      type: "array",
      items: readinessCheckSchema,
    },
  },
} as const;

const nullableOperationalStatusSchema = {
  type: "object",
  required: ["connectionStatus", "lagMs", "updatedAt"],
  properties: {
    connectionStatus: { type: "string" },
    lagMs: { type: ["number", "null"] },
    updatedAt: { type: ["string", "null"] },
  },
} as const;

const errorResponseSchema = {
  type: "object",
  required: ["status", "correlationId", "error"],
  properties: {
    status: { const: "error" },
    correlationId: { type: "string" },
    error: {
      type: "object",
      required: ["code", "message"],
      properties: {
        code: { type: "string" },
        message: { type: "string" },
      },
    },
  },
} as const;

const healthzRouteOptions: RouteShorthandOptions = {
  schema: {
    response: {
      200: {
        type: "object",
        required: ["status", "service", "check", "timestamp", "uptimeSeconds", "correlationId"],
        properties: {
          status: { const: "ok" },
          service: { const: "seemirai" },
          check: { const: "process" },
          timestamp: { type: "string" },
          uptimeSeconds: { type: "number" },
          correlationId: { type: "string" },
        },
      },
      500: errorResponseSchema,
    },
  },
};

const readyzRouteOptions: RouteShorthandOptions = {
  schema: {
    response: {
      200: readinessResponseSchema,
      503: readinessResponseSchema,
      500: errorResponseSchema,
    },
  },
};

const statusRouteOptions: RouteShorthandOptions = {
  schema: {
    response: {
      200: {
        type: "object",
        required: [
          "status",
          "correlationId",
          "generatedAt",
          "runtime",
          "tradingState",
          "marketData",
          "paper",
          "database",
          "alerts",
          "dailyReport",
        ],
        properties: {
          status: { const: "ok" },
          correlationId: { type: "string" },
          generatedAt: { type: "string" },
          runtime: {
            type: "object",
            required: ["exchange", "market", "mode", "universe", "liveTradingEnabled", "paperNoKey"],
            properties: {
              exchange: { type: "string" },
              market: { type: "string" },
              mode: { type: "string" },
              universe: {
                type: "object",
                required: ["phase1", "phase1Count"],
                properties: {
                  phase1: { type: "array", items: { type: "string" } },
                  phase1Count: { type: "number" },
                },
              },
              liveTradingEnabled: { type: "boolean" },
              paperNoKey: { type: "boolean" },
            },
          },
          tradingState: {
            type: "object",
            required: [
              "state",
              "killSwitchState",
              "blockedReason",
              "newOrdersBlocked",
              "requiresManualReview",
            ],
            properties: {
              state: { type: "string" },
              killSwitchState: { type: "string" },
              blockedReason: { type: ["string", "null"] },
              newOrdersBlocked: { type: "boolean" },
              requiresManualReview: { type: "boolean" },
            },
          },
          marketData: nullableOperationalStatusSchema,
          paper: {
            type: "object",
            required: ["pendingPaperOrderCount", "openPositionCount"],
            properties: {
              pendingPaperOrderCount: { type: ["number", "null"] },
              openPositionCount: { type: ["number", "null"] },
            },
          },
          database: readinessResponseSchema,
          alerts: {
            type: "object",
            required: ["lastSentAt", "lastSkippedAt"],
            properties: {
              lastSentAt: { type: ["string", "null"] },
              lastSkippedAt: { type: ["string", "null"] },
            },
          },
          dailyReport: {
            type: "object",
            required: ["lastStatus", "reportDate", "updatedAt"],
            properties: {
              lastStatus: { type: "string" },
              reportDate: { type: ["string", "null"] },
              updatedAt: { type: ["string", "null"] },
            },
          },
        },
      },
      500: errorResponseSchema,
    },
  },
};

/**
 * M8 HTTP control API의 최소 Fastify server를 만든다.
 *
 * Sub PR 1은 읽기 전용 health/readiness/status endpoint와 POST control endpoint가 쓸 공통 bearer guard만 고정한다.
 * kill switch 상태 전이 실행은 후속 PR에서 이 foundation 위에 얹는다.
 *
 * - `/healthz`: 프로세스 생존 확인만 수행한다.
 * - `/readyz`: DB, migration, runtime config처럼 worker 기동에 필요한 의존성을 판단한다.
 * - `/status`: trading state와 운영 snapshot을 secret 없이 반환한다.
 */
export function createHttpControlServer(options: HttpControlServerOptions): FastifyInstance {
  assertHttpControlConfig(options);

  const server = Fastify({
    logger: options.logger ?? false,
  });

  server.setErrorHandler((error, request, reply) => {
    const statusCode = getErrorStatusCode(error);
    // 5xx에서는 내부 예외 message를 숨기고 correlation id만 남겨 로그 추적 경계를 유지한다.
    return reply.status(statusCode).send(
      createErrorResponse({
        correlationId: getCorrelationId(request),
        code: statusCode >= 500 ? "internal_error" : "bad_request",
        message: statusCode >= 500 ? "internal server error" : toErrorMessage(error),
      }),
    );
  });

  // healthz는 DB 장애와 분리된 process liveness만 확인해 supervisor restart 오판을 줄인다.
  server.get("/healthz", healthzRouteOptions, async (request) => ({
    status: "ok",
    service: "seemirai",
    check: "process",
    timestamp: new Date().toISOString(),
    uptimeSeconds: process.uptime(),
    correlationId: getCorrelationId(request),
  }));

  server.get("/readyz", readyzRouteOptions, async (_request, reply) => {
    const readiness = await options.readinessProvider.check();
    // critical readiness 실패는 traffic과 worker 기동 차단을 위해 HTTP 503으로 드러낸다.
    return reply.status(readiness.ready ? 200 : 503).send(readiness);
  });

  server.get("/status", statusRouteOptions, async (request) => {
    const snapshot = await options.statusProvider.getStatus();
    // status는 거래 차단 상태를 포함하되 readiness 실패와 독립적으로 관측 가능해야 한다.
    return {
      status: "ok",
      correlationId: getCorrelationId(request),
      ...snapshot,
    };
  });

  return server;
}

/**
 * HTTP server listen 기본값을 고정한다.
 */
export function getHttpControlListenOptions(
  options: HttpControlListenOptions = {},
): Required<HttpControlListenOptions> {
  return {
    host: options.host ?? DEFAULT_HTTP_CONTROL_HOST,
    port: options.port ?? DEFAULT_HTTP_CONTROL_PORT,
  };
}

/**
 * POST control endpoint가 켜질 때 local token 누락으로 시작하지 않도록 막는다.
 */
export function assertHttpControlConfig(options: {
  controlPostEndpointsEnabled?: boolean;
  localControlToken?: string;
}): void {
  const violations: string[] = [];

  if (options.controlPostEndpointsEnabled && isBlankToken(options.localControlToken)) {
    // 쓰기형 control route가 무인증으로 열리는 설정은 시작 시점에 바로 차단한다.
    violations.push("local control token is required when POST control endpoints are enabled");
  }

  if (violations.length > 0) {
    throw new UnsafeHttpControlConfigError(violations);
  }
}

/**
 * 후속 POST control route에서 재사용할 local bearer token 검증 함수다.
 *
 * 실패 사유별 status code와 error code를 분리해 운영자가 인증 누락, 형식 오류, token 불일치를 구분할 수 있게 한다.
 */
export function authenticateLocalControlRequest(input: LocalControlAuthInput): LocalControlAuthResult {
  const expectedToken = normalizeToken(input.expectedToken);
  if (expectedToken === undefined) {
    // 보호 route가 token 없이 조립된 상태는 요청자 문제가 아니라 서버 설정 오류로 본다.
    return {
      ok: false,
      statusCode: 500,
      correlationId: input.correlationId,
      code: "local_control_token_not_configured",
      message: "local control token is not configured",
    };
  }

  if (input.authorizationHeader === undefined || input.authorizationHeader.trim() === "") {
    // header 자체가 없으면 credential challenge가 가능한 인증 누락으로 응답한다.
    return {
      ok: false,
      statusCode: 401,
      correlationId: input.correlationId,
      code: "authorization_required",
      message: "Authorization bearer token is required",
    };
  }

  const match = /^Bearer\s+(?<token>.+)$/iu.exec(input.authorizationHeader.trim());
  if (match?.groups?.token === undefined || match.groups.token.trim() === "") {
    // scheme은 대소문자를 허용하되 Bearer token 형식 자체는 엄격하게 유지한다.
    return {
      ok: false,
      statusCode: 401,
      correlationId: input.correlationId,
      code: "invalid_authorization_format",
      message: "Authorization must use Bearer token format",
    };
  }

  if (!constantTimeTokenEquals(match.groups.token, expectedToken)) {
    // token이 존재하지만 일치하지 않으면 인증 시도 실패로 보고 권한 거부를 반환한다.
    return {
      ok: false,
      statusCode: 403,
      correlationId: input.correlationId,
      code: "invalid_local_control_token",
      message: "local control token does not match",
    };
  }

  return {
    ok: true,
    correlationId: input.correlationId,
  };
}

/**
 * Fastify route `preHandler`로 쓸 bearer guard를 만든다.
 *
 * route 등록 시점에 token이 없으면 예외를 던져, 보호 route가 실수로 열린 상태로 부팅되지 않게 한다.
 */
export function createLocalControlAuthPreHandler(expectedToken: string | undefined) {
  const normalizedToken = normalizeToken(expectedToken);
  if (normalizedToken === undefined) {
    throw new UnsafeHttpControlConfigError([
      "local control token is required for protected control routes",
    ]);
  }

  return async (request: FastifyRequest, reply: FastifyReply) => {
    const result = authenticateLocalControlRequest({
      authorizationHeader: readAuthorizationHeader(request),
      expectedToken: normalizedToken,
      correlationId: getCorrelationId(request),
    });

    if (!result.ok) {
      // route handler로 진입하기 전에 공통 error shape으로 인증 실패를 종료한다.
      return reply.status(result.statusCode).send(
        createErrorResponse({
          correlationId: result.correlationId,
          code: result.code,
          message: result.message,
        }),
      );
    }
  };
}

/**
 * readiness check 묶음을 하나의 provider로 합친다.
 *
 * 각 check는 독립적으로 실행되며, 최종 ready 여부는 critical check의 성공 여부로만 계산한다.
 */
export function createControlReadinessProvider(checks: readonly ReadinessCheck[]): ControlReadinessProvider {
  return {
    async check(): Promise<ControlReadinessSummary> {
      const results = await Promise.all(checks.map((check) => check()));
      return toReadinessSummary(results, new Date().toISOString());
    },
  };
}

/**
 * PostgreSQL/TimescaleDB와 runtime config loaded 상태를 확인하는 기본 readiness provider다.
 *
 * HTTP control layer의 기본 readiness는 process 생존이 아니라 worker가 안전하게 실행될 수 있는지에 맞춘다.
 */
export function createDatabaseControlReadinessProvider(
  options: CreateDatabaseReadinessProviderOptions,
): ControlReadinessProvider {
  const clock = options.clock ?? (() => new Date());
  const checks: ReadinessCheck[] = [
    createRuntimeConfigLoadedCheck(options.runtimeConfig, clock),
    createDatabaseConnectionCheck(options.database, clock),
    createDatabaseWriteCheck(options.database, clock),
  ];

  if (options.expectedMigrationVersion !== undefined) {
    // 배포된 코드와 DB schema가 어긋난 상태에서는 worker를 ready로 올리지 않는다.
    checks.push(createMigrationVersionCheck(options.database, options.expectedMigrationVersion, clock));
  }

  return createControlReadinessProvider(checks);
}

/**
 * DB snapshot과 safe runtime config만 사용해 `/status` payload를 만든다.
 *
 * status는 운영 대시보드와 수동 점검을 위한 관측면이므로,
 * 일부 집계 조회가 실패해도 endpoint 전체를 실패시키기보다 null로 표시한다.
 */
export function createDatabaseControlStatusProvider(
  options: CreateDatabaseControlStatusProviderOptions,
): ControlStatusProvider {
  const clock = options.clock ?? (() => new Date());

  return {
    async getStatus(): Promise<ControlStatusSnapshot> {
      const killSwitch = await readKillSwitchStatus(options.database);
      const actionPlan = getKillSwitchActionPlan(killSwitch.state);
      const readiness = await options.readinessProvider.check();
      // kill switch action plan은 상태 문자열을 실제 주문 차단/수동 검토 신호로 변환하는 경계다.
      return {
        generatedAt: clock().toISOString(),
        runtime: toSafeRuntimeSummary(options.runtimeConfig),
        tradingState: {
          state: killSwitch.state,
          killSwitchState: killSwitch.state,
          blockedReason: killSwitch.reasonCode,
          newOrdersBlocked: actionPlan.newOrdersBlocked,
          requiresManualReview: actionPlan.requiresManualReview,
        },
        marketData: {
          connectionStatus: options.marketData?.connectionStatus ?? "unknown",
          lagMs: options.marketData?.lagMs ?? null,
          updatedAt: options.marketData?.updatedAt ?? null,
        },
        paper: {
          pendingPaperOrderCount: await countPendingPaperOrders(options.database),
          openPositionCount: await countOpenPositions(options.database),
        },
        database: readiness,
        alerts: {
          lastSentAt: options.alerts?.lastSentAt ?? null,
          lastSkippedAt: options.alerts?.lastSkippedAt ?? null,
        },
        dailyReport: {
          lastStatus: options.dailyReport?.lastStatus ?? "unavailable",
          reportDate: options.dailyReport?.reportDate ?? null,
          updatedAt: options.dailyReport?.updatedAt ?? null,
        },
      };
    },
  };
}

/**
 * runtime config loader가 성공했는지 확인한다.
 *
 * config가 없으면 거래소, mode, universe 기준을 알 수 없으므로 critical readiness 실패로 처리한다.
 */
function createRuntimeConfigLoadedCheck(
  runtimeConfig: RuntimeConfig | undefined,
  clock: () => Date,
): ReadinessCheck {
  return async () => ({
    name: "runtime_config_loaded",
    status: runtimeConfig === undefined ? "fail" : "ok",
    critical: true,
    checkedAt: clock().toISOString(),
    message: runtimeConfig === undefined ? "runtime config is not loaded" : "runtime config is loaded",
    observedValue: runtimeConfig === undefined ? null : runtimeConfig.mode,
  });
}

/**
 * DB 접속 가능 여부를 가장 작은 read query로 확인한다.
 */
function createDatabaseConnectionCheck(database: Database | undefined, clock: () => Date): ReadinessCheck {
  return async () => {
    if (database === undefined) {
      return failedCheck("db_connection", "database is not configured", null, clock);
    }

    try {
      const result = await sql<{ ok: number }>`SELECT 1::int AS ok`.execute(database);
      return passedCheck("db_connection", "database connection is available", result.rows[0]?.ok ?? null, clock);
    } catch (error) {
      return failedCheck("db_connection", toErrorMessage(error), null, clock);
    }
  };
}

/**
 * 실제 애플리케이션 table에 쓰기 권한이 있는지 확인한다.
 *
 * TEMP table은 운영 schema 권한 문제를 놓칠 수 있으므로 `jobs`에 rollback insert를 수행한다.
 */
function createDatabaseWriteCheck(database: Database | undefined, clock: () => Date): ReadinessCheck {
  return async () => {
    if (database === undefined) {
      return failedCheck("db_write", "database is not configured", null, clock);
    }

    try {
      await database.transaction().execute(async (transaction) => {
        // 실제 앱 table 쓰기 권한을 확인한 뒤 의도적 rollback으로 데이터 흔적을 남기지 않는다.
        await transaction
          .insertInto("jobs")
          .values({
            job_type: "readyz.write_check",
            idempotency_key: `readyz.write_check:${randomUUID()}`,
            payload_json: {
              source: "http_control.readyz",
            },
            status: "PENDING",
          })
          .execute();
        throw new ReadinessWriteRollback();
      });
      return passedCheck("db_write", "database write check succeeded", true, clock);
    } catch (error) {
      if (error instanceof ReadinessWriteRollback) {
        // 의도한 rollback은 쓰기 권한 확인 성공 신호로 해석한다.
        return passedCheck("db_write", "database write check succeeded", true, clock);
      }

      return failedCheck("db_write", toErrorMessage(error), false, clock);
    }
  };
}

/**
 * 코드가 기대하는 migration version과 DB가 실제 적용한 version을 비교한다.
 */
function createMigrationVersionCheck(
  database: Database | undefined,
  expectedMigrationVersion: number,
  clock: () => Date,
): ReadinessCheck {
  return async () => {
    if (database === undefined) {
      return failedCheck("migration_version", "database is not configured", null, clock);
    }

    try {
      const result = await sql<{ version: number | null }>`
        SELECT max(version)::int AS version
        FROM schema_migrations
      `.execute(database);
      const version = result.rows[0]?.version ?? null;
      if (version !== expectedMigrationVersion) {
        // schema mismatch는 런타임 쿼리 실패로 이어질 수 있으므로 readiness에서 선제 차단한다.
        return failedCheck(
          "migration_version",
          `migration version mismatch: expected ${expectedMigrationVersion}, got ${String(version)}`,
          version,
          clock,
        );
      }

      return passedCheck("migration_version", "migration version matches", version, clock);
    } catch (error) {
      return failedCheck("migration_version", toErrorMessage(error), null, clock);
    }
  };
}

/**
 * critical check 결과를 `/readyz` 최종 판단으로 접는다.
 */
function toReadinessSummary(
  checks: readonly ControlReadinessCheckResult[],
  checkedAt: string,
): ControlReadinessSummary {
  const ready = checks.every((check) => !check.critical || check.status === "ok");
  return {
    status: ready ? "ok" : "error",
    ready,
    checkedAt,
    checks,
  };
}

function passedCheck(
  name: string,
  message: string,
  observedValue: string | number | boolean | null,
  clock: () => Date,
): ControlReadinessCheckResult {
  return {
    name,
    status: "ok",
    critical: true,
    checkedAt: clock().toISOString(),
    message,
    observedValue,
  };
}

function failedCheck(
  name: string,
  message: string,
  observedValue: string | number | boolean | null,
  clock: () => Date,
): ControlReadinessCheckResult {
  return {
    name,
    status: "fail",
    critical: true,
    checkedAt: clock().toISOString(),
    message,
    observedValue,
  };
}

/**
 * durable kill switch state를 읽어 `/status` tradingState로 전달한다.
 *
 * DB가 없을 때는 local/dev 환경의 기본값으로 NORMAL을 쓰고,
 * DB 조회 실패나 row 누락은 운영에서 안전한 MANUAL_REVIEW_REQUIRED로 닫는다.
 */
async function readKillSwitchStatus(
  database: Database | undefined,
): Promise<{ state: KillSwitchState; reasonCode: string | null }> {
  if (database === undefined) {
    return {
      state: "NORMAL",
      reasonCode: null,
    };
  }

  const row = await database
    .selectFrom("kill_switch_state")
    .select(["state", "reason_code"])
    .where("scope", "=", "global")
    .executeTakeFirst()
    .catch(() => undefined);

  // durable state를 읽지 못하면 운영 화면에서 정상 상태로 보이지 않게 수동 검토 상태로 닫는다.
  return {
    state: row?.state ?? "MANUAL_REVIEW_REQUIRED",
    reasonCode: row?.reason_code ?? "kill_switch_state_unavailable",
  };
}

/**
 * status용 paper 주문 대기 건수를 계산한다.
 *
 * 이 값은 관측 편의용이므로 조회 실패 시 `/status` 전체 실패 대신 null로 낮춘다.
 */
async function countPendingPaperOrders(database: Database | undefined): Promise<number | null> {
  if (database === undefined) {
    return null;
  }

  const result = await sql<{ count: string }>`
      SELECT count(*)::text AS count
      FROM orders
      WHERE status IN ('SUBMITTED', 'ACCEPTED', 'PARTIALLY_FILLED', 'CANCEL_REQUESTED')
    `
    .execute(database)
    .catch(() => undefined);
  if (result === undefined) {
    // 주문 집계 실패는 readiness 실패와 별개로 status snapshot에서 unknown으로 표현한다.
    return null;
  }

  return Number(result.rows[0]?.count ?? "0");
}

/**
 * status용 open position 수를 계산한다.
 *
 * 포지션 집계도 관측 정보이므로 DB 오류를 endpoint 실패로 확대하지 않는다.
 */
async function countOpenPositions(database: Database | undefined): Promise<number | null> {
  if (database === undefined) {
    return null;
  }

  const result = await sql<{ count: string }>`
      SELECT count(*)::text AS count
      FROM positions
      WHERE quantity::numeric <> 0
    `
    .execute(database)
    .catch(() => undefined);
  if (result === undefined) {
    // 포지션 집계 실패는 운영자가 구분할 수 있도록 null로 남긴다.
    return null;
  }

  return Number(result.rows[0]?.count ?? "0");
}

/**
 * runtime config에서 운영 노출이 안전한 필드만 골라낸다.
 */
function toSafeRuntimeSummary(config: RuntimeConfig): ControlStatusSnapshot["runtime"] {
  return {
    exchange: config.exchange,
    market: config.market,
    mode: config.mode,
    universe: {
      phase1: config.universe.phase_1,
      phase1Count: config.universe.phase_1.length,
    },
    liveTradingEnabled: config.live_trading_enabled,
    paperNoKey: config.paper_no_key,
  };
}

/**
 * 모든 HTTP control 오류 응답의 외부 노출 모양을 고정한다.
 */
function createErrorResponse(input: { correlationId: string; code: string; message: string }) {
  return {
    status: "error",
    correlationId: input.correlationId,
    error: {
      code: input.code,
      message: input.message,
    },
  };
}

/**
 * route 간 공통 correlation id를 읽는다.
 */
function getCorrelationId(request: FastifyRequest): string {
  const header = request.headers["x-correlation-id"];
  if (typeof header === "string" && header.trim() !== "") {
    return header;
  }
  return request.id;
}

function readAuthorizationHeader(request: FastifyRequest): string | undefined {
  const authorization = request.headers.authorization;
  return typeof authorization === "string" ? authorization : undefined;
}

function isBlankToken(token: string | undefined): boolean {
  return normalizeToken(token) === undefined;
}

function normalizeToken(token: string | undefined): string | undefined {
  if (token === undefined) {
    return undefined;
  }

  const trimmed = token.trim();
  return trimmed === "" ? undefined : trimmed;
}

/**
 * token 비교 시 입력 길이와 byte 단위 비교 시간을 직접 노출하지 않도록 digest끼리 비교한다.
 */
function constantTimeTokenEquals(actual: string, expected: string): boolean {
  return timingSafeEqual(sha256(actual), sha256(expected));
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}

function getErrorStatusCode(error: unknown): number {
  const statusCode = readNumericProperty(error, "statusCode") ?? readNumericProperty(error, "status");
  if (statusCode === undefined || statusCode < 400) {
    return 500;
  }

  return statusCode;
}

function readNumericProperty(error: unknown, property: "status" | "statusCode"): number | undefined {
  if (typeof error !== "object" || error === null || !(property in error)) {
    return undefined;
  }

  const value = (error as Record<string, unknown>)[property];
  return typeof value === "number" ? value : undefined;
}

function sha256(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}
