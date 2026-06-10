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
import {
  getKillSwitchActionPlan,
  type KillSwitchState,
  type Phase15AltApprovalEvidenceCondition,
  type Phase15AltApprovalEvidenceSnapshot,
} from "../../src/domain/index.js";
import {
  createKillSwitchControlDecision,
  type KillSwitchControlProvider,
  type PnLAccountingStatusSummary,
} from "../../src/application/index.js";
import { loadPilotRuntimeConfigFromEnv, loadRuntimeConfig } from "../../src/runtime/index.js";
import { createDatabaseWhySummaryProvider } from "../../src/infrastructure/db/index.js";
import type { Database } from "../../src/infrastructure/db/index.js";
import type {
  ControlReadinessProvider,
  ControlReadinessSummary,
  ControlStatusProvider,
  ControlStatusSnapshot,
  WhySummary,
  WhySummaryProvider,
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
      universe: {
        phase_1_5: {
          enabled: true,
          candidate_markets: ["KRW-SOL"],
          manual_approvals: [
            {
              market: "KRW-SOL",
              approved_at: "2026-06-01T00:00:00.000Z",
            },
          ],
        },
      },
    });
    const readinessProvider = staticReadinessProvider(readySummary());
    const pilotConfig = loadPilotRuntimeConfigFromEnv({
      SEEMIRAI_PILOT_PROFILE: "PILOT_POLICY_SYNC",
      SEEMIRAI_RUN_UPBIT_PRIVATE_SMOKE: "1",
      SEEMIRAI_UPBIT_ACCESS_KEY: "upbit-access-key-secret",
      SEEMIRAI_UPBIT_SECRET_KEY: "upbit-secret-key-secret",
      SEEMIRAI_UPBIT_KEY_SCOPE: "자산조회,주문조회",
      SEEMIRAI_UPBIT_KEY_SCOPE_EVIDENCE_ID: "scope-evidence-2026-06-01",
      SEEMIRAI_UPBIT_POLICY_SYNC_MARKET: "KRW-BTC",
    });
    server = createHttpControlServer({
      readinessProvider,
      statusProvider: createDatabaseControlStatusProvider({
        runtimeConfig,
        pilotConfig,
        pilotEvidence: {
          profile: "PILOT_POLICY_SYNC",
          status: "PASSED",
          occurredAt: "2026-06-01T00:00:30.000Z",
          correlationId: "pilot-policy-sync-correlation-123456",
          message: "pilot 정책 조회 evidence가 저장됐다.",
          action: null,
          auditEventId: "pilot-audit-1",
          reportArtifactId: "pilot-report-1",
          safeMetadata: {
            market: "KRW-BTC",
            authorization: "Bearer raw-upbit-auth",
          },
        },
        readinessProvider,
        clock: () => new Date("2026-06-01T00:00:00.000Z"),
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
          phase15: {
            enabled: true,
            approvedAltMarkets: [],
            approvedAltCount: 0,
            candidateMarkets: ["KRW-SOL"],
            candidateMarketCount: 1,
            maxManualApprovals: 3,
          },
        },
        liveTradingEnabled: false,
        paperNoKey: true,
        pilot: {
          enabled: true,
          profile: "PILOT_POLICY_SYNC",
          privateSmokeEnabled: true,
          orderSmokeEnabled: false,
          credentialsConfigured: true,
          keyScopes: ["자산조회", "주문조회"],
          keyScopeEvidenceId: "scope-evidence-2026-06-01",
          policySyncMarket: "KRW-BTC",
          statusLabel: "정책 조회 준비",
          lastEvidence: {
            status: "PASSED",
            statusLabel: "검증 통과",
            correlationId: "pilot-...3456",
            auditEventId: "pilot-audit-1",
            reportArtifactId: "pilot-report-1",
            safeMetadata: {
              market: "KRW-BTC",
              authorization: "[REDACTED]",
            },
          },
        },
      },
      marketData: {
        connectionStatus: "STALE",
        lagMs: 12_345,
      },
      paper: {
        status: "unavailable",
        pendingPaperOrderCount: null,
        openPositionCount: null,
      },
      alerts: {
        status: "ok",
        statusLabel: "조회 가능",
        lastSentAt: "2026-05-20T00:00:20.000Z",
      },
      dailyReport: {
        status: "unavailable",
        statusLabel: "조회 불가",
        lastStatus: "unavailable",
      },
      pnl: {
        status: "unavailable",
        statusLabel: "조회 불가",
        latestEquityKrw: null,
        snapshotCount: 0,
      },
    });
    expect(bodyText).not.toContain("telegram-secret-token");
    expect(bodyText).not.toContain("local-control-secret");
    expect(bodyText).not.toContain("upbit-access-key-secret");
    expect(bodyText).not.toContain("upbit-secret-key-secret");
    expect(bodyText).not.toContain("Bearer raw-upbit-auth");
    expect(bodyText).not.toContain("secrets");
    expect(bodyText).not.toContain("telegram_bot_token");
    expect(bodyText).not.toContain("local_control_token");
  });

  it("shows only active phase 1.5 approvals in /status runtime summary", async () => {
    const provider = createDatabaseControlStatusProvider({
      runtimeConfig: loadRuntimeConfig({
        universe: {
          phase_1_5: {
            enabled: true,
            candidate_markets: ["KRW-SOL", "KRW-XRP"],
            manual_approvals: [
              {
                market: "KRW-SOL",
                approved_at: "2026-06-02T00:00:00.000Z",
              },
              {
                market: "KRW-XRP",
                approved_at: "2026-05-01T00:00:00.000Z",
                expires_at: "2026-05-31T00:00:00.000Z",
              },
            ],
          },
        },
      }),
      readinessProvider: staticReadinessProvider(readySummary()),
      clock: () => new Date("2026-06-01T00:00:00.000Z"),
    });

    await expect(provider.getStatus()).resolves.toMatchObject({
      runtime: {
        universe: {
          phase15: {
            approvedAltMarkets: [],
            approvedAltCount: 0,
            candidateMarkets: ["KRW-SOL", "KRW-XRP"],
            candidateMarketCount: 2,
          },
        },
      },
    });
  });

  it("uses phase 1.5 approval evidence when building /status runtime summary", async () => {
    const provider = createDatabaseControlStatusProvider({
      runtimeConfig: loadRuntimeConfig({
        universe: {
          phase_1_5: {
            enabled: true,
            candidate_markets: ["KRW-SOL"],
            manual_approvals: [
              {
                market: "KRW-SOL",
                approved_at: "2026-05-31T00:00:00.000Z",
              },
            ],
          },
        },
      }),
      readinessProvider: staticReadinessProvider(readySummary()),
      phase15ApprovalEvidence: [
        createPhase15ApprovalEvidence("KRW-SOL", "APPROVE", "2026-05-31T00:00:00.000Z"),
      ],
      clock: () => new Date("2026-06-01T00:00:00.000Z"),
    });

    await expect(provider.getStatus()).resolves.toMatchObject({
      runtime: {
        universe: {
          phase15: {
            approvedAltMarkets: ["KRW-SOL"],
            approvedAltCount: 1,
          },
        },
      },
    });
  });

  it("reads durable alert and daily report status without exposing raw job errors", async () => {
    const runtimeConfig = loadRuntimeConfig({});
    server = createHttpControlServer({
      readinessProvider: staticReadinessProvider(readySummary()),
      statusProvider: createDatabaseControlStatusProvider({
        runtimeConfig,
        database: operationalStatusDatabase({
          killSwitch: {
            state: "NORMAL",
            reason_code: null,
          },
          alerts: {
            last_sent_at: new Date("2026-05-20T00:00:20.000Z"),
            last_skipped_at: new Date("2026-05-20T00:00:30.000Z"),
          },
          dailyReportJob: {
            status: "FAILED",
            payload_json: {
              report_date: "2026-05-20",
            },
            run_after: new Date("2026-05-20T00:05:00.000Z"),
            last_error: "telegram provider returned secret-provider-detail",
            updated_at: new Date("2026-05-20T00:06:00.000Z"),
            idempotency_key: "report.daily:2026-05-20",
          },
          pnlSnapshot: {
            strategy_id: "trend",
            market: "KRW-BTC",
            captured_at: new Date("2026-05-20T00:07:00.000Z"),
            equity: "2100000",
            realized_pnl: "1250",
            unrealized_pnl: "500",
            drawdown_bps: "12.5",
            payload_json: {
              status: "CALCULATED",
              sourceFingerprint: "fingerprint-1",
            },
          },
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
      alerts: {
        status: "ok",
        statusLabel: "조회 가능",
        message: "alert cooldown 기록에서 마지막 전송/스킵 시각을 읽었다.",
        lastSentAt: "2026-05-20T00:00:20.000Z",
        lastSkippedAt: "2026-05-20T00:00:30.000Z",
        trace: {
          source: "alert_cooldowns",
          reason: "alert_cooldown_state_read",
        },
      },
      dailyReport: {
        status: "warning",
        statusLabel: "실패",
        message: "마지막 daily report job이 실패했다.",
        action: "jobs table의 추적 정보와 audit event를 확인한 뒤 수동 재실행 또는 재시도를 진행한다.",
        lastStatus: "FAILED",
        reportDate: "2026-05-20",
        nextRunAfter: null,
        updatedAt: "2026-05-20T00:06:00.000Z",
        trace: {
          source: "jobs",
          reason: "daily_report_job_failed",
          idempotencyKey: "report.daily:2026-05-20",
          lastErrorPresent: true,
        },
      },
      pnl: {
        status: "ok",
        statusLabel: "조회 가능",
        message: "최신 PnL snapshot에서 손익과 평가자산을 읽었다.",
        action: null,
        latestCapturedAt: "2026-05-20T00:07:00.000Z",
        latestEquityKrw: "2100000",
        latestRealizedPnlKrw: "1250",
        latestUnrealizedPnlKrw: "500",
        latestDrawdownBps: "12.5",
        latestSource: "pnl_snapshots",
        snapshotCount: 1,
        trace: {
          source: "pnl_snapshots",
          reason: "pnl_snapshot_latest_read",
          readStatus: "OK",
          latestStatus: "CALCULATED",
        },
      },
      paper: {
        status: "unavailable",
        statusLabel: "조회 불가",
        pendingPaperOrderCount: null,
        openPositionCount: null,
      },
    });
    expect(response.body).not.toContain("secret-provider-detail");
  });

  it("maps PARTIAL PnL snapshot to warning status", async () => {
    const runtimeConfig = loadRuntimeConfig({});
    server = createHttpControlServer({
      readinessProvider: staticReadinessProvider(readySummary()),
      statusProvider: createDatabaseControlStatusProvider({
        runtimeConfig,
        database: operationalStatusDatabase({
          killSwitch: {
            state: "NORMAL",
            reason_code: null,
          },
          alerts: {
            last_sent_at: null,
            last_skipped_at: null,
          },
          pnlSnapshot: {
            strategy_id: "trend",
            market: null,
            captured_at: new Date("2026-05-20T00:07:00.000Z"),
            equity: "2100000",
            realized_pnl: "1250",
            unrealized_pnl: "500",
            drawdown_bps: "12.5",
            payload_json: {
              status: "PARTIAL",
              sourceFingerprint: "fingerprint-partial",
              missingReasons: [
                {
                  message: "최신 market snapshot coverage가 일부만 확인됨",
                  reasonCode: "SNAPSHOT_COVERAGE_PARTIAL",
                  scope: "trend::*",
                  source: "pnl_snapshots",
                },
              ],
            },
          },
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
      pnl: {
        status: "warning",
        statusLabel: "일부 계산 가능",
        message: "최신 PnL snapshot은 일부 source만 계산된 상태다.",
        action: "payload_json의 missingReasons와 source trace를 확인한 뒤 누락된 평가가나 회계 source를 보강한다.",
        latestCapturedAt: "2026-05-20T00:07:00.000Z",
        trace: {
          latestStatus: "PARTIAL",
        },
      },
    });
  });

  it("maps PnL provider failure to /status pnl unavailable without failing HTTP", async () => {
    const runtimeConfig = loadRuntimeConfig({});
    server = createHttpControlServer({
      readinessProvider: staticReadinessProvider(readySummary()),
      statusProvider: createDatabaseControlStatusProvider({
        runtimeConfig,
        statusReadinessProvider: staticReadinessProvider(readySummary()),
        pnlAccountingStatusProvider: {
          async getStatus(): Promise<PnLAccountingStatusSummary> {
            throw new Error("pnl provider exploded with raw detail");
          },
        },
      }),
    });

    const response = await server.inject({
      method: "GET",
      url: "/status",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      pnl: {
        status: "unavailable",
        statusLabel: "조회 불가",
        message: "PnL snapshot 상태를 DB에서 읽지 못했다.",
        action: "DB 연결, migration 적용 상태, pnl_snapshots table 접근 권한을 확인한다.",
        latestCapturedAt: null,
        latestEquityKrw: null,
        snapshotCount: 0,
        trace: {
          source: "pnl_accounting_status_provider",
          reason: "pnl_accounting_status_provider_failed",
          readStatus: "UNAVAILABLE",
        },
      },
    });
    expect(response.body).not.toContain("raw detail");
  });

  it("why provider가 주입되지 않으면 /status why를 null로 반환한다", async () => {
    const provider = createDatabaseControlStatusProvider({
      runtimeConfig: loadRuntimeConfig({}),
      statusReadinessProvider: staticReadinessProvider(readySummary()),
    });

    const snapshot = await provider.getStatus();

    expect(snapshot.why).toBeNull();
  });

  it("injected why provider 성공 summary를 /status 응답에 포함한다", async () => {
    server = createHttpControlServer({
      readinessProvider: staticReadinessProvider(readySummary()),
      statusProvider: createDatabaseControlStatusProvider({
        runtimeConfig: loadRuntimeConfig({}),
        statusReadinessProvider: staticReadinessProvider(readySummary()),
        whySummaryProvider: staticWhySummaryProvider(whySummaryFixture()),
      }),
    });

    const response = await server.inject({
      method: "GET",
      url: "/status",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      why: {
        readStatus: "OK",
        markets: {
          readStatus: "OK",
          items: [
            {
              market: "KRW-BTC",
              statusLabel: "매수 판단",
            },
          ],
        },
        strategies: {
          readStatus: "OK",
          items: [
            {
              strategyId: "strategy.trend-following",
              statusLabel: "보유",
            },
          ],
        },
        cash: {
          readStatus: "OK",
          item: {
            statusLabel: "현금 보유",
            holdReasons: [
              {
                label: "신호 대기 중",
                count: 1,
              },
            ],
          },
        },
      },
    });
  });

  it("injected why provider 실패를 HTTP 200과 UNAVAILABLE summary로 낮춘다", async () => {
    server = createHttpControlServer({
      readinessProvider: staticReadinessProvider(readySummary()),
      statusProvider: createDatabaseControlStatusProvider({
        runtimeConfig: loadRuntimeConfig({}),
        statusReadinessProvider: staticReadinessProvider(readySummary()),
        whySummaryProvider: {
          async getWhySummary(): Promise<WhySummary> {
            throw new Error("why provider raw detail");
          },
        },
      }),
    });

    const response = await server.inject({
      method: "GET",
      url: "/status",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      why: {
        readStatus: "UNAVAILABLE",
        markets: {
          readStatus: "UNAVAILABLE",
          statusLabel: "조회 불가",
          action: "DB 연결 상태와 decision_ledger_frames table 접근 권한을 확인한 뒤 다시 조회하세요.",
        },
        strategies: {
          readStatus: "UNAVAILABLE",
        },
        cash: {
          readStatus: "UNAVAILABLE",
          item: null,
        },
        trace: {
          reason: "why_summary_provider_failed",
        },
      },
    });
    expect(response.body).not.toContain("raw detail");
  });

  it("DB-backed why provider query failure를 UNAVAILABLE로 구분한다", async () => {
    const provider = createDatabaseControlStatusProvider({
      runtimeConfig: loadRuntimeConfig({}),
      statusReadinessProvider: staticReadinessProvider(readySummary()),
      whySummaryProvider: createDatabaseWhySummaryProvider(
        failingWhySummaryDatabase(),
        () => new Date("2026-06-06T04:00:00.000Z"),
      ),
    });

    const snapshot = await provider.getStatus();

    expect(snapshot.why).toMatchObject({
      readStatus: "UNAVAILABLE",
      generatedAt: "2026-06-06T04:00:00.000Z",
      markets: {
        readStatus: "UNAVAILABLE",
        statusLabel: "조회 불가",
      },
      cash: {
        readStatus: "UNAVAILABLE",
        item: null,
      },
      trace: {
        reason: "db_query_failed",
      },
    });
  });

  it("DB-backed why provider의 빈 ledger 결과는 NOT_FOUND로 반환한다", async () => {
    const provider = createDatabaseControlStatusProvider({
      runtimeConfig: loadRuntimeConfig({}),
      statusReadinessProvider: staticReadinessProvider(readySummary()),
      whySummaryProvider: createDatabaseWhySummaryProvider(
        emptyWhySummaryDatabase(),
        () => new Date("2026-06-06T04:00:00.000Z"),
      ),
    });

    const snapshot = await provider.getStatus();

    expect(snapshot.why).toMatchObject({
      readStatus: "NOT_FOUND",
      markets: {
        readStatus: "NOT_FOUND",
      },
      strategies: {
        readStatus: "NOT_FOUND",
      },
      cash: {
        readStatus: "NOT_FOUND",
        item: null,
      },
    });
  });

  it("DB-backed why provider는 market+strategy frame을 보존하고 시간 기준으로 최신 판단을 고른다", async () => {
    const summary = await createDatabaseWhySummaryProvider(
      tieBreakWhySummaryDatabase(),
      () => new Date("2026-06-06T04:00:00.000Z"),
    ).getWhySummary();

    expect(summary.readStatus).toBe("OK");
    expect(summary.markets.items).toHaveLength(2);
    expect(summary.markets.items.map((item) => item.trace.selected)).toEqual([
      "market-newer-created-at",
      "market-second-strategy",
    ]);
    expect(summary.strategies.items).toHaveLength(2);
    expect(summary.strategies.items.map((item) => item.trace.strategySelected)).toEqual([
      "strategy-newer-created-at",
      "strategy-second-strategy",
    ]);
  });

  it("maps injected daily report failures to the same /status warning shape", async () => {
    const runtimeConfig = loadRuntimeConfig({});
    server = createHttpControlServer({
      readinessProvider: staticReadinessProvider(readySummary()),
      statusProvider: createDatabaseControlStatusProvider({
        runtimeConfig,
        dailyReport: {
          lastStatus: "FAILED",
          reportDate: "2026-05-20",
          updatedAt: "2026-05-20T00:06:00.000Z",
        },
      }),
    });

    const response = await server.inject({
      method: "GET",
      url: "/status",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      dailyReport: {
        status: "warning",
        statusLabel: "실패",
        message: "마지막 daily report job이 실패했다.",
        action: "jobs table의 추적 정보와 audit event를 확인한 뒤 수동 재실행 또는 재시도를 진행한다.",
        lastStatus: "FAILED",
        reportDate: "2026-05-20",
        nextRunAfter: null,
        updatedAt: "2026-05-20T00:06:00.000Z",
        trace: {
          source: "runtime_injected",
          reason: "daily_report_status_injected_failed",
        },
      },
    });
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
          alertDispatch: {
            fingerprint: "alert:test:paper_trading:P0:kill_switch_control:global:global:db_write_failure",
            cooldownHit: false,
            notification: {
              delivered: true,
              providerMessageId: "telegram-message-1",
            },
            failureEvaluation: {
              state: {
                consecutiveFailures: 0,
                firstFailureAt: null,
                lastFailureAt: null,
              },
            },
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
      alertDispatch: {
        fingerprint: "alert:test:paper_trading:P0:kill_switch_control:global:global:db_write_failure",
        notification: {
          delivered: true,
          providerMessageId: "telegram-message-1",
          skippedReason: null,
        },
      },
      alertDispatchFailure: null,
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
        code: "illegal_kill_switch_state_transition",
        message: "Illegal kill switch state transition rejected: HARD_STOP -> NORMAL",
      },
    });
  });

  it("rejects whitespace-only kill switch reason codes before provider execution", async () => {
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
        "x-correlation-id": "corr-blank-reason",
      },
      payload: {
        targetState: "HARD_STOP",
        reasonCode: "   ",
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      status: "error",
      correlationId: "corr-blank-reason",
      error: {
        code: "bad_request",
      },
    });
    expect(providerCalls).toBe(0);
  });

  it("canonicalizes kill switch reason codes before provider execution", async () => {
    let capturedReasonCode: string | undefined;
    server = createHttpControlServer({
      readinessProvider: staticReadinessProvider(readySummary()),
      statusProvider: unavailableStatusProvider(),
      killSwitchControlProvider: {
        async apply(input) {
          capturedReasonCode = input.reasonCode;
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
        "x-correlation-id": "corr-canonical-reason",
      },
      payload: {
        targetState: "HARD_STOP",
        reasonCode: "DB_WRITE_FAILURE",
      },
    });

    expect(response.statusCode).toBe(200);
    expect(capturedReasonCode).toBe("db_write_failure");
    expect(response.json()).toMatchObject({
      transition: {
        reasonCode: "db_write_failure",
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

function staticWhySummaryProvider(summary: WhySummary): WhySummaryProvider {
  return {
    async getWhySummary() {
      return summary;
    },
  };
}

function whySummaryFixture(): WhySummary {
  return {
    markets: {
      readStatus: "OK",
      statusLabel: "조회 완료",
      message: "시장별 최근 판단 이유를 조회했습니다.",
      impact: null,
      action: null,
      items: [
        {
          market: "KRW-BTC",
          statusLabel: "매수 판단",
          message: "KRW-BTC 시장은 매수 후보로 판단되었습니다.",
          impact: null,
          action: null,
          latestDecisionAt: "2026-06-06T03:00:00.000Z",
          trace: { category: "BUY" },
        },
      ],
      trace: { querySource: "decision_ledger_frames" },
    },
    strategies: {
      readStatus: "OK",
      statusLabel: "조회 완료",
      message: "전략별 최근 판단 이유를 조회했습니다.",
      impact: null,
      action: null,
      items: [
        {
          strategyId: "strategy.trend-following",
          statusLabel: "보유",
          message: "전략이 대기를 선택했습니다.",
          impact: null,
          action: "다음 frame을 기다립니다.",
          latestDecisionAt: "2026-06-06T03:00:00.000Z",
          trace: { category: "HOLD" },
        },
      ],
      trace: { querySource: "decision_ledger_frames" },
    },
    cash: {
      readStatus: "OK",
      statusLabel: "조회 완료",
      message: "현금 보유 이유를 조회했습니다.",
      impact: null,
      action: null,
      item: {
        statusLabel: "현금 보유",
        message: "주문 후보가 없어 현금을 유지했습니다.",
        impact: null,
        action: "전략 신호와 비용 조건을 다시 확인하세요.",
        latestDecisionAt: "2026-06-06T03:00:00.000Z",
        holdReasons: [
          {
            label: "신호 대기 중",
            count: 1,
            trace: { reasonCode: "fixture_waiting_for_signal" },
          },
        ],
        trace: { category: "CASH_HOLD" },
      },
      trace: { querySource: "decision_ledger_frames" },
    },
    generatedAt: "2026-06-06T04:00:00.000Z",
    readStatus: "OK",
    trace: { querySource: "decision_ledger_frames" },
  };
}

function failingWhySummaryDatabase(): Database {
  return {
    fn: {
      max(_columnName: string) {
        return {
          as(alias: string) {
            return alias;
          },
        };
      },
    },
    selectFrom(_tableName: string) {
      throw new Error("decision ledger query failed with raw detail");
    },
  } as unknown as Database;
}

function emptyWhySummaryDatabase(): Database {
  interface EmptyWhyJoin {
    onRef(left: string, operator: string, right: string): EmptyWhyJoin;
  }
  interface EmptyWhyQuery {
    distinctOn(columnName: string): EmptyWhyQuery;
    select(selection: unknown): EmptyWhyQuery;
    where(left: string, operator: string, right: unknown): EmptyWhyQuery;
    groupBy(columnName: string): EmptyWhyQuery;
    as(alias: string): EmptyWhyQuery;
    innerJoin(source: unknown, callback: (join: EmptyWhyJoin) => unknown): EmptyWhyQuery;
    orderBy(columnName: string, direction: string): EmptyWhyQuery;
    limit(count: number): EmptyWhyQuery;
    execute(): Promise<readonly unknown[]>;
  }

  const join: EmptyWhyJoin = {
    onRef() {
      return join;
    },
  };
  const query: EmptyWhyQuery = {
    distinctOn() {
      return query;
    },
    select() {
      return query;
    },
    where() {
      return query;
    },
    groupBy() {
      return query;
    },
    as() {
      return query;
    },
    innerJoin(_source, callback) {
      callback(join);
      return query;
    },
    orderBy() {
      return query;
    },
    limit() {
      return query;
    },
    async execute() {
      return [];
    },
  };

  return {
    fn: {
      max(_columnName: string) {
        return {
          as(alias: string) {
            return alias;
          },
        };
      },
    },
    selectFrom() {
      return query;
    },
  } as unknown as Database;
}

function tieBreakWhySummaryDatabase(): Database {
  type WhySummaryRow = {
    id: string;
    market: string | null;
    strategy_id: string | null;
    category: string;
    summary_status: string;
    reason_counts_json: Record<string, number>;
    observed_at: Date;
    decision_at: Date;
    created_at: Date;
    trace_json: Record<string, unknown>;
  };

  const tiedAt = new Date("2026-06-06T03:00:00.000Z");
  const olderCreatedAt = new Date("2026-06-06T03:00:01.000Z");
  const newerCreatedAt = new Date("2026-06-06T03:00:02.000Z");
  const rows: WhySummaryRow[] = [
    {
      id: "frame-003",
      market: null,
      strategy_id: null,
      category: "CASH_HOLD",
      summary_status: "RECORDED",
      reason_counts_json: { fixture_waiting_for_signal: 1 },
      observed_at: tiedAt,
      decision_at: tiedAt,
      created_at: newerCreatedAt,
      trace_json: { selected: "cash" },
    },
    {
      id: "frame-002",
      market: "KRW-BTC",
      strategy_id: "strategy.tie",
      category: "SELL",
      summary_status: "RECORDED",
      reason_counts_json: {},
      observed_at: tiedAt,
      decision_at: tiedAt,
      created_at: newerCreatedAt,
      trace_json: { selected: "market-newer-created-at", strategySelected: "strategy-newer-created-at" },
    },
    {
      id: "frame-001",
      market: "KRW-BTC",
      strategy_id: "strategy.tie",
      category: "BUY",
      summary_status: "RECORDED",
      reason_counts_json: {},
      observed_at: tiedAt,
      decision_at: tiedAt,
      created_at: olderCreatedAt,
      trace_json: { selected: "older-id", strategySelected: "older-id" },
    },
    {
      id: "frame-004",
      market: "KRW-BTC",
      strategy_id: "strategy.other",
      category: "RISK_REJECTED",
      summary_status: "RECORDED",
      reason_counts_json: {},
      observed_at: tiedAt,
      decision_at: tiedAt,
      created_at: olderCreatedAt,
      trace_json: { selected: "market-second-strategy", strategySelected: "strategy-second-strategy" },
    },
  ];

  return {
    selectFrom() {
      return createTieBreakWhyQuery(rows);
    },
  } as unknown as Database;
}

function createTieBreakWhyQuery(rows: readonly {
  id: string;
  market: string | null;
  strategy_id: string | null;
  category: string;
  summary_status: string;
  reason_counts_json: Record<string, number>;
  observed_at: Date;
  decision_at: Date;
  created_at: Date;
  trace_json: Record<string, unknown>;
}[]) {
  type QueryMode = "all" | "market" | "strategy" | "cash";
  let mode: QueryMode = "all";
  let limitCount: number | null = null;
  let distinctColumns: readonly ("market" | "strategy_id")[] = [];
  const query = {
    distinctOn(columnName: "market" | "strategy_id" | readonly ("market" | "strategy_id")[]) {
      distinctColumns = Array.isArray(columnName) ? columnName : [columnName];
      return query;
    },
    select() {
      return query;
    },
    where(left: string, operator: string, right: unknown) {
      if (left === "market" && operator === "is not" && right === null) {
        mode = "market";
      } else if (left === "strategy_id" && operator === "is not" && right === null) {
        mode = "strategy";
      } else if (left === "category" && operator === "=" && right === "CASH_HOLD") {
        mode = "cash";
      }
      return query;
    },
    orderBy() {
      return query;
    },
    limit(count: number) {
      limitCount = count;
      return query;
    },
    async execute() {
      const filtered = rows.filter((row) => {
        if (mode === "market") {
          return row.market !== null;
        }
        if (mode === "strategy") {
          return row.strategy_id !== null;
        }
        if (mode === "cash") {
          return row.category === "CASH_HOLD";
        }
        return true;
      });
      const sorted = [...filtered].sort(compareWhyRowsByLatestFirst);
      const distinctRows = distinctColumns.length === 0 ? sorted : uniqueRowsByColumns(sorted, distinctColumns);
      return limitCount === null ? distinctRows : distinctRows.slice(0, limitCount);
    },
  };
  return query;
}

function compareWhyRowsByLatestFirst(
  left: { decision_at: Date; created_at: Date; observed_at: Date },
  right: { decision_at: Date; created_at: Date; observed_at: Date },
): number {
  return (
    right.decision_at.getTime() - left.decision_at.getTime() ||
    right.created_at.getTime() - left.created_at.getTime() ||
    right.observed_at.getTime() - left.observed_at.getTime()
  );
}

function uniqueRowsByColumns<Row extends Record<"market" | "strategy_id", string | null>>(
  rows: readonly Row[],
  columnNames: readonly ("market" | "strategy_id")[],
): readonly Row[] {
  const seen = new Set<string>();
  const result: Row[] = [];
  for (const row of rows) {
    const key = columnNames.map((columnName) => row[columnName] ?? "<null>").join("\u0000");
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(row);
  }
  return result;
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
            phase15: {
              enabled: false,
              approvedAltMarkets: [],
              approvedAltCount: 0,
              candidateMarkets: [],
              candidateMarketCount: 0,
              maxManualApprovals: 3,
            },
          },
          liveTradingEnabled: false,
          paperNoKey: true,
          pilot: {
            enabled: false,
            profile: null,
            privateSmokeEnabled: false,
            orderSmokeEnabled: false,
            credentialsConfigured: false,
            keyScopes: [],
            keyScopeEvidenceId: null,
            policySyncMarket: null,
            orderSmokeMarket: null,
            orderSmokeMaxKrw: null,
            lookupOrderConfigured: false,
            statusLabel: "비활성",
            message: "pilot private API profile이 꺼져 있어 기본 PAPER_NO_KEY runtime이 API key 없이 동작한다.",
            action: null,
            lastEvidence: null,
            trace: {
              source: "pilot_runtime_config",
              reason: "pilot_profile_disabled",
              generatedAt: checkedAt,
            },
          },
          liveAutonomous: {
            enabled: false,
            ready: false,
            allowedMarkets: ["KRW-BTC"],
            maxOrderKrw: "10000",
            dailyAutonomousNotionalLimitKrw: "30000",
            maxOpenPositionNotionalKrw: "30000",
            m21WeekGateEvidenceConfigured: false,
            operatorArmEvidenceConfigured: false,
            budgetEvidenceConfigured: false,
            keyScopeEvidenceConfigured: false,
            telegramInboundReady: false,
            reconcileFresh: false,
            pnlStatusReady: false,
            decisionLedgerReady: false,
            exitEngineReady: false,
            statusLabel: "M22 비활성",
            message: "M22 제한적 완전 자동매매가 비활성입니다.",
            action: null,
            trace: {
              source: "live_autonomous_runtime_guard",
              reason: "live_autonomous_disabled",
            },
          },
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
          ...operationalStatusDetail({
            status: "unavailable",
            statusLabel: "조회 불가",
            message: "paper 주문과 포지션 집계를 읽지 못했다.",
            action: "DB 연결과 migration 적용 상태를 확인한 뒤 다시 조회한다.",
            source: "orders+paper_orders+positions",
            reason: "database_not_configured",
          }),
          pendingPaperOrderCount: null,
          openPositionCount: null,
        },
        database: input.database,
        alerts: {
          ...operationalStatusDetail({
            status: "unavailable",
            statusLabel: "조회 불가",
            message: "alert cooldown DB가 연결되지 않아 마지막 전송/스킵 시각을 확인하지 못했다.",
            action: "DB 연결 상태를 확인한 뒤 다시 조회한다.",
            source: "alert_cooldowns",
            reason: "database_not_configured",
          }),
          lastSentAt: null,
          lastSkippedAt: null,
        },
        dailyReport: {
          ...operationalStatusDetail({
            status: "unavailable",
            statusLabel: "조회 불가",
            message: "daily report job DB가 연결되지 않아 마지막 실행 상태를 확인하지 못했다.",
            action: "DB 연결 상태를 확인한 뒤 다시 조회한다.",
            source: "jobs",
            reason: "database_not_configured",
          }),
          lastStatus: "unavailable",
          reportDate: null,
          nextRunAfter: null,
          updatedAt: null,
        },
        pnl: {
          ...operationalStatusDetail({
            status: "unavailable",
            statusLabel: "조회 불가",
            message: "PnL snapshot 상태를 DB에서 읽지 못했다.",
            action: "DB 연결, migration 적용 상태, pnl_snapshots table 접근 권한을 확인한다.",
            source: "pnl_snapshots",
            reason: "database_not_configured",
          }),
          latestCapturedAt: null,
          latestEquityKrw: null,
          latestRealizedPnlKrw: null,
          latestUnrealizedPnlKrw: null,
          latestDrawdownBps: null,
          latestSource: null,
          snapshotCount: 0,
        },
        reconcile: {
          lastReconcileAt: null,
          result: "SKIPPED",
          mismatchCount: null,
          openOrderCount: null,
          balanceStatus: "UNAVAILABLE",
          websocketStatus: "DISCONNECTED",
          actionRequired: "reconcile 실행 필요",
          message: "아직 reconcile이 실행되지 않았다. 실계좌 상태 대조를 시작하려면 reconcile worker를 활성화한다.",
          trace: {
            source: "live_reconcile_status",
            reason: "reconcile_not_run",
          },
        },
        liveAutonomousExit: {
          enabled: false,
          runtimeReady: false,
          exitEngineReady: false,
          status: "ok",
          statusCode: "DISABLED",
          statusLabel: "M22 자동 청산 비활성",
          message: "M22 자동매매가 비활성이라 live autonomous exit 연결도 실행하지 않습니다.",
          impact: "실계좌 주문 side effect가 생성되지 않습니다.",
          action: "M22를 운영하려면 guard evidence와 readiness를 갖춘 뒤 별도 arm 절차를 진행하세요.",
          market: null,
          strategyId: null,
          latestBrokerOrderStatus: null,
          filledQuantity: null,
          remainingQuantity: null,
          requoteIntentIdempotencyKey: null,
          reconcile: {
            result: "SKIPPED",
            mismatchCount: null,
            openOrderCount: null,
            balanceStatus: "UNAVAILABLE",
            websocketStatus: "DISCONNECTED",
            lastReconcileAt: null,
          },
          trace: {
            source: "live_autonomous_exit_status",
            reason: "live_autonomous_exit_disabled",
          },
        },
        why: null,
      };
    },
  };
}

function operationalStatusDetail(input: {
  status: "ok" | "warning" | "unavailable";
  statusLabel: string;
  message: string;
  action: string | null;
  source: string;
  reason: string;
}) {
  return {
    status: input.status,
    statusLabel: input.statusLabel,
    message: input.message,
    action: input.action,
    trace: {
      source: input.source,
      reason: input.reason,
    },
  };
}

function createPhase15ApprovalEvidence(
  market: string,
  action: "APPROVE" | "REJECT" | "REVOKE" | "EXPIRE",
  observedAt: string,
): Phase15AltApprovalEvidenceSnapshot {
  const conditions: readonly Phase15AltApprovalEvidenceCondition[] = [
    { key: "listing_age", passed: true, reasonCode: "phase_1_5_listing_age_sufficient" },
    { key: "market_warning", passed: true, reasonCode: "phase_1_5_market_warning_absent" },
    { key: "market_caution", passed: true, reasonCode: "phase_1_5_market_caution_absent" },
    {
      key: "thirty_day_average_trade_value",
      passed: true,
      reasonCode: "phase_1_5_30d_trade_value_sufficient",
    },
    { key: "seven_day_spread_p95", passed: true, reasonCode: "phase_1_5_spread_p95_within_limit" },
    { key: "expected_slippage", passed: true, reasonCode: "phase_1_5_expected_slippage_within_limit" },
    { key: "depth", passed: true, reasonCode: "phase_1_5_depth_sufficient" },
  ];

  return {
    exchangeId: "upbit_krw_spot",
    market,
    action,
    observedAt,
    thresholds: {
      minListingAgeDays: 90,
      minThirtyDayAverageTradeValueKrw: "10000000000",
      maxSevenDaySpreadP95Bps: "15",
      maxExpectedSlippageBps: "20",
      minDepthKrw: "100000000",
    },
    conditions,
  };
}

function operationalStatusDatabase(input: {
  killSwitch: { state: KillSwitchState; reason_code: string | null };
  alerts: { last_sent_at: Date | null; last_skipped_at: Date | null };
  dailyReportJob?: {
    status: string;
    payload_json: Record<string, unknown>;
    run_after: Date;
    last_error: string | null;
    updated_at: Date;
    idempotency_key: string;
  };
  pnlSnapshot?: {
    strategy_id: string;
    market: string | null;
    captured_at: Date;
    equity: string;
    realized_pnl: string;
    unrealized_pnl: string;
    drawdown_bps: string;
    payload_json: Record<string, unknown>;
  };
}): Database {
  return {
    selectFrom(tableName: string) {
      if (tableName === "kill_switch_state") {
        return fakeSelectQuery(input.killSwitch);
      }
      if (tableName === "alert_cooldowns") {
        return fakeSelectQuery(input.alerts);
      }
      if (tableName === "jobs") {
        return fakeSelectQuery(input.dailyReportJob);
      }
      if (tableName === "pnl_snapshots") {
        return fakeSelectQuery(input.pnlSnapshot, input.pnlSnapshot === undefined ? 0 : 1);
      }
      throw new Error(`unexpected table: ${tableName}`);
    },
  } as unknown as Database;
}

function fakeSelectQuery(row: unknown, count?: number) {
  let mode: "row" | "count" = "row";
  const query = {
    selectAll() {
      mode = "row";
      return query;
    },
    select(selection?: unknown) {
      if (count !== undefined && typeof selection === "function") {
        mode = "count";
      }
      return query;
    },
    where() {
      return query;
    },
    orderBy() {
      return query;
    },
    limit() {
      return query;
    },
    async executeTakeFirst() {
      return mode === "count" ? { count: String(count) } : row;
    },
  };
  return query;
}

/* ============================================================
 * M16 Reconcile /status Integration Tests
 * ============================================================ */

describe("/status reconcile section", () => {
  it("reconcile이 주입되지 않으면 SKIPPED 기본값을 반환한다", async () => {
    const runtimeConfig = loadRuntimeConfig({});
    const provider = createDatabaseControlStatusProvider({
      runtimeConfig,
      readinessProvider: staticReadinessProvider(readySummary()),
    });

    const snapshot = await provider.getStatus();

    expect(snapshot.reconcile).toMatchObject({
      result: "SKIPPED",
      lastReconcileAt: null,
      mismatchCount: null,
      balanceStatus: "UNAVAILABLE",
      actionRequired: "reconcile 실행 필요",
    });
  });

  it("reconcile이 주입되면 해당 summary를 반환한다", async () => {
    const runtimeConfig = loadRuntimeConfig({});
    const provider = createDatabaseControlStatusProvider({
      runtimeConfig,
      readinessProvider: staticReadinessProvider(readySummary()),
      reconcile: {
        lastReconcileAt: "2026-06-02T12:00:00.000Z",
        result: "SUCCESS",
        mismatchCount: 0,
        openOrderCount: 3,
        balanceStatus: "OK",
        websocketStatus: "CONNECTED",
        actionRequired: "정상",
        message: "거래소-로컬 상태 일치",
        trace: {
          source: "live_reconcile_status",
          reason: "reconcile_clean",
        },
      },
    });

    const snapshot = await provider.getStatus();

    expect(snapshot.reconcile).toEqual({
      lastReconcileAt: "2026-06-02T12:00:00.000Z",
      result: "SUCCESS",
      mismatchCount: 0,
      openOrderCount: 3,
      balanceStatus: "OK",
      websocketStatus: "CONNECTED",
      actionRequired: "정상",
      message: "거래소-로컬 상태 일치",
      trace: {
        source: "live_reconcile_status",
        reason: "reconcile_clean",
      },
    });
  });

  it("HTTP /status 응답 schema가 reconcile 섹션을 직렬화한다", async () => {
    const runtimeConfig = loadRuntimeConfig({});
    const server = createHttpControlServer({
      readinessProvider: staticReadinessProvider(readySummary()),
      statusProvider: createDatabaseControlStatusProvider({
        runtimeConfig,
        readinessProvider: staticReadinessProvider(readySummary()),
        reconcile: {
          lastReconcileAt: "2026-06-02T12:00:00.000Z",
          result: "SUCCESS",
          mismatchCount: 0,
          openOrderCount: 1,
          balanceStatus: "OK",
          websocketStatus: "CONNECTED",
          actionRequired: "정상",
          message: "거래소-로컬 상태 일치",
          trace: {
            source: "live_reconcile_status",
            reason: "reconcile_clean",
            runId: "run-schema",
          },
        },
      }),
    });

    try {
      const response = await server.inject({
        method: "GET",
        url: "/status",
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        reconcile: {
          result: "SUCCESS",
          openOrderCount: 1,
          trace: {
            runId: "run-schema",
          },
        },
      });
    } finally {
      await server.close();
    }
  });

  it("reconcileStatusProvider가 있으면 정적 reconcile보다 최신 provider 값을 우선한다", async () => {
    const runtimeConfig = loadRuntimeConfig({});
    const provider = createDatabaseControlStatusProvider({
      runtimeConfig,
      readinessProvider: staticReadinessProvider(readySummary()),
      reconcile: {
        lastReconcileAt: null,
        result: "SKIPPED",
        mismatchCount: null,
        openOrderCount: null,
        balanceStatus: "UNAVAILABLE",
        websocketStatus: "DISCONNECTED",
        actionRequired: "정적 값",
        message: "정적 값",
        trace: {
          source: "static",
        },
      },
      reconcileStatusProvider: {
        async getReconcileStatus() {
          return {
            lastReconcileAt: "2026-06-02T12:00:00.000Z",
            result: "SUCCESS",
            mismatchCount: 0,
            openOrderCount: 1,
            balanceStatus: "OK",
            websocketStatus: "CONNECTED",
            actionRequired: "정상",
            message: "최신 provider 값",
            trace: {
              source: "live_reconcile_status",
              reason: "reconcile_clean",
              runId: "run-provider",
            },
          };
        },
      },
    });

    const snapshot = await provider.getStatus();

    expect(snapshot.reconcile).toMatchObject({
      result: "SUCCESS",
      message: "최신 provider 값",
      trace: {
        runId: "run-provider",
      },
    });
  });

  it("MISMATCH_DETECTED 상태를 올바르게 노출한다", async () => {
    const runtimeConfig = loadRuntimeConfig({});
    const provider = createDatabaseControlStatusProvider({
      runtimeConfig,
      readinessProvider: staticReadinessProvider(readySummary()),
      reconcile: {
        lastReconcileAt: "2026-06-02T12:00:00.000Z",
        result: "MISMATCH_DETECTED",
        mismatchCount: 5,
        openOrderCount: 3,
        balanceStatus: "OK",
        websocketStatus: "CONNECTED",
        actionRequired: "불일치 5건을 확인하세요.",
        message: "불일치 발견: 5건의 불일치가 감지되었습니다.",
        trace: {
          source: "live_reconcile_status",
          reason: "reconcile_mismatch_detected",
          runId: "run-001",
        },
      },
    });

    const snapshot = await provider.getStatus();

    expect(snapshot.reconcile.result).toBe("MISMATCH_DETECTED");
    expect(snapshot.reconcile.mismatchCount).toBe(5);
    expect(snapshot.reconcile.actionRequired).toContain("5건");
  });

  it("reconcile summary에 secret 원문이 노출되지 않는다", async () => {
    const runtimeConfig = loadRuntimeConfig({});
    const provider = createDatabaseControlStatusProvider({
      runtimeConfig,
      readinessProvider: staticReadinessProvider(readySummary()),
      reconcile: {
        lastReconcileAt: "2026-06-02T12:00:00.000Z",
        result: "SUCCESS",
        mismatchCount: 0,
        openOrderCount: 0,
        balanceStatus: "OK",
        websocketStatus: "CONNECTED",
        actionRequired: "정상",
        message: "상태 일치",
        trace: {
          source: "live_reconcile_status",
          reason: "reconcile_clean",
          runId: "run-secret-test",
        },
      },
    });

    const snapshot = await provider.getStatus();
    const serialized = JSON.stringify(snapshot.reconcile);

    // reconcile section에 credential 관련 값이 없어야 함
    expect(serialized).not.toContain("accessKey");
    expect(serialized).not.toContain("secretKey");
    expect(serialized).not.toContain("Authorization");
    expect(serialized).not.toContain("JWT");
  });

  it("WebSocket 상태가 올바르게 전달된다", async () => {
    const runtimeConfig = loadRuntimeConfig({});
    const provider = createDatabaseControlStatusProvider({
      runtimeConfig,
      readinessProvider: staticReadinessProvider(readySummary()),
      reconcile: {
        lastReconcileAt: "2026-06-02T12:00:00.000Z",
        result: "SUCCESS",
        mismatchCount: 0,
        openOrderCount: 0,
        balanceStatus: "OK",
        websocketStatus: "DEGRADED",
        actionRequired: "정상",
        message: "상태 일치",
        trace: {
          source: "live_reconcile_status",
          reason: "reconcile_clean",
        },
      },
    });

    const snapshot = await provider.getStatus();

    expect(snapshot.reconcile.websocketStatus).toBe("DEGRADED");
  });
});
