import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  DEFAULT_HTTP_CONTROL_HOST,
  DEFAULT_HTTP_CONTROL_PORT,
  UnsafeHttpControlConfigError,
  authenticateLocalControlRequest,
  createKillSwitchControlRouteHandler,
  createControlReadinessProvider,
  createDatabaseControlStatusProvider,
  createHttpControlServer,
  createLocalControlAuthPreHandler,
  getHttpControlListenOptions,
} from "../../src/interfaces/index.js";
import { getKillSwitchActionPlan, type KillSwitchState } from "../../src/domain/index.js";
import { createKillSwitchControlDecision, type KillSwitchControlProvider } from "../../src/application/index.js";
import { loadRuntimeConfig } from "../../src/runtime/index.js";
import type { Database } from "../../src/infrastructure/db/index.js";
import type {
  ControlReadinessProvider,
  ControlReadinessSummary,
  ControlStatusProvider,
  ControlStatusSnapshot,
} from "../../src/interfaces/index.js";

const checkedAt = "2026-05-20T00:00:00.000Z";

describe("HTTP control foundation", () => {
  let server: FastifyInstance | undefined;

  afterEach(async () => {
    if (server !== undefined) {
      await server.close();
      server = undefined;
    }
  });

  it("uses 127.0.0.1 as the default bind host", () => {
    expect(getHttpControlListenOptions()).toEqual({
      host: DEFAULT_HTTP_CONTROL_HOST,
      port: DEFAULT_HTTP_CONTROL_PORT,
    });
    expect(getHttpControlListenOptions({ host: "0.0.0.0", port: 9191 })).toEqual({
      host: "0.0.0.0",
      port: 9191,
    });
  });

  it("serves /healthz without checking DB readiness", async () => {
    let readinessCalls = 0;
    server = createHttpControlServer({
      readinessProvider: {
        async check() {
          readinessCalls += 1;
          throw new Error("healthz must not call readiness");
        },
      },
      statusProvider: unavailableStatusProvider(),
    });

    const response = await server.inject({
      method: "GET",
      url: "/healthz",
      headers: {
        "x-correlation-id": "corr-health",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: "ok",
      service: "seemirai",
      check: "process",
      correlationId: "corr-health",
    });
    expect(readinessCalls).toBe(0);
  });

  it("returns 503 from /readyz when a critical readiness check fails", async () => {
    server = createHttpControlServer({
      readinessProvider: staticReadinessProvider({
        status: "error",
        ready: false,
        checkedAt,
        checks: [
          {
            name: "migration_version",
            status: "fail",
            critical: true,
            checkedAt,
            message: "migration version mismatch: expected 7, got 6",
            observedValue: 6,
          },
        ],
      }),
      statusProvider: unavailableStatusProvider(),
    });

    const response = await server.inject({
      method: "GET",
      url: "/readyz",
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      status: "error",
      ready: false,
      checkedAt,
      checks: [
        {
          name: "migration_version",
          status: "fail",
          critical: true,
          checkedAt,
          message: "migration version mismatch: expected 7, got 6",
          observedValue: 6,
        },
      ],
    });
  });

  it("absorbs rejected readiness checks into a failed summary item", async () => {
    const provider = createControlReadinessProvider([
      async () => ({
        name: "runtime_config_loaded",
        status: "ok",
        critical: true,
        checkedAt,
        message: "runtime config is loaded",
        observedValue: "PAPER_TRADING",
      }),
      async () => {
        throw new Error("unexpected readiness failure");
      },
    ]);

    const summary = await provider.check();

    expect(summary.status).toBe("error");
    expect(summary.ready).toBe(false);
    expect(summary.checks).toEqual([
      expect.objectContaining({
        name: "runtime_config_loaded",
        status: "ok",
      }),
      expect.objectContaining({
        name: "readiness_check_2",
        status: "fail",
        critical: true,
        message: "unexpected readiness failure",
        observedValue: null,
      }),
    ]);
  });

  it("returns a common error response with correlationId when a route throws", async () => {
    server = createHttpControlServer({
      readinessProvider: {
        async check() {
          throw new Error("database unavailable");
        },
      },
      statusProvider: unavailableStatusProvider(),
    });

    const response = await server.inject({
      method: "GET",
      url: "/readyz",
      headers: {
        "x-correlation-id": "corr-ready-error",
      },
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({
      status: "error",
      correlationId: "corr-ready-error",
      error: {
        code: "internal_error",
        message: "internal server error",
      },
    });
  });

  it("keeps active kill switch state in /status instead of failing /readyz", async () => {
    const readiness = readySummary();
    const statusProvider = statusSnapshotProvider({
      state: "NEW_ORDERS_BLOCKED",
      blockedReason: "stale_market_data",
      database: readiness,
    });
    server = createHttpControlServer({
      readinessProvider: staticReadinessProvider(readiness),
      statusProvider,
    });

    const readyz = await server.inject({
      method: "GET",
      url: "/readyz",
    });
    const status = await server.inject({
      method: "GET",
      url: "/status",
      headers: {
        "x-correlation-id": "corr-status",
      },
    });

    expect(readyz.statusCode).toBe(200);
    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({
      status: "ok",
      correlationId: "corr-status",
      tradingState: {
        state: "NEW_ORDERS_BLOCKED",
        killSwitchState: "NEW_ORDERS_BLOCKED",
        blockedReason: "stale_market_data",
        newOrdersBlocked: true,
      },
    });
  });

  it("builds a safe /status summary without secrets or raw config", async () => {
    const runtimeConfig = loadRuntimeConfig({
      secrets: {
        telegram_bot_token: "telegram-secret-token",
        local_control_token: "local-control-secret",
      },
    });
    const readinessProvider = staticReadinessProvider(readySummary());
    server = createHttpControlServer({
      readinessProvider,
      statusProvider: createDatabaseControlStatusProvider({
        runtimeConfig,
        readinessProvider,
        marketData: {
          connectionStatus: "STALE",
          lagMs: 12_345,
          updatedAt: "2026-05-20T00:00:10.000Z",
        },
        alerts: {
          lastSentAt: "2026-05-20T00:00:20.000Z",
        },
      }),
    });

    const response = await server.inject({
      method: "GET",
      url: "/status",
    });
    const bodyText = response.body;

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      runtime: {
        exchange: "UPBIT",
        market: "KRW_SPOT",
        mode: "PAPER_TRADING",
        universe: {
          phase1: ["KRW-BTC", "KRW-ETH"],
          phase1Count: 2,
        },
        liveTradingEnabled: false,
        paperNoKey: true,
      },
      marketData: {
        connectionStatus: "STALE",
        lagMs: 12_345,
      },
      paper: {
        pendingPaperOrderCount: null,
        openPositionCount: null,
      },
    });
    expect(bodyText).not.toContain("telegram-secret-token");
    expect(bodyText).not.toContain("local-control-secret");
    expect(bodyText).not.toContain("secrets");
    expect(bodyText).not.toContain("telegram_bot_token");
    expect(bodyText).not.toContain("local_control_token");
  });

  it("keeps /status from running the write readiness provider", async () => {
    let readyzProviderCalls = 0;
    const runtimeConfig = loadRuntimeConfig({});
    server = createHttpControlServer({
      readinessProvider: staticReadinessProvider(readySummary()),
      statusProvider: createDatabaseControlStatusProvider({
        runtimeConfig,
        readinessProvider: {
          async check() {
            readyzProviderCalls += 1;
            throw new Error("status must not call readyz readiness provider");
          },
        },
      }),
    });

    const response = await server.inject({
      method: "GET",
      url: "/status",
    });

    expect(response.statusCode).toBe(200);
    expect(readyzProviderCalls).toBe(0);
    expect(response.json()).toMatchObject({
      database: {
        status: "error",
        ready: false,
        checks: [
          {
            name: "runtime_config_loaded",
            status: "ok",
          },
          {
            name: "db_connection",
            status: "fail",
          },
        ],
      },
    });
    expect(response.body).not.toContain("db_write");
  });

  it("normalizes blockedReason to null when current state does not block new orders", async () => {
    const runtimeConfig = loadRuntimeConfig({});
    server = createHttpControlServer({
      readinessProvider: staticReadinessProvider(readySummary()),
      statusProvider: createDatabaseControlStatusProvider({
        runtimeConfig,
        database: killSwitchStateDatabase({
          state: "NORMAL",
          reason_code: "initial_state",
        }),
        statusReadinessProvider: staticReadinessProvider(readySummary()),
      }),
    });

    const response = await server.inject({
      method: "GET",
      url: "/status",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      tradingState: {
        state: "NORMAL",
        blockedReason: null,
        newOrdersBlocked: false,
      },
    });
  });

  it("requires a local control token before enabling POST control endpoints", () => {
    expect(() =>
      createHttpControlServer({
        readinessProvider: staticReadinessProvider(readySummary()),
        statusProvider: unavailableStatusProvider(),
        controlPostEndpointsEnabled: true,
      }),
    ).toThrow(UnsafeHttpControlConfigError);
  });

  it("requires a kill switch provider when POST control endpoints are enabled", () => {
    expect(() =>
      createHttpControlServer({
        readinessProvider: staticReadinessProvider(readySummary()),
        statusProvider: unavailableStatusProvider(),
        controlPostEndpointsEnabled: true,
        localControlToken: "expected-token",
      }),
    ).toThrow(UnsafeHttpControlConfigError);
  });

  it("executes POST /kill-switch with local bearer auth and returns action evidence", async () => {
    let capturedTargetState: string | undefined;
    const provider: KillSwitchControlProvider = {
      async apply(input) {
        capturedTargetState = input.targetState;
        return {
          ...createKillSwitchControlDecision({
            currentState: "NORMAL",
            targetState: input.targetState,
            reasonCode: input.reasonCode,
            correlationId: input.correlationId,
            occurredAt: checkedAt,
          }),
          auditEventId: "audit-1",
          riskEventId: "risk-1",
          hardStopCancelJob: {
            jobType: "hard_stop_pending_paper_order_cancel",
            idempotencyKey: "hard_stop_pending_paper_order_cancel:corr-kill-switch",
            jobId: "job-1",
            created: true,
          },
        };
      },
    };
    server = createHttpControlServer({
      readinessProvider: staticReadinessProvider(readySummary()),
      statusProvider: unavailableStatusProvider(),
      killSwitchControlProvider: provider,
      localControlToken: "expected-token",
    });

    const missingAuth = await server.inject({
      method: "POST",
      url: "/kill-switch",
      headers: {
        "x-correlation-id": "corr-missing-kill-switch",
      },
      payload: {
        targetState: "HARD_STOP",
        reasonCode: "db_write_failure",
      },
    });
    const success = await server.inject({
      method: "POST",
      url: "/kill-switch",
      headers: {
        authorization: "Bearer expected-token",
        "x-correlation-id": "corr-kill-switch",
      },
      payload: {
        targetState: "HARD_STOP",
        reasonCode: "db_write_failure",
        actor: "operator",
      },
    });

    expect(missingAuth.statusCode).toBe(401);
    expect(missingAuth.json()).toMatchObject({
      correlationId: "corr-missing-kill-switch",
      error: {
        code: "authorization_required",
      },
    });
    expect(success.statusCode).toBe(200);
    expect(capturedTargetState).toBe("HARD_STOP");
    expect(success.json()).toMatchObject({
      status: "ok",
      correlationId: "corr-kill-switch",
      transition: {
        accepted: true,
        fromState: "NORMAL",
        toState: "HARD_STOP",
        reasonCode: "db_write_failure",
      },
      actionPlan: {
        newOrdersBlocked: true,
        strategyEvaluationBlocked: true,
        cancelPendingPaperOrders: true,
        autoLiquidateOpenPositions: false,
        requiresManualReview: true,
      },
      recommendedTargetState: "HARD_STOP",
      hardStopCancelJob: {
        jobType: "hard_stop_pending_paper_order_cancel",
        idempotencyKey: "hard_stop_pending_paper_order_cancel:corr-kill-switch",
        created: true,
      },
      evidence: {
        auditEventId: "audit-1",
        riskEventId: "risk-1",
      },
    });
  });

  it("rejects invalid kill switch target states before provider execution", async () => {
    let providerCalls = 0;
    server = createHttpControlServer({
      readinessProvider: staticReadinessProvider(readySummary()),
      statusProvider: unavailableStatusProvider(),
      killSwitchControlProvider: {
        async apply(input) {
          providerCalls += 1;
          return createKillSwitchControlDecision({
            currentState: "NORMAL",
            targetState: input.targetState,
            reasonCode: input.reasonCode,
            correlationId: input.correlationId,
            occurredAt: checkedAt,
          });
        },
      },
      localControlToken: "expected-token",
    });

    const response = await server.inject({
      method: "POST",
      url: "/kill-switch",
      headers: {
        authorization: "Bearer expected-token",
        "x-correlation-id": "corr-invalid-target",
      },
      payload: {
        targetState: "STRATEGY_PAUSED",
        reasonCode: "operator_requested_strategy_pause",
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      status: "error",
      correlationId: "corr-invalid-target",
      error: {
        code: "bad_request",
      },
    });
    expect(providerCalls).toBe(0);
  });

  it("returns 409 with correlationId when the kill switch transition is illegal", async () => {
    server = createHttpControlServer({
      readinessProvider: staticReadinessProvider(readySummary()),
      statusProvider: unavailableStatusProvider(),
      killSwitchControlProvider: {
        async apply(input) {
          return createKillSwitchControlDecision({
            currentState: "HARD_STOP",
            targetState: input.targetState,
            reasonCode: input.reasonCode,
            correlationId: input.correlationId,
            occurredAt: checkedAt,
          });
        },
      },
      localControlToken: "expected-token",
    });

    const response = await server.inject({
      method: "POST",
      url: "/kill-switch",
      headers: {
        authorization: "Bearer expected-token",
        "x-correlation-id": "corr-illegal-transition",
      },
      payload: {
        targetState: "NORMAL",
        reasonCode: "operator_recovered",
      },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      status: "error",
      correlationId: "corr-illegal-transition",
      error: {
        code: "operator_recovered",
        message: "HTTP control requested kill switch transition: HARD_STOP -> NORMAL",
      },
    });
  });

  it("validates local bearer auth with correlation-aware failures", async () => {
    expect(
      authenticateLocalControlRequest({
        authorizationHeader: undefined,
        expectedToken: "expected-token",
        correlationId: "corr-auth",
      }),
    ).toMatchObject({
      ok: false,
      statusCode: 401,
      correlationId: "corr-auth",
      code: "authorization_required",
    });
    expect(
      authenticateLocalControlRequest({
        authorizationHeader: "Bearer wrong-token",
        expectedToken: "expected-token",
        correlationId: "corr-auth",
      }),
    ).toMatchObject({
      ok: false,
      statusCode: 403,
      correlationId: "corr-auth",
      code: "invalid_local_control_token",
    });
    expect(
      authenticateLocalControlRequest({
        authorizationHeader: "bearer expected-token",
        expectedToken: "expected-token",
        correlationId: "corr-auth",
      }),
    ).toEqual({
      ok: true,
      correlationId: "corr-auth",
    });
  });

  it("provides a reusable Fastify preHandler for future POST control routes", async () => {
    expect(() => createLocalControlAuthPreHandler(undefined)).toThrow(UnsafeHttpControlConfigError);

    server = createHttpControlServer({
      readinessProvider: staticReadinessProvider(readySummary()),
      statusProvider: unavailableStatusProvider(),
    });
    server.post(
      "/test-control",
      {
        preHandler: createLocalControlAuthPreHandler("expected-token"),
      },
      async () => ({
        status: "ok",
      }),
    );

    const missing = await server.inject({
      method: "POST",
      url: "/test-control",
      headers: {
        "x-correlation-id": "corr-missing",
      },
    });
    const mismatch = await server.inject({
      method: "POST",
      url: "/test-control",
      headers: {
        authorization: "Bearer wrong-token",
        "x-correlation-id": "corr-mismatch",
      },
    });
    const success = await server.inject({
      method: "POST",
      url: "/test-control",
      headers: {
        authorization: "bearer expected-token",
      },
    });

    expect(missing.statusCode).toBe(401);
    expect(missing.json()).toMatchObject({
      status: "error",
      correlationId: "corr-missing",
      error: {
        code: "authorization_required",
      },
    });
    expect(mismatch.statusCode).toBe(403);
    expect(mismatch.json()).toMatchObject({
      status: "error",
      correlationId: "corr-mismatch",
      error: {
        code: "invalid_local_control_token",
      },
    });
    expect(success.statusCode).toBe(200);
    expect(success.json()).toEqual({
      status: "ok",
    });
  });

  it("keeps the standalone kill switch route handler reusable", async () => {
    server = createHttpControlServer({
      readinessProvider: staticReadinessProvider(readySummary()),
      statusProvider: unavailableStatusProvider(),
    });
    server.post(
      "/standalone-kill-switch",
      createKillSwitchControlRouteHandler({
        async apply(input) {
          return createKillSwitchControlDecision({
            currentState: "NORMAL",
            targetState: input.targetState,
            reasonCode: input.reasonCode,
            correlationId: input.correlationId,
            occurredAt: checkedAt,
          });
        },
      }),
    );

    const response = await server.inject({
      method: "POST",
      url: "/standalone-kill-switch",
      payload: {
        targetState: "NEW_ORDERS_BLOCKED",
        reasonCode: "stale_market_data",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      transition: {
        toState: "NEW_ORDERS_BLOCKED",
      },
      actionPlan: {
        newOrdersBlocked: true,
      },
    });
  });
});

function staticReadinessProvider(summary: ControlReadinessSummary): ControlReadinessProvider {
  return {
    async check() {
      return summary;
    },
  };
}

function readySummary(): ControlReadinessSummary {
  return {
    status: "ok",
    ready: true,
    checkedAt,
    checks: [
      {
        name: "runtime_config_loaded",
        status: "ok",
        critical: true,
        checkedAt,
        message: "runtime config is loaded",
        observedValue: "PAPER_TRADING",
      },
    ],
  };
}

function unavailableStatusProvider(): ControlStatusProvider {
  return statusSnapshotProvider({
    state: "NORMAL",
    blockedReason: null,
    database: readySummary(),
  });
}

function killSwitchStateDatabase(row: { state: KillSwitchState; reason_code: string | null }): Database {
  const query = {
    select() {
      return query;
    },
    where() {
      return query;
    },
    async executeTakeFirst() {
      return row;
    },
  };

  return {
    selectFrom(tableName: string) {
      if (tableName !== "kill_switch_state") {
        throw new Error(`unexpected table: ${tableName}`);
      }
      return query;
    },
  } as unknown as Database;
}

function statusSnapshotProvider(input: {
  state: KillSwitchState;
  blockedReason: string | null;
  database: ControlReadinessSummary;
}): ControlStatusProvider {
  const actionPlan = getKillSwitchActionPlan(input.state);
  return {
    async getStatus(): Promise<ControlStatusSnapshot> {
      return {
        generatedAt: checkedAt,
        runtime: {
          exchange: "UPBIT",
          market: "KRW_SPOT",
          mode: "PAPER_TRADING",
          universe: {
            phase1: ["KRW-BTC", "KRW-ETH"],
            phase1Count: 2,
          },
          liveTradingEnabled: false,
          paperNoKey: true,
        },
        tradingState: {
          state: input.state,
          killSwitchState: input.state,
          blockedReason: input.blockedReason,
          newOrdersBlocked: actionPlan.newOrdersBlocked,
          requiresManualReview: actionPlan.requiresManualReview,
        },
        marketData: {
          connectionStatus: "unknown",
          lagMs: null,
          updatedAt: null,
        },
        paper: {
          pendingPaperOrderCount: null,
          openPositionCount: null,
        },
        database: input.database,
        alerts: {
          lastSentAt: null,
          lastSkippedAt: null,
        },
        dailyReport: {
          lastStatus: "unavailable",
          reportDate: null,
          updatedAt: null,
        },
      };
    },
  };
}
