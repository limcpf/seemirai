import { createHash, timingSafeEqual } from "node:crypto";
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

export interface ControlReadinessCheckResult {
  name: string;
  status: ControlReadinessStatus;
  critical: boolean;
  checkedAt: string;
  message: string;
  observedValue: string | number | boolean | null;
}

export interface ControlReadinessSummary {
  status: ControlOverallStatus;
  ready: boolean;
  checkedAt: string;
  checks: readonly ControlReadinessCheckResult[];
}

export interface ControlReadinessProvider {
  check(): Promise<ControlReadinessSummary>;
}

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
 */
export function createHttpControlServer(options: HttpControlServerOptions): FastifyInstance {
  assertHttpControlConfig(options);

  const server = Fastify({
    logger: options.logger ?? false,
  });

  server.setErrorHandler((error, request, reply) => {
    const statusCode = getErrorStatusCode(error);
    return reply.status(statusCode).send(
      createErrorResponse({
        correlationId: getCorrelationId(request),
        code: statusCode >= 500 ? "internal_error" : "bad_request",
        message: statusCode >= 500 ? "internal server error" : toErrorMessage(error),
      }),
    );
  });

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
    return reply.status(readiness.ready ? 200 : 503).send(readiness);
  });

  server.get("/status", statusRouteOptions, async (request) => {
    const snapshot = await options.statusProvider.getStatus();
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
    violations.push("local control token is required when POST control endpoints are enabled");
  }

  if (violations.length > 0) {
    throw new UnsafeHttpControlConfigError(violations);
  }
}

/**
 * 후속 POST control route에서 재사용할 local bearer token 검증 함수다.
 */
export function authenticateLocalControlRequest(input: LocalControlAuthInput): LocalControlAuthResult {
  const expectedToken = normalizeToken(input.expectedToken);
  if (expectedToken === undefined) {
    return {
      ok: false,
      statusCode: 500,
      correlationId: input.correlationId,
      code: "local_control_token_not_configured",
      message: "local control token is not configured",
    };
  }

  if (input.authorizationHeader === undefined || input.authorizationHeader.trim() === "") {
    return {
      ok: false,
      statusCode: 401,
      correlationId: input.correlationId,
      code: "authorization_required",
      message: "Authorization bearer token is required",
    };
  }

  const match = /^Bearer (?<token>.+)$/u.exec(input.authorizationHeader);
  if (match?.groups?.token === undefined || match.groups.token.trim() === "") {
    return {
      ok: false,
      statusCode: 401,
      correlationId: input.correlationId,
      code: "invalid_authorization_format",
      message: "Authorization must use Bearer token format",
    };
  }

  if (!constantTimeTokenEquals(match.groups.token, expectedToken)) {
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
 */
export function createLocalControlAuthPreHandler(expectedToken: string | undefined) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const result = authenticateLocalControlRequest({
      authorizationHeader: readAuthorizationHeader(request),
      expectedToken,
      correlationId: getCorrelationId(request),
    });

    if (!result.ok) {
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
    checks.push(createMigrationVersionCheck(options.database, options.expectedMigrationVersion, clock));
  }

  return createControlReadinessProvider(checks);
}

/**
 * DB snapshot과 safe runtime config만 사용해 `/status` payload를 만든다.
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

function createDatabaseWriteCheck(database: Database | undefined, clock: () => Date): ReadinessCheck {
  return async () => {
    if (database === undefined) {
      return failedCheck("db_write", "database is not configured", null, clock);
    }

    try {
      await database.transaction().execute(async (transaction) => {
        await sql`
          CREATE TEMP TABLE IF NOT EXISTS seemirai_readyz_write_check (
            id integer NOT NULL
          ) ON COMMIT DROP
        `.execute(transaction);
        await sql`INSERT INTO seemirai_readyz_write_check (id) VALUES (1)`.execute(transaction);
      });
      return passedCheck("db_write", "database write check succeeded", true, clock);
    } catch (error) {
      return failedCheck("db_write", toErrorMessage(error), false, clock);
    }
  };
}

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
    return null;
  }

  return Number(result.rows[0]?.count ?? "0");
}

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
    return null;
  }

  return Number(result.rows[0]?.count ?? "0");
}

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
