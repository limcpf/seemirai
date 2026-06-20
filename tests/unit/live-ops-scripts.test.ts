import { spawnSync } from "node:child_process";
import { link, mkdtemp, readFile, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

describe("production live ops script skeleton", () => {
  it("live:ops:daemon fixture smoke는 수동 evidence 파일 없이 24/7 loop summary를 만든다", () => {
    const result = spawnSync(
      process.execPath,
      [
        "scripts/run-live-ops-daemon.mjs",
        "--config",
        "config/live-ops.example.json",
        "--env-file",
        "tests/fixtures/live-ops/fake.env",
        "--fixture-smoke",
        "--duration-ms",
        "1000",
        "--json",
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: minimalEnv(),
      },
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    const summary = JSON.parse(result.stdout);
    expect(summary).toMatchObject({
      kind: "live_ops_daemon_summary",
      fixtureSmoke: true,
      durationMs: 1000,
      message: "live:ops daemon이 config/env만으로 자동 매수, 보유, 매도 tick을 반복 평가했습니다.",
    });
    expect(summary.counters.tickCount).toBeGreaterThanOrEqual(1);
    expect(summary.counters.unhandledRejectionCount).toBe(0);
    expect(summary.counters.crashCount).toBe(0);
    expect(summary.latestSummary).toMatchObject({
      fixtureSmoke: true,
      liveOrderCapable: false,
      liveExecution: {
        status: "idle",
      },
    });
    expect(result.stdout).not.toContain("candidate-file");
    expect(result.stdout).not.toContain("manual JSONL");
    expect(result.stdout).not.toContain("fake-upbit-secret-key");
  });

  it("live:ops --tui는 fixture smoke에서 provider 호출 없이 운영 dashboard 첫 화면을 출력한다", () => {
    const result = spawnSync(
      process.execPath,
      [
        "scripts/run-live-ops.mjs",
        "--config",
        "config/live-ops.example.json",
        "--env-file",
        "tests/fixtures/live-ops/fake.env",
        "--fixture-smoke",
        "--tui",
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: minimalEnv(),
      },
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Seemirai Live Ops");
    expect(result.stdout).toContain("운영 dashboard");
    expect(result.stdout).toContain("DB readiness: 통과");
    expect(result.stdout).toContain("Pending migration: 없음");
    expect(result.stdout).toContain("시세 수집: DB-backed 저장 확인");
    expect(result.stdout).toContain("분석/판단: 보류 기록 확인");
    expect(result.stdout).toContain("실주문 실행: 후보 없음 - broker 제출 없음");
    expect(result.stdout).toContain("Reconcile/PnL/status: 상태 요약 확인");
    expect(result.stdout).toContain("Telegram 알림: fixture alert plan 확인");
    expect(result.stdout).toContain("Market data: 체결 1 / 호가 1 / 상태 1");
    expect(result.stdout).toContain("Analysis/decision: 보류 / 주문 후보 0");
    expect(result.stdout).toContain("Live execution: 후보 없음 / 주문 후보 0 / broker 제출 0");
    expect(result.stdout).toContain("Reconcile/PnL/status: fixture 요약 / 대사 정상 / PnL 관측 대기 / open 주문 0 / provider 호출 0");
    expect(result.stdout).toContain("open exposure 0 KRW");
    expect(result.stdout).toContain("budget used 0 KRW");
    expect(result.stdout).toContain("realized PnL 확인 필요 KRW");
    expect(result.stdout).toContain("latest reconcile 없음");
    expect(result.stdout).toContain("mismatch 0");
    expect(result.stdout).toContain("manual review 아니오");
    expect(result.stdout).toContain("Telegram alert: fixture plan / lifecycle 1 / trade 0 / provider 호출 0");
    expect(result.stdout).toContain("후속 provider 연결 전까지 신규 실주문은 제출되지 않습니다");
    expect(result.stdout).not.toContain("fake-upbit-secret-key");
    expect(result.stdout).not.toContain("LIVE_AUTONOMOUS_SMALL_BUDGET");
  });

  it("live:ops JSON 경로는 dashboard 없이 machine-readable summary를 유지한다", () => {
    const result = spawnSync(
      process.execPath,
      [
        "scripts/run-live-ops.mjs",
        "--config",
        "config/live-ops.example.json",
        "--env-file",
        "tests/fixtures/live-ops/fake.env",
        "--fixture-smoke",
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: minimalEnv(),
      },
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    const summary = JSON.parse(result.stdout) as {
      configPath: string;
      envFilePath: string;
      dbReadiness: {
        ready: boolean;
        fixtureSmoke: boolean;
        migration: { expectedLatestVersion: number | null; pendingVersions: number[] };
        checks: Array<{ code: string }>;
      };
      marketData: {
        ready: boolean;
        persisted: { tradeCount: number; orderbookCount: number; statusCount: number };
      };
      analysisDecision: {
        ready: boolean;
        decisionCategory: string;
        orderIntentCount: number;
        recordHoldDecision: boolean;
      };
      liveExecution: {
        ready: boolean;
        status: string;
        liveOrderCapable: boolean;
        orderIntentCount: number;
        attemptedOrderCount: number;
        submittedOrderCount: number;
        brokerGuard: {
          ready: boolean;
          credentialsConfigured: boolean;
          keyScopeEvidenceId: string | null;
          orderSmokeMarket: string;
          orderSmokeMaxKrw: string;
        };
      };
      reconcilePnlStatus: {
        ready: boolean;
        status: string;
        reconcileStatus: string;
        pnlStatus: string;
        openOrderCount: number;
        providerProbeAttempted: boolean;
      };
      telegramAlert: {
        ready: boolean;
        status: string;
        lifecycleAlertCount: number;
        tradeAlertCount: number;
        alertCount: number;
        providerDispatchAttempted: boolean;
      };
    };
    expect(path.isAbsolute(summary.configPath)).toBe(true);
    expect(path.isAbsolute(summary.envFilePath)).toBe(true);
    expect(summary.dbReadiness.ready).toBe(true);
    expect(summary.dbReadiness.fixtureSmoke).toBe(true);
    expect(summary.dbReadiness.migration.expectedLatestVersion).toBeGreaterThan(0);
    expect(summary.dbReadiness.migration.pendingVersions).toEqual([]);
    expect(summary.dbReadiness.checks.map((check) => check.code)).toContain("db_connection_fixture_skipped");
    expect(summary.marketData.ready).toBe(true);
    expect(summary.marketData.persisted).toMatchObject({
      tradeCount: 1,
      orderbookCount: 1,
      statusCount: 1,
    });
    expect(summary.analysisDecision).toMatchObject({
      ready: true,
      decisionCategory: "HOLD",
      orderIntentCount: 0,
      recordHoldDecision: true,
    });
    expect(summary.liveExecution).toMatchObject({
      ready: true,
      status: "idle",
      liveOrderCapable: false,
      orderIntentCount: 0,
      attemptedOrderCount: 0,
      submittedOrderCount: 0,
      brokerGuard: {
        ready: true,
        credentialsConfigured: true,
        keyScopeEvidenceId: "fake-key-scope-evidence",
        orderSmokeMarket: "KRW-BTC",
        orderSmokeMaxKrw: "10000",
      },
    });
    expect(summary.reconcilePnlStatus).toMatchObject({
      ready: true,
      status: "ready",
      reconcileStatus: "fixture_clean",
      pnlStatus: "fixture_observation_pending",
      openOrderCount: 0,
      providerProbeAttempted: false,
    });
    expect(summary.telegramAlert).toMatchObject({
      ready: true,
      status: "planned",
      lifecycleAlertCount: 1,
      tradeAlertCount: 0,
      alertCount: 1,
      providerDispatchAttempted: false,
    });
  });

  it("TUI는 live execution 차단 사유를 후속 연결 대기로 숨기지 않는다", async () => {
    const supportModulePath = path.join(process.cwd(), "scripts/run-live-ops-support.mjs");
    const { renderLiveOpsTuiDashboard } = await import(supportModulePath);
    const output = renderLiveOpsTuiDashboard({
      status: "blocked",
      mode: "소액 실운영",
      market: "KRW-BTC",
      liveOrderCapable: false,
      fixtureSmoke: false,
      attach: "foreground",
      configPath: "/tmp/live-ops.production.json",
      dbReadiness: {
        ready: true,
        migration: {
          appliedLatestVersion: 13,
          expectedLatestVersion: 13,
          pendingVersions: [],
        },
      },
      marketData: {
        ready: true,
        persisted: { tradeCount: 1, orderbookCount: 1, statusCount: 1 },
        latestHeartbeatAt: "2026-06-18T13:33:27.000Z",
      },
      analysisDecision: {
        ready: true,
        decisionCategory: "ORDER_INTENT",
        orderIntentCount: 1,
        evaluatedStrategyCount: 1,
        latestDecisionAt: "2026-06-18T13:33:27.000Z",
      },
      liveExecution: {
        ready: false,
        status: "blocked",
        statusLabel: "운영 상태 차단",
        orderIntentCount: 1,
        submittedOrderCount: 0,
        latestExecutionAt: null,
        checks: [{
          status: "blocked",
          code: "live_ops_execution_status_blocked",
        }],
      },
      reconcilePnlStatus: {
        ready: false,
        providerProbeAttempted: false,
      },
      telegramAlert: {
        ready: false,
        providerDispatchAttempted: false,
      },
      budget: {
        maxOrderKrw: "10000",
        dailyAutonomousNotionalLimitKrw: "30000",
        maxOpenPositionNotionalKrw: "30000",
        operationsStopCeilingKrw: "49999",
      },
      trace: {
        workers: ["db_readiness", "market_data", "analysis_decision", "live_execution"],
        configFile: "live-ops.production.json",
      },
    });

    expect(output).toContain("실주문 실행: 운영 상태 차단");
    expect(output).toContain("Live execution: 운영 상태 차단 / 주문 후보 1 / broker 제출 0 / 차단 live_ops_execution_status_blocked");
    expect(output).not.toContain("Live execution: 후속 연결 대기");
  });

  it("production analysis decision은 cleanup_probe policy로 단일 order intent를 만든다", async () => {
    const config = JSON.parse(await readFile(path.join(process.cwd(), "config", "live-ops.example.json"), "utf8"));
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `
import {
  evaluateLiveOpsCliAnalysisDecision,
  getLiveOpsCliAnalysisOrderIntents,
} from "./scripts/run-live-ops-support.mjs";

const observedAt = "2026-06-16T00:00:00.000Z";
const config = ${JSON.stringify(config)};
const OriginalDate = Date;
globalThis.Date = class FixedDate extends OriginalDate {
  constructor(...args) {
    if (args.length === 0) {
      super(observedAt);
      return;
    }
    super(...args);
  }

  static now() {
    return new OriginalDate(observedAt).getTime();
  }

  static parse(value) {
    return OriginalDate.parse(value);
  }

  static UTC(...args) {
    return OriginalDate.UTC(...args);
  }
};
try {
  const summary = await evaluateLiveOpsCliAnalysisDecision({
    config,
    fixtureSmoke: false,
    marketData: {
      ready: true,
      market: "KRW-BTC",
      sourceProfile: "unit",
      latestHeartbeatAt: observedAt,
      referencePrice: "100000500",
      persisted: { tradeCount: 1, orderbookCount: 1, statusCount: 1 },
      marketEvents: [{
        type: "ORDERBOOK",
        exchangeId: "upbit_krw_spot",
        market: "KRW-BTC",
        asks: [{ price: "100001000", size: "0.5" }],
        bids: [{ price: "100000000", size: "0.5" }],
        exchangeTimestamp: observedAt,
        receivedAt: observedAt,
      }],
    },
  });
  console.log(JSON.stringify({
    summary,
    orderIntents: getLiveOpsCliAnalysisOrderIntents(summary),
  }));
} finally {
  globalThis.Date = OriginalDate;
}
	`,
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: minimalEnv(),
      },
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    const output = JSON.parse(result.stdout);
    const { summary, orderIntents } = output;
    expect(summary).toMatchObject({
      status: "ready",
      ready: true,
      decisionSourceConnected: true,
      decisionCategory: "ORDER_INTENT",
      orderIntentCount: 1,
      trace: {
        policyId: "cleanup_probe",
        dynamicCodeLoading: false,
      },
    });
    expect(summary.checks.map((check: { code: string }) => check.code)).toContain("live_ops_decision_policy_resolved");
    expect(summary.checks.map((check: { code: string }) => check.code)).not.toContain("live_ops_strategy_decision_source_missing");
    expect(summary.orderIntents).toBeUndefined();
    expect(JSON.stringify(summary)).not.toContain("idempotencyKey");
    expect(orderIntents[0]).toMatchObject({
      exchangeId: "upbit_krw_spot",
      market: "KRW-BTC",
      side: "BUY",
      orderType: "LIMIT",
      requestedPrice: "99999000",
      requestedQuantity: "0.0001",
      requestedNotional: "9999.9",
      idempotencyKey: "live_ops_cleanup_probe:runtime_preflight_day:upbit_krw_spot:KRW-BTC:BUY:99999000:0.0001:9999.9",
      postOnly: true,
      timeInForce: "POST_ONLY",
    });
    expect(JSON.stringify(summary)).not.toContain("raw_provider_payload");
  });

  it("cleanup_probe analysis key는 heartbeat가 전날이어도 preflight 날짜 placeholder를 유지한다", async () => {
    const config = JSON.parse(await readFile(path.join(process.cwd(), "config", "live-ops.example.json"), "utf8"));
    const {
      evaluateLiveOpsCliAnalysisDecision,
      getLiveOpsCliAnalysisOrderIntents,
    } = await import(path.join(process.cwd(), "scripts/run-live-ops-support.mjs"));
    const executionAt = "2026-06-16T00:00:10.000Z";
    const latestHeartbeatAt = "2026-06-15T23:59:50.000Z";

    vi.useFakeTimers();
    vi.setSystemTime(new Date(executionAt));
    let output: {
      summary: { observedAt: string };
      orderIntents: Array<{ idempotencyKey: string }>;
    };
    try {
      const summary = await evaluateLiveOpsCliAnalysisDecision({
        config,
        fixtureSmoke: false,
        marketData: {
          ready: true,
          market: "KRW-BTC",
          sourceProfile: "unit",
          latestHeartbeatAt,
          referencePrice: "100000500",
          persisted: { tradeCount: 1, orderbookCount: 1, statusCount: 1 },
          marketEvents: [{
            type: "ORDERBOOK",
            exchangeId: "upbit_krw_spot",
            market: "KRW-BTC",
            asks: [{ price: "100001000", size: "0.5" }],
            bids: [{ price: "100000000", size: "0.5" }],
            exchangeTimestamp: latestHeartbeatAt,
            receivedAt: latestHeartbeatAt,
          }],
        },
      });
      output = {
        summary,
        orderIntents: getLiveOpsCliAnalysisOrderIntents(summary),
      };
    } finally {
      vi.useRealTimers();
    }

    expect(output.summary.observedAt).toBe(executionAt);
    expect(output.orderIntents[0]?.idempotencyKey).toBe(
      "live_ops_cleanup_probe:runtime_preflight_day:upbit_krw_spot:KRW-BTC:BUY:99999000:0.0001:9999.9",
    );
  });

  it("cleanup_probe BLOCK decision은 live execution idle로 낮추지 않도록 blocked summary로 닫는다", async () => {
    const config = JSON.parse(await readFile(path.join(process.cwd(), "config", "live-ops.example.json"), "utf8"));
    config.analysis.decision_policy.cleanup_probe.tick_size_krw = "7";
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `
import {
  evaluateLiveOpsCliAnalysisDecision,
  getLiveOpsCliAnalysisOrderIntents,
} from "./scripts/run-live-ops-support.mjs";

const observedAt = "2026-06-16T00:00:00.000Z";
const config = ${JSON.stringify(config)};
const summary = await evaluateLiveOpsCliAnalysisDecision({
  config,
  fixtureSmoke: false,
  marketData: {
    ready: true,
    market: "KRW-BTC",
    sourceProfile: "unit",
    latestHeartbeatAt: observedAt,
    referencePrice: "100000500",
    persisted: { tradeCount: 1, orderbookCount: 1, statusCount: 1 },
    marketEvents: [{
      type: "ORDERBOOK",
      exchangeId: "upbit_krw_spot",
      market: "KRW-BTC",
      asks: [{ price: "100001000", size: "0.5" }],
      bids: [{ price: "100000000", size: "0.5" }],
      exchangeTimestamp: observedAt,
      receivedAt: observedAt,
    }],
  },
});
console.log(JSON.stringify({
  summary,
  orderIntentCount: getLiveOpsCliAnalysisOrderIntents(summary).length,
}));
`,
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: minimalEnv(),
      },
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    const output = JSON.parse(result.stdout);
    expect(output.orderIntentCount).toBe(0);
    expect(output.summary).toMatchObject({
      status: "blocked",
      ready: false,
      decisionCategory: "BLOCKED",
      blockCount: 1,
      orderIntentCount: 0,
    });
    expect(output.summary.checks.map((check: { code: string }) => check.code)).toContain("live_ops_strategy_decision_blocked");
  });

  it("cleanup_probe는 entry runtime 미연결 시 synthetic evidence 없이 fail-closed 한다", async () => {
    const config = JSON.parse(await readFile(path.join(process.cwd(), "config", "live-ops.example.json"), "utf8"));
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `
import {
  evaluateLiveOpsCliAnalysisDecision,
  evaluateLiveOpsCliLiveExecution,
  getLiveOpsCliAnalysisOrderIntents,
} from "./scripts/run-live-ops-support.mjs";

const observedAt = "2026-06-16T00:00:00.000Z";
const config = ${JSON.stringify(config)};
const marketData = {
  ready: true,
  market: "KRW-BTC",
  sourceProfile: "unit",
  latestHeartbeatAt: observedAt,
  referencePrice: "100000500",
  persisted: { tradeCount: 1, orderbookCount: 1, statusCount: 1 },
  marketEvents: [{
    type: "ORDERBOOK",
    exchangeId: "upbit_krw_spot",
    market: "KRW-BTC",
    asks: [{ price: "100001000", size: "0.5" }],
    bids: [{ price: "100000000", size: "0.5" }],
    exchangeTimestamp: observedAt,
    receivedAt: observedAt,
  }],
};
const analysisDecision = await evaluateLiveOpsCliAnalysisDecision({
  config,
  fixtureSmoke: false,
  marketData,
});
const summary = await evaluateLiveOpsCliLiveExecution({
  config,
  fixtureSmoke: false,
  analysisDecision,
  marketData,
  orderIntents: getLiveOpsCliAnalysisOrderIntents(analysisDecision),
  env: {
    SEEMIRAI_UPBIT_ACCESS_KEY: "fake-access-key",
    SEEMIRAI_UPBIT_SECRET_KEY: "fake-secret-key",
    SEEMIRAI_UPBIT_KEY_SCOPE: "자산조회,주문조회,주문하기",
    SEEMIRAI_UPBIT_KEY_SCOPE_EVIDENCE_ID: "scope-evidence",
  },
});
console.log(JSON.stringify(summary));
`,
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: minimalEnv(),
      },
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    const summary = JSON.parse(result.stdout);
    expect(summary).toMatchObject({
      status: "blocked",
      liveOrderCapable: false,
      orderIntentCount: 1,
      attemptedOrderCount: 0,
      submittedOrderCount: 0,
    });
    const codes = summary.checks.map((check: { code: string }) => check.code);
    expect(codes).toContain("live_ops_entry_runtime_missing");
    expect(codes).not.toContain("live_ops_execution_status_blocked");
    expect(codes).not.toContain("live_ops_order_intent_blocked");
  });

  it("CLI live execution은 SELL 후보를 entry runtime 없이 exit runtime으로 전달한다", async () => {
    const {
      evaluateLiveOpsCliLiveExecution,
    } = await import(path.join(process.cwd(), "scripts/run-live-ops-support.mjs"));
    const config = JSON.parse(await readFile(path.join(process.cwd(), "config", "live-ops.example.json"), "utf8"));
    const observedAt = "2026-06-20T00:00:00.000Z";
    const idempotencyKey = `ops-${"b".repeat(26)}`;
    const sellIntent = createCliSellIntent({ idempotencyKey });
    const exitRuntime = {
      submitExitOrder: vi.fn(async (submission: unknown) => ({
        status: "CANCELED_FOR_REQUOTE",
        statusLabel: "재호가 대기",
        brokerOrderId: "exit-order-001",
        manualReviewRequired: false,
        message: "SELL 주문이 bounded wait 안에 체결되지 않아 취소 확인 후 다음 tick 재호가 대기로 전환했습니다.",
        action: "다음 daemon tick에서 보유 수량과 최신 호가로 SELL 여부를 다시 판단합니다.",
        submission,
      })),
    };

    const summary = await evaluateLiveOpsCliLiveExecution({
      config,
      fixtureSmoke: false,
      analysisDecision: {
        ready: true,
        orderIntentCount: 1,
        decisionCategory: "ORDER_INTENT",
      },
      marketData: {
        ready: true,
        referencePrice: "99000000",
      },
      env: liveOrderEnv(),
      orderIntents: [sellIntent],
      exitRuntime,
      executionStatus: {
        killSwitchActive: false,
        reconcileFresh: true,
        evidenceId: "execution-status-evidence",
      },
      postSubmitReadiness: {
        reconcileReady: true,
        telegramReady: true,
        evidenceId: "post-submit-evidence",
      },
      budgetSnapshot: {
        maxOrderKrw: "10000",
        dailyAutonomousNotionalLimitKrw: "30000",
        dailyAutonomousNotionalUsedKrw: "10000",
        openPositionNotionalKrw: "9900",
        maxOpenPositionNotionalKrw: "30000",
        capturedAt: observedAt,
      },
      lossSnapshot: {
        dailyRealizedLossKrw: "0",
        weeklyRealizedLossKrw: "0",
        capturedAt: observedAt,
      },
    });

    expect(summary).toMatchObject({
      status: "exit_requote_ready",
      ready: true,
      liveOrderCapable: true,
      attemptedOrderCount: 1,
      submittedOrderCount: 1,
      statusLabel: "재호가 대기",
      brokerOrderId: "exit-order-001",
    });
    expect(summary.checks.map((check: { code: string }) => check.code)).toContain("live_ops_exit_request_ready");
    expect(summary.checks.map((check: { code: string }) => check.code)).not.toContain("live_ops_entry_runtime_missing");
    expect(exitRuntime.submitExitOrder).toHaveBeenCalledTimes(1);
    const submission = exitRuntime.submitExitOrder.mock.calls[0]?.[0] as {
      intent: { side: string; idempotencyKey: string };
      costSnapshot: { source: string };
      riskApproval: { source: string };
    };
    expect(submission.intent).toMatchObject({
      side: "SELL",
      idempotencyKey,
    });
    expect(submission.costSnapshot.source).toBe("exit_cost_model");
    expect(submission.riskApproval.source).toBe("risk_gate");
  });

  it("reconcile/PnL/status helper는 private read provider 결과를 secret-safe summary로 낮춘다", () => {
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `
import {
  evaluateLiveOpsCliReconcilePnlStatus,
  renderLiveOpsTuiDashboard,
} from "./scripts/run-live-ops-support.mjs";

const observedAt = "2026-06-15T01:00:00.000Z";
const NativeDate = Date;
globalThis.Date = class FixedDate extends NativeDate {
  constructor(...args) {
    if (args.length === 0) {
      super(observedAt);
      return;
    }
    super(...args);
  }

  static now() {
    return new NativeDate(observedAt).getTime();
  }
};
const calls = { openOrders: 0, balances: 0 };
function createCleanPrivateReadProvider() {
  return {
    async listOpenOrders() {
      return [];
    },
    async getBalances() {
      return {
        exchangeId: "upbit_krw_spot",
        capturedAt: observedAt,
        balances: [
          { currency: "KRW", available: "100000", locked: "0", total: "100000", updatedAt: observedAt },
        ],
      };
    },
  };
}
function createOkPnlStatusProvider() {
  return {
    async getStatus() {
      return {
        readStatus: "OK",
        latestCapturedAt: observedAt,
        latestRealizedPnlKrw: "0",
        latestUnrealizedPnlKrw: "0",
        latestStatus: "CALCULATED",
        snapshotCount: 1,
        reason: "pnl_snapshot_latest_read",
      };
    },
  };
}
const summary = await evaluateLiveOpsCliReconcilePnlStatus({
  config: {
    universe: { default_market: "KRW-BTC" },
  },
  fixtureSmoke: false,
  liveExecution: {
    status: "submitted",
    ready: true,
    liveOrderCapable: true,
    attemptId: "ops-attempt-1",
    brokerOrderId: "upbit-order-1",
    idempotencyKey: "ops-idem-1",
  },
  privateReadProvider: {
    async listOpenOrders(market) {
      calls.openOrders += 1;
      return [{
        brokerOrderId: "upbit-order-1",
        idempotencyKey: "ops-idem-1",
        exchangeId: "upbit_krw_spot",
        market,
        side: "BUY",
        orderType: "LIMIT",
        status: "ACCEPTED",
        requestedQuantity: "0.0001",
        remainingQuantity: "0.00005",
        requestedPrice: "100000000",
        updatedAt: observedAt,
        metadata: { raw_provider_payload: "fake-upbit-secret-key" },
      }];
    },
    async getBalances() {
      calls.balances += 1;
      return {
        exchangeId: "upbit_krw_spot",
        capturedAt: observedAt,
        balances: [
          { currency: "KRW", available: "93000", locked: "7000", total: "100000", updatedAt: observedAt, metadata: { secret_key: "fake-upbit-secret-key" } },
          { currency: "BTC", available: "0.001", locked: "0", total: "0.001", updatedAt: observedAt },
        ],
        metadata: { authorization: "Bearer fake-upbit-secret-key" },
      };
    },
  },
  reconcileStatusProvider: {
    async getReconcileStatus() {
      return {
        lastReconcileAt: observedAt,
        result: "SUCCESS",
        mismatchCount: 0,
        openOrderCount: 1,
        balanceStatus: "OK",
        websocketStatus: "CONNECTED",
        actionRequired: "없음",
        message: "실계좌 상태 대조가 정상입니다.",
        trace: { source: "test" },
      };
    },
  },
  pnlStatusProvider: {
    async getStatus() {
      return {
        readStatus: "OK",
        latestCapturedAt: observedAt,
        latestEquityKrw: "100000",
        latestRealizedPnlKrw: "1200",
        latestUnrealizedPnlKrw: "-300",
        latestDrawdownBps: "5",
        latestSource: "pnl_snapshots",
        latestStatus: "CALCULATED",
        snapshotCount: 1,
        reason: "pnl_snapshot_latest_read",
      };
    },
  },
  budgetSnapshot: {
    dailyAutonomousNotionalUsedKrw: "7000",
  },
  observedAt,
});
const malformed = await evaluateLiveOpsCliReconcilePnlStatus({
  config: {
    universe: { default_market: "KRW-BTC" },
  },
  fixtureSmoke: false,
  liveExecution: {
    status: "submitted",
    ready: true,
    liveOrderCapable: true,
  },
  privateReadProvider: {
    async listOpenOrders() {
      return { malformed: true };
    },
    async getBalances() {
      return {
        exchangeId: "upbit_krw_spot",
        capturedAt: observedAt,
        balances: [],
      };
    },
  },
  pnlStatusProvider: {
    async getStatus() {
      return { readStatus: "OK", latestCapturedAt: observedAt, latestRealizedPnlKrw: "0", latestUnrealizedPnlKrw: "0", latestStatus: "CALCULATED" };
    },
  },
  observedAt,
});
const malformedOrder = await evaluateLiveOpsCliReconcilePnlStatus({
  config: {
    universe: { default_market: "KRW-BTC" },
  },
  fixtureSmoke: false,
  liveExecution: {
    status: "submitted",
    ready: true,
    liveOrderCapable: true,
  },
  privateReadProvider: {
    async listOpenOrders() {
      return [
        {
          market: "KRW-BTC",
          side: "BUY",
          requestedQuantity: "0.0001",
          remainingQuantity: undefined,
          requestedPrice: "100000000",
        },
      ];
    },
    async getBalances() {
      return {
        exchangeId: "upbit_krw_spot",
        capturedAt: observedAt,
        balances: [],
      };
    },
  },
  pnlStatusProvider: {
    async getStatus() {
      return { readStatus: "OK", latestCapturedAt: observedAt, latestRealizedPnlKrw: "0", latestUnrealizedPnlKrw: "0", latestStatus: "CALCULATED" };
    },
  },
  budgetSnapshot: {
    dailyAutonomousNotionalUsedKrw: "7000",
  },
  observedAt,
});
const manualReview = await evaluateLiveOpsCliReconcilePnlStatus({
  config: {
    universe: { default_market: "KRW-BTC" },
  },
  fixtureSmoke: false,
  liveExecution: {
    status: "submitted",
    ready: true,
    liveOrderCapable: true,
  },
  privateReadProvider: {
    async listOpenOrders() {
      return [];
    },
    async getBalances() {
      return {
        exchangeId: "upbit_krw_spot",
        capturedAt: observedAt,
        balances: [
          { currency: "KRW", available: "100000", locked: "0", total: "100000", updatedAt: observedAt },
        ],
      };
    },
  },
  reconcileStatusProvider: {
    async getReconcileStatus() {
      return {
        lastReconcileAt: observedAt,
        result: "MISMATCH_DETECTED",
        mismatchCount: 2,
        openOrderCount: 0,
        balanceStatus: "OK",
        websocketStatus: "DEGRADED",
        actionRequired: "수동 검토 필요",
        message: "실계좌 상태 대조에서 불일치가 발견되었습니다.",
        trace: { source: "test" },
      };
    },
  },
  pnlStatusProvider: {
    async getStatus() {
      return {
        readStatus: "NOT_FOUND",
        latestCapturedAt: null,
        latestRealizedPnlKrw: null,
        latestUnrealizedPnlKrw: null,
        snapshotCount: 0,
        reason: "pnl_snapshot_not_found",
      };
    },
  },
  observedAt,
});
const skippedReconcile = await evaluateLiveOpsCliReconcilePnlStatus({
  config: {
    universe: { default_market: "KRW-BTC" },
  },
  fixtureSmoke: false,
  liveExecution: {
    status: "submitted",
    ready: true,
    liveOrderCapable: true,
  },
  privateReadProvider: createCleanPrivateReadProvider(),
  reconcileStatusProvider: {
    async getReconcileStatus() {
      return {
        lastReconcileAt: null,
        result: "SKIPPED",
        mismatchCount: null,
        openOrderCount: null,
        balanceStatus: "UNAVAILABLE",
        websocketStatus: "DISCONNECTED",
        actionRequired: "reconcile 실행 필요",
        message: "reconcile worker가 아직 실행되지 않았습니다.",
        trace: { source: "test" },
      };
    },
  },
  pnlStatusProvider: createOkPnlStatusProvider(),
  observedAt,
});
const staleBalanceReconcile = await evaluateLiveOpsCliReconcilePnlStatus({
  config: {
    universe: { default_market: "KRW-BTC" },
  },
  fixtureSmoke: false,
  liveExecution: {
    status: "submitted",
    ready: true,
    liveOrderCapable: true,
  },
  privateReadProvider: createCleanPrivateReadProvider(),
  reconcileStatusProvider: {
    async getReconcileStatus() {
      return {
        lastReconcileAt: observedAt,
        result: "SUCCESS",
        mismatchCount: 0,
        openOrderCount: 0,
        balanceStatus: "STALE",
        websocketStatus: "CONNECTED",
        actionRequired: "잔고 snapshot 최신화 필요",
        message: "reconcile 결과는 성공이지만 잔고 snapshot이 stale입니다.",
        trace: { source: "test" },
      };
    },
  },
  pnlStatusProvider: createOkPnlStatusProvider(),
  observedAt,
});
const missingReconcile = await evaluateLiveOpsCliReconcilePnlStatus({
  config: {
    universe: { default_market: "KRW-BTC" },
  },
  fixtureSmoke: false,
  liveExecution: {
    status: "submitted",
    ready: true,
    liveOrderCapable: true,
  },
  privateReadProvider: createCleanPrivateReadProvider(),
  pnlStatusProvider: createOkPnlStatusProvider(),
  observedAt,
});
const manualTui = renderLiveOpsTuiDashboard({
  status: "blocked",
  mode: "소액 실운영",
  configPath: "/tmp/live-ops.json",
  envFilePath: "/tmp/live-ops.env",
  liveOrderCapable: false,
  tui: true,
  attach: null,
  fixtureSmoke: false,
  dbReadiness: { ready: true, migration: { appliedLatestVersion: 13, expectedLatestVersion: 13, pendingVersions: [] } },
  marketData: { ready: true, persisted: { tradeCount: 0, orderbookCount: 0, statusCount: 0 }, latestHeartbeatAt: observedAt },
  analysisDecision: { ready: true, decisionCategory: "HOLD", orderIntentCount: 0, evaluatedStrategyCount: 1, latestDecisionAt: observedAt },
  liveExecution: { ready: false, status: "manual_review_required", liveOrderCapable: false, orderIntentCount: 0, submittedOrderCount: 0, latestExecutionAt: null },
  reconcilePnlStatus: manualReview,
  telegramAlert: { ready: true, statusLabel: "owner chat 대기", lifecycleAlertCount: 0, tradeAlertCount: 0, providerDispatchAttempted: false },
  budget: {
    maxOrderKrw: "10000",
    dailyAutonomousNotionalLimitKrw: "30000",
    maxOpenPositionNotionalKrw: "30000",
    operationsStopCeilingKrw: "49999",
  },
  trace: { workers: ["reconcile_pnl_status"], defaultMarket: "KRW-BTC" },
});
console.log(JSON.stringify({
  summary,
  malformed,
  malformedOrder,
  manualReview,
  skippedReconcile,
  staleBalanceReconcile,
  missingReconcile,
  manualTui,
  calls,
}));
        `,
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: minimalEnv(),
      },
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    const output = JSON.parse(result.stdout) as {
      summary: {
        ready: boolean;
        providerProbeAttempted: boolean;
        openOrderCount: number;
        openExposureKrw: string;
        budgetUsedKrw: string;
        realizedPnlKrw: string;
        unrealizedPnlKrw: string;
        latestReconcileAt: string;
        mismatchCount: number;
        manualReviewRequired: boolean;
        privateRead: { balanceCurrencyCount: number; krwAvailable: string; krwLocked: string };
      };
      malformed: { status: string; ready: boolean; manualReviewRequired: boolean; checks: Array<{ code: string }> };
      malformedOrder: { status: string; ready: boolean; manualReviewRequired: boolean; checks: Array<{ code: string }> };
      manualReview: { ready: boolean; manualReviewRequired: boolean; mismatchCount: number };
      skippedReconcile: {
        status: string;
        ready: boolean;
        liveOrderCapable: boolean;
        manualReviewRequired: boolean;
        latestReconcileAt: string | null;
        checks: Array<{ code: string; status: string }>;
      };
      staleBalanceReconcile: {
        status: string;
        ready: boolean;
        liveOrderCapable: boolean;
        manualReviewRequired: boolean;
        checks: Array<{ code: string; status: string; details?: { balanceStatus?: string } }>;
      };
      missingReconcile: {
        status: string;
        ready: boolean;
        liveOrderCapable: boolean;
        manualReviewRequired: boolean;
        latestReconcileAt: string | null;
        checks: Array<{ code: string; status: string }>;
      };
      manualTui: string;
      calls: { openOrders: number; balances: number };
    };

    expect(output.summary).toMatchObject({
      ready: true,
      providerProbeAttempted: true,
      openOrderCount: 1,
      openExposureKrw: "5000",
      budgetUsedKrw: "7000",
      realizedPnlKrw: "1200",
      unrealizedPnlKrw: "-300",
      latestReconcileAt: "2026-06-15T01:00:00.000Z",
      mismatchCount: 0,
      manualReviewRequired: false,
      privateRead: {
        balanceCurrencyCount: 2,
        krwAvailable: "93000",
        krwLocked: "7000",
      },
    });
    expect(output.malformed).toMatchObject({
      status: "manual_review_required",
      ready: false,
      manualReviewRequired: true,
    });
    expect(output.malformed.checks.map((check) => check.code)).toContain("live_ops_private_read_orders_malformed");
    expect(output.malformedOrder).toMatchObject({
      status: "manual_review_required",
      ready: false,
      manualReviewRequired: true,
    });
    expect(output.malformedOrder.checks.map((check) => check.code)).toContain("live_ops_private_read_open_exposure_malformed");
    expect(output.manualReview).toMatchObject({
      ready: false,
      manualReviewRequired: true,
      mismatchCount: 2,
    });
    expect(output.skippedReconcile).toMatchObject({
      status: "manual_review_required",
      ready: false,
      liveOrderCapable: false,
      manualReviewRequired: true,
      latestReconcileAt: null,
    });
    expect(output.skippedReconcile.checks).toContainEqual(expect.objectContaining({
      code: "live_ops_reconcile_status_requires_review",
      status: "blocked",
    }));
    expect(output.staleBalanceReconcile).toMatchObject({
      status: "manual_review_required",
      ready: false,
      liveOrderCapable: false,
      manualReviewRequired: true,
    });
    expect(output.staleBalanceReconcile.checks).toContainEqual(expect.objectContaining({
      code: "live_ops_reconcile_status_requires_review",
      status: "blocked",
      details: expect.objectContaining({ balanceStatus: "STALE" }),
    }));
    expect(output.missingReconcile).toMatchObject({
      status: "manual_review_required",
      ready: false,
      liveOrderCapable: false,
      manualReviewRequired: true,
      latestReconcileAt: null,
    });
    expect(output.missingReconcile.checks).toContainEqual(expect.objectContaining({
      code: "live_ops_reconcile_status_requires_review",
      status: "blocked",
    }));
    expect(output.manualTui).toContain("mismatch 2");
    expect(output.manualTui).toContain("manual review 필요");
    expect(output.manualTui).toContain("realized PnL 확인 필요 KRW");
    expect(output.calls).toEqual({ openOrders: 1, balances: 1 });
    expect(result.stdout).not.toContain("fake-upbit-secret-key");
    expect(result.stdout).not.toContain("Authorization");
  });

  it("Telegram helper는 owner chat dispatch port를 호출하고 실패를 retry/manual review summary로 격리한다", () => {
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `
import {
  evaluateLiveOpsCliTelegramAlert,
  renderLiveOpsTuiDashboard,
} from "./scripts/run-live-ops-support.mjs";

const config = {
  universe: { default_market: "KRW-BTC" },
  telegram: {
    startup_alert_enabled: true,
    live_order_capable_alert_enabled: true,
    trade_event_alerts_enabled: true,
  },
};
const liveExecution = {
  status: "submitted",
  ready: true,
  liveOrderCapable: true,
  attemptedOrderCount: 1,
  submittedOrderCount: 1,
  attemptStatus: "SUBMITTED",
  attemptId: "ops-attempt-1",
  idempotencyKey: "ops-idem-1",
  brokerOrderId: "upbit-order-1",
  message: "실주문 실행 경계가 주문 후보를 broker 제출까지 전진시켰습니다.",
};
const orderIntent = {
  market: "KRW-BTC",
  strategyId: "live_ops_fixture_strategy",
  side: "BUY",
  orderType: "LIMIT",
  requestedQuantity: "0.0001",
  requestedNotional: "10000",
  requestedPrice: "100000000",
};
const observedAt = "2026-06-15T01:00:00.000Z";
const dispatches = [];
const manualDispatches = [];
const cleanupDispatches = [];
const idleDispatches = [];
const genericBlockedDispatches = [];
const blockedDispatches = [];
const sent = await evaluateLiveOpsCliTelegramAlert({
  config,
  fixtureSmoke: false,
  liveExecution,
  orderIntent,
  observedAt,
  telegramDispatcher: {
    async dispatch(payload) {
      dispatches.push(payload);
      return {
        status: "sent",
        attemptedCount: payload.events.length,
        deliveredCount: payload.events.length,
        cooldownHitCount: 0,
        retryPlannedCount: 0,
        failureCount: 0,
      };
    },
  },
});
const manualReview = await evaluateLiveOpsCliTelegramAlert({
  config,
  fixtureSmoke: false,
  liveExecution: {
    ...liveExecution,
    status: "manual_review_required",
    ready: false,
    liveOrderCapable: false,
    attemptStatus: "MANUAL_REVIEW_REQUIRED",
    message: "실주문 실행 결과를 확정할 수 없어 수동 점검 상태로 전환했습니다.",
  },
  orderIntent,
  observedAt,
  telegramDispatcher: {
    async dispatch(payload) {
      manualDispatches.push(payload);
      return {
        status: "sent",
        attemptedCount: payload.events.length,
        deliveredCount: payload.events.length,
        cooldownHitCount: 0,
        retryPlannedCount: 0,
        failureCount: 0,
      };
    },
  },
});
const manualReviewWithoutDispatcher = await evaluateLiveOpsCliTelegramAlert({
  config,
  fixtureSmoke: false,
  liveExecution: {
    ...liveExecution,
    status: "manual_review_required",
    ready: false,
    liveOrderCapable: false,
    attemptStatus: "MANUAL_REVIEW_REQUIRED",
    message: "실주문 실행 결과를 확정할 수 없어 수동 점검 상태로 전환했습니다.",
  },
  orderIntent,
  observedAt,
});
const cleanupCompleted = await evaluateLiveOpsCliTelegramAlert({
  config,
  fixtureSmoke: false,
  liveExecution: {
    ...liveExecution,
    status: "cancel_confirmed",
    ready: true,
    liveOrderCapable: true,
    attemptStatus: "CANCEL_CONFIRMED",
    cleanupStatus: "completed",
    cancelRequestedAt: observedAt,
    terminalCheckedAt: observedAt,
    cleanup: { cleanCancel: true },
    message: "실주문 제출, 취소 요청, terminal cancel 확인이 같은 cleanup attempt에서 완료됐습니다.",
  },
  orderIntent,
  observedAt,
  telegramDispatcher: {
    async dispatch(payload) {
      cleanupDispatches.push(payload);
      return {
        status: "sent",
        attemptedCount: payload.events.length,
        deliveredCount: payload.events.length,
        cooldownHitCount: 0,
        retryPlannedCount: 0,
        failureCount: 0,
      };
    },
  },
});
const idleWithoutDispatcher = await evaluateLiveOpsCliTelegramAlert({
  config,
  fixtureSmoke: false,
  liveExecution: {
    ...liveExecution,
    status: "idle",
    ready: true,
    liveOrderCapable: false,
    attemptedOrderCount: 0,
    submittedOrderCount: 0,
    attemptStatus: null,
    message: "production decision tick에 주문 후보가 없어 broker 제출은 발생하지 않았습니다.",
  },
  orderIntent: undefined,
  observedAt,
});
const idleWithDispatcher = await evaluateLiveOpsCliTelegramAlert({
  config,
  fixtureSmoke: false,
  liveExecution: {
    ...liveExecution,
    status: "idle",
    ready: true,
    liveOrderCapable: false,
    attemptedOrderCount: 0,
    submittedOrderCount: 0,
    attemptStatus: null,
    message: "production decision tick에 주문 후보가 없어 broker 제출은 발생하지 않았습니다.",
  },
  orderIntent: undefined,
  observedAt,
  telegramDispatcher: {
    async dispatch(payload) {
      idleDispatches.push(payload);
      return {
        status: "sent",
        attemptedCount: payload.events.length,
        deliveredCount: payload.events.length,
        cooldownHitCount: 0,
        retryPlannedCount: 0,
        failureCount: 0,
      };
    },
  },
});
const genericBlocked = await evaluateLiveOpsCliTelegramAlert({
  config,
  fixtureSmoke: false,
  liveExecution: {
    ...liveExecution,
    status: "blocked",
    ready: false,
    liveOrderCapable: false,
    attemptedOrderCount: 0,
    submittedOrderCount: 0,
    attemptStatus: null,
    message: "live broker port가 연결되지 않아 broker 제출을 중단했습니다.",
  },
  orderIntent,
  observedAt,
  telegramDispatcher: {
    async dispatch(payload) {
      genericBlockedDispatches.push(payload);
      return {
        status: "sent",
        attemptedCount: payload.events.length,
        deliveredCount: payload.events.length,
        cooldownHitCount: 0,
        retryPlannedCount: 0,
        failureCount: 0,
      };
    },
  },
});
const blocked = await evaluateLiveOpsCliTelegramAlert({
  config,
  fixtureSmoke: false,
  liveExecution: {
    ...liveExecution,
    status: "blocked",
    ready: false,
    liveOrderCapable: false,
    attemptedOrderCount: 1,
    submittedOrderCount: 0,
    attemptStatus: "BLOCKED",
    message: "현재 CostModel/RiskGate 입력이 제출 조건을 통과하지 못해 broker 제출을 중단했습니다.",
  },
  orderIntent,
  observedAt,
  telegramDispatcher: {
    async dispatch(payload) {
      blockedDispatches.push(payload);
      return {
        status: "sent",
        attemptedCount: payload.events.length,
        deliveredCount: payload.events.length,
        cooldownHitCount: 0,
        retryPlannedCount: 0,
        failureCount: 0,
      };
    },
  },
});
const failed = await evaluateLiveOpsCliTelegramAlert({
  config,
  fixtureSmoke: false,
  liveExecution,
  orderIntent,
  observedAt,
  telegramDispatcher: {
    async dispatch(payload) {
      return {
        status: "partial_failure",
        attemptedCount: payload.events.length,
        deliveredCount: payload.events.length - 1,
        cooldownHitCount: 0,
        retryPlannedCount: 1,
        failureCount: 1,
      };
    },
  },
});
const failedTui = renderLiveOpsTuiDashboard({
  status: "blocked",
  mode: "소액 실운영",
  configPath: "/tmp/live-ops.json",
  envFilePath: "/tmp/live-ops.env",
  liveOrderCapable: false,
  tui: true,
  attach: null,
  fixtureSmoke: false,
  dbReadiness: { ready: true, migration: { appliedLatestVersion: 13, expectedLatestVersion: 13, pendingVersions: [] } },
  marketData: { ready: true, persisted: { tradeCount: 1, orderbookCount: 1, statusCount: 1 }, latestHeartbeatAt: observedAt },
  analysisDecision: { ready: true, decisionCategory: "ORDER_INTENT", orderIntentCount: 1, evaluatedStrategyCount: 1, latestDecisionAt: observedAt },
  liveExecution,
  reconcilePnlStatus: {
    ready: true,
    statusLabel: "private read 확인",
    reconcileStatusLabel: "정상",
    pnlStatusLabel: "정상",
    openOrderCount: 0,
    providerProbeAttempted: true,
    openExposureKrw: "0",
    budgetUsedKrw: "0",
    realizedPnlKrw: "0",
    unrealizedPnlKrw: "0",
    latestReconcileAt: observedAt,
    mismatchCount: 0,
    manualReviewRequired: false,
  },
  telegramAlert: failed,
  budget: {
    maxOrderKrw: "10000",
    dailyAutonomousNotionalLimitKrw: "30000",
    maxOpenPositionNotionalKrw: "30000",
    operationsStopCeilingKrw: "49999",
  },
  trace: { workers: ["telegram_alert"], defaultMarket: "KRW-BTC" },
});
console.log(JSON.stringify({
  sent,
  manualReview,
  manualReviewWithoutDispatcher,
  cleanupCompleted,
  idleWithoutDispatcher,
  idleWithDispatcher,
  genericBlocked,
  blocked,
  failed,
  eventKinds: dispatches[0].events.map((event) => event.eventKind),
  submittedEvent: dispatches[0].events.find((event) => event.eventKind === "ORDER_SUBMITTED"),
  manualEventKinds: manualDispatches[0].events.map((event) => event.eventKind),
  cleanupEventKinds: cleanupDispatches[0].events.map((event) => event.eventKind),
  idleEventKinds: idleDispatches[0].events.map((event) => event.eventKind),
  genericBlockedDispatchCount: genericBlockedDispatches.length,
  blockedEventKinds: blockedDispatches[0].events.map((event) => event.eventKind),
  blockedDispatchCount: blockedDispatches.length,
  dispatchedMarket: dispatches[0].market,
  failedTui,
}));
        `,
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: minimalEnv(),
      },
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    const output = JSON.parse(result.stdout) as {
      sent: { ready: boolean; providerDispatchAttempted: boolean; alertCount: number; deliveredCount: number };
      manualReview: { ready: boolean; providerDispatchAttempted: boolean; alertCount: number; deliveredCount: number };
      manualReviewWithoutDispatcher: { ready: boolean; providerDispatchAttempted: boolean; status: string; checks: { code: string }[] };
      cleanupCompleted: { ready: boolean; providerDispatchAttempted: boolean; alertCount: number; deliveredCount: number; status: string };
      idleWithoutDispatcher: { ready: boolean; providerDispatchAttempted: boolean; status: string; checks: { code: string }[] };
      idleWithDispatcher: { ready: boolean; providerDispatchAttempted: boolean; alertCount: number; deliveredCount: number; status: string };
      genericBlocked: { ready: boolean; providerDispatchAttempted: boolean; alertCount: number; status: string };
      blocked: { ready: boolean; providerDispatchAttempted: boolean; alertCount: number; deliveredCount: number; status: string };
      failed: { ready: boolean; status: string; retryPlannedCount: number; failureCount: number; action: string };
      eventKinds: string[];
      submittedEvent: { orderId?: string; brokerOrderId?: string; idempotencyKey?: string };
      manualEventKinds: string[];
      cleanupEventKinds: string[];
      idleEventKinds: string[];
      genericBlockedDispatchCount: number;
      blockedEventKinds: string[];
      blockedDispatchCount: number;
      dispatchedMarket: string;
      failedTui: string;
    };

    expect(output.sent).toMatchObject({
      ready: true,
      providerDispatchAttempted: true,
      alertCount: 3,
      deliveredCount: 3,
    });
    expect(output.eventKinds).toEqual([
      "TELEGRAM_CONNECTION_READY",
      "LIVE_ORDER_CAPABLE_STARTED",
      "ORDER_SUBMITTED",
    ]);
    expect(output.submittedEvent).toMatchObject({
      orderId: "ops-attempt-1",
      brokerOrderId: "upbit-order-1",
      idempotencyKey: "ops-idem-1",
    });
    expect(output.manualReview).toMatchObject({
      ready: true,
      providerDispatchAttempted: true,
      alertCount: 2,
      deliveredCount: 2,
    });
    expect(output.manualEventKinds).toEqual([
      "TELEGRAM_CONNECTION_READY",
      "MANUAL_REVIEW_REQUIRED",
    ]);
    expect(output.manualReviewWithoutDispatcher).toMatchObject({
      ready: false,
      providerDispatchAttempted: false,
      status: "blocked",
    });
    expect(output.manualReviewWithoutDispatcher.checks.map((check) => check.code)).toContain("live_ops_telegram_boundary_missing");
    expect(output.cleanupCompleted).toMatchObject({
      ready: true,
      providerDispatchAttempted: true,
      alertCount: 5,
      deliveredCount: 5,
      status: "sent",
    });
    expect(output.cleanupEventKinds).toEqual([
      "TELEGRAM_CONNECTION_READY",
      "LIVE_ORDER_CAPABLE_STARTED",
      "ORDER_SUBMITTED",
      "CANCEL_REQUESTED",
      "CANCEL_CONFIRMED",
    ]);
    expect(output.idleWithoutDispatcher).toMatchObject({
      ready: true,
      providerDispatchAttempted: false,
      status: "idle",
    });
    expect(output.idleWithoutDispatcher.checks.map((check) => check.code)).toContain("live_ops_telegram_not_required");
    expect(output.idleWithDispatcher).toMatchObject({
      ready: true,
      providerDispatchAttempted: true,
      alertCount: 1,
      deliveredCount: 1,
      status: "sent",
    });
    expect(output.idleEventKinds).toEqual([
      "TELEGRAM_CONNECTION_READY",
    ]);
    expect(output.genericBlocked).toMatchObject({
      ready: false,
      providerDispatchAttempted: false,
      alertCount: 0,
      status: "pending",
    });
    expect(output.genericBlockedDispatchCount).toBe(0);
    expect(output.blocked).toMatchObject({
      ready: true,
      providerDispatchAttempted: true,
      alertCount: 2,
      deliveredCount: 2,
      status: "sent",
    });
    expect(output.blockedEventKinds).toEqual([
      "TELEGRAM_CONNECTION_READY",
      "RISK_BLOCKED",
    ]);
    expect(output.blockedDispatchCount).toBe(1);
    expect(output.dispatchedMarket).toBe("KRW-BTC");
    expect(output.failed).toMatchObject({
      ready: false,
      status: "manual_review_required",
      retryPlannedCount: 1,
      failureCount: 1,
    });
    expect(output.failed.action).toContain("되돌리지 않습니다");
    expect(output.failedTui).toContain("Telegram alert: 전송 재시도 필요");
    expect(output.failedTui).toContain("retry 1");
    expect(output.failedTui).toContain("failure 1");
    expect(output.failedTui).not.toContain("Telegram alert: 후속 연결 대기");
  });

  it("production provider wiring은 DB reconcile/private read와 Telegram dispatcher를 실제 경계에 연결한다", () => {
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `
import {
  createLiveOpsCliDatabasePrivateReadProvider,
  createLiveOpsCliDatabasePnlStatusProvider,
  createLiveOpsCliDatabaseReconcileStatusProvider,
  createLiveOpsCliTelegramDispatcher,
} from "./scripts/run-live-ops-support.mjs";

const observedAt = "2026-06-15T01:00:00.000Z";
const queries = [];
const pool = {
  async query(sql, params = []) {
    const text = sql.replace(/\\s+/gu, " ").trim();
    queries.push({ text, params });
    if (text.includes("FROM live_reconcile_exchange_order_snapshots") && text.includes("exchange_order_id")) {
      const marketFilter = params[0];
      const rows = [
        {
          id: "row-terminal",
          exchange_order_id: null,
          identifier: "ops-idem-closed",
          identity_fingerprint: null,
          market: "KRW-BTC",
          side: "BUY",
          status: "CANCEL",
          requested_quantity: "0.0002",
          remaining_quantity: "0",
          requested_price: "100000000",
          source: "closed",
          captured_at: "2026-06-15T01:02:00.000Z",
        },
        {
          id: "row-open",
          exchange_order_id: "upbit-order-1",
          identifier: "ops-idem-1",
          identity_fingerprint: null,
          market: "KRW-BTC",
          side: "BUY",
          status: "WAIT",
          requested_quantity: "0.0001",
          remaining_quantity: "0.00005",
          requested_price: "100000000",
          source: "open",
          captured_at: observedAt,
        },
        {
          id: "row-eth-open",
          exchange_order_id: "eth-open-order-1",
          identifier: "eth-open-identifier-1",
          identity_fingerprint: null,
          market: "KRW-ETH",
          side: "BUY",
          status: "WAIT",
          requested_quantity: "0.002",
          remaining_quantity: "0.002",
          requested_price: "2500000",
          source: "open",
          captured_at: observedAt,
        },
        {
          id: "row-bridge",
          exchange_order_id: "upbit-closed-order",
          identifier: "ops-idem-closed",
          identity_fingerprint: null,
          market: "KRW-BTC",
          side: "BUY",
          status: "WAIT",
          requested_quantity: "0.0002",
          remaining_quantity: "0.0001",
          requested_price: "100000000",
          source: "lookup",
          captured_at: "2026-06-15T01:00:30.000Z",
        },
        {
          id: "row-stale-open",
          exchange_order_id: "upbit-closed-order",
          identifier: null,
          identity_fingerprint: null,
          market: "KRW-BTC",
          side: "BUY",
          status: "WAIT",
          requested_quantity: "0.0002",
          remaining_quantity: "0.0001",
          requested_price: "100000000",
          source: "open",
          captured_at: "2026-06-15T01:00:00.000Z",
        },
      ];
      return {
        rows: marketFilter === undefined ? rows : rows.filter((row) => row.market === marketFilter),
      };
    }
    if (text.includes("FROM live_reconcile_balance_snapshots") && text.includes("SELECT currency")) {
      return {
        rows: [{
          currency: "KRW",
          available: "93000",
          locked: "7000",
          total: "100000",
          captured_at: observedAt,
        }],
      };
    }
    if (text.includes("FROM live_reconcile_runs") && text.includes("mismatch_count")) {
      return {
        rows: [{
          id: "run-1",
          status: "COMPLETED",
          started_at: observedAt,
          finished_at: observedAt,
          correlation_id: "corr-1",
          balance_snapshot_count: 1,
          exchange_order_snapshot_count: 1,
          open_order_count: 1,
          mismatch_count: 0,
          mismatch_types: [],
        }],
      };
    }
    if (text.includes("FROM pnl_snapshots") && text.includes("LIMIT 1")) {
      return {
        rows: [{
          strategy_id: "live_ops",
          market: params[0],
          captured_at: observedAt,
          equity: "100000",
          realized_pnl: "1200",
          unrealized_pnl: "-300",
          drawdown_bps: "5",
          source_fingerprint: "pnl-snapshot-1",
          payload_status: "COMPLETE",
        }],
      };
    }
    if (text.includes("count(*)::int AS count") && text.includes("FROM pnl_snapshots")) {
      return { rows: [{ count: 3 }] };
    }
    throw new Error(\`unexpected query: \${text}\`);
  },
};

const privateReadProvider = createLiveOpsCliDatabasePrivateReadProvider(pool);
const reconcileStatusProvider = createLiveOpsCliDatabaseReconcileStatusProvider(pool);
const pnlStatusProvider = createLiveOpsCliDatabasePnlStatusProvider(pool, "KRW-BTC");
const openOrders = await privateReadProvider.listOpenOrders("KRW-BTC");
const accountOpenOrders = await privateReadProvider.listOpenOrders();
const balances = await privateReadProvider.getBalances();
const reconcile = await reconcileStatusProvider.getReconcileStatus();
const pnl = await pnlStatusProvider.getStatus();

const fetchCalls = [];
const telegramDispatcher = createLiveOpsCliTelegramDispatcher({
  config: { telegram: { provider_timeout_ms: 1000 } },
  env: {
    SEEMIRAI_TELEGRAM_BOT_TOKEN: "fake-telegram-token",
    SEEMIRAI_TELEGRAM_CHAT_ID: "owner-chat-1",
  },
  async fetchImpl(url, options) {
    fetchCalls.push({
      urlIncludesToken: String(url).includes("fake-telegram-token"),
      method: options.method,
      body: JSON.parse(options.body),
    });
    return {
      ok: true,
      async json() {
        return { ok: true };
      },
    };
  },
});
const telegram = await telegramDispatcher.dispatch({
  market: "KRW-BTC",
  observedAt,
  events: [{
    eventKind: "ORDER_SUBMITTED",
    market: "KRW-BTC",
    occurredAt: observedAt,
    safeSummary: "주문 제출 evidence가 확정되었습니다.",
    orderId: "ops-attempt-1",
    brokerOrderId: "upbit-order-1",
    idempotencyKey: "ops-idem-1",
  }],
});
const missingTelegramDispatcher = createLiveOpsCliTelegramDispatcher({
  config: {},
  env: {},
  async fetchImpl() {
    throw new Error("unexpected-fetch");
  },
});

console.log(JSON.stringify({
  openOrders,
  accountOpenOrders,
  balances,
  reconcile,
  pnl,
  telegram,
  missingTelegramDispatcher: missingTelegramDispatcher === undefined,
  fetchCall: fetchCalls[0],
  openOrderQueries: queries
    .filter((query) => query.text.includes("FROM live_reconcile_exchange_order_snapshots"))
    .map((query) => ({
      params: query.params,
      hasMarketFilter: query.text.includes("AND market = $1"),
    })),
  queryCount: queries.length,
}));
        `,
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: minimalEnv(),
      },
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    const output = JSON.parse(result.stdout) as {
      openOrders: Array<{
        brokerOrderId: string;
        idempotencyKey: string;
        exchangeId: string;
        market: string;
        remainingQuantity: string;
      }>;
      accountOpenOrders: Array<{
        brokerOrderId: string;
        idempotencyKey: string;
        exchangeId: string;
        market: string;
        remainingQuantity: string;
      }>;
      balances: { exchangeId: string; capturedAt: string; balances: Array<{ currency: string; total: string }> };
      reconcile: { result: string; mismatchCount: number; openOrderCount: number; balanceStatus: string; actionRequired: string };
      pnl: { readStatus: string; latestRealizedPnlKrw: string; latestUnrealizedPnlKrw: string; snapshotCount: number };
      telegram: { status: string; attemptedCount: number; deliveredCount: number; failureCount: number };
      missingTelegramDispatcher: boolean;
      fetchCall: { urlIncludesToken: boolean; method: string; body: { chat_id: string; text: string } };
      openOrderQueries: Array<{ params: unknown[]; hasMarketFilter: boolean }>;
      queryCount: number;
    };

    expect(output.openOrders).toEqual([expect.objectContaining({
      brokerOrderId: "upbit-order-1",
      idempotencyKey: "ops-idem-1",
      exchangeId: "upbit_krw_spot",
      market: "KRW-BTC",
      remainingQuantity: "0.00005",
    })]);
    expect(output.accountOpenOrders).toEqual([
      expect.objectContaining({
        brokerOrderId: "upbit-order-1",
        market: "KRW-BTC",
      }),
      expect.objectContaining({
        brokerOrderId: "eth-open-order-1",
        market: "KRW-ETH",
      }),
    ]);
    expect(output.openOrderQueries).toEqual(expect.arrayContaining([
      { params: ["KRW-BTC"], hasMarketFilter: true },
      { params: [], hasMarketFilter: false },
    ]));
    expect(output.balances).toMatchObject({
      exchangeId: "upbit_krw_spot",
      capturedAt: "2026-06-15T01:00:00.000Z",
      balances: [expect.objectContaining({ currency: "KRW", total: "100000" })],
    });
    expect(output.reconcile).toMatchObject({
      result: "SUCCESS",
      mismatchCount: 0,
      openOrderCount: 1,
      balanceStatus: "OK",
      actionRequired: "없음",
    });
    expect(output.pnl).toMatchObject({
      readStatus: "OK",
      latestRealizedPnlKrw: "1200",
      latestUnrealizedPnlKrw: "-300",
      snapshotCount: 3,
    });
    expect(output.telegram).toMatchObject({
      status: "sent",
      attemptedCount: 1,
      deliveredCount: 1,
      failureCount: 0,
    });
    expect(output.fetchCall).toMatchObject({
      urlIncludesToken: true,
      method: "POST",
      body: expect.objectContaining({
        chat_id: "owner-chat-1",
      }),
    });
    expect(output.fetchCall.body.text).toContain("주문 제출");
    expect(output.fetchCall.body.text).toContain("추적 정보");
    expect(output.missingTelegramDispatcher).toBe(true);
    expect(output.queryCount).toBeGreaterThanOrEqual(5);
    expect(result.stdout).not.toContain("fake-telegram-token");
  });

  it("database PnL status provider는 같은 strategy 최신 row를 기준으로 aggregate fallback과 not-ready 차단을 보존한다", async () => {
    const supportModulePath = path.join(process.cwd(), "scripts/run-live-ops-support.mjs");
    const {
      createLiveOpsCliDatabasePnlStatusProvider,
    } = await import(supportModulePath);
    const queries: Array<{ text: string; params: unknown[] }> = [];
    const staleMarketRow = {
      strategy_id: "live_ops_cleanup_probe",
      market: "KRW-BTC",
      captured_at: "2026-06-18T13:32:00.000Z",
      equity: "100000",
      realized_pnl: "0",
      unrealized_pnl: "0",
      drawdown_bps: "0",
      source_fingerprint: "stale-market",
      payload_status: "CALCULATED",
    };
    const freshOtherStrategyAggregateRow = {
      strategy_id: "other_strategy",
      market: null,
      captured_at: "2026-06-18T13:33:28.000Z",
      equity: "999999",
      realized_pnl: "-9999",
      unrealized_pnl: "9999",
      drawdown_bps: "99",
      source_fingerprint: "other-strategy-aggregate",
      payload_status: "CALCULATED",
    };
    const freshAggregateRow = {
      strategy_id: "live_ops_cleanup_probe",
      market: null,
      captured_at: "2026-06-18T13:33:27.000Z",
      equity: "100000",
      realized_pnl: "-120",
      unrealized_pnl: "30",
      drawdown_bps: "2",
      source_fingerprint: "fresh-aggregate",
      payload_status: "CALCULATED",
    };
    const freshestNotReadyRow = {
      strategy_id: "live_ops_cleanup_probe",
      market: "KRW-BTC",
      captured_at: "2026-06-18T13:33:29.000Z",
      equity: "100000",
      realized_pnl: "0",
      unrealized_pnl: "0",
      drawdown_bps: "0",
      source_fingerprint: "fresh-not-ready",
      payload_status: "PARTIAL",
    };
    let rows = [freshOtherStrategyAggregateRow, freshestNotReadyRow, freshAggregateRow, staleMarketRow];
    const pool = {
      async query(sql: string, params: unknown[] = []) {
        const text = sql.replace(/\s+/gu, " ").trim();
        queries.push({ text, params });
        if (text.includes("FROM pnl_snapshots") && text.includes("LIMIT 1")) {
          const orderBy = text.slice(text.indexOf("ORDER BY"));
          const capturedBeforeMarketPreference = orderBy.indexOf("captured_at") >= 0
            && orderBy.indexOf("captured_at") < orderBy.indexOf("(market = $1)");
          const filtersLiveOpsStrategy = text.includes("strategy_id = 'live_ops_cleanup_probe'");
          return {
            rows: [capturedBeforeMarketPreference && filtersLiveOpsStrategy
              ? rows.filter((row) => row.strategy_id === "live_ops_cleanup_probe").sort((left, right) => (
                String(right.captured_at).localeCompare(String(left.captured_at))
              ))[0]
              : staleMarketRow],
          };
        }
        if (text.includes("count(*)::int AS count") && text.includes("FROM pnl_snapshots")) {
          return { rows: [{ count: text.includes("strategy_id = 'live_ops_cleanup_probe'")
            ? rows.filter((row) => row.strategy_id === "live_ops_cleanup_probe").length
            : rows.length }] };
        }
        throw new Error(`unexpected query: ${text}`);
      },
    };

    const status = await createLiveOpsCliDatabasePnlStatusProvider(pool, "KRW-BTC").getStatus();

    expect(status).toMatchObject({
      readStatus: "OK",
      latestCapturedAt: "2026-06-18T13:33:29.000Z",
      latestRealizedPnlKrw: "0",
      latestUnrealizedPnlKrw: "0",
      latestStatus: "PARTIAL",
      snapshotCount: 3,
    });
    expect(queries[0]?.params).toEqual(["KRW-BTC"]);
    expect(queries[0]?.text).toContain("strategy_id = 'live_ops_cleanup_probe'");

    rows = [freshOtherStrategyAggregateRow, freshAggregateRow, staleMarketRow];
    const aggregateFallbackStatus = await createLiveOpsCliDatabasePnlStatusProvider(pool, "KRW-BTC").getStatus();

    expect(aggregateFallbackStatus).toMatchObject({
      readStatus: "OK",
      latestCapturedAt: "2026-06-18T13:33:27.000Z",
      latestRealizedPnlKrw: "-120",
      latestUnrealizedPnlKrw: "30",
      latestStatus: "CALCULATED",
      snapshotCount: 2,
    });
  });

  it("database reconcile status provider는 잔량 미확인 open order도 open으로 집계한다", async () => {
    const supportSource = await readFile(
      path.join(process.cwd(), "scripts/run-live-ops-support.mjs"),
      "utf8",
    );

    expect(supportSource).toContain("remaining_quantity IS NULL OR remaining_quantity > 0");
  });

  it("database PnL status provider는 cleanup strategy row가 없으면 global 계산 완료 row를 최초 cleanup 손실 근거로 읽는다", async () => {
    const supportModulePath = path.join(process.cwd(), "scripts/run-live-ops-support.mjs");
    const {
      createLiveOpsCliDatabasePnlStatusProvider,
    } = await import(supportModulePath);
    const queries: Array<{ text: string; params: unknown[] }> = [];
    const globalCalculatedRow = {
      strategy_id: null,
      market: null,
      captured_at: "2026-06-18T13:33:27.000Z",
      equity: "100000",
      realized_pnl: "0",
      unrealized_pnl: "0",
      drawdown_bps: "0",
      source_fingerprint: "global-calculated",
      payload_status: "CALCULATED",
    };
    const pool = {
      async query(sql: string, params: unknown[] = []) {
        const text = sql.replace(/\s+/gu, " ").trim();
        queries.push({ text, params });
        if (text.includes("FROM pnl_snapshots") && text.includes("LIMIT 1")) {
          const allowsGlobalFallback = text.includes("strategy_id IS NULL");
          return { rows: allowsGlobalFallback ? [globalCalculatedRow] : [] };
        }
        if (text.includes("count(*)::int AS count") && text.includes("FROM pnl_snapshots")) {
          const allowsGlobalFallback = text.includes("strategy_id IS NULL");
          return { rows: [{ count: allowsGlobalFallback ? 1 : 0 }] };
        }
        throw new Error(`unexpected query: ${text}`);
      },
    };

    const status = await createLiveOpsCliDatabasePnlStatusProvider(pool, "KRW-BTC").getStatus();

    expect(status).toMatchObject({
      readStatus: "OK",
      latestCapturedAt: "2026-06-18T13:33:27.000Z",
      latestRealizedPnlKrw: "0",
      latestUnrealizedPnlKrw: "0",
      latestStatus: "CALCULATED",
      snapshotCount: 1,
    });
    expect(queries[0]?.text).toContain("strategy_id IS NULL");
  });

  it("database PnL status provider는 cleanup row가 없으면 최신 not-ready보다 CALCULATED fallback row를 우선한다", async () => {
    const supportModulePath = path.join(process.cwd(), "scripts/run-live-ops-support.mjs");
    const {
      createLiveOpsCliDatabasePnlStatusProvider,
    } = await import(supportModulePath);
    const queries: Array<{ text: string; params: unknown[] }> = [];
    const freshNotReadyFallbackRow = {
      strategy_id: null,
      market: "KRW-BTC",
      captured_at: "2026-06-18T13:33:29.000Z",
      equity: "100000",
      realized_pnl: "0",
      unrealized_pnl: "0",
      drawdown_bps: "0",
      source_fingerprint: "fresh-not-ready",
      payload_status: "PARTIAL",
    };
    const olderCalculatedFallbackRow = {
      strategy_id: "global",
      market: null,
      captured_at: "2026-06-18T13:33:27.000Z",
      equity: "100000",
      realized_pnl: "-120",
      unrealized_pnl: "30",
      drawdown_bps: "2",
      source_fingerprint: "older-calculated",
      payload_status: "CALCULATED",
    };
    const pool = {
      async query(sql: string, params: unknown[] = []) {
        const text = sql.replace(/\s+/gu, " ").trim();
        queries.push({ text, params });
        if (text.includes("FROM pnl_snapshots") && text.includes("LIMIT 1")) {
          const prefersCalculatedFallback = text.includes("payload_json ->> 'status' = 'CALCULATED'");
          return { rows: [prefersCalculatedFallback ? olderCalculatedFallbackRow : freshNotReadyFallbackRow] };
        }
        if (text.includes("count(*)::int AS count") && text.includes("FROM pnl_snapshots")) {
          return { rows: [{ count: 2 }] };
        }
        throw new Error(`unexpected query: ${text}`);
      },
    };

    const status = await createLiveOpsCliDatabasePnlStatusProvider(pool, "KRW-BTC").getStatus();

    expect(status).toMatchObject({
      readStatus: "OK",
      latestCapturedAt: "2026-06-18T13:33:27.000Z",
      latestRealizedPnlKrw: "-120",
      latestUnrealizedPnlKrw: "30",
      latestStatus: "CALCULATED",
      snapshotCount: 2,
    });
    expect(queries[0]?.text).toContain("payload_json ->> 'status' = 'CALCULATED'");
  });

  it("preflight recorder는 private read 결과를 DB reconcile evidence로 남긴다", async () => {
    const supportModulePath = path.join(process.cwd(), "scripts/run-live-ops-support.mjs");
    const {
      createLiveOpsCliDatabasePreflightReconcileRecorder,
      createLiveOpsCliDatabaseReconcileStatusProvider,
    } = await import(supportModulePath);
    const observedAt = "2026-06-18T13:33:27.000Z";
    const queries: Array<{ text: string; params: unknown[] }> = [];
    const state: {
      run?: {
        id: string;
        status: string;
        started_at: string;
        finished_at: string | null;
        correlation_id: string;
      };
      balanceRows: unknown[];
      orderRows: unknown[];
      mismatchRows: unknown[];
    } = {
      balanceRows: [],
      orderRows: [],
      mismatchRows: [],
    };
    const client = {
      async query(sql: string, params: unknown[] = []) {
        const text = sql.replace(/\s+/gu, " ").trim();
        queries.push({ text, params });
        if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK") {
          return { rows: [] };
        }
        if (text.startsWith("INSERT INTO live_reconcile_runs")) {
          state.run = {
            id: "preflight-run-1",
            status: "RUNNING",
            started_at: params[1] as string,
            finished_at: null,
            correlation_id: params[2] as string,
          };
          return { rows: [state.run] };
        }
        if (text.includes("FROM live_reconcile_runs") && text.includes("WHERE idempotency_key")) {
          return { rows: state.run === undefined ? [] : [state.run] };
        }
        if (text.startsWith("INSERT INTO live_reconcile_balance_snapshots")) {
          state.balanceRows.push(params);
          return { rows: [] };
        }
        if (text.startsWith("INSERT INTO live_reconcile_exchange_order_snapshots")) {
          state.orderRows.push(params);
          return { rows: [] };
        }
        if (text.startsWith("INSERT INTO live_reconcile_mismatch_evidence")) {
          state.mismatchRows.push(params);
          return { rows: [] };
        }
        if (text.startsWith("UPDATE live_reconcile_runs")) {
          state.run = {
            ...state.run!,
            status: params[1] as string,
            finished_at: params[2] as string,
          };
          return { rows: [] };
        }
        throw new Error(`unexpected client query: ${text}`);
      },
      release() {},
    };
    const pool = {
      async connect() {
        return client;
      },
      async query(sql: string) {
        const text = sql.replace(/\s+/gu, " ").trim();
        if (text.includes("FROM live_reconcile_runs") && text.includes("mismatch_count")) {
          if (state.run === undefined) {
            return { rows: [] };
          }
          return {
            rows: [{
              ...state.run,
              balance_snapshot_count: state.balanceRows.length,
              exchange_order_snapshot_count: state.orderRows.length,
              open_order_count: state.orderRows.length,
              mismatch_count: state.mismatchRows.length,
              mismatch_types: state.mismatchRows.length > 0 ? ["UNTRACKED_EXCHANGE_OPEN_ORDER"] : [],
            }],
          };
        }
        throw new Error(`unexpected pool query: ${text}`);
      },
    };
    const recorder = createLiveOpsCliDatabasePreflightReconcileRecorder(pool);
    const reconcileStatusProvider = createLiveOpsCliDatabaseReconcileStatusProvider(pool);

    const cleanEvidence = await recorder.recordPreflight({
      market: "KRW-BTC",
      openOrders: [],
      balanceSnapshot: {
        exchangeId: "upbit_krw_spot",
        capturedAt: observedAt,
        balances: [{
          currency: "KRW",
          available: "50000.9836425",
          locked: "0",
          total: "50000.9836425",
        }],
      },
      observedAt,
    });
    const cleanReconcile = await reconcileStatusProvider.getReconcileStatus();

    expect(cleanEvidence).toMatchObject({
      created: true,
      runId: "preflight-run-1",
      status: "COMPLETED",
      balanceSnapshotCount: 1,
      exchangeOrderSnapshotCount: 0,
      mismatchCount: 0,
      source: "live_ops_cli_private_read_preflight",
    });
    expect(cleanReconcile).toMatchObject({
      result: "SUCCESS",
      balanceStatus: "OK",
      mismatchCount: 0,
      openOrderCount: 0,
    });
    expect(state.balanceRows).toHaveLength(1);
    expect(state.orderRows).toHaveLength(0);
    expect(state.mismatchRows).toHaveLength(0);
    expect(JSON.stringify(queries)).not.toContain("raw_provider_payload");

    delete state.run;
    state.balanceRows = [];
    state.orderRows = [];
    state.mismatchRows = [];
    const manualReviewEvidence = await recorder.recordPreflight({
      market: "KRW-BTC",
      openOrders: [{
        brokerOrderId: "xrp-open-order-1",
        idempotencyKey: "xrp-open-identifier-1",
        exchangeId: "upbit_krw_spot",
        market: "KRW-XRP",
        side: "BUY",
        orderType: "MARKET",
        status: "OPEN",
        requestedQuantity: null,
        remainingQuantity: "10",
        requestedPrice: null,
        updatedAt: observedAt,
      }],
      balanceSnapshot: {
        exchangeId: "upbit_krw_spot",
        capturedAt: observedAt,
        balances: [{
          currency: "KRW",
          available: "50000.9836425",
          locked: "0",
          total: "50000.9836425",
        }],
      },
      observedAt,
    });

    expect(manualReviewEvidence).toMatchObject({
      created: true,
      status: "MANUAL_REVIEW_REQUIRED",
      exchangeOrderSnapshotCount: 1,
      mismatchCount: 1,
      mismatchTypes: ["UNTRACKED_EXCHANGE_OPEN_ORDER"],
    });
    expect(state.orderRows).toHaveLength(1);
    expect(state.orderRows[0]).toEqual(expect.arrayContaining(["KRW-XRP", null]));
    expect(state.mismatchRows).toHaveLength(1);
  });

  it("production preflight는 reconcile 미실행 DB에 private read evidence를 먼저 기록한다", async () => {
    const supportModulePath = path.join(process.cwd(), "scripts/run-live-ops-support.mjs");
    const {
      createLiveOpsCliProductionExecutionInputs,
    } = await import(supportModulePath);
    const recorded: unknown[] = [];
    const listedOpenOrderMarkets: unknown[] = [];
    let reconcileReadCount = 0;
    const config = {
      universe: { markets: ["KRW-BTC"], default_market: "KRW-BTC" },
      budget: {
        max_order_krw: "10000",
        daily_autonomous_notional_limit_krw: "30000",
        max_open_position_notional_krw: "30000",
      },
    };
    const productionRuntime = {
      entryRuntime: {},
      cleanupLifecycle: {},
      privateReadProvider: {
        async listOpenOrders(market?: unknown) {
          listedOpenOrderMarkets.push(market);
          return [];
        },
        async getBalances() {
          return {
            exchangeId: "upbit_krw_spot",
            capturedAt: "2026-06-18T13:33:27.000Z",
            balances: [{
              currency: "KRW",
              available: "50000",
              locked: "0",
              total: "50000",
            }],
          };
        },
      },
      reconcileStatusProvider: {
        async getReconcileStatus() {
          reconcileReadCount += 1;
          if (reconcileReadCount === 1) {
            return {
              lastReconcileAt: null,
              result: "SKIPPED",
              mismatchCount: null,
              openOrderCount: null,
              balanceStatus: "UNAVAILABLE",
              websocketStatus: "DISCONNECTED",
              actionRequired: "reconcile 실행 필요",
              message: "아직 완료된 실계좌 reconcile evidence가 없습니다.",
              trace: { source: "live_ops_cli_database_reconcile", reason: "reconcile_not_run" },
            };
          }
          return {
            lastReconcileAt: "2026-06-18T13:33:27.000Z",
            result: "SUCCESS",
            mismatchCount: 0,
            openOrderCount: 0,
            balanceStatus: "OK",
            websocketStatus: "CONNECTED",
            actionRequired: "없음",
            message: "preflight private read reconcile evidence를 읽었습니다.",
            trace: { source: "live_ops_cli_database_reconcile", runId: "preflight-run-1" },
          };
        },
      },
      pnlStatusProvider: {
        async getStatus() {
          return { readStatus: "NOT_FOUND", reason: "pnl_snapshot_not_found" };
        },
      },
      killSwitchProvider: {
        async getStatus() {
          return {
            active: false,
            state: "NORMAL",
            reasonCode: "initial_state",
            updatedAt: "2026-06-18T13:33:27.000Z",
          };
        },
      },
      budgetReservation: {
        async readDailyReservedNotional() {
          return { reservedNotionalKrw: "0", reservationCount: 0 };
        },
      },
      preflightReconcileRecorder: {
        async recordPreflight(input: unknown) {
          recorded.push(input);
          return {
            created: true,
            runId: "preflight-run-1",
            status: "COMPLETED",
            source: "live_ops_cli_private_read_preflight",
          };
        },
      },
      telegramDispatcher: {},
    };
    const result = await withFakeSystemTime("2026-06-18T13:33:27.000Z", () => createLiveOpsCliProductionExecutionInputs({
      config,
      env: {
        SEEMIRAI_UPBIT_ACCESS_KEY: "fake-access-key",
        SEEMIRAI_UPBIT_SECRET_KEY: "fake-secret-key",
        SEEMIRAI_UPBIT_KEY_SCOPE: "자산조회,주문조회,주문하기",
        SEEMIRAI_UPBIT_KEY_SCOPE_EVIDENCE_ID: "scope-evidence",
      },
      fixtureSmoke: false,
      analysisDecision: {
        ready: true,
        decisionCategory: "ORDER_INTENT",
        orderIntentCount: 1,
      },
      marketData: {
        ready: true,
        latestHeartbeatAt: "2026-06-18T13:33:27.000Z",
      },
      orderIntents: [createCleanupRuntimeIntent()],
      productionRuntime,
    }));

    expect(recorded).toHaveLength(1);
    expect(listedOpenOrderMarkets).toEqual([undefined]);
    expect(reconcileReadCount).toBe(2);
    expect(result.executionStatus).toMatchObject({
      killSwitchActive: false,
      reconcileFresh: true,
      preflightReconcileEvidence: {
        runId: "preflight-run-1",
        status: "COMPLETED",
      },
    });
    expect(result.postSubmitReadiness).toMatchObject({
      reconcileReady: true,
      telegramReady: true,
    });
  });

  it("production preflight는 freshness와 daily budget day를 실행 wall clock 기준으로 판정한다", async () => {
    const supportModulePath = path.join(process.cwd(), "scripts/run-live-ops-support.mjs");
    const {
      createLiveOpsCliProductionExecutionInputs,
    } = await import(supportModulePath);
    const executionAt = "2026-06-19T00:00:10.000Z";
    const latestPnlCapturedAt = "2026-06-19T00:00:10.500Z";
    const latestHeartbeatAt = "2026-06-18T23:59:45.000Z";
    const staleReconcileAt = "2026-06-18T23:59:30.000Z";
    const recorded: unknown[] = [];
    const dailyReadObservedAt: unknown[] = [];
    let reconcileReadCount = 0;
    const config = {
      universe: { markets: ["KRW-BTC"], default_market: "KRW-BTC" },
      budget: {
        max_order_krw: "10000",
        daily_autonomous_notional_limit_krw: "30000",
        max_open_position_notional_krw: "30000",
      },
    };
    const productionRuntime = {
      entryRuntime: {},
      cleanupLifecycle: {},
      privateReadProvider: {
        async listOpenOrders() {
          return [];
        },
        async getBalances() {
          return {
            exchangeId: "upbit_krw_spot",
            capturedAt: executionAt,
            balances: [{
              currency: "KRW",
              available: "50000",
              locked: "0",
              total: "50000",
              updatedAt: executionAt,
            }],
          };
        },
      },
      reconcileStatusProvider: {
        async getReconcileStatus() {
          reconcileReadCount += 1;
          return {
            lastReconcileAt: reconcileReadCount === 1 ? staleReconcileAt : executionAt,
            result: "SUCCESS",
            mismatchCount: 0,
            openOrderCount: 0,
            balanceStatus: "OK",
            websocketStatus: "CONNECTED",
            actionRequired: "없음",
            message: "clean reconcile fixture",
            trace: { source: "live_ops_cli_database_reconcile" },
          };
        },
      },
      pnlStatusProvider: {
        async getStatus() {
          return { readStatus: "OK", latestCapturedAt: latestPnlCapturedAt, latestRealizedPnlKrw: "0", latestUnrealizedPnlKrw: "0", latestStatus: "CALCULATED" };
        },
      },
      killSwitchProvider: {
        async getStatus() {
          return {
            active: false,
            state: "NORMAL",
            reasonCode: "normal",
            updatedAt: executionAt,
          };
        },
      },
      budgetReservation: {
        async readDailyReservedNotional(observedAt: unknown) {
          dailyReadObservedAt.push(observedAt);
          return { reservedNotionalKrw: "0", reservationCount: 0 };
        },
      },
      preflightReconcileRecorder: {
        async recordPreflight(input: unknown) {
          recorded.push(input);
          return {
            created: true,
            runId: "preflight-run-wall-clock",
            status: "COMPLETED",
            source: "live_ops_cli_private_read_preflight",
            recordedAt: executionAt,
          };
        },
      },
      telegramDispatcher: {},
    };

    vi.useFakeTimers();
    vi.setSystemTime(new Date(executionAt));
    let result: Awaited<ReturnType<typeof createLiveOpsCliProductionExecutionInputs>>;
    try {
      result = await createLiveOpsCliProductionExecutionInputs({
        config,
        env: {
          SEEMIRAI_UPBIT_ACCESS_KEY: "fake-access-key",
          SEEMIRAI_UPBIT_SECRET_KEY: "fake-secret-key",
          SEEMIRAI_UPBIT_KEY_SCOPE: "자산조회,주문조회,주문하기",
          SEEMIRAI_UPBIT_KEY_SCOPE_EVIDENCE_ID: "scope-evidence",
        },
        fixtureSmoke: false,
        analysisDecision: {
          ready: true,
          decisionCategory: "ORDER_INTENT",
          orderIntentCount: 1,
        },
        marketData: {
          ready: true,
          latestHeartbeatAt,
          referencePrice: "100000000",
        },
        orderIntents: [createCleanupRuntimeIntent()],
        productionRuntime,
      });
    } finally {
      vi.useRealTimers();
    }

    expect(dailyReadObservedAt).toEqual([executionAt]);
    expect(recorded).toEqual([expect.objectContaining({ observedAt: executionAt })]);
    expect(reconcileReadCount).toBe(2);
    expect(result.executionStatus).toMatchObject({
      killSwitchActive: false,
      reconcileFresh: true,
      preflightReconcileEvidence: {
        runId: "preflight-run-wall-clock",
        status: "COMPLETED",
      },
    });
    expect(result.lossSnapshot).toMatchObject({
      dailyRealizedLossKrw: "0",
      weeklyRealizedLossKrw: "0",
      capturedAt: latestPnlCapturedAt,
      source: "pnl_snapshots",
    });
    expect(result.orderIntents[0]).toMatchObject({
      idempotencyKey: "live_ops_cleanup_probe:2026-06-19:upbit_krw_spot:KRW-BTC:BUY:100000000:0.0001:10000",
      metadata: {
        analysis_idempotency_key: "ops-aaaaaaaaaaaaaaaaaaaaaaaaaa",
        idempotency_date_scope: "2026-06-19",
        idempotency_date_source: "live_ops_runtime_preflight",
      },
    });
  });

  it("production preflight는 provider read 지연 뒤 stale해진 PnL snapshot을 손실 증거로 쓰지 않는다", async () => {
    const supportModulePath = path.join(process.cwd(), "scripts/run-live-ops-support.mjs");
    const {
      createLiveOpsCliProductionExecutionInputs,
    } = await import(supportModulePath);
    const executionAt = "2026-06-19T00:00:30.000Z";
    const latestPnlCapturedAt = "2026-06-19T00:00:01.000Z";
    const config = {
      universe: { markets: ["KRW-BTC"], default_market: "KRW-BTC" },
      budget: {
        max_order_krw: "10000",
        daily_autonomous_notional_limit_krw: "30000",
        max_open_position_notional_krw: "30000",
      },
    };
    const productionRuntime = {
      entryRuntime: {},
      cleanupLifecycle: {},
      privateReadProvider: {
        async listOpenOrders() {
          return [];
        },
        async getBalances() {
          return {
            exchangeId: "upbit_krw_spot",
            capturedAt: executionAt,
            balances: [{
              currency: "KRW",
              available: "50000",
              locked: "0",
              total: "50000",
              updatedAt: executionAt,
            }],
          };
        },
      },
      reconcileStatusProvider: {
        async getReconcileStatus() {
          return {
            lastReconcileAt: executionAt,
            result: "SUCCESS",
            mismatchCount: 0,
            openOrderCount: 0,
            balanceStatus: "OK",
          };
        },
      },
      pnlStatusProvider: {
        async getStatus() {
          await new Promise((resolve) => setTimeout(resolve, 2_100));
          return {
            readStatus: "OK",
            latestCapturedAt: latestPnlCapturedAt,
            latestRealizedPnlKrw: "0",
            latestUnrealizedPnlKrw: "0",
            latestStatus: "CALCULATED",
          };
        },
      },
      killSwitchProvider: {
        async getStatus() {
          return { active: false, state: "NORMAL" };
        },
      },
      budgetReservation: {
        async readDailyReservedNotional() {
          return { reservedNotionalKrw: "0", reservationCount: 0 };
        },
      },
      preflightReconcileRecorder: {
        async recordPreflight() {
          throw new Error("FreshCleanReconcileShouldNotRecord");
        },
      },
      telegramDispatcher: {},
    };

    vi.useFakeTimers();
    vi.setSystemTime(new Date(executionAt));
    let result: Awaited<ReturnType<typeof createLiveOpsCliProductionExecutionInputs>>;
    try {
      const pending = createLiveOpsCliProductionExecutionInputs({
        config,
        env: {
          SEEMIRAI_UPBIT_ACCESS_KEY: "fake-access-key",
          SEEMIRAI_UPBIT_SECRET_KEY: "fake-secret-key",
          SEEMIRAI_UPBIT_KEY_SCOPE: "자산조회,주문조회,주문하기",
          SEEMIRAI_UPBIT_KEY_SCOPE_EVIDENCE_ID: "scope-evidence",
        },
        fixtureSmoke: false,
        analysisDecision: {
          ready: true,
          decisionCategory: "ORDER_INTENT",
          orderIntentCount: 1,
        },
        marketData: {
          ready: true,
          latestHeartbeatAt: executionAt,
          referencePrice: "100000000",
        },
        orderIntents: [createCleanupRuntimeIntent()],
        productionRuntime,
      });
      await vi.advanceTimersByTimeAsync(2_100);
      result = await pending;
    } finally {
      vi.useRealTimers();
    }

    expect(result.lossSnapshot).toMatchObject({
      ready: false,
      reasonCode: "pnl_snapshot_stale",
    });
  });

  it("production preflight는 금지 scope key로 private read를 열기 전에 fail-closed 한다", async () => {
    const supportModulePath = path.join(process.cwd(), "scripts/run-live-ops-support.mjs");
    const {
      createLiveOpsCliProductionExecutionInputs,
      evaluateLiveOpsCliLiveExecution,
    } = await import(supportModulePath);
    const privateReadCalls: string[] = [];
    const config = {
      live_trading_enabled: true,
      universe: { markets: ["KRW-BTC"], default_market: "KRW-BTC" },
      budget: {
        max_order_krw: "10000",
        daily_autonomous_notional_limit_krw: "30000",
        max_open_position_notional_krw: "30000",
      },
    };
    const forbiddenScopeEnv = {
      SEEMIRAI_UPBIT_ACCESS_KEY: "fake-access-key",
      SEEMIRAI_UPBIT_SECRET_KEY: "fake-secret-key",
      SEEMIRAI_UPBIT_KEY_SCOPE: "자산조회,주문조회,주문하기,출금조회",
      SEEMIRAI_UPBIT_KEY_SCOPE_EVIDENCE_ID: "scope-evidence",
    };
    const productionRuntime = {
      entryRuntime: {},
      cleanupLifecycle: {},
      privateReadProvider: {
        async listOpenOrders() {
          privateReadCalls.push("listOpenOrders");
          return [];
        },
        async getBalances() {
          privateReadCalls.push("getBalances");
          return { exchangeId: "upbit_krw_spot", capturedAt: "2026-06-18T13:33:27.000Z", balances: [] };
        },
      },
      reconcileStatusProvider: {
        async getReconcileStatus() {
          return { result: "SUCCESS", mismatchCount: 0, openOrderCount: 0 };
        },
      },
      pnlStatusProvider: {
        async getStatus() {
          return { readStatus: "OK" };
        },
      },
      killSwitchProvider: {
        async getStatus() {
          return { active: false, state: "NORMAL" };
        },
      },
      budgetReservation: {
        async readDailyReservedNotional() {
          return { reservedNotionalKrw: "0", reservationCount: 0 };
        },
      },
      preflightReconcileRecorder: {
        async recordPreflight() {
          throw new Error("PreflightRecorderShouldNotRun");
        },
      },
      telegramDispatcher: {},
    };
    const executionInputs = await createLiveOpsCliProductionExecutionInputs({
      config,
      env: forbiddenScopeEnv,
      fixtureSmoke: false,
      analysisDecision: {
        ready: true,
        decisionCategory: "ORDER_INTENT",
        orderIntentCount: 1,
      },
      marketData: {
        ready: true,
        latestHeartbeatAt: "2026-06-18T13:33:27.000Z",
        referencePrice: "100000000",
      },
      orderIntents: [createCleanupRuntimeIntent()],
      productionRuntime,
    });
    const summary = await evaluateLiveOpsCliLiveExecution({
      config,
      fixtureSmoke: false,
      analysisDecision: {
        ready: true,
        decisionCategory: "ORDER_INTENT",
        orderIntentCount: 1,
      },
      marketData: {
        ready: true,
        latestHeartbeatAt: "2026-06-18T13:33:27.000Z",
        referencePrice: "100000000",
      },
      env: forbiddenScopeEnv,
      orderIntents: executionInputs.orderIntents,
      entryRuntime: executionInputs.entryRuntime,
      executionStatus: executionInputs.executionStatus,
      postSubmitReadiness: executionInputs.postSubmitReadiness,
      budgetSnapshot: executionInputs.budgetSnapshot,
      lossSnapshot: executionInputs.lossSnapshot,
      cleanupLifecycle: executionInputs.cleanupLifecycle,
    });

    expect(privateReadCalls).toEqual([]);
    expect(executionInputs.executionStatus).toBeUndefined();
    expect(executionInputs.budgetSnapshot).toBeUndefined();
    expect(summary).toMatchObject({
      status: "blocked",
      submittedOrderCount: 0,
    });
    expect(summary.checks).toContainEqual(expect.objectContaining({
      code: "live_ops_broker_guard_blocked",
    }));
  });

  it("cleanup_probe live execution은 reservation observedAt과 같은 날짜로 key와 evidence를 다시 만든다", async () => {
    const supportModulePath = path.join(process.cwd(), "scripts/run-live-ops-support.mjs");
    const {
      evaluateLiveOpsCliLiveExecution,
    } = await import(supportModulePath);
    const executionAt = "2026-06-15T00:00:01.000Z";
    const staleAnalysisKey = "live_ops_cleanup_probe:2026-06-14:upbit_krw_spot:KRW-BTC:BUY:100000000:0.0001:10000";
    const runtimeDecisionKey = "live_ops_cleanup_probe:2026-06-15:upbit_krw_spot:KRW-BTC:BUY:100000000:0.0001:10000";
    const submittedRequests: Array<Record<string, any>> = [];

    vi.useFakeTimers();
    vi.setSystemTime(new Date(executionAt));
    try {
      await evaluateLiveOpsCliLiveExecution({
        config: {
          live_trading_enabled: true,
          universe: { markets: ["KRW-BTC"], default_market: "KRW-BTC" },
          budget: {
            max_order_krw: "10000",
            daily_autonomous_notional_limit_krw: "30000",
            max_open_position_notional_krw: "30000",
          },
        },
        fixtureSmoke: false,
        analysisDecision: {
          ready: true,
          decisionCategory: "ORDER_INTENT",
          orderIntentCount: 1,
        },
        marketData: {
          ready: true,
          latestHeartbeatAt: "2026-06-14T23:59:59.000Z",
          referencePrice: "100000000",
        },
        env: {
          SEEMIRAI_UPBIT_ACCESS_KEY: "fake-access-key",
          SEEMIRAI_UPBIT_SECRET_KEY: "fake-secret-key",
          SEEMIRAI_UPBIT_KEY_SCOPE: "자산조회,주문조회,주문하기",
          SEEMIRAI_UPBIT_KEY_SCOPE_EVIDENCE_ID: "scope-evidence",
        },
        orderIntents: [createCleanupRuntimeIntentWithKey(staleAnalysisKey, "2026-06-14")],
        entryRuntime: {
          async submitEntryCandidate(request: Record<string, any>) {
            submittedRequests.push(request);
            return {
              status: "BLOCKED",
              attemptId: request.idempotencyKey,
              idempotencyKey: request.idempotencyKey,
              message: "unit blocked after request capture",
              action: "none",
              events: [],
            };
          },
        },
        executionStatus: {
          killSwitchActive: false,
          reconcileFresh: true,
          evidenceId: "execution-status-evidence",
        },
        postSubmitReadiness: {
          reconcileReady: true,
          telegramReady: true,
          evidenceId: "post-submit-readiness-evidence",
        },
        budgetSnapshot: {
          maxOrderKrw: "10000",
          dailyAutonomousNotionalLimitKrw: "30000",
          dailyAutonomousNotionalUsedKrw: "0",
          openPositionNotionalKrw: "0",
          maxOpenPositionNotionalKrw: "30000",
          capturedAt: executionAt,
        },
        lossSnapshot: {
          dailyRealizedLossKrw: "0",
          weeklyRealizedLossKrw: "0",
          capturedAt: executionAt,
        },
      });
    } finally {
      vi.useRealTimers();
    }

    const request = submittedRequests[0];
    expect(request?.observedAt).toBe(executionAt);
    expect(request?.candidate.metadata).toMatchObject({
      decision_idempotency_key: runtimeDecisionKey,
      analysis_idempotency_key: staleAnalysisKey,
      idempotency_date_scope: "2026-06-15",
      idempotency_date_source: "live_ops_runtime_preflight",
    });
    expect(request?.candidate.costSnapshot.order_intent.idempotency_key).toBe(runtimeDecisionKey);
    expect(request?.candidate.riskApproval.order_intent.idempotency_key).toBe(runtimeDecisionKey);
  });

  it("cleanup_probe live execution은 preflight 날짜 key를 제출 직전 wall clock 날짜로 다시 바꾸지 않는다", async () => {
    const supportModulePath = path.join(process.cwd(), "scripts/run-live-ops-support.mjs");
    const {
      evaluateLiveOpsCliLiveExecution,
    } = await import(supportModulePath);
    const preflightAt = "2026-06-14T23:59:59.000Z";
    const executionAt = "2026-06-15T00:00:01.000Z";
    const preflightDecisionKey = "live_ops_cleanup_probe:2026-06-14:upbit_krw_spot:KRW-BTC:BUY:100000000:0.0001:10000";
    const nextDayDecisionKey = "live_ops_cleanup_probe:2026-06-15:upbit_krw_spot:KRW-BTC:BUY:100000000:0.0001:10000";
    const preflightIntent = createCleanupRuntimeIntentWithKey(preflightDecisionKey, "2026-06-14") as Record<string, any>;
    preflightIntent.metadata = {
      ...preflightIntent.metadata,
      idempotency_date_source: "live_ops_runtime_preflight",
      idempotency_observed_at: preflightAt,
    };
    const submittedRequests: Array<Record<string, any>> = [];

    vi.useFakeTimers();
    vi.setSystemTime(new Date(executionAt));
    try {
      await evaluateLiveOpsCliLiveExecution({
        config: {
          live_trading_enabled: true,
          universe: { markets: ["KRW-BTC"], default_market: "KRW-BTC" },
          budget: {
            max_order_krw: "10000",
            daily_autonomous_notional_limit_krw: "30000",
            max_open_position_notional_krw: "30000",
          },
        },
        fixtureSmoke: false,
        analysisDecision: {
          ready: true,
          decisionCategory: "ORDER_INTENT",
          orderIntentCount: 1,
        },
        marketData: {
          ready: true,
          latestHeartbeatAt: preflightAt,
          referencePrice: "100000000",
        },
        env: {
          SEEMIRAI_UPBIT_ACCESS_KEY: "fake-access-key",
          SEEMIRAI_UPBIT_SECRET_KEY: "fake-secret-key",
          SEEMIRAI_UPBIT_KEY_SCOPE: "자산조회,주문조회,주문하기",
          SEEMIRAI_UPBIT_KEY_SCOPE_EVIDENCE_ID: "scope-evidence",
        },
        orderIntents: [preflightIntent],
        entryRuntime: {
          async submitEntryCandidate(request: Record<string, any>) {
            submittedRequests.push(request);
            return {
              status: "BLOCKED",
              attemptId: request.idempotencyKey,
              idempotencyKey: request.idempotencyKey,
              message: "unit blocked after request capture",
              action: "none",
              events: [],
            };
          },
        },
        executionStatus: {
          killSwitchActive: false,
          reconcileFresh: true,
          evidenceId: "execution-status-evidence",
        },
        postSubmitReadiness: {
          reconcileReady: true,
          telegramReady: true,
          evidenceId: "post-submit-readiness-evidence",
        },
        budgetSnapshot: {
          maxOrderKrw: "10000",
          dailyAutonomousNotionalLimitKrw: "30000",
          dailyAutonomousNotionalUsedKrw: "0",
          openPositionNotionalKrw: "0",
          maxOpenPositionNotionalKrw: "30000",
          capturedAt: preflightAt,
        },
        lossSnapshot: {
          dailyRealizedLossKrw: "0",
          weeklyRealizedLossKrw: "0",
          capturedAt: preflightAt,
        },
      });
    } finally {
      vi.useRealTimers();
    }

    const request = submittedRequests[0];
    expect(request?.observedAt).toBe(preflightAt);
    expect(request?.candidate.metadata.decision_idempotency_key).toBe(preflightDecisionKey);
    expect(request?.candidate.metadata.decision_idempotency_key).not.toBe(nextDayDecisionKey);
    expect(request?.candidate.costSnapshot.order_intent.idempotency_key).toBe(preflightDecisionKey);
    expect(request?.candidate.riskApproval.order_intent.idempotency_key).toBe(preflightDecisionKey);
  });

  it("cleanup_probe runtime evidence 보강은 이미 보존된 원본 analysis key를 덮어쓰지 않는다", async () => {
    const supportModulePath = path.join(process.cwd(), "scripts/run-live-ops-support.mjs");
    const {
      evaluateLiveOpsCliLiveExecution,
    } = await import(supportModulePath);
    const executionAt = "2026-06-15T00:00:01.000Z";
    const originalAnalysisKey = "live_ops_cleanup_probe:runtime_preflight_day:upbit_krw_spot:KRW-BTC:BUY:100000000:0.0001:10000";
    const runtimeDecisionKey = "live_ops_cleanup_probe:2026-06-15:upbit_krw_spot:KRW-BTC:BUY:100000000:0.0001:10000";
    const alreadyNormalizedIntent = createCleanupRuntimeIntentWithKey(runtimeDecisionKey, "2026-06-15") as Record<string, any>;
    alreadyNormalizedIntent.metadata = {
      ...alreadyNormalizedIntent.metadata,
      analysis_idempotency_key: originalAnalysisKey,
    };
    const submittedRequests: Array<Record<string, any>> = [];

    vi.useFakeTimers();
    vi.setSystemTime(new Date(executionAt));
    try {
      await evaluateLiveOpsCliLiveExecution({
        config: {
          live_trading_enabled: true,
          universe: { markets: ["KRW-BTC"], default_market: "KRW-BTC" },
          budget: {
            max_order_krw: "10000",
            daily_autonomous_notional_limit_krw: "30000",
            max_open_position_notional_krw: "30000",
          },
        },
        fixtureSmoke: false,
        analysisDecision: {
          ready: true,
          decisionCategory: "ORDER_INTENT",
          orderIntentCount: 1,
        },
        marketData: {
          ready: true,
          latestHeartbeatAt: executionAt,
          referencePrice: "100000000",
        },
        env: {
          SEEMIRAI_UPBIT_ACCESS_KEY: "fake-access-key",
          SEEMIRAI_UPBIT_SECRET_KEY: "fake-secret-key",
          SEEMIRAI_UPBIT_KEY_SCOPE: "자산조회,주문조회,주문하기",
          SEEMIRAI_UPBIT_KEY_SCOPE_EVIDENCE_ID: "scope-evidence",
        },
        orderIntents: [alreadyNormalizedIntent],
        entryRuntime: {
          async submitEntryCandidate(request: Record<string, any>) {
            submittedRequests.push(request);
            return {
              status: "BLOCKED",
              attemptId: request.idempotencyKey,
              idempotencyKey: request.idempotencyKey,
              message: "unit blocked after request capture",
              action: "none",
              events: [],
            };
          },
        },
        executionStatus: {
          killSwitchActive: false,
          reconcileFresh: true,
          evidenceId: "execution-status-evidence",
        },
        postSubmitReadiness: {
          reconcileReady: true,
          telegramReady: true,
          evidenceId: "post-submit-readiness-evidence",
        },
        budgetSnapshot: {
          maxOrderKrw: "10000",
          dailyAutonomousNotionalLimitKrw: "30000",
          dailyAutonomousNotionalUsedKrw: "0",
          openPositionNotionalKrw: "0",
          maxOpenPositionNotionalKrw: "30000",
          capturedAt: executionAt,
        },
        lossSnapshot: {
          dailyRealizedLossKrw: "0",
          weeklyRealizedLossKrw: "0",
          capturedAt: executionAt,
        },
      });
    } finally {
      vi.useRealTimers();
    }

    expect(submittedRequests[0]?.candidate.metadata).toMatchObject({
      decision_idempotency_key: runtimeDecisionKey,
      analysis_idempotency_key: originalAnalysisKey,
      idempotency_date_scope: "2026-06-15",
      idempotency_date_source: "live_ops_runtime_preflight",
    });
  });

  it("cleanup_probe runtime evidence 보강은 명시적인 CostModel 차단을 승인으로 덮지 않는다", async () => {
    const supportModulePath = path.join(process.cwd(), "scripts/run-live-ops-support.mjs");
    const {
      evaluateLiveOpsCliLiveExecution,
    } = await import(supportModulePath);
    const executionAt = "2026-06-15T00:00:01.000Z";
    const runtimeDecisionKey = "live_ops_cleanup_probe:2026-06-15:upbit_krw_spot:KRW-BTC:BUY:100000000:0.0001:10000";
    const blockedIntent = createCleanupRuntimeIntentWithKey(runtimeDecisionKey, "2026-06-15") as Record<string, any>;
    blockedIntent.costSnapshot = {
      ...blockedIntent.costSnapshot,
      trade_allowed: false,
      reason_code: "cost_margin_ok",
    };
    const submittedRequests: Array<Record<string, any>> = [];

    vi.useFakeTimers();
    vi.setSystemTime(new Date(executionAt));
    try {
      const summary = await evaluateLiveOpsCliLiveExecution({
        config: {
          live_trading_enabled: true,
          universe: { markets: ["KRW-BTC"], default_market: "KRW-BTC" },
          budget: {
            max_order_krw: "10000",
            daily_autonomous_notional_limit_krw: "30000",
            max_open_position_notional_krw: "30000",
          },
        },
        fixtureSmoke: false,
        analysisDecision: {
          ready: true,
          decisionCategory: "ORDER_INTENT",
          orderIntentCount: 1,
        },
        marketData: {
          ready: true,
          latestHeartbeatAt: executionAt,
          referencePrice: "100000000",
        },
        env: {
          SEEMIRAI_UPBIT_ACCESS_KEY: "fake-access-key",
          SEEMIRAI_UPBIT_SECRET_KEY: "fake-secret-key",
          SEEMIRAI_UPBIT_KEY_SCOPE: "자산조회,주문조회,주문하기",
          SEEMIRAI_UPBIT_KEY_SCOPE_EVIDENCE_ID: "scope-evidence",
        },
        orderIntents: [blockedIntent],
        entryRuntime: {
          async submitEntryCandidate(request: Record<string, any>) {
            submittedRequests.push(request);
            return {
              status: "SUBMITTED",
              attemptId: request.idempotencyKey,
              idempotencyKey: request.idempotencyKey,
              brokerOrderId: "unexpected-cost-blocked-order",
              message: "unexpected submit",
              action: "none",
              events: [],
            };
          },
        },
        executionStatus: {
          killSwitchActive: false,
          reconcileFresh: true,
          evidenceId: "execution-status-evidence",
        },
        postSubmitReadiness: {
          reconcileReady: true,
          telegramReady: true,
          evidenceId: "post-submit-readiness-evidence",
        },
        budgetSnapshot: {
          maxOrderKrw: "10000",
          dailyAutonomousNotionalLimitKrw: "30000",
          dailyAutonomousNotionalUsedKrw: "0",
          openPositionNotionalKrw: "0",
          maxOpenPositionNotionalKrw: "30000",
          capturedAt: executionAt,
        },
        lossSnapshot: {
          dailyRealizedLossKrw: "0",
          weeklyRealizedLossKrw: "0",
          capturedAt: executionAt,
        },
      });

      expect(summary).toMatchObject({
        status: "blocked",
        submittedOrderCount: 0,
      });
      expect(summary.checks).toContainEqual(expect.objectContaining({
        code: "live_ops_order_intent_blocked",
      }));
    } finally {
      vi.useRealTimers();
    }

    expect(submittedRequests).toHaveLength(0);
  });

  it("cleanup_probe runtime evidence 보강은 malformed 기존 CostModel evidence를 승인으로 합성하지 않는다", async () => {
    const supportModulePath = path.join(process.cwd(), "scripts/run-live-ops-support.mjs");
    const {
      evaluateLiveOpsCliLiveExecution,
    } = await import(supportModulePath);
    const executionAt = "2026-06-15T00:00:01.000Z";
    const runtimeDecisionKey = "live_ops_cleanup_probe:2026-06-15:upbit_krw_spot:KRW-BTC:BUY:100000000:0.0001:10000";
    const malformedCostIntent = createCleanupRuntimeIntentWithKey(runtimeDecisionKey, "2026-06-15") as Record<string, any>;
    malformedCostIntent.costSnapshot = {
      source: "cost_model",
      order_intent: malformedCostIntent.costSnapshot.order_intent,
    };
    const submittedRequests: Array<Record<string, any>> = [];

    vi.useFakeTimers();
    vi.setSystemTime(new Date(executionAt));
    try {
      const summary = await evaluateLiveOpsCliLiveExecution({
        config: {
          live_trading_enabled: true,
          universe: { markets: ["KRW-BTC"], default_market: "KRW-BTC" },
          budget: {
            max_order_krw: "10000",
            daily_autonomous_notional_limit_krw: "30000",
            max_open_position_notional_krw: "30000",
          },
        },
        fixtureSmoke: false,
        analysisDecision: {
          ready: true,
          decisionCategory: "ORDER_INTENT",
          orderIntentCount: 1,
        },
        marketData: {
          ready: true,
          latestHeartbeatAt: executionAt,
          referencePrice: "100000000",
        },
        env: {
          SEEMIRAI_UPBIT_ACCESS_KEY: "fake-access-key",
          SEEMIRAI_UPBIT_SECRET_KEY: "fake-secret-key",
          SEEMIRAI_UPBIT_KEY_SCOPE: "자산조회,주문조회,주문하기",
          SEEMIRAI_UPBIT_KEY_SCOPE_EVIDENCE_ID: "scope-evidence",
        },
        orderIntents: [malformedCostIntent],
        entryRuntime: {
          async submitEntryCandidate(request: Record<string, any>) {
            submittedRequests.push(request);
            return {
              status: "SUBMITTED",
              attemptId: request.idempotencyKey,
              idempotencyKey: request.idempotencyKey,
              brokerOrderId: "unexpected-malformed-cost-order",
              message: "unexpected submit",
              action: "none",
              events: [],
            };
          },
        },
        executionStatus: {
          killSwitchActive: false,
          reconcileFresh: true,
          evidenceId: "execution-status-evidence",
        },
        postSubmitReadiness: {
          reconcileReady: true,
          telegramReady: true,
          evidenceId: "post-submit-readiness-evidence",
        },
        budgetSnapshot: {
          maxOrderKrw: "10000",
          dailyAutonomousNotionalLimitKrw: "30000",
          dailyAutonomousNotionalUsedKrw: "0",
          openPositionNotionalKrw: "0",
          maxOpenPositionNotionalKrw: "30000",
          capturedAt: executionAt,
        },
        lossSnapshot: {
          dailyRealizedLossKrw: "0",
          weeklyRealizedLossKrw: "0",
          capturedAt: executionAt,
        },
      });

      expect(summary).toMatchObject({
        status: "blocked",
        submittedOrderCount: 0,
      });
      expect(summary.checks).toContainEqual(expect.objectContaining({
        code: "live_ops_order_intent_blocked",
      }));
    } finally {
      vi.useRealTimers();
    }

    expect(submittedRequests).toHaveLength(0);
  });

  it("cleanup_probe runtime evidence 보강은 부분 RiskGate evidence를 승인으로 합성하지 않는다", async () => {
    const supportModulePath = path.join(process.cwd(), "scripts/run-live-ops-support.mjs");
    const {
      evaluateLiveOpsCliLiveExecution,
    } = await import(supportModulePath);
    const executionAt = "2026-06-15T00:00:01.000Z";
    const runtimeDecisionKey = "live_ops_cleanup_probe:2026-06-15:upbit_krw_spot:KRW-BTC:BUY:100000000:0.0001:10000";
    const partialRiskIntent = createCleanupRuntimeIntentWithKey(runtimeDecisionKey, "2026-06-15") as Record<string, any>;
    partialRiskIntent.riskApproval = {
      order_intent: partialRiskIntent.riskApproval.order_intent,
    };
    const submittedRequests: Array<Record<string, any>> = [];

    vi.useFakeTimers();
    vi.setSystemTime(new Date(executionAt));
    try {
      const summary = await evaluateLiveOpsCliLiveExecution({
        config: {
          live_trading_enabled: true,
          universe: { markets: ["KRW-BTC"], default_market: "KRW-BTC" },
          budget: {
            max_order_krw: "10000",
            daily_autonomous_notional_limit_krw: "30000",
            max_open_position_notional_krw: "30000",
          },
        },
        fixtureSmoke: false,
        analysisDecision: {
          ready: true,
          decisionCategory: "ORDER_INTENT",
          orderIntentCount: 1,
        },
        marketData: {
          ready: true,
          latestHeartbeatAt: executionAt,
          referencePrice: "100000000",
        },
        env: {
          SEEMIRAI_UPBIT_ACCESS_KEY: "fake-access-key",
          SEEMIRAI_UPBIT_SECRET_KEY: "fake-secret-key",
          SEEMIRAI_UPBIT_KEY_SCOPE: "자산조회,주문조회,주문하기",
          SEEMIRAI_UPBIT_KEY_SCOPE_EVIDENCE_ID: "scope-evidence",
        },
        orderIntents: [partialRiskIntent],
        entryRuntime: {
          async submitEntryCandidate(request: Record<string, any>) {
            submittedRequests.push(request);
            return {
              status: "SUBMITTED",
              attemptId: request.idempotencyKey,
              idempotencyKey: request.idempotencyKey,
              brokerOrderId: "unexpected-partial-risk-order",
              message: "unexpected submit",
              action: "none",
              events: [],
            };
          },
        },
        executionStatus: {
          killSwitchActive: false,
          reconcileFresh: true,
          evidenceId: "execution-status-evidence",
        },
        postSubmitReadiness: {
          reconcileReady: true,
          telegramReady: true,
          evidenceId: "post-submit-readiness-evidence",
        },
        budgetSnapshot: {
          maxOrderKrw: "10000",
          dailyAutonomousNotionalLimitKrw: "30000",
          dailyAutonomousNotionalUsedKrw: "0",
          openPositionNotionalKrw: "0",
          maxOpenPositionNotionalKrw: "30000",
          capturedAt: executionAt,
        },
        lossSnapshot: {
          dailyRealizedLossKrw: "0",
          weeklyRealizedLossKrw: "0",
          capturedAt: executionAt,
        },
      });

      expect(summary).toMatchObject({
        status: "blocked",
        submittedOrderCount: 0,
      });
      expect(summary.checks).toContainEqual(expect.objectContaining({
        code: "live_ops_order_intent_blocked",
      }));
    } finally {
      vi.useRealTimers();
    }

    expect(submittedRequests).toHaveLength(0);
  });

  it("cleanup_probe runtime evidence 보강은 다른 후보의 stale CostModel order_intent를 현재 후보로 다시 쓰지 않는다", async () => {
    const supportModulePath = path.join(process.cwd(), "scripts/run-live-ops-support.mjs");
    const {
      evaluateLiveOpsCliLiveExecution,
    } = await import(supportModulePath);
    const executionAt = "2026-06-15T00:00:01.000Z";
    const runtimeDecisionKey = "live_ops_cleanup_probe:2026-06-15:upbit_krw_spot:KRW-BTC:BUY:100000000:0.0001:10000";
    const staleEvidenceIntent = createCleanupRuntimeIntentWithKey(runtimeDecisionKey, "2026-06-15") as Record<string, any>;
    staleEvidenceIntent.costSnapshot = {
      ...staleEvidenceIntent.costSnapshot,
      trade_allowed: true,
      reason_code: "cost_margin_ok",
      order_intent: {
        ...staleEvidenceIntent.costSnapshot.order_intent,
        requested_price: "99000000",
        requested_notional: "9900",
      },
    };
    const submittedRequests: Array<Record<string, any>> = [];

    vi.useFakeTimers();
    vi.setSystemTime(new Date(executionAt));
    try {
      const summary = await evaluateLiveOpsCliLiveExecution({
        config: {
          live_trading_enabled: true,
          universe: { markets: ["KRW-BTC"], default_market: "KRW-BTC" },
          budget: {
            max_order_krw: "10000",
            daily_autonomous_notional_limit_krw: "30000",
            max_open_position_notional_krw: "30000",
          },
        },
        fixtureSmoke: false,
        analysisDecision: {
          ready: true,
          decisionCategory: "ORDER_INTENT",
          orderIntentCount: 1,
        },
        marketData: {
          ready: true,
          latestHeartbeatAt: executionAt,
          referencePrice: "100000000",
        },
        env: {
          SEEMIRAI_UPBIT_ACCESS_KEY: "fake-access-key",
          SEEMIRAI_UPBIT_SECRET_KEY: "fake-secret-key",
          SEEMIRAI_UPBIT_KEY_SCOPE: "자산조회,주문조회,주문하기",
          SEEMIRAI_UPBIT_KEY_SCOPE_EVIDENCE_ID: "scope-evidence",
        },
        orderIntents: [staleEvidenceIntent],
        entryRuntime: {
          async submitEntryCandidate(request: Record<string, any>) {
            submittedRequests.push(request);
            return {
              status: "SUBMITTED",
              attemptId: request.idempotencyKey,
              idempotencyKey: request.idempotencyKey,
              brokerOrderId: "unexpected-stale-cost-evidence-order",
              message: "unexpected submit",
              action: "none",
              events: [],
            };
          },
        },
        executionStatus: {
          killSwitchActive: false,
          reconcileFresh: true,
          evidenceId: "execution-status-evidence",
        },
        postSubmitReadiness: {
          reconcileReady: true,
          telegramReady: true,
          evidenceId: "post-submit-readiness-evidence",
        },
        budgetSnapshot: {
          maxOrderKrw: "10000",
          dailyAutonomousNotionalLimitKrw: "30000",
          dailyAutonomousNotionalUsedKrw: "0",
          openPositionNotionalKrw: "0",
          maxOpenPositionNotionalKrw: "30000",
          capturedAt: executionAt,
        },
        lossSnapshot: {
          dailyRealizedLossKrw: "0",
          weeklyRealizedLossKrw: "0",
          capturedAt: executionAt,
        },
      });

      expect(summary).toMatchObject({
        status: "blocked",
        submittedOrderCount: 0,
      });
      expect(summary.checks).toContainEqual(expect.objectContaining({
        code: "live_ops_order_intent_blocked",
      }));
    } finally {
      vi.useRealTimers();
    }

    expect(submittedRequests).toHaveLength(0);
  });

  it("production preflight는 오래된 clean reconcile도 같은 tick evidence로 갱신한다", async () => {
    const supportModulePath = path.join(process.cwd(), "scripts/run-live-ops-support.mjs");
    const {
      createLiveOpsCliProductionExecutionInputs,
    } = await import(supportModulePath);
    const observedAt = "2026-06-18T13:33:27.000Z";
    const recorded: unknown[] = [];
    let reconcileReadCount = 0;
    const productionRuntime = {
      entryRuntime: {},
      cleanupLifecycle: {},
      privateReadProvider: {
        async listOpenOrders() {
          return [];
        },
        async getBalances() {
          return {
            exchangeId: "upbit_krw_spot",
            capturedAt: observedAt,
            balances: [{ currency: "KRW", available: "50000", locked: "0", total: "50000" }],
          };
        },
      },
      reconcileStatusProvider: {
        async getReconcileStatus() {
          reconcileReadCount += 1;
          if (reconcileReadCount === 1) {
            return {
              lastReconcileAt: "2026-06-18T13:00:00.000Z",
              result: "SUCCESS",
              mismatchCount: 0,
              openOrderCount: 0,
              balanceStatus: "OK",
              websocketStatus: "CONNECTED",
            };
          }
          return {
            lastReconcileAt: observedAt,
            result: "SUCCESS",
            mismatchCount: 0,
            openOrderCount: 0,
            balanceStatus: "OK",
            websocketStatus: "CONNECTED",
          };
        },
      },
      pnlStatusProvider: {
        async getStatus() {
          return { readStatus: "OK", latestCapturedAt: observedAt, latestRealizedPnlKrw: "0", latestUnrealizedPnlKrw: "0", latestStatus: "CALCULATED" };
        },
      },
      killSwitchProvider: {
        async getStatus() {
          return { active: false, state: "NORMAL" };
        },
      },
      budgetReservation: {
        async readDailyReservedNotional() {
          return { reservedNotionalKrw: "0", reservationCount: 0 };
        },
      },
      preflightReconcileRecorder: {
        async recordPreflight(input: unknown) {
          recorded.push(input);
          return { created: true, runId: "fresh-preflight-run", status: "COMPLETED" };
        },
      },
      telegramDispatcher: {},
    };

    const result = await withFakeSystemTime(observedAt, () => createLiveOpsCliProductionExecutionInputs({
      config: {
        universe: { markets: ["KRW-BTC"], default_market: "KRW-BTC" },
        budget: {
          max_order_krw: "10000",
          daily_autonomous_notional_limit_krw: "30000",
          max_open_position_notional_krw: "30000",
        },
      },
      env: {
        SEEMIRAI_UPBIT_ACCESS_KEY: "fake-access-key",
        SEEMIRAI_UPBIT_SECRET_KEY: "fake-secret-key",
        SEEMIRAI_UPBIT_KEY_SCOPE: "자산조회,주문조회,주문하기",
        SEEMIRAI_UPBIT_KEY_SCOPE_EVIDENCE_ID: "scope-evidence",
      },
      fixtureSmoke: false,
      analysisDecision: { ready: true, decisionCategory: "ORDER_INTENT", orderIntentCount: 1 },
      marketData: { ready: true, latestHeartbeatAt: observedAt, referencePrice: "100000000" },
      orderIntents: [createCleanupRuntimeIntent()],
      productionRuntime,
    }));

    expect(recorded).toHaveLength(1);
    expect(reconcileReadCount).toBe(2);
    expect(result.executionStatus).toMatchObject({
      reconcileFresh: true,
      preflightReconcileEvidence: {
        runId: "fresh-preflight-run",
        status: "COMPLETED",
      },
    });
  });

  it("production preflight는 기존 BTC 보유분을 open position 예산과 RiskGate positions에 반영한다", async () => {
    const supportModulePath = path.join(process.cwd(), "scripts/run-live-ops-support.mjs");
    const {
      createLiveOpsCliEntryRuntime,
      createLiveOpsCliProductionExecutionInputs,
      evaluateLiveOpsCliLiveExecution,
    } = await import(supportModulePath);
    const observedAt = "2026-06-18T13:33:27.000Z";
    const submitted: unknown[] = [];
    const reservations: unknown[] = [];
    const rawIntent = { ...createCleanupRuntimeIntent() } as Record<string, unknown>;
    delete rawIntent.costSnapshot;
    delete rawIntent.costInput;
    delete rawIntent.riskApproval;
    delete rawIntent.risk;
    const config = {
      universe: { markets: ["KRW-BTC"], default_market: "KRW-BTC" },
      budget: {
        max_order_krw: "10000",
        daily_autonomous_notional_limit_krw: "100000",
        max_open_position_notional_krw: "30000",
      },
    };
    const productionRuntime = {
      entryRuntime: {},
      cleanupLifecycle: {},
      privateReadProvider: {
        async listOpenOrders() {
          return [];
        },
        async getBalances() {
          return {
            exchangeId: "upbit_krw_spot",
            capturedAt: observedAt,
            balances: [
              { currency: "KRW", available: "50000", locked: "0", total: "50000" },
              { currency: "BTC", available: "0.00025", locked: "0", total: "0.00025" },
            ],
          };
        },
      },
      reconcileStatusProvider: {
        async getReconcileStatus() {
          return { lastReconcileAt: observedAt, result: "SUCCESS", mismatchCount: 0, openOrderCount: 0, balanceStatus: "OK" };
        },
      },
      pnlStatusProvider: {
        async getStatus() {
          return { readStatus: "OK", latestCapturedAt: observedAt, latestRealizedPnlKrw: "0", latestUnrealizedPnlKrw: "0", latestStatus: "CALCULATED" };
        },
      },
      killSwitchProvider: {
        async getStatus() {
          return { active: false, state: "NORMAL" };
        },
      },
      budgetReservation: {
        async readDailyReservedNotional() {
          return { reservedNotionalKrw: "0", reservationCount: 0 };
        },
      },
      preflightReconcileRecorder: {
        async recordPreflight() {
          throw new Error("FreshCleanReconcileShouldNotRecord");
        },
      },
      telegramDispatcher: {},
    };
    const executionInputs = await withFakeSystemTime(observedAt, () => createLiveOpsCliProductionExecutionInputs({
      config,
      env: {
        SEEMIRAI_UPBIT_ACCESS_KEY: "fake-access-key",
        SEEMIRAI_UPBIT_SECRET_KEY: "fake-secret-key",
        SEEMIRAI_UPBIT_KEY_SCOPE: "자산조회,주문조회,주문하기",
        SEEMIRAI_UPBIT_KEY_SCOPE_EVIDENCE_ID: "scope-evidence",
      },
      fixtureSmoke: false,
      analysisDecision: { ready: true, decisionCategory: "ORDER_INTENT", orderIntentCount: 1 },
      marketData: { ready: true, latestHeartbeatAt: observedAt, referencePrice: "100000000" },
      orderIntents: [rawIntent],
      productionRuntime,
    }));
    const liveExecution = await withFakeSystemTime(observedAt, () => evaluateLiveOpsCliLiveExecution({
      config,
      fixtureSmoke: false,
      analysisDecision: { ready: true, decisionCategory: "ORDER_INTENT", orderIntentCount: 1 },
      marketData: { ready: true, latestHeartbeatAt: observedAt, referencePrice: "100000000" },
      env: {
        SEEMIRAI_UPBIT_ACCESS_KEY: "fake-access-key",
        SEEMIRAI_UPBIT_SECRET_KEY: "fake-secret-key",
        SEEMIRAI_UPBIT_KEY_SCOPE: "자산조회,주문조회,주문하기",
        SEEMIRAI_UPBIT_KEY_SCOPE_EVIDENCE_ID: "scope-evidence",
      },
      orderIntents: executionInputs.orderIntents,
      entryRuntime: createLiveOpsCliEntryRuntime({
        broker: {
          async submitOrder(submission: unknown) {
            submitted.push(submission);
            return { brokerOrderId: "unexpected-held-position-order" };
          },
        },
        budgetReservation: {
          async reserve(request: unknown) {
            reservations.push(request);
            return { reserved: true };
          },
        },
      }),
      executionStatus: executionInputs.executionStatus,
      postSubmitReadiness: executionInputs.postSubmitReadiness,
      budgetSnapshot: executionInputs.budgetSnapshot,
      lossSnapshot: executionInputs.lossSnapshot,
      cleanupLifecycle: executionInputs.cleanupLifecycle,
    }));

    expect(executionInputs.budgetSnapshot).toMatchObject({
      openPositionNotionalKrw: "25000",
      dailyAutonomousNotionalUsedKrw: "25000",
    });
    expect(executionInputs.orderIntents[0]?.risk.positions).toContainEqual(expect.objectContaining({
      market: "KRW-BTC",
      notionalBpsOfEquity: "5000",
    }));
    expect(liveExecution).toMatchObject({
      status: "blocked",
      attemptStatus: "BLOCKED",
      submittedOrderCount: 0,
    });
    expect(submitted).toHaveLength(0);
    expect(reservations).toHaveLength(0);
  });

  it("production preflight는 clean source가 있으면 PnL missing을 closeout runner로 복구한다", async () => {
    const supportModulePath = path.join(process.cwd(), "scripts/run-live-ops-support.mjs");
    const {
      createLiveOpsCliProductionExecutionInputs,
    } = await import(supportModulePath);
    const observedAt = "2026-06-20T05:00:00.000Z";
    const closeoutCalls: unknown[] = [];
    let pnlReadCount = 0;
    const rawIntent = { ...createCleanupRuntimeIntent() } as Record<string, unknown>;
    delete rawIntent.costSnapshot;
    delete rawIntent.costInput;
    delete rawIntent.riskApproval;
    delete rawIntent.risk;
    const config = {
      universe: { markets: ["KRW-BTC"], default_market: "KRW-BTC" },
      budget: {
        max_order_krw: "10000",
        daily_autonomous_notional_limit_krw: "30000",
        max_open_position_notional_krw: "30000",
      },
    };
    const productionRuntime = {
      entryRuntime: {},
      cleanupLifecycle: {},
      privateReadProvider: {
        async listOpenOrders() {
          return [];
        },
        async getBalances() {
          return {
            exchangeId: "upbit_krw_spot",
            capturedAt: observedAt,
            balances: [{ currency: "KRW", available: "50000", locked: "0", total: "50000" }],
          };
        },
      },
      reconcileStatusProvider: {
        async getReconcileStatus() {
          return {
            lastReconcileAt: observedAt,
            result: "SUCCESS",
            mismatchCount: 0,
            openOrderCount: 0,
            balanceStatus: "OK",
          };
        },
      },
      pnlStatusProvider: {
        async getStatus() {
          pnlReadCount += 1;
          if (pnlReadCount === 1) {
            return { readStatus: "NOT_FOUND", reason: "pnl_snapshot_not_found" };
          }
          return {
            readStatus: "OK",
            latestCapturedAt: observedAt,
            latestEquityKrw: "50000",
            latestRealizedPnlKrw: "0",
            latestUnrealizedPnlKrw: "0",
            latestDrawdownBps: "0",
            latestStatus: "CALCULATED",
            latestSource: "pnl_snapshots",
            snapshotCount: 1,
            reason: "pnl_snapshot_latest_read",
          };
        },
      },
      pnlCloseoutRunner: {
        async refreshPreflightPnl(input: unknown) {
          closeoutCalls.push(input);
          return {
            status: "ready",
            inserted: true,
            capturedAt: observedAt,
            strategyId: "live_ops_cleanup_probe",
            market: "KRW-BTC",
            realizedPnlKrw: "0",
            unrealizedPnlKrw: "0",
          };
        },
      },
      killSwitchProvider: {
        async getStatus() {
          return { active: false, state: "NORMAL" };
        },
      },
      budgetReservation: {
        async readDailyReservedNotional() {
          return { reservedNotionalKrw: "0", reservationCount: 0 };
        },
      },
      preflightReconcileRecorder: {
        async recordPreflight() {
          throw new Error("FreshCleanReconcileShouldNotRecord");
        },
      },
      telegramDispatcher: {},
    };

    const executionInputs = await withFakeSystemTime(observedAt, () => createLiveOpsCliProductionExecutionInputs({
      config,
      env: {
        SEEMIRAI_UPBIT_ACCESS_KEY: "fake-access-key",
        SEEMIRAI_UPBIT_SECRET_KEY: "fake-secret-key",
        SEEMIRAI_UPBIT_KEY_SCOPE: "자산조회,주문조회,주문하기",
        SEEMIRAI_UPBIT_KEY_SCOPE_EVIDENCE_ID: "scope-evidence",
      },
      fixtureSmoke: false,
      analysisDecision: { ready: true, decisionCategory: "ORDER_INTENT", orderIntentCount: 1 },
      marketData: { ready: true, latestHeartbeatAt: observedAt, referencePrice: "100000000" },
      orderIntents: [rawIntent],
      productionRuntime,
    }));

    expect(closeoutCalls).toEqual([expect.objectContaining({
      market: "KRW-BTC",
      strategyId: "live_ops_cleanup_probe",
      observedAt,
      referencePrice: "100000000",
    })]);
    expect(pnlReadCount).toBe(2);
    expect(executionInputs.lossSnapshot).toMatchObject({
      dailyRealizedLossKrw: "0",
      weeklyRealizedLossKrw: "0",
      capturedAt: observedAt,
      source: "pnl_snapshots",
    });
  });

  it("production preflight는 PnL non-OK 상태를 0 손실로 보정하지 않고 제출 전 차단한다", async () => {
    const supportModulePath = path.join(process.cwd(), "scripts/run-live-ops-support.mjs");
    const {
      createLiveOpsCliEntryRuntime,
      createLiveOpsCliProductionExecutionInputs,
      evaluateLiveOpsCliLiveExecution,
    } = await import(supportModulePath);
    const observedAt = "2026-06-18T13:33:27.000Z";
    const submitted: unknown[] = [];
    const rawIntent = { ...createCleanupRuntimeIntent() } as Record<string, unknown>;
    delete rawIntent.costSnapshot;
    delete rawIntent.costInput;
    delete rawIntent.riskApproval;
    delete rawIntent.risk;
    const config = {
      universe: { markets: ["KRW-BTC"], default_market: "KRW-BTC" },
      budget: {
        max_order_krw: "10000",
        daily_autonomous_notional_limit_krw: "30000",
        max_open_position_notional_krw: "30000",
      },
    };
    const productionRuntime = {
      entryRuntime: {},
      cleanupLifecycle: {},
      privateReadProvider: {
        async listOpenOrders() {
          return [];
        },
        async getBalances() {
          return {
            exchangeId: "upbit_krw_spot",
            capturedAt: observedAt,
            balances: [{ currency: "KRW", available: "50000", locked: "0", total: "50000" }],
          };
        },
      },
      reconcileStatusProvider: {
        async getReconcileStatus() {
          return { lastReconcileAt: observedAt, result: "SUCCESS", mismatchCount: 0, openOrderCount: 0, balanceStatus: "OK" };
        },
      },
      pnlStatusProvider: {
        async getStatus() {
          return { readStatus: "NOT_FOUND", reason: "pnl_snapshot_not_found" };
        },
      },
      killSwitchProvider: {
        async getStatus() {
          return { active: false, state: "NORMAL" };
        },
      },
      budgetReservation: {
        async readDailyReservedNotional() {
          return { reservedNotionalKrw: "0", reservationCount: 0 };
        },
      },
      preflightReconcileRecorder: {
        async recordPreflight() {
          throw new Error("FreshCleanReconcileShouldNotRecord");
        },
      },
      telegramDispatcher: {},
    };
    const executionInputs = await withFakeSystemTime(observedAt, () => createLiveOpsCliProductionExecutionInputs({
      config,
      env: {
        SEEMIRAI_UPBIT_ACCESS_KEY: "fake-access-key",
        SEEMIRAI_UPBIT_SECRET_KEY: "fake-secret-key",
        SEEMIRAI_UPBIT_KEY_SCOPE: "자산조회,주문조회,주문하기",
        SEEMIRAI_UPBIT_KEY_SCOPE_EVIDENCE_ID: "scope-evidence",
      },
      fixtureSmoke: false,
      analysisDecision: { ready: true, decisionCategory: "ORDER_INTENT", orderIntentCount: 1 },
      marketData: { ready: true, latestHeartbeatAt: observedAt, referencePrice: "100000000" },
      orderIntents: [rawIntent],
      productionRuntime,
    }));
    const liveExecution = await evaluateLiveOpsCliLiveExecution({
      config,
      fixtureSmoke: false,
      analysisDecision: { ready: true, decisionCategory: "ORDER_INTENT", orderIntentCount: 1 },
      marketData: { ready: true, latestHeartbeatAt: observedAt, referencePrice: "100000000" },
      env: {
        SEEMIRAI_UPBIT_ACCESS_KEY: "fake-access-key",
        SEEMIRAI_UPBIT_SECRET_KEY: "fake-secret-key",
        SEEMIRAI_UPBIT_KEY_SCOPE: "자산조회,주문조회,주문하기",
        SEEMIRAI_UPBIT_KEY_SCOPE_EVIDENCE_ID: "scope-evidence",
      },
      orderIntents: executionInputs.orderIntents,
      entryRuntime: createLiveOpsCliEntryRuntime({
        broker: {
          async submitOrder(submission: unknown) {
            submitted.push(submission);
            return { brokerOrderId: "unexpected-pnl-missing-order" };
          },
        },
        budgetReservation: {
          async reserve() {
            return { reserved: true };
          },
        },
      }),
      executionStatus: executionInputs.executionStatus,
      postSubmitReadiness: executionInputs.postSubmitReadiness,
      budgetSnapshot: executionInputs.budgetSnapshot,
      lossSnapshot: executionInputs.lossSnapshot,
      cleanupLifecycle: executionInputs.cleanupLifecycle,
    });

    expect(executionInputs.lossSnapshot).toMatchObject({
      ready: false,
      reasonCode: "pnl_snapshot_not_found",
    });
    expect(liveExecution).toMatchObject({
      status: "blocked",
      submittedOrderCount: 0,
    });
    expect(liveExecution.checks).toContainEqual(expect.objectContaining({
      code: "live_ops_execution_status_blocked",
      details: expect.objectContaining({
        violations: expect.arrayContaining(["실제 realized loss snapshot이 필요합니다"]),
      }),
    }));
    expect(submitted).toHaveLength(0);
  });

  it.each([
    {
      name: "오래된 OK PnL snapshot",
      pnlStatus: {
        readStatus: "OK",
        latestCapturedAt: "2026-06-18T13:32:56.000Z",
        latestRealizedPnlKrw: "0",
        latestUnrealizedPnlKrw: "0",
        latestStatus: "CALCULATED",
      },
      reasonCode: "pnl_snapshot_stale",
    },
    {
      name: "PARTIAL PnL snapshot",
      pnlStatus: {
        readStatus: "OK",
        latestCapturedAt: "2026-06-18T13:33:27.000Z",
        latestRealizedPnlKrw: "0",
        latestUnrealizedPnlKrw: "0",
        latestStatus: "PARTIAL",
      },
      reasonCode: "pnl_snapshot_status_not_ready",
    },
    {
      name: "status가 없는 OK PnL snapshot",
      pnlStatus: {
        readStatus: "OK",
        latestCapturedAt: "2026-06-18T13:33:27.000Z",
        latestRealizedPnlKrw: "0",
        latestUnrealizedPnlKrw: "0",
      },
      reasonCode: "pnl_snapshot_status_not_ready",
    },
    {
      name: "readStatus가 복사된 OK PnL snapshot",
      pnlStatus: {
        readStatus: "OK",
        latestCapturedAt: "2026-06-18T13:33:27.000Z",
        latestRealizedPnlKrw: "0",
        latestUnrealizedPnlKrw: "0",
        latestStatus: "OK",
      },
      reasonCode: "pnl_snapshot_status_not_ready",
    },
    {
      name: "reconcile 계층 SUCCESS가 복사된 PnL snapshot",
      pnlStatus: {
        readStatus: "OK",
        latestCapturedAt: "2026-06-18T13:33:27.000Z",
        latestRealizedPnlKrw: "0",
        latestUnrealizedPnlKrw: "0",
        latestStatus: "SUCCESS",
      },
      reasonCode: "pnl_snapshot_status_not_ready",
    },
    {
      name: "job 계층 COMPLETE가 복사된 PnL snapshot",
      pnlStatus: {
        readStatus: "OK",
        latestCapturedAt: "2026-06-18T13:33:27.000Z",
        latestRealizedPnlKrw: "0",
        latestUnrealizedPnlKrw: "0",
        latestStatus: "COMPLETE",
      },
      reasonCode: "pnl_snapshot_status_not_ready",
    },
    {
      name: "job 계층 COMPLETED가 복사된 PnL snapshot",
      pnlStatus: {
        readStatus: "OK",
        latestCapturedAt: "2026-06-18T13:33:27.000Z",
        latestRealizedPnlKrw: "0",
        latestUnrealizedPnlKrw: "0",
        latestStatus: "COMPLETED",
      },
      reasonCode: "pnl_snapshot_status_not_ready",
    },
  ])("production preflight는 $name을 손실 증거로 쓰지 않고 제출 전 차단한다", async ({ pnlStatus, reasonCode }) => {
    const supportModulePath = path.join(process.cwd(), "scripts/run-live-ops-support.mjs");
    const {
      createLiveOpsCliEntryRuntime,
      createLiveOpsCliProductionExecutionInputs,
      evaluateLiveOpsCliLiveExecution,
    } = await import(supportModulePath);
    const observedAt = "2026-06-18T13:33:27.000Z";
    const submitted: unknown[] = [];
    const rawIntent = { ...createCleanupRuntimeIntent() } as Record<string, unknown>;
    delete rawIntent.costSnapshot;
    delete rawIntent.costInput;
    delete rawIntent.riskApproval;
    delete rawIntent.risk;
    const config = {
      universe: { markets: ["KRW-BTC"], default_market: "KRW-BTC" },
      budget: {
        max_order_krw: "10000",
        daily_autonomous_notional_limit_krw: "30000",
        max_open_position_notional_krw: "30000",
      },
    };
    const productionRuntime = {
      entryRuntime: {},
      cleanupLifecycle: {},
      privateReadProvider: {
        async listOpenOrders() {
          return [];
        },
        async getBalances() {
          return {
            exchangeId: "upbit_krw_spot",
            capturedAt: observedAt,
            balances: [{ currency: "KRW", available: "50000", locked: "0", total: "50000" }],
          };
        },
      },
      reconcileStatusProvider: {
        async getReconcileStatus() {
          return { lastReconcileAt: observedAt, result: "SUCCESS", mismatchCount: 0, openOrderCount: 0, balanceStatus: "OK" };
        },
      },
      pnlStatusProvider: {
        async getStatus() {
          return pnlStatus;
        },
      },
      killSwitchProvider: {
        async getStatus() {
          return { active: false, state: "NORMAL" };
        },
      },
      budgetReservation: {
        async readDailyReservedNotional() {
          return { reservedNotionalKrw: "0", reservationCount: 0 };
        },
      },
      preflightReconcileRecorder: {
        async recordPreflight() {
          throw new Error("FreshCleanReconcileShouldNotRecord");
        },
      },
      telegramDispatcher: {},
    };
    const executionInputs = await withFakeSystemTime(observedAt, () => createLiveOpsCliProductionExecutionInputs({
      config,
      env: {
        SEEMIRAI_UPBIT_ACCESS_KEY: "fake-access-key",
        SEEMIRAI_UPBIT_SECRET_KEY: "fake-secret-key",
        SEEMIRAI_UPBIT_KEY_SCOPE: "자산조회,주문조회,주문하기",
        SEEMIRAI_UPBIT_KEY_SCOPE_EVIDENCE_ID: "scope-evidence",
      },
      fixtureSmoke: false,
      analysisDecision: { ready: true, decisionCategory: "ORDER_INTENT", orderIntentCount: 1 },
      marketData: { ready: true, latestHeartbeatAt: observedAt, referencePrice: "100000000" },
      orderIntents: [rawIntent],
      productionRuntime,
    }));
    const liveExecution = await evaluateLiveOpsCliLiveExecution({
      config,
      fixtureSmoke: false,
      analysisDecision: { ready: true, decisionCategory: "ORDER_INTENT", orderIntentCount: 1 },
      marketData: { ready: true, latestHeartbeatAt: observedAt, referencePrice: "100000000" },
      env: {
        SEEMIRAI_UPBIT_ACCESS_KEY: "fake-access-key",
        SEEMIRAI_UPBIT_SECRET_KEY: "fake-secret-key",
        SEEMIRAI_UPBIT_KEY_SCOPE: "자산조회,주문조회,주문하기",
        SEEMIRAI_UPBIT_KEY_SCOPE_EVIDENCE_ID: "scope-evidence",
      },
      orderIntents: executionInputs.orderIntents,
      entryRuntime: createLiveOpsCliEntryRuntime({
        broker: {
          async submitOrder(submission: unknown) {
            submitted.push(submission);
            return { brokerOrderId: "unexpected-pnl-policy-order" };
          },
        },
        budgetReservation: {
          async reserve() {
            return { reserved: true };
          },
        },
      }),
      executionStatus: executionInputs.executionStatus,
      postSubmitReadiness: executionInputs.postSubmitReadiness,
      budgetSnapshot: executionInputs.budgetSnapshot,
      lossSnapshot: executionInputs.lossSnapshot,
      cleanupLifecycle: executionInputs.cleanupLifecycle,
    });

    expect(executionInputs.lossSnapshot).toMatchObject({
      ready: false,
      reasonCode,
    });
    expect(liveExecution).toMatchObject({
      status: "blocked",
      submittedOrderCount: 0,
    });
    expect(liveExecution.checks).toContainEqual(expect.objectContaining({
      code: "live_ops_execution_status_blocked",
      details: expect.objectContaining({
        violations: expect.arrayContaining(["실제 realized loss snapshot이 필요합니다"]),
      }),
    }));
    expect(submitted).toHaveLength(0);
  });

  it("production boot는 broker guard를 runtime 생성 조건으로 먼저 평가한다", async () => {
    const supportSource = await readFile(
      path.join(process.cwd(), "scripts", "run-live-ops-support.mjs"),
      "utf8",
    );
    const loadInputsStart = supportSource.indexOf("export async function loadLiveOpsCliInputs");
    const runtimeCallIndex = supportSource.indexOf("await createLiveOpsCliProductionRuntime", loadInputsStart);
    const brokerGuardIndex = supportSource.indexOf("evaluateLiveOpsCliBrokerGuard", loadInputsStart);
    const runtimeGateSource = supportSource.slice(brokerGuardIndex, runtimeCallIndex);

    expect(loadInputsStart).toBeGreaterThanOrEqual(0);
    expect(brokerGuardIndex).toBeGreaterThan(loadInputsStart);
    expect(runtimeCallIndex).toBeGreaterThan(loadInputsStart);
    expect(brokerGuardIndex).toBeLessThan(runtimeCallIndex);
    expect(runtimeGateSource).toContain("productionBrokerGuard");
    expect(runtimeGateSource).toContain("!productionBrokerGuard.ready");
  });

  it("production preflight는 KRW 가용잔고 누락이나 0원을 broker 제출 전에 차단한다", async () => {
    const supportModulePath = path.join(process.cwd(), "scripts/run-live-ops-support.mjs");
    const {
      createLiveOpsCliEntryRuntime,
      createLiveOpsCliProductionExecutionInputs,
      evaluateLiveOpsCliLiveExecution,
    } = await import(supportModulePath);
    const config = {
      live_trading_enabled: true,
      universe: { markets: ["KRW-BTC"], default_market: "KRW-BTC" },
      budget: {
        max_order_krw: "10000",
        daily_autonomous_notional_limit_krw: "30000",
        max_open_position_notional_krw: "30000",
      },
    };
    const cases = [{
      name: "missing-krw",
      balances: [{ currency: "BTC", available: "0.001", locked: "0", total: "0.001" }],
      reason: "krw_available_missing_or_non_positive",
    }, {
      name: "zero-krw",
      balances: [{ currency: "KRW", available: "0", locked: "0", total: "0" }],
      reason: "krw_available_missing_or_non_positive",
    }];

    for (const testCase of cases) {
      const submitted: unknown[] = [];
      const reservations: unknown[] = [];
      const rawIntent = { ...createCleanupRuntimeIntent() } as Record<string, unknown>;
      delete rawIntent.costInput;
      delete rawIntent.risk;
      delete rawIntent.costSnapshot;
      delete rawIntent.riskApproval;
      const entryRuntime = createLiveOpsCliEntryRuntime({
        broker: {
          async submitOrder(request: unknown) {
            submitted.push(request);
            return {
              brokerOrderId: `unexpected-${testCase.name}`,
              idempotencyKey: "ops-aaaaaaaaaaaaaaaaaaaaaaaaaa",
              exchangeId: "upbit_krw_spot",
              market: "KRW-BTC",
              side: "BUY",
              orderType: "LIMIT",
              status: "ACCEPTED",
              requestedQuantity: "0.0001",
              remainingQuantity: "0.0001",
              requestedPrice: "100000000",
              acceptedAt: "2026-06-18T13:33:27.000Z",
              updatedAt: "2026-06-18T13:33:27.000Z",
            };
          },
        },
        budgetReservation: {
          async reserve(request: {
            attemptId: string;
            idempotencyKey: string;
            requestedNotionalKrw: string;
            budgetSnapshot: unknown;
          }) {
            reservations.push(request);
            return {
              reserved: true,
              reservation: {
                reservationId: `reservation-${request.attemptId}`,
                attemptId: request.attemptId,
                idempotencyKey: request.idempotencyKey,
                reservedNotionalKrw: request.requestedNotionalKrw,
                budgetSnapshot: request.budgetSnapshot,
                reservedAt: "2026-06-18T13:33:27.000Z",
              },
            };
          },
        },
      });
      const productionRuntime = {
        entryRuntime,
        cleanupLifecycle: undefined,
        privateReadProvider: {
          async listOpenOrders() {
            return [];
          },
          async getBalances() {
            return {
              exchangeId: "upbit_krw_spot",
              capturedAt: "2026-06-18T13:33:27.000Z",
              balances: testCase.balances,
            };
          },
        },
        reconcileStatusProvider: {
          async getReconcileStatus() {
            return {
              lastReconcileAt: "2026-06-18T13:33:27.000Z",
              result: "SUCCESS",
              mismatchCount: 0,
              openOrderCount: 0,
              balanceStatus: "OK",
              websocketStatus: "CONNECTED",
              actionRequired: "없음",
              message: "기존 preflight reconcile evidence는 정상입니다.",
              trace: { source: "live_ops_cli_database_reconcile", runId: `clean-${testCase.name}` },
            };
          },
        },
        pnlStatusProvider: {
          async getStatus() {
            return {
              readStatus: "OK",
              latestCapturedAt: "2026-06-18T13:33:27.000Z",
              latestRealizedPnlKrw: "0",
              latestUnrealizedPnlKrw: "0",
              latestStatus: "CALCULATED",
            };
          },
        },
        killSwitchProvider: {
          async getStatus() {
            return {
              active: false,
              state: "NORMAL",
              reasonCode: "initial_state",
              updatedAt: "2026-06-18T13:33:27.000Z",
            };
          },
        },
        budgetReservation: {
          async readDailyReservedNotional() {
            return { reservedNotionalKrw: "0", reservationCount: 0 };
          },
        },
        preflightReconcileRecorder: {
          async recordPreflight() {
            throw new Error("PreflightRecorderShouldNotRun");
          },
        },
        telegramDispatcher: {},
      };
      const executionInputs = await withFakeSystemTime("2026-06-18T13:33:27.000Z", () => createLiveOpsCliProductionExecutionInputs({
        config,
        env: {
          SEEMIRAI_UPBIT_ACCESS_KEY: "fake-access-key",
          SEEMIRAI_UPBIT_SECRET_KEY: "fake-secret-key",
          SEEMIRAI_UPBIT_KEY_SCOPE: "자산조회,주문조회,주문하기",
          SEEMIRAI_UPBIT_KEY_SCOPE_EVIDENCE_ID: "scope-evidence",
        },
        fixtureSmoke: false,
        analysisDecision: {
          ready: true,
          decisionCategory: "ORDER_INTENT",
          orderIntentCount: 1,
        },
        marketData: {
          ready: true,
          latestHeartbeatAt: "2026-06-18T13:33:27.000Z",
          referencePrice: "100000000",
        },
        orderIntents: [rawIntent],
        productionRuntime,
      }));
      const enrichedIntent = executionInputs.orderIntents[0] as {
        risk?: { infrastructureSignals?: Array<{ signal?: string; reason?: string }> };
      };
      const summary = await evaluateLiveOpsCliLiveExecution({
        config,
        fixtureSmoke: false,
        analysisDecision: {
          ready: true,
          decisionCategory: "ORDER_INTENT",
          orderIntentCount: 1,
        },
        marketData: {
          ready: true,
          latestHeartbeatAt: "2026-06-18T13:33:27.000Z",
          referencePrice: "100000000",
        },
        env: {
          SEEMIRAI_UPBIT_ACCESS_KEY: "fake-access-key",
          SEEMIRAI_UPBIT_SECRET_KEY: "fake-secret-key",
          SEEMIRAI_UPBIT_KEY_SCOPE: "자산조회,주문조회,주문하기",
          SEEMIRAI_UPBIT_KEY_SCOPE_EVIDENCE_ID: "scope-evidence",
        },
        orderIntents: executionInputs.orderIntents,
        entryRuntime: executionInputs.entryRuntime,
        executionStatus: executionInputs.executionStatus,
        postSubmitReadiness: executionInputs.postSubmitReadiness,
        budgetSnapshot: executionInputs.budgetSnapshot,
        lossSnapshot: executionInputs.lossSnapshot,
        cleanupLifecycle: executionInputs.cleanupLifecycle,
      });

      expect(enrichedIntent.risk?.infrastructureSignals).toContainEqual(expect.objectContaining({
        signal: "BALANCE_POSITION_MISMATCH",
        reason: testCase.reason,
      }));
      expect(summary).toMatchObject({
        status: "blocked",
        submittedOrderCount: 0,
      });
      expect(summary.checks.map((check: { code: string }) => check.code)).toContain("live_ops_order_intent_blocked");
      expect(submitted).toHaveLength(0);
      expect(reservations).toHaveLength(0);
    }
  });

  it("production preflight는 기존 clean DB 뒤 다른 마켓 미체결 주문도 manual review evidence로 넘긴다", async () => {
    const supportModulePath = path.join(process.cwd(), "scripts/run-live-ops-support.mjs");
    const {
      createLiveOpsCliProductionExecutionInputs,
    } = await import(supportModulePath);
    const recorded: Array<{ openOrders?: Array<{ market?: string; brokerOrderId?: string }> }> = [];
    const listedOpenOrderMarkets: unknown[] = [];
    let reconcileReadCount = 0;
    const config = {
      universe: { markets: ["KRW-BTC"], default_market: "KRW-BTC" },
      budget: {
        max_order_krw: "10000",
        daily_autonomous_notional_limit_krw: "30000",
        max_open_position_notional_krw: "30000",
      },
    };
    const productionRuntime = {
      entryRuntime: {},
      cleanupLifecycle: {},
      privateReadProvider: {
        async listOpenOrders(market?: unknown) {
          listedOpenOrderMarkets.push(market);
          return [{
            brokerOrderId: "eth-open-order-1",
            idempotencyKey: "eth-open-identifier-1",
            exchangeId: "upbit_krw_spot",
            market: "KRW-ETH",
            side: "BID",
            orderType: "LIMIT",
            status: "OPEN",
            requestedQuantity: "0.002",
            remainingQuantity: "0.002",
            requestedPrice: "2500000",
            acceptedAt: "2026-06-18T13:33:00.000Z",
            updatedAt: "2026-06-18T13:33:27.000Z",
          }, {
            brokerOrderId: "xrp-open-order-1",
            idempotencyKey: "xrp-open-identifier-1",
            exchangeId: "upbit_krw_spot",
            market: "KRW-XRP",
            side: "BUY",
            orderType: "MARKET",
            status: "OPEN",
            requestedQuantity: null,
            remainingQuantity: "10",
            requestedPrice: null,
            acceptedAt: "2026-06-18T13:33:00.000Z",
            updatedAt: "2026-06-18T13:33:27.000Z",
          }];
        },
        async getBalances() {
          return {
            exchangeId: "upbit_krw_spot",
            capturedAt: "2026-06-18T13:33:27.000Z",
            balances: [{
              currency: "KRW",
              available: "50000",
              locked: "0",
              total: "50000",
            }],
          };
        },
      },
      reconcileStatusProvider: {
        async getReconcileStatus() {
          reconcileReadCount += 1;
          if (reconcileReadCount === 1) {
            return {
              lastReconcileAt: "2026-06-18T13:00:00.000Z",
              result: "SUCCESS",
              mismatchCount: 0,
              openOrderCount: 0,
              balanceStatus: "OK",
              websocketStatus: "CONNECTED",
              actionRequired: "없음",
              message: "기존 preflight reconcile evidence는 정상입니다.",
              trace: { source: "live_ops_cli_database_reconcile", runId: "previous-clean-run" },
            };
          }
          return {
            lastReconcileAt: "2026-06-18T13:33:27.000Z",
            result: "MANUAL_REVIEW_REQUIRED",
            mismatchCount: 1,
            openOrderCount: 1,
            balanceStatus: "ORDER_MISMATCH",
            websocketStatus: "CONNECTED",
            actionRequired: "거래소 미체결 주문을 확인하세요.",
            message: "실계좌 상태 대조에서 불일치가 발견되었습니다.",
            trace: { source: "live_ops_cli_database_reconcile", runId: "preflight-run-eth" },
          };
        },
      },
      pnlStatusProvider: {
        async getStatus() {
          return { readStatus: "NOT_FOUND", reason: "pnl_snapshot_not_found" };
        },
      },
      killSwitchProvider: {
        async getStatus() {
          return {
            active: false,
            state: "NORMAL",
            reasonCode: "initial_state",
            updatedAt: "2026-06-18T13:33:27.000Z",
          };
        },
      },
      budgetReservation: {
        async readDailyReservedNotional() {
          return { reservedNotionalKrw: "0", reservationCount: 0 };
        },
      },
      preflightReconcileRecorder: {
        async recordPreflight(input: { openOrders?: Array<{ market?: string; brokerOrderId?: string }> }) {
          recorded.push(input);
          return {
            created: true,
            runId: "preflight-run-eth",
            status: "MANUAL_REVIEW_REQUIRED",
            source: "live_ops_cli_private_read_preflight",
          };
        },
      },
      telegramDispatcher: {},
    };
    const result = await withFakeSystemTime("2026-06-18T13:33:27.000Z", () => createLiveOpsCliProductionExecutionInputs({
      config,
      env: {
        SEEMIRAI_UPBIT_ACCESS_KEY: "fake-access-key",
        SEEMIRAI_UPBIT_SECRET_KEY: "fake-secret-key",
        SEEMIRAI_UPBIT_KEY_SCOPE: "자산조회,주문조회,주문하기",
        SEEMIRAI_UPBIT_KEY_SCOPE_EVIDENCE_ID: "scope-evidence",
      },
      fixtureSmoke: false,
      analysisDecision: {
        ready: true,
        decisionCategory: "ORDER_INTENT",
        orderIntentCount: 1,
      },
      marketData: {
        ready: true,
        latestHeartbeatAt: "2026-06-18T13:33:27.000Z",
      },
      orderIntents: [createCleanupRuntimeIntent()],
      productionRuntime,
    }));

    expect(listedOpenOrderMarkets).toEqual([undefined]);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.openOrders).toEqual([expect.objectContaining({
      brokerOrderId: "eth-open-order-1",
      market: "KRW-ETH",
    }), expect.objectContaining({
      brokerOrderId: "xrp-open-order-1",
      market: "KRW-XRP",
    })]);
    expect(reconcileReadCount).toBe(2);
    expect(result.executionStatus).toMatchObject({
      killSwitchActive: false,
      reconcileFresh: false,
      preflightReconcileEvidence: {
        runId: "preflight-run-eth",
        status: "MANUAL_REVIEW_REQUIRED",
      },
    });
    expect(result.budgetSnapshot).toMatchObject({
      openPositionNotionalKrw: "5000",
      dailyAutonomousNotionalUsedKrw: "5000",
    });
  });

  it("preflight manual review evidence는 live execution과 status summary에 남는다", async () => {
    const supportModulePath = path.join(process.cwd(), "scripts/run-live-ops-support.mjs");
    const {
      evaluateLiveOpsCliLiveExecution,
      evaluateLiveOpsCliReconcilePnlStatus,
      evaluateLiveOpsCliTelegramAlert,
      renderLiveOpsSummary,
      renderLiveOpsTuiDashboard,
    } = await import(supportModulePath);
    const observedAt = "2026-06-18T13:33:27.000Z";
    const preflightReconcileEvidence = {
      created: true,
      runId: "preflight-run-open-order",
      idempotencyKey: "live-ops-preflight:openorder",
      correlationId: "preflight-reconcile-openorder",
      status: "MANUAL_REVIEW_REQUIRED",
      balanceSnapshotCount: 1,
      exchangeOrderSnapshotCount: 1,
      mismatchCount: 1,
      mismatchTypes: ["UNTRACKED_EXCHANGE_OPEN_ORDER"],
      recordedAt: observedAt,
      source: "live_ops_cli_private_read_preflight",
    };
    const config = {
      universe: { markets: ["KRW-BTC"], default_market: "KRW-BTC" },
      budget: {
        max_order_krw: "10000",
        daily_autonomous_notional_limit_krw: "30000",
        max_open_position_notional_krw: "30000",
      },
    };
    const executionStatus = {
      killSwitchActive: false,
      reconcileFresh: false,
      evidenceId: "execution-preflight-open-order",
      preflightReconcileEvidence,
    };
    const liveExecution = await evaluateLiveOpsCliLiveExecution({
      config,
      fixtureSmoke: false,
      analysisDecision: {
        ready: true,
        decisionCategory: "ORDER_INTENT",
        orderIntentCount: 1,
      },
      marketData: {
        ready: true,
        latestHeartbeatAt: observedAt,
        referencePrice: "100000000",
      },
      env: {
        SEEMIRAI_UPBIT_ACCESS_KEY: "fake-access-key",
        SEEMIRAI_UPBIT_SECRET_KEY: "fake-secret-key",
        SEEMIRAI_UPBIT_KEY_SCOPE: "자산조회,주문조회,주문하기",
        SEEMIRAI_UPBIT_KEY_SCOPE_EVIDENCE_ID: "scope-evidence",
      },
      orderIntents: [createCleanupRuntimeIntent()],
      entryRuntime: {
        async submitEntryCandidate() {
          throw new Error("unexpected-submit");
        },
      },
      executionStatus,
      postSubmitReadiness: {
        reconcileReady: true,
        telegramReady: true,
        evidenceId: "post-submit-ready",
      },
      budgetSnapshot: {
        maxOrderKrw: "10000",
        dailyAutonomousNotionalLimitKrw: "30000",
        dailyAutonomousNotionalUsedKrw: "5000",
        openPositionNotionalKrw: "5000",
        maxOpenPositionNotionalKrw: "30000",
        capturedAt: observedAt,
      },
      lossSnapshot: {
        dailyRealizedLossKrw: "0",
        weeklyRealizedLossKrw: "0",
        capturedAt: observedAt,
      },
    });
    const reconcilePnlStatus = await evaluateLiveOpsCliReconcilePnlStatus({
      config,
      fixtureSmoke: false,
      liveExecution,
      budgetSnapshot: {
        dailyAutonomousNotionalUsedKrw: "5000",
        openPositionNotionalKrw: "5000",
      },
      observedAt,
    });
    const telegramDispatches: unknown[] = [];
    const telegramAlert = await evaluateLiveOpsCliTelegramAlert({
      config: {
        ...config,
        telegram: {
          trade_event_alerts_enabled: true,
        },
      },
      fixtureSmoke: false,
      liveExecution,
      orderIntent: createCleanupRuntimeIntent(),
      observedAt,
      correlationId: "preflight-manual-review",
      telegramDispatcher: {
        async dispatch(input: unknown) {
          telegramDispatches.push(input);
          return {
            status: "sent",
            attemptedCount: 1,
            deliveredCount: 1,
            retryPlannedCount: 0,
            failureCount: 0,
          };
        },
      },
    });
    const dashboard = renderLiveOpsTuiDashboard(renderLiveOpsSummary({
      configPath: "config/live-ops.example.json",
      envFilePath: "tests/fixtures/live-ops/fake.env",
      config,
      env: {},
      fixtureSmoke: false,
      dbReadiness: { ready: true },
      marketData: {
        ready: true,
        persisted: {
          tradeCount: 1,
          orderbookCount: 1,
          statusCount: 1,
        },
      },
      analysisDecision: { ready: true },
      liveExecution,
      reconcilePnlStatus,
      telegramAlert: { ready: false, status: "pending" },
    }));

    expect(liveExecution).toMatchObject({
      status: "manual_review_required",
      ready: false,
      preflightReconcileEvidence: expect.objectContaining({
        runId: "preflight-run-open-order",
        status: "MANUAL_REVIEW_REQUIRED",
      }),
    });
    expect(liveExecution.checks).toContainEqual(expect.objectContaining({
      code: "live_ops_execution_status_blocked",
      details: expect.objectContaining({
        mismatchTypes: ["UNTRACKED_EXCHANGE_OPEN_ORDER"],
        preflightReconcileEvidence: expect.objectContaining({ runId: "preflight-run-open-order" }),
      }),
    }));
    expect(reconcilePnlStatus).toMatchObject({
      status: "manual_review_required",
      reconcileStatus: "preflight_manual_review_required",
      openOrderCount: 1,
      openExposureKrw: "5000",
      budgetUsedKrw: "5000",
      mismatchCount: 1,
      preflightReconcileEvidence: expect.objectContaining({ runId: "preflight-run-open-order" }),
    });
    expect(reconcilePnlStatus.checks).toContainEqual(expect.objectContaining({
      code: "live_ops_preflight_reconcile_manual_review",
    }));
    expect(telegramAlert).toMatchObject({
      status: "sent",
      lifecycleAlertCount: 1,
      deliveredCount: 1,
    });
    expect(telegramDispatches).toHaveLength(1);
    expect(JSON.stringify(telegramDispatches[0])).toContain("MANUAL_REVIEW_REQUIRED");
    expect(dashboard).toContain("preflight MANUAL_REVIEW_REQUIRED preflight-run-open-order");
  });

  it("submitted 상태의 private read는 현재 주문과 다른 open order를 manual review로 차단한다", async () => {
    const supportModulePath = path.join(process.cwd(), "scripts/run-live-ops-support.mjs");
    const {
      evaluateLiveOpsCliReconcilePnlStatus,
    } = await import(supportModulePath);
    const observedAt = "2026-06-18T13:33:27.000Z";
    const summary = await evaluateLiveOpsCliReconcilePnlStatus({
      config: {
        universe: { default_market: "KRW-BTC" },
      },
      fixtureSmoke: false,
      liveExecution: {
        status: "submitted",
        ready: true,
        liveOrderCapable: true,
        attemptId: "ops-attempt-1",
        brokerOrderId: "upbit-order-1",
        idempotencyKey: "ops-idem-1",
      },
      privateReadProvider: {
        async listOpenOrders() {
          return [{
            brokerOrderId: "upbit-order-1",
            idempotencyKey: "ops-idem-1",
            exchangeId: "upbit_krw_spot",
            market: "KRW-BTC",
            side: "BUY",
            orderType: "LIMIT",
            status: "ACCEPTED",
            requestedQuantity: "0.0001",
            remainingQuantity: "0.00005",
            requestedPrice: "100000000",
            updatedAt: observedAt,
          }, {
            brokerOrderId: "eth-open-order-1",
            idempotencyKey: "eth-open-identifier-1",
            exchangeId: "upbit_krw_spot",
            market: "KRW-ETH",
            side: "BUY",
            orderType: "LIMIT",
            status: "OPEN",
            requestedQuantity: "0.002",
            remainingQuantity: "0.002",
            requestedPrice: "2500000",
            updatedAt: observedAt,
          }];
        },
        async getBalances() {
          return {
            exchangeId: "upbit_krw_spot",
            capturedAt: observedAt,
            balances: [{ currency: "KRW", available: "50000", locked: "0", total: "50000" }],
          };
        },
      },
      reconcileStatusProvider: {
        async getReconcileStatus() {
          return {
            lastReconcileAt: observedAt,
            result: "SUCCESS",
            mismatchCount: 0,
            openOrderCount: 0,
            balanceStatus: "OK",
            websocketStatus: "CONNECTED",
            actionRequired: "없음",
            message: "기존 reconcile evidence는 정상입니다.",
          };
        },
      },
      pnlStatusProvider: {
        async getStatus() {
          return {
            readStatus: "OK",
            latestCapturedAt: observedAt,
            latestRealizedPnlKrw: "0",
            latestUnrealizedPnlKrw: "0",
            latestStatus: "CALCULATED",
            snapshotCount: 1,
          };
        },
      },
      budgetSnapshot: {
        dailyAutonomousNotionalUsedKrw: "10000",
      },
      observedAt,
    });

    expect(summary).toMatchObject({
      ready: false,
      manualReviewRequired: true,
      openOrderCount: 2,
      openExposureKrw: "10000",
      budgetUsedKrw: "10000",
    });
    expect(summary.checks).toContainEqual(expect.objectContaining({
      code: "live_ops_reconcile_status_requires_review",
    }));
  });

  it("post-cleanup 상태 요약은 현재 reservation notional을 budget used에 반영한다", async () => {
    const supportModulePath = path.join(process.cwd(), "scripts/run-live-ops-support.mjs");
    const {
      evaluateLiveOpsCliReconcilePnlStatus,
    } = await import(supportModulePath);
    const observedAt = "2026-06-18T13:33:27.000Z";
    const summary = await evaluateLiveOpsCliReconcilePnlStatus({
      config: {
        universe: { default_market: "KRW-BTC" },
      },
      fixtureSmoke: false,
      liveExecution: {
        status: "cancel_confirmed",
        ready: true,
        liveOrderCapable: true,
        attemptId: "ops-attempt-1",
        brokerOrderId: "upbit-order-1",
        idempotencyKey: "ops-idem-1",
        reservedNotionalKrw: "10000",
        budgetUsageAfterReservationKrw: "10000",
        cleanup: {
          cleanCancel: true,
        },
      },
      privateReadProvider: {
        async listOpenOrders() {
          return [];
        },
        async getBalances() {
          return {
            exchangeId: "upbit_krw_spot",
            capturedAt: observedAt,
            balances: [{ currency: "KRW", available: "40000", locked: "0", total: "40000" }],
          };
        },
      },
      reconcileStatusProvider: {
        async getReconcileStatus() {
          return {
            lastReconcileAt: observedAt,
            result: "SUCCESS",
            mismatchCount: 0,
            openOrderCount: 0,
            balanceStatus: "OK",
            websocketStatus: "CONNECTED",
            actionRequired: "없음",
            message: "cleanup 뒤 계정 상태가 정상입니다.",
          };
        },
      },
      pnlStatusProvider: {
        async getStatus() {
          return {
            readStatus: "OK",
            latestCapturedAt: observedAt,
            latestRealizedPnlKrw: "0",
            latestUnrealizedPnlKrw: "0",
            latestStatus: "CALCULATED",
            snapshotCount: 1,
          };
        },
      },
      budgetSnapshot: {
        dailyAutonomousNotionalUsedKrw: "0",
      },
      observedAt,
    });

    expect(summary).toMatchObject({
      ready: true,
      openOrderCount: 0,
      openExposureKrw: "0",
      budgetUsedKrw: "10000",
    });
  });

  it("post-submit PnL summary는 계산 미완료 snapshot을 ready로 낮추지 않는다", async () => {
    const supportModulePath = path.join(process.cwd(), "scripts/run-live-ops-support.mjs");
    const {
      evaluateLiveOpsCliReconcilePnlStatus,
    } = await import(supportModulePath);
    const observedAt = "2026-06-18T13:33:27.000Z";
    const summary = await evaluateLiveOpsCliReconcilePnlStatus({
      config: {
        universe: { default_market: "KRW-BTC" },
      },
      fixtureSmoke: false,
      liveExecution: {
        status: "cancel_confirmed",
        ready: true,
        liveOrderCapable: true,
        attemptId: "ops-attempt-1",
        brokerOrderId: "upbit-order-1",
        idempotencyKey: "ops-idem-1",
        reservedNotionalKrw: "10000",
        budgetUsageAfterReservationKrw: "10000",
      },
      privateReadProvider: {
        async listOpenOrders() {
          return [];
        },
        async getBalances() {
          return {
            exchangeId: "upbit_krw_spot",
            capturedAt: observedAt,
            balances: [{ currency: "KRW", available: "40000", locked: "0", total: "40000" }],
          };
        },
      },
      reconcileStatusProvider: {
        async getReconcileStatus() {
          return {
            lastReconcileAt: observedAt,
            result: "SUCCESS",
            mismatchCount: 0,
            openOrderCount: 0,
            balanceStatus: "OK",
            websocketStatus: "CONNECTED",
            actionRequired: "없음",
            message: "cleanup 뒤 계정 상태가 정상입니다.",
          };
        },
      },
      pnlStatusProvider: {
        async getStatus() {
          return {
            readStatus: "OK",
            latestCapturedAt: observedAt,
            latestRealizedPnlKrw: "0",
            latestUnrealizedPnlKrw: "0",
            latestStatus: "PARTIAL",
            snapshotCount: 1,
          };
        },
      },
      budgetSnapshot: {
        dailyAutonomousNotionalUsedKrw: "0",
      },
      observedAt,
    });

    expect(summary).toMatchObject({
      status: "manual_review_required",
      ready: false,
      manualReviewRequired: true,
      pnlStatus: "pnl_snapshot_status_not_ready",
      budgetUsedKrw: "10000",
    });
    expect(summary.checks).toContainEqual(expect.objectContaining({
      code: "live_ops_pnl_status_requires_review",
    }));
  });

  it("post-submit PnL summary는 stale snapshot을 ready로 낮추지 않는다", async () => {
    const supportModulePath = path.join(process.cwd(), "scripts/run-live-ops-support.mjs");
    const {
      evaluateLiveOpsCliReconcilePnlStatus,
    } = await import(supportModulePath);
    const observedAt = "2026-06-18T13:33:27.000Z";
    const summary = await evaluateLiveOpsCliReconcilePnlStatus({
      config: {
        universe: { default_market: "KRW-BTC" },
      },
      fixtureSmoke: false,
      liveExecution: {
        status: "cancel_confirmed",
        ready: true,
        liveOrderCapable: true,
        attemptId: "ops-attempt-1",
        brokerOrderId: "upbit-order-1",
        idempotencyKey: "ops-idem-1",
        reservedNotionalKrw: "10000",
        budgetUsageAfterReservationKrw: "10000",
      },
      privateReadProvider: {
        async listOpenOrders() {
          return [];
        },
        async getBalances() {
          return {
            exchangeId: "upbit_krw_spot",
            capturedAt: observedAt,
            balances: [{ currency: "KRW", available: "40000", locked: "0", total: "40000" }],
          };
        },
      },
      reconcileStatusProvider: {
        async getReconcileStatus() {
          return {
            lastReconcileAt: observedAt,
            result: "SUCCESS",
            mismatchCount: 0,
            openOrderCount: 0,
            balanceStatus: "OK",
            websocketStatus: "CONNECTED",
            actionRequired: "없음",
            message: "cleanup 뒤 계정 상태가 정상입니다.",
          };
        },
      },
      pnlStatusProvider: {
        async getStatus() {
          return {
            readStatus: "OK",
            latestCapturedAt: "2026-06-18T13:32:20.000Z",
            latestRealizedPnlKrw: "0",
            latestUnrealizedPnlKrw: "0",
            latestStatus: "CALCULATED",
            snapshotCount: 1,
          };
        },
      },
      budgetSnapshot: {
        dailyAutonomousNotionalUsedKrw: "0",
      },
      observedAt,
    });

    expect(summary).toMatchObject({
      status: "manual_review_required",
      ready: false,
      manualReviewRequired: true,
      pnlStatus: "pnl_snapshot_stale",
      budgetUsedKrw: "10000",
    });
    expect(summary.checks).toContainEqual(expect.objectContaining({
      code: "live_ops_pnl_status_requires_review",
    }));
  });

  it("post-submit PnL summary는 provider read 완료 후 stale해진 snapshot을 ready로 낮추지 않는다", async () => {
    const supportModulePath = path.join(process.cwd(), "scripts/run-live-ops-support.mjs");
    const {
      evaluateLiveOpsCliReconcilePnlStatus,
    } = await import(supportModulePath);
    const observedAt = "2026-06-18T13:33:27.000Z";

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-18T13:34:05.000Z"));
    try {
      const summary = await evaluateLiveOpsCliReconcilePnlStatus({
        config: {
          universe: { default_market: "KRW-BTC" },
        },
        fixtureSmoke: false,
        liveExecution: {
          status: "cancel_confirmed",
          ready: true,
          liveOrderCapable: true,
          attemptId: "ops-attempt-1",
          brokerOrderId: "upbit-order-1",
          idempotencyKey: "ops-idem-1",
          reservedNotionalKrw: "10000",
          budgetUsageAfterReservationKrw: "10000",
        },
        privateReadProvider: {
          async listOpenOrders() {
            return [];
          },
          async getBalances() {
            return {
              exchangeId: "upbit_krw_spot",
              capturedAt: observedAt,
              balances: [{ currency: "KRW", available: "40000", locked: "0", total: "40000" }],
            };
          },
        },
        reconcileStatusProvider: {
          async getReconcileStatus() {
            return {
              lastReconcileAt: observedAt,
              result: "SUCCESS",
              mismatchCount: 0,
              openOrderCount: 0,
              balanceStatus: "OK",
              websocketStatus: "CONNECTED",
              actionRequired: "없음",
              message: "cleanup 뒤 계정 상태가 정상입니다.",
            };
          },
        },
        pnlStatusProvider: {
          async getStatus() {
            return {
              readStatus: "OK",
              latestCapturedAt: observedAt,
              latestRealizedPnlKrw: "0",
              latestUnrealizedPnlKrw: "0",
              latestStatus: "CALCULATED",
              snapshotCount: 1,
            };
          },
        },
        budgetSnapshot: {
          dailyAutonomousNotionalUsedKrw: "0",
        },
        observedAt,
      });

      expect(summary).toMatchObject({
        status: "manual_review_required",
        ready: false,
        manualReviewRequired: true,
        pnlStatus: "pnl_snapshot_stale",
        budgetUsedKrw: "10000",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("terminal cancel no-fill은 stale CALCULATED PnL row를 수동 점검으로 올리지 않는다", async () => {
    const supportModulePath = path.join(process.cwd(), "scripts/run-live-ops-support.mjs");
    const {
      evaluateLiveOpsCliReconcilePnlStatus,
    } = await import(supportModulePath);
    const observedAt = "2026-06-18T13:33:27.000Z";
    const summary = await evaluateLiveOpsCliReconcilePnlStatus({
      config: {
        universe: { default_market: "KRW-BTC" },
      },
      fixtureSmoke: false,
      liveExecution: {
        status: "cancel_confirmed",
        ready: true,
        liveOrderCapable: true,
        attemptId: "ops-attempt-1",
        brokerOrderId: "upbit-order-1",
        idempotencyKey: "ops-idem-1",
        reservedNotionalKrw: "10000",
        budgetUsageAfterReservationKrw: "10000",
        terminalCheckedAt: observedAt,
        cleanup: {
          cleanCancel: true,
        },
      },
      privateReadProvider: {
        async listOpenOrders() {
          return [];
        },
        async getBalances() {
          return {
            exchangeId: "upbit_krw_spot",
            capturedAt: observedAt,
            balances: [{ currency: "KRW", available: "40000", locked: "0", total: "40000" }],
          };
        },
      },
      reconcileStatusProvider: {
        async getReconcileStatus() {
          return {
            lastReconcileAt: observedAt,
            result: "SUCCESS",
            mismatchCount: 0,
            openOrderCount: 0,
            balanceStatus: "OK",
            websocketStatus: "CONNECTED",
            actionRequired: "없음",
            message: "cleanup 뒤 no-fill cancel이 확인됐습니다.",
          };
        },
      },
      pnlStatusProvider: {
        async getStatus() {
          return {
            readStatus: "OK",
            latestCapturedAt: "2026-06-18T13:32:20.000Z",
            latestRealizedPnlKrw: "0",
            latestUnrealizedPnlKrw: "0",
            latestStatus: "CALCULATED",
            snapshotCount: 1,
          };
        },
      },
      budgetSnapshot: {
        dailyAutonomousNotionalUsedKrw: "0",
      },
      observedAt,
    });

    expect(summary).toMatchObject({
      status: "ready",
      ready: true,
      manualReviewRequired: false,
      pnlStatus: "cleanup_no_fill",
      budgetUsedKrw: "10000",
    });
  });

  it("private read 실패와 변형 응답도 현재 reservation notional을 budget used 하한으로 보존한다", async () => {
    const supportModulePath = path.join(process.cwd(), "scripts/run-live-ops-support.mjs");
    const {
      evaluateLiveOpsCliReconcilePnlStatus,
    } = await import(supportModulePath);
    const observedAt = "2026-06-18T13:33:27.000Z";
    const liveExecution = {
      status: "cancel_confirmed",
      ready: true,
      liveOrderCapable: true,
      attemptId: "ops-attempt-1",
      brokerOrderId: "upbit-order-1",
      idempotencyKey: "ops-idem-1",
      reservedNotionalKrw: "10000",
      budgetUsageAfterReservationKrw: "15000",
      cleanup: {
        cleanCancel: true,
      },
    };
    const commonInput = {
      config: {
        universe: { default_market: "KRW-BTC" },
      },
      fixtureSmoke: false,
      liveExecution,
      budgetSnapshot: {
        dailyAutonomousNotionalUsedKrw: "0",
      },
      observedAt,
    };

    const failedSummary = await evaluateLiveOpsCliReconcilePnlStatus({
      ...commonInput,
      privateReadProvider: {
        async listOpenOrders() {
          throw new Error("RateLimitedDuringPrivateRead");
        },
        async getBalances() {
          return {
            exchangeId: "upbit_krw_spot",
            capturedAt: observedAt,
            balances: [{ currency: "KRW", available: "40000", locked: "0", total: "40000" }],
          };
        },
      },
      reconcileStatusProvider: {
        async getReconcileStatus() {
          return { result: "SUCCESS", mismatchCount: 0, openOrderCount: 0 };
        },
      },
      pnlStatusProvider: {
        async getStatus() {
          return { readStatus: "OK" };
        },
      },
    });
    const malformedSummary = await evaluateLiveOpsCliReconcilePnlStatus({
      ...commonInput,
      privateReadProvider: {
        async listOpenOrders() {
          return "malformed-open-orders";
        },
        async getBalances() {
          return {
            exchangeId: "upbit_krw_spot",
            capturedAt: observedAt,
            balances: [{ currency: "KRW", available: "40000", locked: "0", total: "40000" }],
          };
        },
      },
      reconcileStatusProvider: {
        async getReconcileStatus() {
          return { result: "SUCCESS", mismatchCount: 0, openOrderCount: 0 };
        },
      },
      pnlStatusProvider: {
        async getStatus() {
          return { readStatus: "OK" };
        },
      },
    });

    expect(failedSummary).toMatchObject({
      status: "manual_review_required",
      budgetUsedKrw: "15000",
    });
    expect(failedSummary.checks).toContainEqual(expect.objectContaining({
      code: "live_ops_private_read_failed",
    }));
    expect(malformedSummary).toMatchObject({
      status: "manual_review_required",
      budgetUsedKrw: "15000",
    });
    expect(malformedSummary.checks).toContainEqual(expect.objectContaining({
      code: "live_ops_private_read_orders_malformed",
    }));
  });

  it("live:ops:tui attach는 같은 dashboard를 attach 대상으로 렌더링한다", () => {
    const result = spawnSync(
      process.execPath,
      [
        "scripts/run-live-ops-tui.mjs",
        "--config",
        "config/live-ops.example.json",
        "--env-file",
        "tests/fixtures/live-ops/fake.env",
        "--fixture-smoke",
        "--attach",
        "fixture",
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: minimalEnv(),
      },
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Seemirai Live Ops");
    expect(result.stdout).toContain("attach=fixture");
    expect(result.stdout).toMatch(/DB schema: 적용 v\d+ \/ 기준 v\d+/u);
    expect(result.stdout).toContain("시세 수집: DB-backed 저장 확인");
    expect(result.stdout).toContain("분석/판단: 보류 기록 확인");
    expect(result.stdout).toContain("실주문 실행: 후보 없음 - broker 제출 없음");
    expect(result.stdout).toContain("Reconcile/PnL/status: 상태 요약 확인");
    expect(result.stdout).toContain("Telegram 알림: fixture alert plan 확인");
    expect(result.stdout).not.toContain("fake-local-control-token");
  });

  it("non-fixture live:ops:tui attach는 status source를 읽고 production runtime과 provider를 새로 열지 않는다", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-live-ops-attach-"));
    const statusSourcePath = path.join(tempDir, "status-source.json");
    await writeFile(statusSourcePath, JSON.stringify({
      summary: {
        dbReadiness: {
          ready: true,
          migration: {
            appliedLatestVersion: 13,
            expectedLatestVersion: 13,
            pendingVersions: [],
          },
        },
        marketData: {
          ready: true,
          persisted: {
            tradeCount: 2,
            orderbookCount: 4,
            statusCount: 1,
          },
          latestHeartbeatAt: "2026-06-18T13:33:27.000Z",
        },
        analysisDecision: {
          ready: true,
          decisionCategory: "ORDER_INTENT",
          orderIntentCount: 1,
          evaluatedStrategyCount: 1,
          latestDecisionAt: "2026-06-18T13:33:27.000Z",
        },
        liveExecution: {
          status: "manual_review_required",
          ready: false,
          liveOrderCapable: true,
          statusLabel: "수동 점검",
          latestExecutionAt: "2026-06-18T13:33:28.000Z",
          orderIntentCount: 1,
          attemptedOrderCount: 1,
          submittedOrderCount: 0,
          checks: [{
            status: "blocked",
            code: "live_ops_preflight_reconcile_manual_review",
          }],
        },
        reconcilePnlStatus: {
          status: "manual_review_required",
          ready: false,
          providerProbeAttempted: true,
          manualReviewRequired: true,
          statusLabel: "수동 확인 필요",
          reconcileStatusLabel: "수동 확인",
          pnlStatusLabel: "관측 대기",
          openOrderCount: 2,
          openExposureKrw: "12000",
          budgetUsedKrw: "12000",
          realizedPnlKrw: null,
          unrealizedPnlKrw: null,
          latestReconcileAt: "2026-06-18T13:33:27.000Z",
          mismatchCount: 1,
        },
        telegramAlert: {
          status: "idle",
          ready: true,
          lifecycleAlertCount: 1,
          tradeAlertCount: 0,
          alertCount: 1,
          providerDispatchAttempted: false,
          statusLabel: "대기",
        },
      },
    }), "utf8");
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `
import { loadLiveOpsCliInputs, renderLiveOpsSummary } from "./scripts/run-live-ops-support.mjs";

let websocketOpened = false;
let fetchCalled = false;
globalThis.WebSocket = class {
  constructor() {
    websocketOpened = true;
    throw new Error("AttachShouldNotOpenProvider");
  }
};

const inputs = await loadLiveOpsCliInputs({
  configPath: "config/live-ops.example.json",
  envFilePath: "tests/fixtures/live-ops/fake.env",
  fixtureSmoke: false,
  attach: ${JSON.stringify(statusSourcePath)},
  attachReadonly: true,
  fetchImpl: async () => {
    fetchCalled = true;
    throw new Error("AttachShouldNotFetch");
  },
});
const summary = renderLiveOpsSummary({
  ...inputs,
  fixtureSmoke: false,
  tui: true,
  attach: ${JSON.stringify(statusSourcePath)},
});

console.log(JSON.stringify({
  status: summary.status,
  message: summary.message,
  liveOrderCapable: summary.liveOrderCapable,
  openOrderCount: summary.reconcilePnlStatus.openOrderCount,
  budgetUsedKrw: summary.reconcilePnlStatus.budgetUsedKrw,
  manualReviewRequired: summary.reconcilePnlStatus.manualReviewRequired,
  websocketOpened,
  fetchCalled,
  liveExecutionStatusLabel: summary.liveExecution.statusLabel,
  providerProbeAttempted: summary.reconcilePnlStatus.providerProbeAttempted,
  telegramDispatchAttempted: summary.telegramAlert.providerDispatchAttempted,
}));
        `,
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: minimalEnv(),
      },
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    const output = JSON.parse(result.stdout) as {
      status: string;
      message: string;
      liveOrderCapable: boolean;
      openOrderCount: number;
      budgetUsedKrw: string;
      manualReviewRequired: boolean;
      websocketOpened: boolean;
      fetchCalled: boolean;
      liveExecutionStatusLabel: string;
      providerProbeAttempted: boolean;
      telegramDispatchAttempted: boolean;
    };
    expect(output).toMatchObject({
      status: "blocked",
      liveOrderCapable: true,
      openOrderCount: 2,
      budgetUsedKrw: "12000",
      manualReviewRequired: true,
      websocketOpened: false,
      fetchCalled: false,
      liveExecutionStatusLabel: "수동 점검",
      providerProbeAttempted: true,
      telegramDispatchAttempted: false,
    });
    expect(output.message).toContain("status source");
  });

  it("non-fixture live:ops:tui attach는 status source를 읽지 못하면 실패한다", () => {
    const result = spawnSync(
      process.execPath,
      [
        "scripts/run-live-ops-tui.mjs",
        "--config",
        "config/live-ops.example.json",
        "--env-file",
        "tests/fixtures/live-ops/fake.env",
        "--attach",
        path.join(os.tmpdir(), "seemirai-missing-status-source.json"),
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: minimalEnv(),
      },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("attach status source");
  });

  it("non-fixture live:ops:tui attach는 liveOrderCapable이 boolean이 아니면 실패한다", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-live-ops-attach-invalid-"));
    const statusSourcePath = path.join(tempDir, "status-source.json");
    await writeFile(statusSourcePath, JSON.stringify({
      summary: {
        dbReadiness: { ready: true },
        marketData: { ready: true },
        analysisDecision: { ready: true },
        liveExecution: {
          ready: true,
          status: "idle",
          liveOrderCapable: "false",
        },
        reconcilePnlStatus: { ready: true },
        telegramAlert: { ready: true },
      },
    }), "utf8");
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `
import { loadLiveOpsCliInputs } from "./scripts/run-live-ops-support.mjs";

await loadLiveOpsCliInputs({
  configPath: "config/live-ops.example.json",
  envFilePath: "tests/fixtures/live-ops/fake.env",
  fixtureSmoke: false,
  attach: ${JSON.stringify(statusSourcePath)},
  attachReadonly: true,
});
        `,
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: minimalEnv(),
      },
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("liveOrderCapable");
  });

  it("live:ops foreground 명령은 --attach를 성공 처리하지 않는다", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-live-ops-foreground-attach-"));
    const statusSourcePath = path.join(tempDir, "status-source.json");
    await writeFile(statusSourcePath, JSON.stringify({ summary: {} }), "utf8");
    const result = spawnSync(
      process.execPath,
      [
        "scripts/run-live-ops.mjs",
        "--config",
        "config/live-ops.example.json",
        "--env-file",
        "tests/fixtures/live-ops/fake.env",
        "--attach",
        statusSourcePath,
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: minimalEnv(),
      },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("--attach는 live:ops:tui");
  });

  it("production live ops closeout source scan은 private order 직접 호출과 Telegram dispatcher 위치를 확인한다", async () => {
    const productionFiles = [
      "scripts/run-live-ops-support.mjs",
      "scripts/run-live-ops.mjs",
      "scripts/run-live-ops-tui.mjs",
      "src/runtime/live-ops-market-data.ts",
      "src/runtime/live-ops-market-data/collector.ts",
      "src/runtime/live-ops-analysis-decision.ts",
      "src/runtime/live-ops-analysis-decision/pipeline.ts",
      "src/runtime/live-ops-decision-policy.ts",
      "src/runtime/live-ops-decision-policy/cleanup-probe.ts",
      "src/runtime/live-ops-decision-policy/resolver.ts",
      "src/runtime/live-ops-live-execution.ts",
      "src/runtime/live-ops-live-execution/service.ts",
      "src/runtime/live-ops-telegram-alerts.ts",
      "src/runtime/live-ops-telegram-alerts/plan.ts",
    ];
    const forbiddenPrivateOrderPatterns = [
      /POST\s+\/v1\/orders/u,
      /DELETE\s+\/v1\/order/u,
      /Authorization/u,
      /Bearer/u,
      /UpbitPrivateRestClient/u,
      /createGuardedUpbitLiveBrokerRuntime/u,
    ];

    for (const filePath of productionFiles) {
      const content = await readFile(path.join(process.cwd(), filePath), "utf8");
      for (const forbiddenPattern of forbiddenPrivateOrderPatterns) {
        expect(content, `${filePath} must not match ${forbiddenPattern.source}`).not.toMatch(forbiddenPattern);
      }
      if (filePath !== "scripts/run-live-ops-support.mjs") {
        expect(content, `${filePath} must not dispatch Telegram directly`).not.toMatch(/sendMessage/u);
      }
    }
    const supportContent = await readFile(path.join(process.cwd(), "scripts/run-live-ops-support.mjs"), "utf8");
    expect(supportContent).toContain("createLiveOpsCliTelegramDispatcher");
    expect(supportContent).toContain("sendMessage");
  });

  it("Upbit public provider boot helper는 공개 구독과 universe/stale guard를 검증한다", () => {
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `
import {
  createLiveOpsUpbitSubscriptionMessage,
  mapLiveOpsUpbitPayloadToEvent,
  parseLiveOpsUpbitWebSocketMessage,
} from "./scripts/run-live-ops-support.mjs";

const tradePayload = {
  type: "trade",
  code: "KRW-BTC",
  trade_price: 100000000,
  trade_volume: 0.001,
  ask_bid: "BID",
  trade_timestamp: Date.parse("2026-06-15T00:00:00.000Z"),
  timestamp: Date.parse("2026-06-15T00:00:00.000Z"),
  sequential_id: "9007199254740993",
  stream_type: "REALTIME",
};
const orderbookPayload = {
  type: "orderbook",
  code: "KRW-BTC",
  total_ask_size: 0.2,
  total_bid_size: 0.3,
  orderbook_units: [{
    ask_price: 100001000,
    ask_size: 0.2,
    bid_price: 100000000,
    bid_size: 0.3,
  }],
  timestamp: Date.parse("2026-06-15T00:00:00.000Z"),
  level: 0,
  stream_type: "REALTIME",
};
const receivedAt = "2026-06-15T00:00:01.000Z";
const subscription = createLiveOpsUpbitSubscriptionMessage({ market: "KRW-BTC" });
const [parsedLargeTrade] = parseLiveOpsUpbitWebSocketMessage(
  '{"type":"trade","code":"KRW-BTC","trade_price":100000000,"trade_volume":0.001,"ask_bid":"BID","trade_timestamp":1781481600000,"timestamp":1781481600000,"sequential_id":17303368620470000123,"stream_type":"REALTIME"}',
);
const largeTrade = mapLiveOpsUpbitPayloadToEvent(parsedLargeTrade, {
  market: "KRW-BTC",
  receivedAt,
  observedAt: receivedAt,
  staleAfterMs: 30000,
});
const trade = mapLiveOpsUpbitPayloadToEvent(tradePayload, {
  market: "KRW-BTC",
  receivedAt,
  observedAt: receivedAt,
  staleAfterMs: 30000,
});
const orderbook = mapLiveOpsUpbitPayloadToEvent(orderbookPayload, {
  market: "KRW-BTC",
  receivedAt,
  observedAt: receivedAt,
  staleAfterMs: 30000,
});
const stale = mapLiveOpsUpbitPayloadToEvent(tradePayload, {
  market: "KRW-BTC",
  receivedAt: "2026-06-15T00:01:00.000Z",
  observedAt: "2026-06-15T00:01:00.000Z",
  staleAfterMs: 30000,
});
let outsideUniverse = "not-thrown";
try {
  mapLiveOpsUpbitPayloadToEvent({ ...tradePayload, code: "KRW-ETH" }, {
    market: "KRW-BTC",
    receivedAt,
    observedAt: receivedAt,
    staleAfterMs: 30000,
  });
} catch (error) {
  outsideUniverse = error instanceof Error ? error.message : String(error);
}
console.log(JSON.stringify({
  subscription: JSON.parse(subscription),
  subscriptionText: subscription,
  largeTrade,
  trade,
  orderbook,
  stale,
  outsideUniverse,
  parsedCount: parseLiveOpsUpbitWebSocketMessage(JSON.stringify([tradePayload])).length,
}));
        `,
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: minimalEnv(),
      },
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    const output = JSON.parse(result.stdout) as {
      subscription: unknown;
      subscriptionText: string;
      largeTrade: { type: string; tradeId: string };
      trade: { type: string; market: string; tradeId: string; price: string; quantity: string; side: string };
      orderbook: { type: string; market: string; asks: Array<{ price: string; size: string }>; bids: Array<{ price: string; size: string }> };
      stale: { type: string; status: string; reasonCode: string };
      outsideUniverse: string;
      parsedCount: number;
    };

    expect(output.subscription).toEqual([
      { ticket: "live-ops-market-data" },
      { type: "trade", codes: ["KRW-BTC"], is_only_realtime: true },
      { type: "orderbook", codes: ["KRW-BTC"], is_only_realtime: true },
      { format: "DEFAULT" },
    ]);
    expect(output.subscriptionText).not.toMatch(/authorization|bearer|myOrder|myAsset|\/v1\/orders/iu);
    expect(output.largeTrade).toMatchObject({
      type: "TRADE",
      tradeId: "17303368620470000123",
    });
    expect(output.trade).toMatchObject({
      type: "TRADE",
      market: "KRW-BTC",
      tradeId: "9007199254740993",
      price: "100000000",
      quantity: "0.001",
      side: "BID",
    });
    expect(output.orderbook).toMatchObject({
      type: "ORDERBOOK",
      market: "KRW-BTC",
      asks: [{ price: "100001000", size: "0.2" }],
      bids: [{ price: "100000000", size: "0.3" }],
    });
    expect(output.stale).toMatchObject({
      type: "STATUS",
      status: "STALE",
      reasonCode: "live_ops_upbit_public_lag_exceeded",
    });
    expect(output.outsideUniverse).toBe("LiveOpsMarketDataOutsideUniverse");
    expect(output.parsedCount).toBe(1);
    expect(result.stdout).not.toContain("fake-upbit-secret-key");
  });

  it("live execution helper는 단일 post-only 후보만 broker boundary로 전달한다", () => {
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `
import {
  createLiveOpsCliEntryRuntime,
  evaluateLiveOpsCliLiveExecution,
  renderLiveOpsSummary,
} from "./scripts/run-live-ops-support.mjs";

const submitted = [];
const reservations = [];
const broker = {
  async submitOrder(submission) {
    submitted.push(submission);
    return {
      brokerOrderId: "upbit-live-boundary-001",
      idempotencyKey: submission.intent.idempotencyKey,
      exchangeId: submission.intent.exchangeId,
      market: submission.intent.market,
      side: submission.intent.side,
      orderType: submission.intent.orderType,
      status: "ACCEPTED",
      requestedQuantity: submission.intent.requestedQuantity,
      remainingQuantity: submission.intent.requestedQuantity,
      requestedPrice: submission.intent.requestedPrice,
      acceptedAt: "2026-06-15T00:00:00.000Z",
      updatedAt: "2026-06-15T00:00:00.000Z",
    };
  },
};
const budgetReservation = {
  async reserve(request) {
    reservations.push({
      attemptId: request.attemptId,
      idempotencyKey: request.idempotencyKey,
      market: request.market,
      strategyId: request.strategyId,
      requestedNotionalKrw: request.requestedNotionalKrw,
    });
    return {
      reserved: true,
      reservation: {
        reservationId: "reservation-001",
        attemptId: request.attemptId,
        idempotencyKey: request.idempotencyKey,
        reservedNotionalKrw: request.requestedNotionalKrw,
        budgetSnapshot: request.budgetSnapshot,
        reservedAt: "2026-06-15T00:00:00.000Z",
      },
    };
  },
};
const config = {
  live_trading_enabled: true,
  universe: { markets: ["KRW-BTC"], default_market: "KRW-BTC" },
  budget: {
    max_order_krw: "10000",
    daily_autonomous_notional_limit_krw: "30000",
    max_open_position_notional_krw: "30000",
  },
};
const analysisDecision = {
  ready: true,
  decisionCategory: "ORDER_INTENT",
  orderIntentCount: 1,
  orderIntents: [],
};
const observedAt = "2026-06-15T00:00:00.000Z";
function orderIntentEvidence(intent) {
  return {
    exchange_id: intent.exchangeId,
    market: intent.market,
    strategy_id: intent.strategyId,
    side: intent.side,
    order_type: intent.orderType,
    post_only: intent.postOnly,
    time_in_force: intent.timeInForce,
    requested_quantity: intent.requestedQuantity,
    requested_notional: intent.requestedNotional,
    requested_price: intent.requestedPrice,
    idempotency_key: intent.idempotencyKey,
    expected_loss_bps_of_equity: intent.metadata.expected_loss_bps_of_equity ?? intent.metadata.expectedLossBpsOfEquity,
  };
}
function createCostInput() {
  return {
    expectedReturnBps: "40",
    entryFeeBps: "5",
    exitFeeBps: "5",
    spreadCostBpsP75: "2",
    expectedSlippageBpsP95: "2",
    cancelRequotePenaltyBps: "1",
    safetyBufferBps: "10",
  };
}
function createRiskInput(strategyId) {
  return {
    account: {
      equityKrw: "1000000",
      dailyRealizedPnlBps: "0",
      weeklyRealizedPnlBps: "0",
      maxDrawdownBps: "0",
      capturedAt: observedAt,
    },
    positions: [],
    strategy: {
      strategyId,
      consecutiveLosses: 0,
      capturedAt: observedAt,
    },
    infrastructureSignals: [],
    thresholdSnapshot: {
      thresholds: {
        dailyLossLimitBps: "100",
        weeklyLossLimitBps: "300",
        maxDrawdownBps: "500",
        maxOrderNotionalBpsOfEquity: "100",
        maxExpectedLossBpsOfEquity: "20",
        btcEthMaxPositionBpsOfEquity: "2000",
        altMaxPositionBpsOfEquity: "500",
        totalAltMaxPositionBpsOfEquity: "1500",
        maxConsecutiveStrategyLosses: 3,
      },
      capturedAt: observedAt,
      source: "live-ops-scripts.test",
    },
  };
}
const intent = {
  exchangeId: "upbit_krw_spot",
  market: "KRW-BTC",
  strategyId: "live_ops_fixture_strategy",
  side: "BUY",
  orderType: "LIMIT",
  requestedPrice: "100000000",
  referencePrice: "100000000",
  requestedQuantity: "0.0001",
  requestedNotional: "10000",
  idempotencyKey: "ops-aaaaaaaaaaaaaaaaaaaaaaaaaa",
  reason: "test order intent",
  postOnly: true,
  timeInForce: "POST_ONLY",
  metadata: {
    expected_loss_bps_of_equity: "5",
  },
};
intent.costInput = createCostInput();
intent.risk = createRiskInput(intent.strategyId);
intent.costSnapshot = {
  source: "cost_model",
  exchange_id: intent.exchangeId,
  market: intent.market,
  trade_allowed: true,
  reason_code: "cost_margin_ok",
  order_intent: orderIntentEvidence(intent),
};
intent.riskApproval = {
  source: "risk_gate",
  approved: true,
  action: "ALLOW",
  status: "PASS",
  failed_evaluation_reason_codes: [],
  order_intent: orderIntentEvidence(intent),
};
const executionStatus = {
  killSwitchActive: false,
  reconcileFresh: true,
  evidenceId: "execution-status-evidence",
};
const postSubmitReadiness = {
  reconcileReady: true,
  telegramReady: true,
  evidenceId: "post-submit-readiness-evidence",
};
const runtimeBudgetSnapshot = {
  maxOrderKrw: "10000",
  dailyAutonomousNotionalLimitKrw: "30000",
  dailyAutonomousNotionalUsedKrw: "0",
  openPositionNotionalKrw: "0",
  maxOpenPositionNotionalKrw: "30000",
  capturedAt: observedAt,
};
const runtimeLossSnapshot = {
  dailyRealizedLossKrw: "0",
  weeklyRealizedLossKrw: "0",
  capturedAt: observedAt,
};
const summary = await evaluateLiveOpsCliLiveExecution({
  config,
  fixtureSmoke: false,
  analysisDecision,
  marketData: {
    ready: true,
    latestHeartbeatAt: "2026-06-15T00:00:00.000Z",
  },
  env: {
    SEEMIRAI_UPBIT_ACCESS_KEY: "fake-access-key",
    SEEMIRAI_UPBIT_SECRET_KEY: "fake-secret-key",
    SEEMIRAI_UPBIT_KEY_SCOPE: "자산조회,주문조회,주문하기",
    SEEMIRAI_UPBIT_KEY_SCOPE_EVIDENCE_ID: "scope-evidence",
  },
  orderIntents: [intent],
  entryRuntime: createLiveOpsCliEntryRuntime({ broker, budgetReservation }),
  executionStatus,
  postSubmitReadiness,
  budgetSnapshot: runtimeBudgetSnapshot,
  lossSnapshot: runtimeLossSnapshot,
});
const submittedWithoutReservation = [];
const blockedSummary = await evaluateLiveOpsCliLiveExecution({
  config,
  fixtureSmoke: false,
  analysisDecision,
  marketData: {
    ready: true,
    latestHeartbeatAt: "2026-06-15T00:00:00.000Z",
  },
  env: {
    SEEMIRAI_UPBIT_ACCESS_KEY: "fake-access-key",
    SEEMIRAI_UPBIT_SECRET_KEY: "fake-secret-key",
    SEEMIRAI_UPBIT_KEY_SCOPE: "자산조회,주문조회,주문하기",
    SEEMIRAI_UPBIT_KEY_SCOPE_EVIDENCE_ID: "scope-evidence",
  },
  orderIntents: [intent],
  entryRuntime: createLiveOpsCliEntryRuntime({
    broker: {
      async submitOrder(submission) {
        submittedWithoutReservation.push(submission);
        return {
          brokerOrderId: "unexpected-order",
        };
      },
    },
  }),
  executionStatus,
  postSubmitReadiness,
  budgetSnapshot: runtimeBudgetSnapshot,
  lossSnapshot: runtimeLossSnapshot,
});
const submittedWithoutRisk = [];
const riskBlockedSummary = await evaluateLiveOpsCliLiveExecution({
  config,
  fixtureSmoke: false,
  analysisDecision,
  marketData: {
    ready: true,
    latestHeartbeatAt: "2026-06-15T00:00:00.000Z",
  },
  env: {
    SEEMIRAI_UPBIT_ACCESS_KEY: "fake-access-key",
    SEEMIRAI_UPBIT_SECRET_KEY: "fake-secret-key",
    SEEMIRAI_UPBIT_KEY_SCOPE: "자산조회,주문조회,주문하기",
    SEEMIRAI_UPBIT_KEY_SCOPE_EVIDENCE_ID: "scope-evidence",
  },
  orderIntents: [
    {
      ...intent,
      riskApproval: undefined,
    },
  ],
  entryRuntime: createLiveOpsCliEntryRuntime({
    broker: {
      async submitOrder(submission) {
        submittedWithoutRisk.push(submission);
        return {
          brokerOrderId: "unexpected-riskless-order",
        };
      },
    },
    budgetReservation,
  }),
  executionStatus,
  postSubmitReadiness,
  budgetSnapshot: runtimeBudgetSnapshot,
  lossSnapshot: runtimeLossSnapshot,
});
const submittedWithoutStatus = [];
const statusBlockedSummary = await evaluateLiveOpsCliLiveExecution({
  config,
  fixtureSmoke: false,
  analysisDecision,
  marketData: {
    ready: true,
    latestHeartbeatAt: "2026-06-15T00:00:00.000Z",
  },
  env: {
    SEEMIRAI_UPBIT_ACCESS_KEY: "fake-access-key",
    SEEMIRAI_UPBIT_SECRET_KEY: "fake-secret-key",
    SEEMIRAI_UPBIT_KEY_SCOPE: "자산조회,주문조회,주문하기",
    SEEMIRAI_UPBIT_KEY_SCOPE_EVIDENCE_ID: "scope-evidence",
  },
  orderIntents: [intent],
  entryRuntime: createLiveOpsCliEntryRuntime({
    broker: {
      async submitOrder(submission) {
        submittedWithoutStatus.push(submission);
        return {
          brokerOrderId: "unexpected-statusless-order",
        };
      },
    },
    budgetReservation,
  }),
  budgetSnapshot: runtimeBudgetSnapshot,
  lossSnapshot: runtimeLossSnapshot,
});
const submittedWithoutReservationEvidence = [];
const reservationEvidenceBlockedSummary = await evaluateLiveOpsCliLiveExecution({
  config,
  fixtureSmoke: false,
  analysisDecision,
  marketData: {
    ready: true,
    latestHeartbeatAt: "2026-06-15T00:00:00.000Z",
  },
  env: {
    SEEMIRAI_UPBIT_ACCESS_KEY: "fake-access-key",
    SEEMIRAI_UPBIT_SECRET_KEY: "fake-secret-key",
    SEEMIRAI_UPBIT_KEY_SCOPE: "자산조회,주문조회,주문하기",
    SEEMIRAI_UPBIT_KEY_SCOPE_EVIDENCE_ID: "scope-evidence",
  },
  orderIntents: [intent],
  entryRuntime: createLiveOpsCliEntryRuntime({
    broker: {
      async submitOrder(submission) {
        submittedWithoutReservationEvidence.push(submission);
        return {
          brokerOrderId: "unexpected-reservationless-order",
        };
      },
    },
    budgetReservation: {
      async reserve() {
        return {
          reserved: true,
        };
      },
    },
  }),
  executionStatus,
  postSubmitReadiness,
  budgetSnapshot: runtimeBudgetSnapshot,
  lossSnapshot: runtimeLossSnapshot,
});
const staleEvidence = {
  ...orderIntentEvidence(intent),
  post_only: false,
  time_in_force: "GTC",
};
const submittedWithStaleEvidence = [];
const staleEvidenceSummary = await evaluateLiveOpsCliLiveExecution({
  config,
  fixtureSmoke: false,
  analysisDecision,
  marketData: {
    ready: true,
    latestHeartbeatAt: "2026-06-15T00:00:00.000Z",
  },
  env: {
    SEEMIRAI_UPBIT_ACCESS_KEY: "fake-access-key",
    SEEMIRAI_UPBIT_SECRET_KEY: "fake-secret-key",
    SEEMIRAI_UPBIT_KEY_SCOPE: "자산조회,주문조회,주문하기",
    SEEMIRAI_UPBIT_KEY_SCOPE_EVIDENCE_ID: "scope-evidence",
  },
  orderIntents: [
    {
      ...intent,
      costSnapshot: {
        ...intent.costSnapshot,
        order_intent: staleEvidence,
      },
      riskApproval: {
        ...intent.riskApproval,
        order_intent: staleEvidence,
      },
    },
  ],
  entryRuntime: createLiveOpsCliEntryRuntime({
    broker: {
      async submitOrder(submission) {
        submittedWithStaleEvidence.push(submission);
        return {
          brokerOrderId: "unexpected-stale-evidence-order",
        };
      },
    },
    budgetReservation,
  }),
  executionStatus,
  postSubmitReadiness,
  budgetSnapshot: runtimeBudgetSnapshot,
  lossSnapshot: runtimeLossSnapshot,
});
function createRuntimeRequest(overrides = {}) {
  return {
    config: {
      enabled: true,
      allowed_markets: ["KRW-BTC"],
      max_order_krw: "10000",
      daily_autonomous_notional_limit_krw: "30000",
      max_open_position_notional_krw: "30000",
      max_daily_loss_krw: "10000",
      max_weekly_loss_krw: "30000",
      max_price_deviation_bps: "30",
      identifier_prefix: "ops-",
      identifier_max_length: 32,
    },
    candidate: {
      exchangeId: intent.exchangeId,
      market: intent.market,
      strategyId: intent.strategyId,
      requestedQuantity: intent.requestedQuantity,
      requestedNotional: intent.requestedNotional,
      requestedPrice: intent.requestedPrice,
      referencePrice: intent.referencePrice,
      reason: intent.reason,
      expectedLossBpsOfEquity: intent.metadata.expected_loss_bps_of_equity,
      orderType: "LIMIT",
      postOnly: true,
      timeInForce: "POST_ONLY",
      costInput: intent.costInput,
      risk: intent.risk,
      costSnapshot: intent.costSnapshot,
      riskApproval: intent.riskApproval,
      metadata: intent.metadata,
    },
    budgetSnapshot: {
      maxOrderKrw: "10000",
      dailyAutonomousNotionalLimitKrw: "30000",
      dailyAutonomousNotionalUsedKrw: "0",
      openPositionNotionalKrw: "0",
      maxOpenPositionNotionalKrw: "30000",
      capturedAt: "2026-06-15T00:00:00.000Z",
    },
    lossSnapshot: {
      dailyRealizedLossKrw: "0",
      weeklyRealizedLossKrw: "0",
      capturedAt: "2026-06-15T00:00:00.000Z",
    },
    killSwitchActive: false,
    reconcileFresh: true,
    executionStatusEvidenceId: "execution-status-evidence",
    postSubmitReconcileReady: true,
    postSubmitTelegramReady: true,
    postSubmitReadinessEvidenceId: "post-submit-readiness-evidence",
    idempotencyKey: intent.idempotencyKey,
    observedAt: "2026-06-15T00:00:00.000Z",
    ...overrides,
  };
}
const submittedWithDirectKillSwitch = [];
const directKillSwitchResult = await createLiveOpsCliEntryRuntime({
  broker: {
    async submitOrder(submission) {
      submittedWithDirectKillSwitch.push(submission);
      return {
        brokerOrderId: "unexpected-kill-switch-order",
      };
    },
  },
  budgetReservation,
}).submitEntryCandidate(createRuntimeRequest({ killSwitchActive: true }));
const submittedWithMissingStatusEvidence = [];
const directMissingStatusEvidenceResult = await createLiveOpsCliEntryRuntime({
  broker: {
    async submitOrder(submission) {
      submittedWithMissingStatusEvidence.push(submission);
      return {
        brokerOrderId: "unexpected-missing-status-evidence-order",
      };
    },
  },
  budgetReservation,
}).submitEntryCandidate(createRuntimeRequest({ executionStatusEvidenceId: undefined }));
const submittedWithMissingPostSubmitReadiness = [];
const directMissingPostSubmitReadinessResult = await createLiveOpsCliEntryRuntime({
  broker: {
    async submitOrder(submission) {
      submittedWithMissingPostSubmitReadiness.push(submission);
      return {
        brokerOrderId: "unexpected-missing-post-submit-readiness-order",
      };
    },
  },
  budgetReservation,
}).submitEntryCandidate(createRuntimeRequest({
  postSubmitTelegramReady: false,
  postSubmitReadinessEvidenceId: undefined,
}));
const directInvalidCostInputRequest = createRuntimeRequest();
directInvalidCostInputRequest.candidate = {
  ...directInvalidCostInputRequest.candidate,
  costInput: {
    ...createCostInput(),
    entryFeeBps: "-10",
    expectedSlippageBpsP95: "abc",
  },
};
const submittedWithInvalidCostInput = [];
const directInvalidCostInputResult = await createLiveOpsCliEntryRuntime({
  broker: {
    async submitOrder(submission) {
      submittedWithInvalidCostInput.push(submission);
      return {
        brokerOrderId: "unexpected-invalid-cost-input-order",
      };
    },
  },
  budgetReservation,
}).submitEntryCandidate(directInvalidCostInputRequest);
const directInvalidMarketRequest = createRuntimeRequest();
directInvalidMarketRequest.candidate = {
  ...directInvalidMarketRequest.candidate,
  market: "KRW-ETH",
};
const submittedWithInvalidMarket = [];
const directInvalidMarketResult = await createLiveOpsCliEntryRuntime({
  broker: {
    async submitOrder(submission) {
      submittedWithInvalidMarket.push(submission);
      return {
        brokerOrderId: "unexpected-invalid-market-order",
      };
    },
  },
  budgetReservation,
}).submitEntryCandidate(directInvalidMarketRequest);
const directMismatchNotionalRequest = createRuntimeRequest();
directMismatchNotionalRequest.candidate = {
  ...directMismatchNotionalRequest.candidate,
  requestedPrice: "200000000",
  requestedQuantity: "0.0001",
  requestedNotional: "10000",
};
const submittedWithMismatchNotional = [];
const directMismatchNotionalResult = await createLiveOpsCliEntryRuntime({
  broker: {
    async submitOrder(submission) {
      submittedWithMismatchNotional.push(submission);
      return {
        brokerOrderId: "unexpected-mismatch-notional-order",
      };
    },
  },
  budgetReservation,
}).submitEntryCandidate(directMismatchNotionalRequest);
const directBelowMinimumNotionalRequest = createRuntimeRequest();
directBelowMinimumNotionalRequest.candidate = {
  ...directBelowMinimumNotionalRequest.candidate,
  requestedPrice: "40000000",
  requestedQuantity: "0.0001",
  requestedNotional: "4000",
};
const submittedWithBelowMinimumNotional = [];
const directBelowMinimumNotionalResult = await createLiveOpsCliEntryRuntime({
  broker: {
    async submitOrder(submission) {
      submittedWithBelowMinimumNotional.push(submission);
      return {
        brokerOrderId: "unexpected-below-minimum-notional-order",
      };
    },
  },
  budgetReservation,
}).submitEntryCandidate(directBelowMinimumNotionalRequest);
const directLossLimitRequest = createRuntimeRequest({
  lossSnapshot: {
    dailyRealizedLossKrw: "10001",
    weeklyRealizedLossKrw: "0",
    capturedAt: observedAt,
  },
});
const submittedWithLossLimit = [];
const directLossLimitResult = await createLiveOpsCliEntryRuntime({
  broker: {
    async submitOrder(submission) {
      submittedWithLossLimit.push(submission);
      return {
        brokerOrderId: "unexpected-loss-limit-order",
      };
    },
  },
  budgetReservation,
}).submitEntryCandidate(directLossLimitRequest);
const directPriceDeviationRequest = createRuntimeRequest();
directPriceDeviationRequest.candidate = {
  ...directPriceDeviationRequest.candidate,
  requestedPrice: "99000000",
  referencePrice: "100000000",
  requestedQuantity: "0.0001",
  requestedNotional: "9900",
};
const submittedWithPriceDeviation = [];
const directPriceDeviationResult = await createLiveOpsCliEntryRuntime({
  broker: {
    async submitOrder(submission) {
      submittedWithPriceDeviation.push(submission);
      return {
        brokerOrderId: "unexpected-price-deviation-order",
      };
    },
  },
  budgetReservation,
}).submitEntryCandidate(directPriceDeviationRequest);
const directBudgetLimitRequest = createRuntimeRequest({
  budgetSnapshot: {
    maxOrderKrw: "10000",
    dailyAutonomousNotionalLimitKrw: "30000",
    dailyAutonomousNotionalUsedKrw: "25000",
    openPositionNotionalKrw: "25000",
    maxOpenPositionNotionalKrw: "30000",
    capturedAt: observedAt,
  },
});
const submittedWithBudgetLimit = [];
const directBudgetLimitResult = await createLiveOpsCliEntryRuntime({
  broker: {
    async submitOrder(submission) {
      submittedWithBudgetLimit.push(submission);
      return {
        brokerOrderId: "unexpected-budget-limit-order",
      };
    },
  },
  budgetReservation,
}).submitEntryCandidate(directBudgetLimitRequest);
const directSnapshotMaxOrderLimitRequest = createRuntimeRequest({
  budgetSnapshot: {
    maxOrderKrw: "5000",
    dailyAutonomousNotionalLimitKrw: "30000",
    dailyAutonomousNotionalUsedKrw: "0",
    openPositionNotionalKrw: "0",
    maxOpenPositionNotionalKrw: "30000",
    capturedAt: observedAt,
  },
});
const submittedWithSnapshotMaxOrderLimit = [];
const directSnapshotMaxOrderLimitResult = await createLiveOpsCliEntryRuntime({
  broker: {
    async submitOrder(submission) {
      submittedWithSnapshotMaxOrderLimit.push(submission);
      return {
        brokerOrderId: "unexpected-snapshot-max-order-limit-order",
      };
    },
  },
  budgetReservation,
}).submitEntryCandidate(directSnapshotMaxOrderLimitRequest);
const directReservationExceptionResult = await createLiveOpsCliEntryRuntime({
  broker: {
    async submitOrder() {
      return {
        brokerOrderId: "unexpected-reservation-exception-order",
      };
    },
  },
  budgetReservation: {
    async reserve() {
      throw new Error("ReservationUnavailable");
    },
  },
}).submitEntryCandidate(createRuntimeRequest());
const directBrokerExceptionResult = await createLiveOpsCliEntryRuntime({
  broker: {
    async submitOrder() {
      throw new Error("BrokerTimeout");
    },
  },
  budgetReservation,
}).submitEntryCandidate(createRuntimeRequest());
const directBrokerEvidenceMissingResult = await createLiveOpsCliEntryRuntime({
  broker: {
    async submitOrder() {
      return {};
    },
  },
  budgetReservation,
}).submitEntryCandidate(createRuntimeRequest());
const directBrokerStatusMissingResult = await createLiveOpsCliEntryRuntime({
  broker: {
    async submitOrder() {
      return {
        brokerOrderId: "status-missing-live-order-001",
      };
    },
  },
  budgetReservation,
}).submitEntryCandidate(createRuntimeRequest());
const directBrokerRejectedResult = await createLiveOpsCliEntryRuntime({
  broker: {
    async submitOrder(submission) {
      return {
        brokerOrderId: "rejected-live-order-001",
        idempotencyKey: submission.intent.idempotencyKey,
        market: submission.intent.market,
        status: "REJECTED",
      };
    },
  },
  budgetReservation,
}).submitEntryCandidate(createRuntimeRequest());
const directBrokerPortMissingResult = await createLiveOpsCliEntryRuntime({
  budgetReservation,
}).submitEntryCandidate(createRuntimeRequest());
const directCostRegressionRequest = createRuntimeRequest();
directCostRegressionRequest.candidate = {
  ...directCostRegressionRequest.candidate,
  costInput: {
    ...createCostInput(),
    expectedReturnBps: "10",
  },
};
const submittedWithCostRegression = [];
const directCostRegressionResult = await createLiveOpsCliEntryRuntime({
  broker: {
    async submitOrder(submission) {
      submittedWithCostRegression.push(submission);
      return {
        brokerOrderId: "unexpected-cost-regression-order",
      };
    },
  },
  budgetReservation,
}).submitEntryCandidate(directCostRegressionRequest);
const directRiskRegressionRequest = createRuntimeRequest();
directRiskRegressionRequest.candidate = {
  ...directRiskRegressionRequest.candidate,
  risk: {
    ...directRiskRegressionRequest.candidate.risk,
    thresholdSnapshot: {
      ...directRiskRegressionRequest.candidate.risk.thresholdSnapshot,
      thresholds: {
        ...directRiskRegressionRequest.candidate.risk.thresholdSnapshot.thresholds,
        maxExpectedLossBpsOfEquity: "4",
      },
    },
  },
};
const submittedWithRiskRegression = [];
const directRiskRegressionResult = await createLiveOpsCliEntryRuntime({
  broker: {
    async submitOrder(submission) {
      submittedWithRiskRegression.push(submission);
      return {
        brokerOrderId: "unexpected-risk-regression-order",
      };
    },
  },
  budgetReservation,
}).submitEntryCandidate(directRiskRegressionRequest);
const directDefaultSafetyBufferRequest = createRuntimeRequest();
directDefaultSafetyBufferRequest.candidate = {
  ...directDefaultSafetyBufferRequest.candidate,
  costInput: {
    ...createCostInput(),
    expectedReturnBps: "20",
  },
};
delete directDefaultSafetyBufferRequest.candidate.costInput.safetyBufferBps;
const submittedWithDefaultSafetyBufferGap = [];
const directDefaultSafetyBufferResult = await createLiveOpsCliEntryRuntime({
  broker: {
    async submitOrder(submission) {
      submittedWithDefaultSafetyBufferGap.push(submission);
      return {
        brokerOrderId: "unexpected-default-safety-buffer-order",
      };
    },
  },
  budgetReservation,
}).submitEntryCandidate(directDefaultSafetyBufferRequest);
const directInfrastructureRiskRequest = createRuntimeRequest();
directInfrastructureRiskRequest.candidate = {
  ...directInfrastructureRiskRequest.candidate,
  risk: {
    ...directInfrastructureRiskRequest.candidate.risk,
    infrastructureSignals: [
      {
        signal: "DB_WRITE_FAILURE",
        observedAt,
      },
    ],
  },
};
const submittedWithInfrastructureRisk = [];
const directInfrastructureRiskResult = await createLiveOpsCliEntryRuntime({
  broker: {
    async submitOrder(submission) {
      submittedWithInfrastructureRisk.push(submission);
      return {
        brokerOrderId: "unexpected-infrastructure-risk-order",
      };
    },
  },
  budgetReservation,
}).submitEntryCandidate(directInfrastructureRiskRequest);
const directNumericDecimalRequest = createRuntimeRequest();
directNumericDecimalRequest.candidate = {
  ...directNumericDecimalRequest.candidate,
  requestedPrice: 100000000,
};
const submittedWithNumericDecimal = [];
const directNumericDecimalResult = await createLiveOpsCliEntryRuntime({
  broker: {
    async submitOrder(submission) {
      submittedWithNumericDecimal.push(submission);
      return {
        brokerOrderId: "unexpected-numeric-decimal-order",
      };
    },
  },
  budgetReservation,
}).submitEntryCandidate(directNumericDecimalRequest);
const strategyDecisionKey = "live_ops_fixture_strategy:upbit_krw_spot:KRW-BTC:BUY:2026-06-15T00:00:00.000Z";
const strategyKeyIntent = {
  ...intent,
  idempotencyKey: strategyDecisionKey,
  timeInForce: "POST_ONLY",
};
strategyKeyIntent.costSnapshot = {
  ...intent.costSnapshot,
  order_intent: orderIntentEvidence(strategyKeyIntent),
};
strategyKeyIntent.riskApproval = {
  ...intent.riskApproval,
  order_intent: orderIntentEvidence(strategyKeyIntent),
};
const submittedWithStrategyWrapper = [];
const strategyWrapperReservations = [];
const strategyKeyWrapperSummary = await evaluateLiveOpsCliLiveExecution({
  config,
  fixtureSmoke: false,
  analysisDecision,
  marketData: {
    ready: true,
    latestHeartbeatAt: observedAt,
  },
  env: {
    SEEMIRAI_UPBIT_ACCESS_KEY: "fake-access-key",
    SEEMIRAI_UPBIT_SECRET_KEY: "fake-secret-key",
    SEEMIRAI_UPBIT_KEY_SCOPE: "자산조회,주문조회,주문하기",
    SEEMIRAI_UPBIT_KEY_SCOPE_EVIDENCE_ID: "scope-evidence",
  },
  orderIntents: [strategyKeyIntent],
  entryRuntime: createLiveOpsCliEntryRuntime({
    broker: {
      async submitOrder(submission) {
        submittedWithStrategyWrapper.push(submission);
        return {
          brokerOrderId: "strategy-wrapper-live-order-001",
          status: "ACCEPTED",
        };
      },
    },
    budgetReservation: {
      async reserve(request) {
        strategyWrapperReservations.push(request);
        return {
          reserved: true,
          reservation: {
            reservationId: "strategy-wrapper-reservation-001",
            attemptId: request.attemptId,
            idempotencyKey: request.idempotencyKey,
            reservedNotionalKrw: request.requestedNotionalKrw,
            budgetSnapshot: request.budgetSnapshot,
            reservedAt: observedAt,
          },
        };
      },
    },
  }),
  executionStatus,
  postSubmitReadiness,
  budgetSnapshot: runtimeBudgetSnapshot,
  lossSnapshot: runtimeLossSnapshot,
});
const runtimeRequests = [];
const usedBudgetSnapshot = {
  maxOrderKrw: "10000",
  dailyAutonomousNotionalLimitKrw: "30000",
  dailyAutonomousNotionalUsedKrw: "1234.5",
  openPositionNotionalKrw: "5678.9",
  maxOpenPositionNotionalKrw: "30000",
  capturedAt: observedAt,
};
const usedLossSnapshot = {
  dailyRealizedLossKrw: "111.1",
  weeklyRealizedLossKrw: "222.2",
  capturedAt: observedAt,
};
const strategyKeySummary = await evaluateLiveOpsCliLiveExecution({
  config,
  fixtureSmoke: false,
  analysisDecision,
  marketData: {
    ready: true,
    latestHeartbeatAt: observedAt,
  },
  env: {
    SEEMIRAI_UPBIT_ACCESS_KEY: "fake-access-key",
    SEEMIRAI_UPBIT_SECRET_KEY: "fake-secret-key",
    SEEMIRAI_UPBIT_KEY_SCOPE: "자산조회,주문조회,주문하기",
    SEEMIRAI_UPBIT_KEY_SCOPE_EVIDENCE_ID: "scope-evidence",
  },
  orderIntents: [strategyKeyIntent],
  entryRuntime: {
    async submitEntryCandidate(request) {
      runtimeRequests.push(request);
      return {
        status: "SUBMITTED",
        attemptId: request.idempotencyKey,
        idempotencyKey: request.idempotencyKey,
        brokerOrderId: "strategy-key-live-order-001",
        message: "strategy key fixture submitted",
        action: "fixture action",
        violations: [],
        events: [],
        trace: {
          reason: "broker_submitted",
        },
        executionResult: {
          brokerOrder: {
            brokerOrderId: "strategy-key-live-order-001",
          },
        },
      };
    },
  },
  executionStatus,
  postSubmitReadiness,
  budgetSnapshot: usedBudgetSnapshot,
  lossSnapshot: usedLossSnapshot,
});
const decimalIntent = {
  ...intent,
  requestedNotional: "10000.0",
  requestedPrice: "100000000.0",
  requestedQuantity: "0.00010000",
};
decimalIntent.costInput = createCostInput();
decimalIntent.risk = createRiskInput(decimalIntent.strategyId);
decimalIntent.costSnapshot = {
  ...intent.costSnapshot,
  order_intent: {
    ...orderIntentEvidence(decimalIntent),
    requested_price: "100000000",
    requested_quantity: "0.0001",
    requested_notional: "10000",
  },
};
decimalIntent.riskApproval = {
  ...intent.riskApproval,
  order_intent: {
    ...orderIntentEvidence(decimalIntent),
    requested_price: "100000000",
    requested_quantity: "0.0001",
    requested_notional: "10000",
  },
};
const submittedWithDecimalEvidence = [];
const normalizedDecimalReservations = [];
const decimalEvidenceSummary = await evaluateLiveOpsCliLiveExecution({
  config,
  fixtureSmoke: false,
  analysisDecision,
  marketData: {
    ready: true,
    latestHeartbeatAt: observedAt,
  },
  env: {
    SEEMIRAI_UPBIT_ACCESS_KEY: "fake-access-key",
    SEEMIRAI_UPBIT_SECRET_KEY: "fake-secret-key",
    SEEMIRAI_UPBIT_KEY_SCOPE: "자산조회,주문조회,주문하기",
    SEEMIRAI_UPBIT_KEY_SCOPE_EVIDENCE_ID: "scope-evidence",
  },
  orderIntents: [decimalIntent],
  entryRuntime: createLiveOpsCliEntryRuntime({
    broker: {
      async submitOrder(submission) {
        submittedWithDecimalEvidence.push(submission);
        return {
          brokerOrderId: "decimal-evidence-live-order-001",
          status: "ACCEPTED",
        };
      },
    },
    budgetReservation: {
      async reserve(request) {
        normalizedDecimalReservations.push(request);
        return {
          reserved: true,
          reservation: {
            reservationId: "decimal-reservation-001",
            attemptId: request.attemptId,
            idempotencyKey: request.idempotencyKey,
            reservedNotionalKrw: "10000",
            budgetSnapshot: request.budgetSnapshot,
            reservedAt: observedAt,
          },
        };
      },
    },
  }),
  executionStatus,
  postSubmitReadiness,
  budgetSnapshot: runtimeBudgetSnapshot,
  lossSnapshot: runtimeLossSnapshot,
});
const camelExpectedLossIntent = {
  ...intent,
  metadata: {
    expectedLossBpsOfEquity: "5",
  },
  costInput: {
    ...createCostInput(),
  },
};
delete camelExpectedLossIntent.costInput.safetyBufferBps;
camelExpectedLossIntent.risk = createRiskInput(camelExpectedLossIntent.strategyId);
camelExpectedLossIntent.costSnapshot = {
  ...intent.costSnapshot,
  order_intent: orderIntentEvidence(camelExpectedLossIntent),
};
camelExpectedLossIntent.riskApproval = {
  ...intent.riskApproval,
  order_intent: orderIntentEvidence(camelExpectedLossIntent),
};
const camelRuntimeRequests = [];
const camelExpectedLossSummary = await evaluateLiveOpsCliLiveExecution({
  config,
  fixtureSmoke: false,
  analysisDecision,
  marketData: {
    ready: true,
    latestHeartbeatAt: observedAt,
  },
  env: {
    SEEMIRAI_UPBIT_ACCESS_KEY: "fake-access-key",
    SEEMIRAI_UPBIT_SECRET_KEY: "fake-secret-key",
    SEEMIRAI_UPBIT_KEY_SCOPE: "자산조회,주문조회,주문하기",
    SEEMIRAI_UPBIT_KEY_SCOPE_EVIDENCE_ID: "scope-evidence",
  },
  orderIntents: [camelExpectedLossIntent],
  entryRuntime: {
    async submitEntryCandidate(request) {
      camelRuntimeRequests.push(request);
      return {
        status: "SUBMITTED",
        attemptId: request.idempotencyKey,
        idempotencyKey: request.idempotencyKey,
        brokerOrderId: "camel-expected-loss-live-order-001",
        message: "camel expected loss fixture submitted",
        action: "fixture action",
        violations: [],
        events: [],
        trace: {
          reason: "broker_submitted",
        },
        executionResult: {
          brokerOrder: {
            brokerOrderId: "camel-expected-loss-live-order-001",
          },
        },
      };
    },
  },
  executionStatus,
  postSubmitReadiness,
  budgetSnapshot: runtimeBudgetSnapshot,
  lossSnapshot: runtimeLossSnapshot,
});
const zeroCostInputIntent = {
  ...intent,
  costInput: {
    ...createCostInput(),
    spreadCostBpsP75: "0",
    expectedSlippageBpsP95: "0",
    cancelRequotePenaltyBps: "0",
  },
};
zeroCostInputIntent.risk = createRiskInput(zeroCostInputIntent.strategyId);
zeroCostInputIntent.costSnapshot = {
  ...intent.costSnapshot,
  order_intent: orderIntentEvidence(zeroCostInputIntent),
};
zeroCostInputIntent.riskApproval = {
  ...intent.riskApproval,
  order_intent: orderIntentEvidence(zeroCostInputIntent),
};
const zeroCostRuntimeRequests = [];
const zeroCostInputSummary = await evaluateLiveOpsCliLiveExecution({
  config,
  fixtureSmoke: false,
  analysisDecision,
  marketData: {
    ready: true,
    latestHeartbeatAt: observedAt,
  },
  env: {
    SEEMIRAI_UPBIT_ACCESS_KEY: "fake-access-key",
    SEEMIRAI_UPBIT_SECRET_KEY: "fake-secret-key",
    SEEMIRAI_UPBIT_KEY_SCOPE: "자산조회,주문조회,주문하기",
    SEEMIRAI_UPBIT_KEY_SCOPE_EVIDENCE_ID: "scope-evidence",
  },
  orderIntents: [zeroCostInputIntent],
  entryRuntime: {
    async submitEntryCandidate(request) {
      zeroCostRuntimeRequests.push(request);
      return {
        status: "SUBMITTED",
        attemptId: request.idempotencyKey,
        idempotencyKey: request.idempotencyKey,
        brokerOrderId: "zero-cost-input-live-order-001",
        message: "zero cost input fixture submitted",
        action: "fixture action",
        violations: [],
        events: [],
        trace: {
          reason: "broker_submitted",
        },
        executionResult: {
          brokerOrder: {
            brokerOrderId: "zero-cost-input-live-order-001",
          },
        },
      };
    },
  },
  executionStatus,
  postSubmitReadiness,
  budgetSnapshot: runtimeBudgetSnapshot,
  lossSnapshot: runtimeLossSnapshot,
});
const zeroExpectedLossIntent = {
  ...intent,
  metadata: {
    expected_loss_bps_of_equity: "0",
  },
};
zeroExpectedLossIntent.risk = createRiskInput(zeroExpectedLossIntent.strategyId);
zeroExpectedLossIntent.costSnapshot = {
  ...intent.costSnapshot,
  order_intent: orderIntentEvidence(zeroExpectedLossIntent),
};
zeroExpectedLossIntent.riskApproval = {
  ...intent.riskApproval,
  order_intent: orderIntentEvidence(zeroExpectedLossIntent),
};
const zeroExpectedLossRuntimeRequests = [];
const zeroExpectedLossSummary = await evaluateLiveOpsCliLiveExecution({
  config,
  fixtureSmoke: false,
  analysisDecision,
  marketData: {
    ready: true,
    latestHeartbeatAt: observedAt,
  },
  env: {
    SEEMIRAI_UPBIT_ACCESS_KEY: "fake-access-key",
    SEEMIRAI_UPBIT_SECRET_KEY: "fake-secret-key",
    SEEMIRAI_UPBIT_KEY_SCOPE: "자산조회,주문조회,주문하기",
    SEEMIRAI_UPBIT_KEY_SCOPE_EVIDENCE_ID: "scope-evidence",
  },
  orderIntents: [zeroExpectedLossIntent],
  entryRuntime: {
    async submitEntryCandidate(request) {
      zeroExpectedLossRuntimeRequests.push(request);
      return {
        status: "SUBMITTED",
        attemptId: request.idempotencyKey,
        idempotencyKey: request.idempotencyKey,
        brokerOrderId: "zero-expected-loss-live-order-001",
        message: "zero expected loss fixture submitted",
        action: "fixture action",
        violations: [],
        events: [],
        trace: {
          reason: "broker_submitted",
        },
        executionResult: {
          brokerOrder: {
            brokerOrderId: "zero-expected-loss-live-order-001",
          },
        },
      };
    },
  },
  executionStatus,
  postSubmitReadiness,
  budgetSnapshot: runtimeBudgetSnapshot,
  lossSnapshot: runtimeLossSnapshot,
});
const marketReferenceIntent = {
  ...intent,
};
delete marketReferenceIntent.referencePrice;
marketReferenceIntent.costSnapshot = {
  ...intent.costSnapshot,
  order_intent: orderIntentEvidence(marketReferenceIntent),
};
marketReferenceIntent.riskApproval = {
  ...intent.riskApproval,
  order_intent: orderIntentEvidence(marketReferenceIntent),
};
const marketReferenceRuntimeRequests = [];
const marketReferenceSummary = await evaluateLiveOpsCliLiveExecution({
  config,
  fixtureSmoke: false,
  analysisDecision,
  marketData: {
    ready: true,
    latestHeartbeatAt: observedAt,
    referencePrice: "100000000",
    referencePriceSource: "fixture_trade",
  },
  env: {
    SEEMIRAI_UPBIT_ACCESS_KEY: "fake-access-key",
    SEEMIRAI_UPBIT_SECRET_KEY: "fake-secret-key",
    SEEMIRAI_UPBIT_KEY_SCOPE: "자산조회,주문조회,주문하기",
    SEEMIRAI_UPBIT_KEY_SCOPE_EVIDENCE_ID: "scope-evidence",
  },
  orderIntents: [marketReferenceIntent],
  entryRuntime: {
    async submitEntryCandidate(request) {
      marketReferenceRuntimeRequests.push(request);
      return {
        status: "SUBMITTED",
        attemptId: request.idempotencyKey,
        idempotencyKey: request.idempotencyKey,
        brokerOrderId: "market-reference-live-order-001",
        message: "market reference fixture submitted",
        action: "fixture action",
        violations: [],
        events: [],
        trace: {
          reason: "broker_submitted",
        },
        executionResult: {
          brokerOrder: {
            brokerOrderId: "market-reference-live-order-001",
          },
        },
      };
    },
  },
  executionStatus,
  postSubmitReadiness,
  budgetSnapshot: runtimeBudgetSnapshot,
  lossSnapshot: runtimeLossSnapshot,
});
const submittedWithoutReferencePrice = [];
const missingReferencePriceSummary = await evaluateLiveOpsCliLiveExecution({
  config,
  fixtureSmoke: false,
  analysisDecision,
  marketData: {
    ready: true,
    latestHeartbeatAt: observedAt,
  },
  env: {
    SEEMIRAI_UPBIT_ACCESS_KEY: "fake-access-key",
    SEEMIRAI_UPBIT_SECRET_KEY: "fake-secret-key",
    SEEMIRAI_UPBIT_KEY_SCOPE: "자산조회,주문조회,주문하기",
    SEEMIRAI_UPBIT_KEY_SCOPE_EVIDENCE_ID: "scope-evidence",
  },
  orderIntents: [marketReferenceIntent],
  entryRuntime: {
    async submitEntryCandidate(request) {
      submittedWithoutReferencePrice.push(request);
      return {
        status: "SUBMITTED",
        attemptId: request.idempotencyKey,
        idempotencyKey: request.idempotencyKey,
        brokerOrderId: "unexpected-missing-reference-price-order",
        message: "unexpected missing reference price submit",
        action: "fixture action",
        violations: [],
        events: [],
      };
    },
  },
  executionStatus,
  postSubmitReadiness,
  budgetSnapshot: runtimeBudgetSnapshot,
  lossSnapshot: runtimeLossSnapshot,
});
const missingRuntimeSummary = await evaluateLiveOpsCliLiveExecution({
  config,
  fixtureSmoke: false,
  analysisDecision,
  marketData: {
    ready: true,
    latestHeartbeatAt: observedAt,
  },
  env: {
    SEEMIRAI_UPBIT_ACCESS_KEY: "fake-access-key",
    SEEMIRAI_UPBIT_SECRET_KEY: "fake-secret-key",
    SEEMIRAI_UPBIT_KEY_SCOPE: "자산조회,주문조회,주문하기",
    SEEMIRAI_UPBIT_KEY_SCOPE_EVIDENCE_ID: "scope-evidence",
  },
  orderIntents: [intent],
  executionStatus,
  postSubmitReadiness,
  budgetSnapshot: runtimeBudgetSnapshot,
  lossSnapshot: runtimeLossSnapshot,
});
const topLevelSubmittedBlocked = renderLiveOpsSummary({
  configPath: "config/live-ops.example.json",
  envFilePath: "tests/fixtures/live-ops/fake.env",
  config,
  env: {},
  fixtureSmoke: false,
  dbReadiness: { ready: true },
  marketData: { ready: true },
  analysisDecision: { ready: true },
  liveExecution: summary,
  reconcilePnlStatus: { ready: false, status: "blocked" },
  telegramAlert: { ready: false, status: "blocked" },
});
const topLevelIdleBlocked = renderLiveOpsSummary({
  configPath: "config/live-ops.example.json",
  envFilePath: "tests/fixtures/live-ops/fake.env",
  config,
  env: {},
  fixtureSmoke: false,
  dbReadiness: { ready: true },
  marketData: { ready: true },
  analysisDecision: { ready: true },
  liveExecution: { status: "idle", ready: true, liveOrderCapable: false },
  reconcilePnlStatus: { ready: false, status: "pending" },
  telegramAlert: { ready: false, status: "pending" },
});
const topLevelDecisionSourcePendingReady = renderLiveOpsSummary({
  configPath: "config/live-ops.example.json",
  envFilePath: "tests/fixtures/live-ops/fake.env",
  config,
  env: {},
  fixtureSmoke: false,
  dbReadiness: { ready: true },
  marketData: { ready: true },
  analysisDecision: { status: "pending", ready: false, decisionSourceConnected: false },
  liveExecution: { status: "idle", ready: true, liveOrderCapable: false },
  reconcilePnlStatus: { ready: true, status: "idle" },
  telegramAlert: { ready: true, status: "idle" },
});
console.log(JSON.stringify({
  summary,
  submitted,
  reservations,
  blockedSummary,
  submittedWithoutReservation,
  riskBlockedSummary,
  submittedWithoutRisk,
  statusBlockedSummary,
  submittedWithoutStatus,
  reservationEvidenceBlockedSummary,
  submittedWithoutReservationEvidence,
  staleEvidenceSummary,
  submittedWithStaleEvidence,
  directKillSwitchResult,
  submittedWithDirectKillSwitch,
  directMissingStatusEvidenceResult,
  submittedWithMissingStatusEvidence,
  directMissingPostSubmitReadinessResult,
  submittedWithMissingPostSubmitReadiness,
  directInvalidCostInputResult,
  submittedWithInvalidCostInput,
  directInvalidMarketResult,
  submittedWithInvalidMarket,
  directMismatchNotionalResult,
  submittedWithMismatchNotional,
  directBelowMinimumNotionalResult,
  submittedWithBelowMinimumNotional,
  directLossLimitResult,
  submittedWithLossLimit,
  directPriceDeviationResult,
  submittedWithPriceDeviation,
  directBudgetLimitResult,
  submittedWithBudgetLimit,
  directSnapshotMaxOrderLimitResult,
  submittedWithSnapshotMaxOrderLimit,
  directReservationExceptionResult,
  directBrokerExceptionResult,
  directBrokerEvidenceMissingResult,
  directBrokerStatusMissingResult,
  directBrokerRejectedResult,
  directBrokerPortMissingResult,
  directCostRegressionResult,
  submittedWithCostRegression,
  directRiskRegressionResult,
  submittedWithRiskRegression,
  directDefaultSafetyBufferResult,
  submittedWithDefaultSafetyBufferGap,
  directInfrastructureRiskResult,
  submittedWithInfrastructureRisk,
  directNumericDecimalResult,
  submittedWithNumericDecimal,
  strategyKeyWrapperSummary,
  submittedWithStrategyWrapper,
  strategyWrapperReservations,
  strategyKeySummary,
  runtimeRequests,
  usedBudgetSnapshot,
  usedLossSnapshot,
  decimalEvidenceSummary,
  submittedWithDecimalEvidence,
  normalizedDecimalReservations,
  camelExpectedLossSummary,
  camelRuntimeRequests,
  zeroCostInputSummary,
  zeroCostRuntimeRequests,
  zeroExpectedLossSummary,
  zeroExpectedLossRuntimeRequests,
  marketReferenceSummary,
  marketReferenceRuntimeRequests,
  missingReferencePriceSummary,
  submittedWithoutReferencePrice,
  missingRuntimeSummary,
  topLevelSubmittedBlocked,
  topLevelIdleBlocked,
  topLevelDecisionSourcePendingReady,
}));
        `,
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: minimalEnv(),
      },
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    const output = JSON.parse(result.stdout) as {
      summary: {
        status: string;
        liveOrderCapable: boolean;
        submittedOrderCount: number;
        brokerOrderId: string;
        checks: Array<{ code: string }>;
      };
      submitted: Array<{
        intent: {
          exchangeId: string;
          market: string;
          side: string;
          orderType: string;
          postOnly: boolean;
          timeInForce: string;
          idempotencyKey: string;
        };
      }>;
      reservations: Array<{
        attemptId: string;
        idempotencyKey: string;
        market: string;
        strategyId: string;
        requestedNotionalKrw: string;
      }>;
      blockedSummary: {
        status: string;
        liveOrderCapable: boolean;
        submittedOrderCount: number;
        checks: Array<{ code: string }>;
      };
      submittedWithoutReservation: unknown[];
      riskBlockedSummary: {
        status: string;
        liveOrderCapable: boolean;
        submittedOrderCount: number;
        checks: Array<{ code: string }>;
      };
      submittedWithoutRisk: unknown[];
      statusBlockedSummary: {
        status: string;
        liveOrderCapable: boolean;
        submittedOrderCount: number;
        checks: Array<{ code: string }>;
      };
      submittedWithoutStatus: unknown[];
      reservationEvidenceBlockedSummary: {
        status: string;
        liveOrderCapable: boolean;
        submittedOrderCount: number;
        checks: Array<{ code: string }>;
      };
      submittedWithoutReservationEvidence: unknown[];
      staleEvidenceSummary: {
        status: string;
        liveOrderCapable: boolean;
        submittedOrderCount: number;
        checks: Array<{ code: string }>;
      };
      submittedWithStaleEvidence: unknown[];
      directKillSwitchResult: {
        status: string;
        violations: string[];
      };
      submittedWithDirectKillSwitch: unknown[];
      directMissingStatusEvidenceResult: {
        status: string;
        violations: string[];
        trace: {
          violations: string[];
        };
      };
      submittedWithMissingStatusEvidence: unknown[];
      directMissingPostSubmitReadinessResult: {
        status: string;
        violations: string[];
        trace: {
          violations: string[];
        };
      };
      submittedWithMissingPostSubmitReadiness: unknown[];
      directInvalidCostInputResult: {
        status: string;
        violations: string[];
        trace: {
          violations: string[];
        };
      };
      submittedWithInvalidCostInput: unknown[];
      directInvalidMarketResult: {
        status: string;
        violations: string[];
      };
      submittedWithInvalidMarket: unknown[];
      directMismatchNotionalResult: {
        status: string;
        violations: string[];
      };
      submittedWithMismatchNotional: unknown[];
      directBelowMinimumNotionalResult: {
        status: string;
        violations: string[];
      };
      submittedWithBelowMinimumNotional: unknown[];
      directLossLimitResult: {
        status: string;
        violations: string[];
        trace: {
          violations: string[];
        };
      };
      submittedWithLossLimit: unknown[];
      directPriceDeviationResult: {
        status: string;
        violations: string[];
        trace: {
          violations: string[];
        };
      };
      submittedWithPriceDeviation: unknown[];
      directBudgetLimitResult: {
        status: string;
        violations: string[];
        trace: {
          violations: string[];
        };
      };
      submittedWithBudgetLimit: unknown[];
      directSnapshotMaxOrderLimitResult: {
        status: string;
        violations: string[];
        trace: {
          violations: string[];
        };
      };
      submittedWithSnapshotMaxOrderLimit: unknown[];
      directReservationExceptionResult: {
        status: string;
        violations: string[];
        trace: {
          reason: string;
          error: string;
        };
      };
      directBrokerExceptionResult: {
        status: string;
        violations: string[];
        trace: {
          reason: string;
          error: string;
          reservation: {
            reservationId: string;
          };
          submission: {
            intent: {
              idempotencyKey: string;
            };
          };
        };
      };
      directBrokerEvidenceMissingResult: {
        status: string;
        violations: string[];
        trace: {
          reason: string;
          reservation: {
            reservationId: string;
          };
          submission: {
            intent: {
              idempotencyKey: string;
            };
          };
          brokerOrder: Record<string, unknown>;
        };
      };
      directBrokerStatusMissingResult: {
        status: string;
        violations: string[];
        trace: {
          reason: string;
          brokerOrder: {
            brokerOrderId: string;
          };
        };
      };
      directBrokerRejectedResult: {
        status: string;
        violations: string[];
        trace: {
          reason: string;
          brokerOrder: {
            status: string;
          };
        };
      };
      directBrokerPortMissingResult: {
        status: string;
        violations: string[];
        trace: {
          reason: string;
        };
      };
      directCostRegressionResult: {
        status: string;
        violations: string[];
        trace: {
          violations: string[];
        };
      };
      submittedWithCostRegression: unknown[];
      directRiskRegressionResult: {
        status: string;
        violations: string[];
        trace: {
          violations: string[];
        };
      };
      submittedWithRiskRegression: unknown[];
      directDefaultSafetyBufferResult: {
        status: string;
        violations: string[];
        trace: {
          violations: string[];
        };
      };
      submittedWithDefaultSafetyBufferGap: unknown[];
      directInfrastructureRiskResult: {
        status: string;
        violations: string[];
        trace: {
          violations: string[];
        };
      };
      submittedWithInfrastructureRisk: unknown[];
      directNumericDecimalResult: {
        status: string;
        violations: string[];
        trace: {
          violations: string[];
        };
      };
      submittedWithNumericDecimal: unknown[];
      strategyKeyWrapperSummary: {
        status: string;
        idempotencyKey: string;
        submittedOrderCount: number;
      };
      submittedWithStrategyWrapper: Array<{
        intent: {
          idempotencyKey: string;
          timeInForce: string;
        };
      }>;
      strategyWrapperReservations: Array<{
        idempotencyKey: string;
      }>;
      strategyKeySummary: {
        status: string;
        attemptId: string;
        idempotencyKey: string;
      };
      runtimeRequests: Array<{
        idempotencyKey: string;
        config: {
          max_daily_loss_krw: string;
          max_weekly_loss_krw: string;
        };
        candidate: {
          costInput: Record<string, unknown>;
          risk: Record<string, unknown>;
          metadata: {
            decision_idempotency_key: string;
          };
        };
        budgetSnapshot: Record<string, string>;
        lossSnapshot: Record<string, string>;
      }>;
      usedBudgetSnapshot: Record<string, string>;
      usedLossSnapshot: Record<string, string>;
      decimalEvidenceSummary: {
        status: string;
        submittedOrderCount: number;
      };
      submittedWithDecimalEvidence: unknown[];
      normalizedDecimalReservations: Array<{
        requestedNotionalKrw: string;
      }>;
      camelExpectedLossSummary: {
        status: string;
        submittedOrderCount: number;
      };
      camelRuntimeRequests: Array<{
        candidate: {
          expectedLossBpsOfEquity: string;
          costInput: Record<string, unknown>;
        };
      }>;
      zeroCostInputSummary: {
        status: string;
        submittedOrderCount: number;
      };
      zeroCostRuntimeRequests: Array<{
        candidate: {
          costInput: Record<string, unknown>;
        };
      }>;
      zeroExpectedLossSummary: {
        status: string;
        submittedOrderCount: number;
      };
      zeroExpectedLossRuntimeRequests: Array<{
        candidate: {
          expectedLossBpsOfEquity: string;
        };
      }>;
      marketReferenceSummary: {
        status: string;
        submittedOrderCount: number;
      };
      marketReferenceRuntimeRequests: Array<{
        candidate: {
          referencePrice: string;
        };
      }>;
      missingReferencePriceSummary: {
        status: string;
        attemptedOrderCount: number;
        submittedOrderCount: number;
        checks: Array<{ code: string }>;
      };
      submittedWithoutReferencePrice: unknown[];
      missingRuntimeSummary: {
        status: string;
        attemptedOrderCount: number;
        submittedOrderCount: number;
        checks: Array<{ code: string }>;
      };
      topLevelSubmittedBlocked: {
        status: string;
        liveOrderCapable: boolean;
      };
      topLevelIdleBlocked: {
        status: string;
        liveOrderCapable: boolean;
      };
      topLevelDecisionSourcePendingReady: {
        status: string;
        message: string;
        liveOrderCapable: boolean;
      };
    };
    expect(output.summary).toMatchObject({
      status: "submitted",
      liveOrderCapable: true,
      submittedOrderCount: 1,
      brokerOrderId: "upbit-live-boundary-001",
    });
    expect(output.summary.checks.map((check) => check.code)).toContain("live_ops_execution_submitted");
    expect(output.reservations).toContainEqual({
      attemptId: "ops-aaaaaaaaaaaaaaaaaaaaaaaaaa",
      idempotencyKey: "ops-aaaaaaaaaaaaaaaaaaaaaaaaaa",
      market: "KRW-BTC",
      strategyId: "live_ops_fixture_strategy",
      requestedNotionalKrw: "10000",
    });
    expect(output.submitted).toHaveLength(1);
    expect(output.submitted[0]?.intent).toMatchObject({
      exchangeId: "upbit_krw_spot",
      market: "KRW-BTC",
      side: "BUY",
      orderType: "LIMIT",
      postOnly: true,
      timeInForce: "POST_ONLY",
      idempotencyKey: "ops-aaaaaaaaaaaaaaaaaaaaaaaaaa",
    });
    expect(output.submitted[0]).toMatchObject({
      costSnapshot: {
        source: "cost_model",
        trade_allowed: true,
      },
      riskApproval: {
        source: "risk_gate",
        approved: true,
        action: "ALLOW",
      },
    });
    expect(output.blockedSummary).toMatchObject({
      status: "blocked",
      liveOrderCapable: false,
      submittedOrderCount: 0,
    });
    expect(output.blockedSummary.checks.map((check) => check.code)).toContain("live_ops_execution_blocked");
    expect(output.submittedWithoutReservation).toHaveLength(0);
    expect(output.riskBlockedSummary).toMatchObject({
      status: "blocked",
      liveOrderCapable: false,
      submittedOrderCount: 0,
    });
    expect(output.riskBlockedSummary.checks.map((check) => check.code)).toContain("live_ops_order_intent_blocked");
    expect(output.submittedWithoutRisk).toHaveLength(0);
    expect(output.statusBlockedSummary).toMatchObject({
      status: "blocked",
      liveOrderCapable: false,
      submittedOrderCount: 0,
    });
    expect(output.statusBlockedSummary.checks.map((check) => check.code)).toContain("live_ops_execution_status_blocked");
    expect(output.submittedWithoutStatus).toHaveLength(0);
    expect(output.reservationEvidenceBlockedSummary).toMatchObject({
      status: "blocked",
      liveOrderCapable: false,
      submittedOrderCount: 0,
    });
    expect(output.reservationEvidenceBlockedSummary.checks.map((check) => check.code)).toContain("live_ops_execution_blocked");
    expect(output.submittedWithoutReservationEvidence).toHaveLength(0);
    expect(output.staleEvidenceSummary).toMatchObject({
      status: "blocked",
      liveOrderCapable: false,
      submittedOrderCount: 0,
    });
    expect(output.staleEvidenceSummary.checks.map((check) => check.code)).toContain("live_ops_order_intent_blocked");
    expect(output.submittedWithStaleEvidence).toHaveLength(0);
    expect(output.directKillSwitchResult).toMatchObject({
      status: "BLOCKED",
      violations: ["execution_runtime_status_blocked"],
    });
    expect(output.submittedWithDirectKillSwitch).toHaveLength(0);
    expect(output.directMissingStatusEvidenceResult).toMatchObject({
      status: "BLOCKED",
      violations: ["execution_runtime_status_blocked"],
      trace: {
        violations: expect.arrayContaining(["execution status evidence id가 wrapper 경계에서도 필요합니다"]),
      },
    });
    expect(output.submittedWithMissingStatusEvidence).toHaveLength(0);
    expect(output.directMissingPostSubmitReadinessResult).toMatchObject({
      status: "BLOCKED",
      violations: ["execution_runtime_status_blocked"],
      trace: {
        violations: expect.arrayContaining([
          "제출 후 Telegram trade alert 경계가 wrapper 경계에서도 준비되어야 합니다",
          "post-submit readiness evidence id가 wrapper 경계에서도 필요합니다",
        ]),
      },
    });
    expect(output.submittedWithMissingPostSubmitReadiness).toHaveLength(0);
    expect(output.directInvalidCostInputResult).toMatchObject({
      status: "BLOCKED",
      violations: ["execution_runtime_guard_blocked"],
      trace: {
        violations: expect.arrayContaining(["live ops wrapper candidate costInput은 non-negative decimal이어야 합니다"]),
      },
    });
    expect(output.submittedWithInvalidCostInput).toHaveLength(0);
    expect(output.directInvalidMarketResult).toMatchObject({
      status: "BLOCKED",
      violations: ["execution_runtime_guard_blocked"],
    });
    expect(output.submittedWithInvalidMarket).toHaveLength(0);
    expect(output.directMismatchNotionalResult).toMatchObject({
      status: "BLOCKED",
      violations: ["execution_runtime_guard_blocked"],
    });
    expect(output.submittedWithMismatchNotional).toHaveLength(0);
    expect(output.directBelowMinimumNotionalResult).toMatchObject({
      status: "BLOCKED",
      violations: ["execution_runtime_guard_blocked"],
    });
    expect(output.submittedWithBelowMinimumNotional).toHaveLength(0);
    expect(output.directLossLimitResult).toMatchObject({
      status: "BLOCKED",
      violations: ["execution_runtime_guard_blocked"],
      trace: {
        violations: expect.arrayContaining(["live ops wrapper 일일 손실 한도를 초과했습니다"]),
      },
    });
    expect(output.submittedWithLossLimit).toHaveLength(0);
    expect(output.directPriceDeviationResult).toMatchObject({
      status: "BLOCKED",
      violations: ["execution_runtime_guard_blocked"],
      trace: {
        violations: expect.arrayContaining(["live ops wrapper 후보 가격 이탈이 허용 bps를 초과했습니다"]),
      },
    });
    expect(output.submittedWithPriceDeviation).toHaveLength(0);
    expect(output.directBudgetLimitResult).toMatchObject({
      status: "BLOCKED",
      violations: ["execution_runtime_guard_blocked"],
      trace: {
        violations: expect.arrayContaining([
          "live ops wrapper 일일 자동 주문 예산을 초과했습니다",
          "live ops wrapper open position 예산을 초과했습니다",
        ]),
      },
    });
    expect(output.submittedWithBudgetLimit).toHaveLength(0);
    expect(output.directSnapshotMaxOrderLimitResult).toMatchObject({
      status: "BLOCKED",
      violations: ["execution_runtime_guard_blocked"],
      trace: {
        violations: expect.arrayContaining(["live ops wrapper 후보 실제 주문 금액이 budget snapshot 단일 주문 한도를 초과했습니다"]),
      },
    });
    expect(output.submittedWithSnapshotMaxOrderLimit).toHaveLength(0);
    expect(output.directReservationExceptionResult).toMatchObject({
      status: "BLOCKED",
      violations: ["budget_reservation_unavailable"],
      trace: {
        reason: "budget_reservation_unavailable",
        error: "Error",
      },
    });
    expect(output.directBrokerExceptionResult).toMatchObject({
      status: "MANUAL_REVIEW_REQUIRED",
      violations: ["broker_submission_uncertain"],
      trace: {
        reason: "broker_submission_uncertain",
        error: "Error",
        reservation: {
          reservationId: "reservation-001",
        },
      },
    });
    expect(output.directBrokerExceptionResult.trace.submission.intent.idempotencyKey).toBe("ops-aaaaaaaaaaaaaaaaaaaaaaaaaa");
    expect(output.directBrokerEvidenceMissingResult).toMatchObject({
      status: "MANUAL_REVIEW_REQUIRED",
      violations: ["broker_result_evidence_missing"],
      trace: {
        reason: "broker_result_evidence_missing",
        reservation: {
          reservationId: "reservation-001",
        },
        brokerOrder: {},
      },
    });
    expect(output.directBrokerEvidenceMissingResult.trace.submission.intent.idempotencyKey).toBe("ops-aaaaaaaaaaaaaaaaaaaaaaaaaa");
    expect(output.directBrokerStatusMissingResult).toMatchObject({
      status: "MANUAL_REVIEW_REQUIRED",
      violations: ["broker_result_evidence_missing"],
      trace: {
        reason: "broker_result_evidence_missing",
        brokerOrder: {
          brokerOrderId: "status-missing-live-order-001",
        },
      },
    });
    expect(output.directBrokerRejectedResult).toMatchObject({
      status: "MANUAL_REVIEW_REQUIRED",
      violations: ["broker_result_not_accepted"],
      trace: {
        reason: "broker_result_not_accepted",
        brokerOrder: {
          status: "REJECTED",
        },
      },
    });
    expect(output.directBrokerPortMissingResult).toMatchObject({
      status: "BLOCKED",
      violations: ["broker_port_missing"],
      trace: {
        reason: "broker_port_missing",
      },
    });
    expect(output.directCostRegressionResult).toMatchObject({
      status: "BLOCKED",
      violations: ["execution_runtime_cost_risk_blocked"],
      trace: {
        violations: expect.arrayContaining(["live ops wrapper CostModel 현재 입력이 비용 여유 조건을 통과하지 못했습니다"]),
      },
    });
    expect(output.submittedWithCostRegression).toHaveLength(0);
    expect(output.directRiskRegressionResult).toMatchObject({
      status: "BLOCKED",
      violations: ["execution_runtime_cost_risk_blocked"],
      trace: {
        violations: expect.arrayContaining(["live ops wrapper RiskGate 현재 예상 손실이 한도를 초과했습니다"]),
      },
    });
    expect(output.submittedWithRiskRegression).toHaveLength(0);
    expect(output.directDefaultSafetyBufferResult).toMatchObject({
      status: "BLOCKED",
      violations: ["execution_runtime_cost_risk_blocked"],
      trace: {
        violations: expect.arrayContaining(["live ops wrapper CostModel 현재 입력이 비용 여유 조건을 통과하지 못했습니다"]),
      },
    });
    expect(output.submittedWithDefaultSafetyBufferGap).toHaveLength(0);
    expect(output.directInfrastructureRiskResult).toMatchObject({
      status: "BLOCKED",
      violations: ["execution_runtime_cost_risk_blocked"],
      trace: {
        violations: expect.arrayContaining(["live ops wrapper RiskGate 현재 인프라 차단 신호가 활성화됐습니다: DB_WRITE_FAILURE"]),
      },
    });
    expect(output.submittedWithInfrastructureRisk).toHaveLength(0);
    expect(output.directNumericDecimalResult).toMatchObject({
      status: "BLOCKED",
      violations: ["execution_runtime_guard_blocked"],
      trace: {
        violations: expect.arrayContaining(["live ops wrapper 후보 가격, 수량, 주문 금액은 양수 decimal이어야 합니다"]),
      },
    });
    expect(output.submittedWithNumericDecimal).toHaveLength(0);
    expect(output.strategyKeyWrapperSummary).toMatchObject({
      status: "submitted",
      submittedOrderCount: 1,
    });
    expect(output.strategyKeyWrapperSummary.idempotencyKey).toMatch(/^ops-[a-f0-9]{26}$/u);
    expect(output.submittedWithStrategyWrapper).toHaveLength(1);
    expect(output.submittedWithStrategyWrapper[0]?.intent.idempotencyKey).toBe(output.strategyKeyWrapperSummary.idempotencyKey);
    expect(output.submittedWithStrategyWrapper[0]?.intent.timeInForce).toBe("POST_ONLY");
    expect(output.strategyWrapperReservations).toHaveLength(1);
    expect(output.strategyWrapperReservations[0]?.idempotencyKey).toBe(output.strategyKeyWrapperSummary.idempotencyKey);
    expect(output.strategyKeySummary).toMatchObject({
      status: "submitted",
    });
    expect(output.strategyKeySummary.idempotencyKey).toMatch(/^ops-[a-f0-9]{26}$/u);
    expect(output.strategyKeySummary.idempotencyKey).not.toContain("live_ops_fixture_strategy");
    expect(output.runtimeRequests).toHaveLength(1);
    expect(output.runtimeRequests[0]?.idempotencyKey).toBe(output.strategyKeySummary.idempotencyKey);
    expect(output.runtimeRequests[0]?.config).toMatchObject({
      max_daily_loss_krw: "10000",
      max_weekly_loss_krw: "30000",
    });
    expect(output.runtimeRequests[0]?.budgetSnapshot).toEqual(output.usedBudgetSnapshot);
    expect(output.runtimeRequests[0]?.lossSnapshot).toEqual(output.usedLossSnapshot);
    expect(output.runtimeRequests[0]?.candidate.costInput).toMatchObject({
      expectedReturnBps: "40",
      safetyBufferBps: "10",
    });
    expect(output.runtimeRequests[0]?.candidate.risk).toMatchObject({
      strategy: {
        strategyId: "live_ops_fixture_strategy",
      },
    });
    expect(output.runtimeRequests[0]?.candidate.metadata).toMatchObject({
      decision_idempotency_key: "live_ops_fixture_strategy:upbit_krw_spot:KRW-BTC:BUY:2026-06-15T00:00:00.000Z",
    });
    expect(output.decimalEvidenceSummary).toMatchObject({
      status: "submitted",
      submittedOrderCount: 1,
    });
    expect(output.submittedWithDecimalEvidence).toHaveLength(1);
    expect(output.normalizedDecimalReservations).toHaveLength(1);
    expect(output.normalizedDecimalReservations[0]?.requestedNotionalKrw).toBe("10000.0");
    expect(output.camelExpectedLossSummary).toMatchObject({
      status: "submitted",
      submittedOrderCount: 1,
    });
    expect(output.camelRuntimeRequests).toHaveLength(1);
    expect(output.camelRuntimeRequests[0]?.candidate.expectedLossBpsOfEquity).toBe("5");
    expect(output.camelRuntimeRequests[0]?.candidate.costInput).not.toHaveProperty("safetyBufferBps");
    expect(output.zeroCostInputSummary).toMatchObject({
      status: "submitted",
      submittedOrderCount: 1,
    });
    expect(output.zeroCostRuntimeRequests).toHaveLength(1);
    expect(output.zeroCostRuntimeRequests[0]?.candidate.costInput).toMatchObject({
      spreadCostBpsP75: "0",
      expectedSlippageBpsP95: "0",
      cancelRequotePenaltyBps: "0",
    });
    expect(output.zeroExpectedLossSummary).toMatchObject({
      status: "submitted",
      submittedOrderCount: 1,
    });
    expect(output.zeroExpectedLossRuntimeRequests).toHaveLength(1);
    expect(output.zeroExpectedLossRuntimeRequests[0]?.candidate.expectedLossBpsOfEquity).toBe("0");
    expect(output.marketReferenceSummary).toMatchObject({
      status: "submitted",
      submittedOrderCount: 1,
    });
    expect(output.marketReferenceRuntimeRequests).toHaveLength(1);
    expect(output.marketReferenceRuntimeRequests[0]?.candidate.referencePrice).toBe("100000000");
    expect(output.missingReferencePriceSummary).toMatchObject({
      status: "blocked",
      attemptedOrderCount: 0,
      submittedOrderCount: 0,
    });
    expect(output.missingReferencePriceSummary.checks.map((check) => check.code)).toContain("live_ops_order_intent_blocked");
    expect(output.submittedWithoutReferencePrice).toHaveLength(0);
    expect(output.missingRuntimeSummary).toMatchObject({
      status: "blocked",
      attemptedOrderCount: 0,
      submittedOrderCount: 0,
    });
    expect(output.missingRuntimeSummary.checks.map((check) => check.code)).toContain("live_ops_entry_runtime_missing");
    expect(output.topLevelSubmittedBlocked).toMatchObject({
      status: "blocked",
      liveOrderCapable: true,
    });
    expect(output.topLevelIdleBlocked).toMatchObject({
      status: "blocked",
      liveOrderCapable: false,
    });
    expect(output.topLevelDecisionSourcePendingReady).toMatchObject({
      status: "blocked",
      liveOrderCapable: false,
    });
    expect(output.topLevelDecisionSourcePendingReady.message).toContain("production live ops boot가 fail-closed");
    expect(result.stdout).not.toContain("fake-secret-key");
  });

  it("cleanup lifecycle은 submit 이후 같은 attempt를 취소 확인으로 닫고 중복 reservation을 차단한다", async () => {
    const supportModulePath = path.join(process.cwd(), "scripts/run-live-ops-support.mjs");
    const {
      createLiveOpsCliCleanupArtifactStore,
      createLiveOpsCliCleanupLifecycle,
      createLiveOpsCliEntryRuntime,
      createLiveOpsCliFileBudgetReservation,
      evaluateLiveOpsCliLiveExecution,
    } = await import(supportModulePath);
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-live-ops-cleanup-"));
    const artifactStore = await createLiveOpsCliCleanupArtifactStore({ artifactDir: tempDir });
    const observedAt = "2026-06-15T00:00:00.000Z";
    const submitted: unknown[] = [];
    const canceled: string[] = [];
    const broker = {
      async submitOrder(submission: {
        intent: {
          idempotencyKey: string;
          market: string;
          requestedPrice: string;
          requestedQuantity: string;
        };
      }) {
        submitted.push(submission);
        return {
          brokerOrderId: "upbit-cleanup-order-001",
          idempotencyKey: submission.intent.idempotencyKey,
          exchangeId: "upbit_krw_spot",
          market: submission.intent.market,
          side: "BUY",
          orderType: "LIMIT",
          status: "ACCEPTED",
          requestedQuantity: submission.intent.requestedQuantity,
          remainingQuantity: submission.intent.requestedQuantity,
          requestedPrice: submission.intent.requestedPrice,
          acceptedAt: observedAt,
          updatedAt: observedAt,
        };
      },
      async cancelOrder(orderId: string) {
        canceled.push(orderId);
        return {
          brokerOrderId: orderId,
          idempotencyKey: "ops-aaaaaaaaaaaaaaaaaaaaaaaaaa",
          exchangeId: "upbit_krw_spot",
          market: "KRW-BTC",
          side: "BUY",
          orderType: "LIMIT",
          status: "CANCEL_REQUESTED",
          requestedQuantity: "0.0001",
          remainingQuantity: "0.0001",
          requestedPrice: "100000000",
          updatedAt: observedAt,
        };
      },
      async getOrder(orderId: string) {
        return {
          brokerOrderId: orderId,
          idempotencyKey: "ops-aaaaaaaaaaaaaaaaaaaaaaaaaa",
          exchangeId: "upbit_krw_spot",
          market: "KRW-BTC",
          side: "BUY",
          orderType: "LIMIT",
          status: "CANCELED",
          requestedQuantity: "0.0001",
          remainingQuantity: "0.0001",
          requestedPrice: "100000000",
          updatedAt: observedAt,
        };
      },
    };
    const clock = () => observedAt;
    const budgetReservation = createLiveOpsCliFileBudgetReservation({ artifactStore, clock });
    const entryRuntime = createLiveOpsCliEntryRuntime({ broker, budgetReservation });
    const cleanupLifecycle = createLiveOpsCliCleanupLifecycle({
      broker,
      artifactStore,
      clock,
      cancelPollCount: 1,
      cancelPollIntervalMs: 0,
    });
    const config = {
      live_trading_enabled: true,
      universe: { markets: ["KRW-BTC"], default_market: "KRW-BTC" },
      budget: {
        max_order_krw: "10000",
        daily_autonomous_notional_limit_krw: "30000",
        max_open_position_notional_krw: "30000",
      },
    };
    const intent = createCleanupRuntimeIntent();
    const commonInput = {
      config,
      fixtureSmoke: false,
      analysisDecision: {
        ready: true,
        decisionCategory: "ORDER_INTENT",
        orderIntentCount: 1,
      },
      marketData: {
        ready: true,
        latestHeartbeatAt: observedAt,
        referencePrice: "100000000",
      },
      env: {
        SEEMIRAI_UPBIT_ACCESS_KEY: "fake-access-key",
        SEEMIRAI_UPBIT_SECRET_KEY: "fake-secret-key",
        SEEMIRAI_UPBIT_KEY_SCOPE: "자산조회,주문조회,주문하기",
        SEEMIRAI_UPBIT_KEY_SCOPE_EVIDENCE_ID: "scope-evidence",
      },
      orderIntents: [intent],
      entryRuntime,
      executionStatus: {
        killSwitchActive: false,
        reconcileFresh: true,
        evidenceId: "execution-status-evidence",
      },
      postSubmitReadiness: {
        reconcileReady: true,
        telegramReady: true,
        evidenceId: "post-submit-readiness-evidence",
      },
      budgetSnapshot: {
        maxOrderKrw: "10000",
        dailyAutonomousNotionalLimitKrw: "30000",
        dailyAutonomousNotionalUsedKrw: "0",
        openPositionNotionalKrw: "0",
        maxOpenPositionNotionalKrw: "30000",
        capturedAt: observedAt,
      },
      lossSnapshot: {
        dailyRealizedLossKrw: "0",
        weeklyRealizedLossKrw: "0",
        capturedAt: observedAt,
      },
      cleanupLifecycle,
    };

    const firstSummary = await evaluateLiveOpsCliLiveExecution(commonInput);
    const artifact = JSON.parse(await readFile(firstSummary.cleanupArtifactPath, "utf8")) as {
      status: string;
      terminalState: string;
      terminalCancelConfirmedAt: string;
      brokerOrderIdSuffix: string;
      openExposureKrw: string;
    };
    const secondSummary = await evaluateLiveOpsCliLiveExecution(commonInput);

    expect(firstSummary).toMatchObject({
      status: "cancel_confirmed",
      cleanupStatus: "completed",
      terminalState: "CANCELED",
      submittedOrderCount: 1,
    });
    expect(artifact).toMatchObject({
      status: "completed",
      terminalState: "CANCELED",
      terminalCancelConfirmedAt: observedAt,
      brokerOrderIdSuffix: "rder-001",
      openExposureKrw: "0",
    });
    expect(secondSummary).toMatchObject({
      status: "blocked",
      attemptedOrderCount: 1,
      submittedOrderCount: 0,
    });
    expect(secondSummary.checks.map((check: { code: string }) => check.code)).toContain("live_ops_execution_blocked");
    expect(submitted).toHaveLength(1);
    expect(canceled).toEqual(["upbit-cleanup-order-001"]);
    expect(JSON.stringify(artifact)).not.toContain("fake-secret-key");
    expect(JSON.stringify(artifact)).not.toContain("raw_provider_payload");
  });

  it("file budget reservation은 reserve 실행 wall clock 날짜로 reservation day를 고정한다", async () => {
    const supportModulePath = path.join(process.cwd(), "scripts/run-live-ops-support.mjs");
    const {
      createLiveOpsCliCleanupArtifactStore,
      createLiveOpsCliFileBudgetReservation,
    } = await import(supportModulePath);
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-live-ops-budget-observed-at-"));
    const artifactStore = await createLiveOpsCliCleanupArtifactStore({ artifactDir: tempDir });
    const requestObservedAt = "2026-06-15T23:59:59.000Z";
    const budgetReservation = createLiveOpsCliFileBudgetReservation({
      artifactStore,
      clock: () => "2026-06-16T00:00:01.000Z",
    });

    const result = await budgetReservation.reserve({
      attemptId: "ops-aaaaaaaaaaaaaaaaaaaaaaaaaa",
      idempotencyKey: "ops-aaaaaaaaaaaaaaaaaaaaaaaaaa",
      market: "KRW-BTC",
      strategyId: "live_ops_cleanup_probe",
      requestedNotionalKrw: "10000",
      budgetSnapshot: {
        dailyAutonomousNotionalLimitKrw: "30000",
        dailyAutonomousNotionalUsedKrw: "0",
        openPositionNotionalKrw: "0",
      },
      observedAt: requestObservedAt,
    });
    const reservedOnRequestDay = await budgetReservation.readDailyReservedNotional(requestObservedAt);
    const reservedOnClockDay = await budgetReservation.readDailyReservedNotional("2026-06-16T00:00:01.000Z");

    expect(result).toMatchObject({
      reserved: true,
      reservation: {
        reservedAt: "2026-06-16T00:00:01.000Z",
        budgetUsageAfterReservationKrw: "10000",
      },
    });
    expect(reservedOnRequestDay).toMatchObject({ day: "2026-06-15", reservedNotionalKrw: "0" });
    expect(reservedOnClockDay).toMatchObject({ day: "2026-06-16", reservedNotionalKrw: "10000" });
  });

  it("file budget reservation은 일일 예산 집계를 lock 안에서 선점한다", async () => {
    const supportModulePath = path.join(process.cwd(), "scripts/run-live-ops-support.mjs");
    const {
      createLiveOpsCliCleanupArtifactStore,
      createLiveOpsCliFileBudgetReservation,
    } = await import(supportModulePath);
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-live-ops-budget-lock-"));
    const artifactStore = await createLiveOpsCliCleanupArtifactStore({ artifactDir: tempDir });
    const observedAt = "2026-06-15T00:00:00.000Z";
    const budgetReservation = createLiveOpsCliFileBudgetReservation({
      artifactStore,
      clock: () => observedAt,
    });
    const createRequest = (attemptId: string, requestedNotionalKrw: string) => ({
      attemptId,
      idempotencyKey: attemptId,
      market: "KRW-BTC",
      strategyId: "live_ops_cleanup_probe",
      requestedNotionalKrw,
      budgetSnapshot: {
        dailyAutonomousNotionalLimitKrw: "30000",
        dailyAutonomousNotionalUsedKrw: "0",
        openPositionNotionalKrw: "0",
      },
      observedAt,
    });

    const first = await budgetReservation.reserve(createRequest("ops-aaaaaaaaaaaaaaaaaaaaaaaaaa", "20000"));
    const second = await budgetReservation.reserve(createRequest("ops-bbbbbbbbbbbbbbbbbbbbbbbbbb", "15000"));
    const dailyUsage = await budgetReservation.readDailyReservedNotional(observedAt);
    const lock = await artifactStore.acquireDailyReservationLock("2026-06-15");
    const lockLease = JSON.parse(await readFile(lock.path, "utf8"));
    let busy;
    try {
      busy = await budgetReservation.reserve(createRequest("ops-cccccccccccccccccccccccccc", "10000"));
    } finally {
      await lock.release();
    }
    const staleLockPath = artifactStore.dailyReservationLockPath("2026-06-15");
    await writeFile(staleLockPath, JSON.stringify({
      source: "live_ops_cli_daily_budget_reservation_lock",
      day: "2026-06-15",
      leaseId: "active-expired-main-lock",
      acquiredAt: "2026-06-14T23:50:00.000Z",
      expiresAt: "2026-06-14T23:55:00.000Z",
      pid: process.pid,
      owner: lockLease.owner,
    }, null, 2), "utf8");
    const activeOwnerBusy = await budgetReservation.reserve(createRequest("ops-eeeeeeeeeeeeeeeeeeeeeeeeee", "10000"));
    const activeOwnerLockAfterBusy = JSON.parse(await readFile(staleLockPath, "utf8"));
    await writeFile(staleLockPath, JSON.stringify({
      source: "live_ops_cli_daily_budget_reservation_lock",
      day: "2026-06-15",
      leaseId: "pid-reused-main-lock",
      acquiredAt: "2026-06-14T23:50:00.000Z",
      expiresAt: "2026-06-14T23:55:00.000Z",
      pid: process.pid,
      owner: {
        ...lockLease.owner,
        processStartTime: "stale-process-start",
      },
    }, null, 2), "utf8");
    const pidReusedLock = await artifactStore.acquireDailyReservationLock("2026-06-15", { acquiredAt: observedAt });
    await pidReusedLock.release();
    await writeFile(staleLockPath, JSON.stringify({
      source: "live_ops_cli_daily_budget_reservation_lock",
      day: "2026-06-15",
      leaseId: "competing-claim-main-lock",
      acquiredAt: "2026-06-14T23:50:00.000Z",
      expiresAt: "2026-06-14T23:55:00.000Z",
      pid: process.pid,
      owner: {
        ...lockLease.owner,
        processStartTime: "stale-process-start",
      },
    }, null, 2), "utf8");
    const competingClaimPath = `${staleLockPath}.claimed-preexisting-test`;
    const competingTempPath = `${staleLockPath}.tmp-preexisting-test`;
    await link(staleLockPath, competingClaimPath);
    await link(staleLockPath, competingTempPath);
    const orphanClaimRecoveredLock = await artifactStore.acquireDailyReservationLock("2026-06-15", { acquiredAt: observedAt });
    await orphanClaimRecoveredLock.release();
    await writeFile(staleLockPath, "{}", "utf8");
    const schemaMalformedBusy = await budgetReservation.reserve(createRequest("ops-ffffffffffffffffffffffffff", "10000"));
    await utimes(staleLockPath, new Date("2026-06-14T23:50:00.000Z"), new Date("2026-06-14T23:50:00.000Z"));
    const schemaMalformedLock = await artifactStore.acquireDailyReservationLock("2026-06-15", { acquiredAt: observedAt });
    await schemaMalformedLock.release();
    await writeFile(staleLockPath, "{", "utf8");
    await utimes(staleLockPath, new Date("2026-06-14T23:50:00.000Z"), new Date("2026-06-14T23:50:00.000Z"));
    const recovered = await budgetReservation.reserve(createRequest("ops-dddddddddddddddddddddddddd", "10000"));
    const finalDailyUsage = await budgetReservation.readDailyReservedNotional(observedAt);

    expect(first).toMatchObject({
      reserved: true,
      reservation: {
        attemptId: "ops-aaaaaaaaaaaaaaaaaaaaaaaaaa",
        reservedNotionalKrw: "20000",
        budgetUsageAfterReservationKrw: "20000",
      },
    });
    expect(second).toMatchObject({
      reserved: false,
      reasonCode: "live_ops_daily_budget_exceeded",
      budgetUsage: {
        day: "2026-06-15",
        reservedNotionalKrw: "20000",
        currentUsedKrw: "20000",
        requestedNotionalKrw: "15000",
        dailyAutonomousNotionalLimitKrw: "30000",
      },
    });
    expect(await artifactStore.readReservation("ops-bbbbbbbbbbbbbbbbbbbbbbbbbb")).toBeUndefined();
    expect(dailyUsage).toMatchObject({
      day: "2026-06-15",
      reservedNotionalKrw: "20000",
      reservationCount: 1,
    });
    expect(busy).toMatchObject({
      reserved: false,
      reasonCode: "live_ops_daily_budget_lock_busy",
    });
    expect(lockLease).toMatchObject({
      source: "live_ops_cli_daily_budget_reservation_lock",
      day: "2026-06-15",
      leaseId: expect.any(String),
      pid: expect.any(Number),
    });
    expect(await artifactStore.readReservation("ops-cccccccccccccccccccccccccc")).toBeUndefined();
    expect(activeOwnerBusy).toMatchObject({
      reserved: false,
      reasonCode: "live_ops_daily_budget_lock_busy",
    });
    expect(activeOwnerLockAfterBusy).toMatchObject({
      source: "live_ops_cli_daily_budget_reservation_lock",
      day: "2026-06-15",
      leaseId: "active-expired-main-lock",
      pid: process.pid,
      owner: lockLease.owner,
    });
    expect(await artifactStore.readReservation("ops-eeeeeeeeeeeeeeeeeeeeeeeeee")).toBeUndefined();
    await expect(readFile(competingClaimPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(competingTempPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(schemaMalformedBusy).toMatchObject({
      reserved: false,
      reasonCode: "live_ops_daily_budget_lock_busy",
    });
    expect(await artifactStore.readReservation("ops-ffffffffffffffffffffffffff")).toBeUndefined();
    expect(recovered).toMatchObject({
      reserved: true,
      reservation: {
        attemptId: "ops-dddddddddddddddddddddddddd",
        reservedNotionalKrw: "10000",
        budgetUsageAfterReservationKrw: "30000",
      },
    });
    await expect(readFile(staleLockPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(finalDailyUsage).toMatchObject({
      day: "2026-06-15",
      reservedNotionalKrw: "30000",
      reservationCount: 2,
    });
  });

  it("cleanup lifecycle은 실패 artifact에 terminal cancel confirmed alias를 남기지 않는다", async () => {
    const supportModulePath = path.join(process.cwd(), "scripts/run-live-ops-support.mjs");
    const {
      createLiveOpsCliCleanupArtifactStore,
      createLiveOpsCliCleanupLifecycle,
    } = await import(supportModulePath);
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-live-ops-cleanup-failed-"));
    const artifactStore = await createLiveOpsCliCleanupArtifactStore({ artifactDir: tempDir });
    const observedAt = "2026-06-15T00:00:00.000Z";
    const brokerOrder = {
      brokerOrderId: "upbit-cleanup-order-pending",
      idempotencyKey: "ops-pending-id",
      exchangeId: "upbit_krw_spot",
      market: "KRW-BTC",
      side: "BUY",
      orderType: "LIMIT",
      status: "ACCEPTED",
      requestedQuantity: "0.0001",
      remainingQuantity: "0.0001",
      requestedPrice: "100000000",
      updatedAt: observedAt,
    };
    const cleanupLifecycle = createLiveOpsCliCleanupLifecycle({
      artifactStore,
      clock: () => observedAt,
      cancelPollCount: 1,
      cancelPollIntervalMs: 0,
      broker: {
        async cancelOrder() {
          return { ...brokerOrder, status: "CANCEL_REQUESTED" };
        },
        async getOrder() {
          return brokerOrder;
        },
      },
    });

    const summary = await cleanupLifecycle({
      submittedSummary: {
        status: "submitted",
        ready: true,
        liveOrderCapable: true,
        checks: [],
      },
      attempt: {
        attemptId: "ops-aaaaaaaaaaaaaaaaaaaaaaaaaa",
        idempotencyKey: "ops-aaaaaaaaaaaaaaaaaaaaaaaaaa",
        status: "SUBMITTED",
        executionResult: { brokerOrder },
      },
      request: {
        idempotencyKey: "ops-aaaaaaaaaaaaaaaaaaaaaaaaaa",
        candidate: {
          market: "KRW-BTC",
          requestedNotional: "10000",
        },
      },
      market: "KRW-BTC",
      observedAt,
    });
    const artifact = JSON.parse(await readFile(summary.cleanupArtifactPath, "utf8")) as {
      status: string;
      terminalCheckedAt: string;
      terminalCancelConfirmedAt?: string;
    };

    expect(summary).toMatchObject({
      status: "manual_review_required",
      cleanupStatus: "manual_review_required",
    });
    expect(artifact).toMatchObject({
      status: "manual_review_required",
      terminalCheckedAt: observedAt,
    });
    expect(artifact.terminalCancelConfirmedAt).toBeUndefined();
  });

  it("cleanup lifecycle은 cancel poll 실패도 수동 점검 artifact로 남긴다", async () => {
    const supportModulePath = path.join(process.cwd(), "scripts/run-live-ops-support.mjs");
    const {
      createLiveOpsCliCleanupArtifactStore,
      createLiveOpsCliCleanupLifecycle,
    } = await import(supportModulePath);
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-live-ops-cleanup-poll-failed-"));
    const artifactStore = await createLiveOpsCliCleanupArtifactStore({ artifactDir: tempDir });
    const observedAt = "2026-06-15T00:00:00.000Z";
    const brokerOrder = {
      brokerOrderId: "upbit-cleanup-order-poll-failed",
      idempotencyKey: "ops-poll-failed-id",
      exchangeId: "upbit_krw_spot",
      market: "KRW-BTC",
      side: "BUY",
      orderType: "LIMIT",
      status: "ACCEPTED",
      requestedQuantity: "0.0001",
      remainingQuantity: "0.0001",
      requestedPrice: "100000000",
      updatedAt: observedAt,
    };
    const cleanupLifecycle = createLiveOpsCliCleanupLifecycle({
      artifactStore,
      clock: () => observedAt,
      cancelPollCount: 1,
      cancelPollIntervalMs: 0,
      broker: {
        async cancelOrder() {
          return { ...brokerOrder, status: "CANCEL_REQUESTED" };
        },
        async getOrder() {
          throw Object.assign(new Error("RateLimitedDuringPoll"), {
            status: 429,
            upbitErrorName: "too_many_requests",
          });
        },
      },
    });

    const summary = await cleanupLifecycle({
      submittedSummary: {
        status: "submitted",
        ready: true,
        liveOrderCapable: true,
        checks: [],
      },
      attempt: {
        attemptId: "ops-aaaaaaaaaaaaaaaaaaaaaaaaaa",
        idempotencyKey: "ops-aaaaaaaaaaaaaaaaaaaaaaaaaa",
        status: "SUBMITTED",
        executionResult: { brokerOrder },
      },
      request: {
        idempotencyKey: "ops-aaaaaaaaaaaaaaaaaaaaaaaaaa",
        candidate: {
          market: "KRW-BTC",
          requestedNotional: "10000",
        },
      },
      market: "KRW-BTC",
      observedAt,
    });
    const artifact = JSON.parse(await readFile(summary.cleanupArtifactPath, "utf8")) as {
      status: string;
      reason: string;
      cancelRequestedAt: string;
      terminalCheckedAt: string;
      cancelBrokerOrderIdSuffix: string;
      terminalState: string | null;
      failure: {
        errorName: string;
        status: number;
        upbitErrorName: string;
      };
    };

    expect(summary).toMatchObject({
      status: "manual_review_required",
      cleanupStatus: "manual_review_required",
      cleanupArtifactPath: expect.any(String),
    });
    expect(artifact).toMatchObject({
      status: "manual_review_required",
      reason: "Error",
      cancelRequestedAt: observedAt,
      terminalCheckedAt: observedAt,
      cancelBrokerOrderIdSuffix: "l-failed",
      terminalState: null,
      failure: {
        errorName: "Error",
        status: 429,
        upbitErrorName: "too_many_requests",
      },
    });
  });

  it("Upbit live broker는 duplicate_identifier 복구 주문도 cleanup 취소 대상으로 소유권을 기록한다", async () => {
    const supportModulePath = path.join(process.cwd(), "scripts/run-live-ops-support.mjs");
    const { createLiveOpsCliUpbitLiveBroker } = await import(supportModulePath);
    const observedAt = "2026-06-15T00:00:00.000Z";
    const calls: Array<{ method: string; url: string; body: unknown }> = [];
    const recoveredPayload = {
      uuid: "upbit-recovered-cleanup-order",
      identifier: "ops-duplicate-id",
      market: "KRW-BTC",
      side: "bid",
      ord_type: "limit",
      state: "wait",
      volume: "0.0001",
      remaining_volume: "0.0001",
      price: "100000000",
      time_in_force: "post_only",
      created_at: observedAt,
    };
    const broker = createLiveOpsCliUpbitLiveBroker({
      env: {
        SEEMIRAI_UPBIT_ACCESS_KEY: "fake-access-key",
        SEEMIRAI_UPBIT_SECRET_KEY: "fake-secret-key",
      },
      clock: () => observedAt,
      nonceFactory: () => "fixed-nonce",
      async fetchImpl(url: URL, options: { method: string; body?: string }) {
        calls.push({
          method: options.method,
          url: String(url),
          body: options.body === undefined ? null : JSON.parse(options.body),
        });
        if (options.method === "POST") {
          return {
            ok: false,
            status: 400,
            async json() {
              return { error: { name: "duplicate_identifier" } };
            },
          };
        }
        if (options.method === "GET") {
          return {
            ok: true,
            async json() {
              return recoveredPayload;
            },
          };
        }
        if (options.method === "DELETE") {
          return {
            ok: true,
            async json() {
              return { ...recoveredPayload, state: "cancel" };
            },
          };
        }
        throw new Error(`unexpected method ${options.method}`);
      },
    });

    const recoveredOrder = await broker.submitOrder({
      intent: {
        exchangeId: "upbit_krw_spot",
        market: "KRW-BTC",
        side: "BUY",
        orderType: "LIMIT",
        postOnly: true,
        timeInForce: "POST_ONLY",
        idempotencyKey: "ops-duplicate-id",
        requestedQuantity: "0.0001",
        requestedPrice: "100000000",
      },
    });
    const cancelOrder = await broker.cancelOrder(recoveredOrder.brokerOrderId);

    expect(recoveredOrder).toMatchObject({
      brokerOrderId: "upbit-recovered-cleanup-order",
      idempotencyKey: "ops-duplicate-id",
      status: "ACCEPTED",
    });
    expect(cancelOrder).toMatchObject({
      brokerOrderId: "upbit-recovered-cleanup-order",
      status: "CANCELED",
    });
    expect(calls.map((call) => call.method)).toEqual(["POST", "GET", "DELETE"]);
    expect(calls[2]?.url).toContain("uuid=upbit-recovered-cleanup-order");
  });

  it("DB readiness 차단 시 provider를 열기 전에 production boot를 중단한다", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-live-ops-db-block-"));
    const fixtureEnv = await readFile(path.join(process.cwd(), "tests", "fixtures", "live-ops", "fake.env"), "utf8");
    const envFilePath = path.join(tempDir, "blocked-db.env");
    await writeFile(
      envFilePath,
      fixtureEnv.replace(
        /^SEEMIRAI_DATABASE_URL=.*$/mu,
        "SEEMIRAI_DATABASE_URL=postgres://seemirai:fake-password@127.0.0.1:1/seemirai",
      ),
      "utf8",
    );

    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `
import { loadLiveOpsCliInputs } from "./scripts/run-live-ops-support.mjs";

let providerOpened = false;
globalThis.WebSocket = class {
  constructor() {
    providerOpened = true;
    throw new Error("ProviderShouldNotOpen");
  }
};

try {
  await loadLiveOpsCliInputs({
    configPath: "config/live-ops.example.json",
    envFilePath: ${JSON.stringify(envFilePath)},
    fixtureSmoke: false,
  });
  console.log(JSON.stringify({ status: "unexpected-ready", providerOpened }));
} catch (error) {
  console.log(JSON.stringify({
    status: "blocked",
    providerOpened,
    message: error instanceof Error ? error.message : String(error),
  }));
}
        `,
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: minimalEnv(),
      },
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    const output = JSON.parse(result.stdout) as {
      status: string;
      providerOpened: boolean;
      message: string;
    };
    expect(output.status).toBe("blocked");
    expect(output.providerOpened).toBe(false);
    expect(output.message).toContain("DB readiness를 통과하지 못해 live ops boot를 중단합니다");
  });

  it("provider boot blocked summary는 non-fixture 명령 성공으로 흐르지 않는다", () => {
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `
import { assertLiveOpsCliMarketDataReady } from "./scripts/run-live-ops-support.mjs";

try {
  assertLiveOpsCliMarketDataReady({
    ready: false,
    checks: [{
      status: "blocked",
      message: "Upbit public market data provider boot를 완료하지 못했습니다.",
    }],
  }, { fixtureSmoke: false });
  console.log(JSON.stringify({ status: "unexpected-ready" }));
} catch (error) {
  console.log(JSON.stringify({
    status: "blocked",
    message: error instanceof Error ? error.message : String(error),
  }));
}
        `,
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: minimalEnv(),
      },
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    const output = JSON.parse(result.stdout) as { status: string; message: string };
    expect(output.status).toBe("blocked");
    expect(output.message).toContain("market data provider boot를 통과하지 못해 live ops boot를 중단합니다");
  });

  it("최종 blocked summary는 non-fixture live:ops 성공으로 남기지 않는다", () => {
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `
import { assertLiveOpsCliSummaryReady } from "./scripts/run-live-ops-support.mjs";

try {
  assertLiveOpsCliSummaryReady({
    status: "blocked",
    message: "production live ops boot가 fail-closed 됐습니다.",
  }, { fixtureSmoke: false });
  console.log(JSON.stringify({ status: "unexpected-ready" }));
} catch (error) {
  console.log(JSON.stringify({
    status: "blocked",
    message: error instanceof Error ? error.message : String(error),
  }));
}
        `,
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: minimalEnv(),
      },
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    const output = JSON.parse(result.stdout) as { status: string; message: string };
    expect(output.status).toBe("blocked");
    expect(output.message).toContain("live ops 최종 readiness를 통과하지 못해 boot를 중단합니다");
  });

  it("live:ops:tui attach skeleton은 attach 대상 없이는 실패한다", () => {
    const result = spawnSync(
      process.execPath,
      [
        "scripts/run-live-ops-tui.mjs",
        "--config",
        "config/live-ops.example.json",
        "--env-file",
        "tests/fixtures/live-ops/fake.env",
        "--fixture-smoke",
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: minimalEnv(),
      },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("--attach");
  });

  it("legacy M22 readiness env가 섞이면 production live ops script가 fail-closed 한다", () => {
    const result = spawnSync(
      process.execPath,
      [
        "scripts/run-live-ops.mjs",
        "--config",
        "config/live-ops.example.json",
        "--env-file",
        "tests/fixtures/live-ops/fake.env",
        "--fixture-smoke",
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...minimalEnv(),
          SEEMIRAI_M22_DECISION_LEDGER_READY: "1",
        },
      },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("실제 readiness probe로 대체해야 합니다");
  });

  it("예산 상한을 완화한 운영 JSON은 CLI contract에서도 fail-closed 한다", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-live-ops-script-"));
    const config = JSON.parse(await readFile(path.join(process.cwd(), "config", "live-ops.example.json"), "utf8"));
    config.budget.max_order_krw = "100000000";
    const configPath = path.join(tempDir, "unsafe-live-ops.json");
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");

    const result = spawnSync(
      process.execPath,
      [
        "scripts/run-live-ops.mjs",
        "--config",
        configPath,
        "--env-file",
        "tests/fixtures/live-ops/fake.env",
        "--fixture-smoke",
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: minimalEnv(),
      },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("budget.max_order_krw");
  });

  it("더 보수적인 운영 중지 ceiling은 CLI contract에서도 허용한다", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-live-ops-script-"));
    const config = JSON.parse(await readFile(path.join(process.cwd(), "config", "live-ops.example.json"), "utf8"));
    config.budget.operations_stop_ceiling_krw = "40000";
    const configPath = path.join(tempDir, "conservative-live-ops.json");
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");

    const result = spawnSync(
      process.execPath,
      [
        "scripts/run-live-ops.mjs",
        "--config",
        configPath,
        "--env-file",
        "tests/fixtures/live-ops/fake.env",
        "--fixture-smoke",
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: minimalEnv(),
      },
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
  });

  it("strict runtime config와 다른 exchange/unknown key는 CLI contract에서도 fail-closed 한다", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-live-ops-script-"));
    const config = JSON.parse(await readFile(path.join(process.cwd(), "config", "live-ops.example.json"), "utf8"));
    config.exchange = "BINANCE";
    config.operator_note = "not part of runtime contract";
    const configPath = path.join(tempDir, "unsafe-live-ops.json");
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");

    const result = spawnSync(
      process.execPath,
      [
        "scripts/run-live-ops.mjs",
        "--config",
        configPath,
        "--env-file",
        "tests/fixtures/live-ops/fake.env",
        "--fixture-smoke",
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: minimalEnv(),
      },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("exchange는 UPBIT");
    expect(result.stderr).toContain("$.operator_note");
  });

  it("모든 SEEMIRAI_RUN_UPBIT_*_SMOKE env가 production CLI에서 fail-closed 된다", () => {
    const result = spawnSync(
      process.execPath,
      [
        "scripts/run-live-ops.mjs",
        "--config",
        "config/live-ops.example.json",
        "--env-file",
        "tests/fixtures/live-ops/fake.env",
        "--fixture-smoke",
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...minimalEnv(),
          SEEMIRAI_RUN_UPBIT_LIVE_RECONCILE_WS_SMOKE: "1",
        },
      },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("production live ops smoke/readiness");
  });

  it("process env의 smoke flag는 env file override로 숨길 수 없다", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-live-ops-env-"));
    const envFileContent = await readFile(path.join(process.cwd(), "tests", "fixtures", "live-ops", "fake.env"), "utf8");
    const envFilePath = path.join(tempDir, "override.env");
    await writeFile(envFilePath, `${envFileContent}\nSEEMIRAI_RUN_UPBIT_LIVE_BROKER_SMOKE=0\n`, "utf8");

    const result = spawnSync(
      process.execPath,
      [
        "scripts/run-live-ops.mjs",
        "--config",
        "config/live-ops.example.json",
        "--env-file",
        envFilePath,
        "--fixture-smoke",
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...minimalEnv(),
          SEEMIRAI_RUN_UPBIT_LIVE_BROKER_SMOKE: "1",
        },
      },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("SEEMIRAI_RUN_UPBIT_LIVE_BROKER_SMOKE");
  });
});

function createCleanupRuntimeIntent() {
  const intent = {
    exchangeId: "upbit_krw_spot",
    market: "KRW-BTC",
    strategyId: "live_ops_cleanup_probe",
    side: "BUY",
    orderType: "LIMIT",
    requestedPrice: "100000000",
    referencePrice: "100000000",
    requestedQuantity: "0.0001",
    requestedNotional: "10000",
    idempotencyKey: "ops-aaaaaaaaaaaaaaaaaaaaaaaaaa",
    reason: "issue_206_cleanup_probe",
    postOnly: true,
    timeInForce: "POST_ONLY",
    metadata: {
      expected_loss_bps_of_equity: "5",
    },
  };
  const orderIntentEvidence = {
    exchange_id: intent.exchangeId,
    market: intent.market,
    strategy_id: intent.strategyId,
    side: intent.side,
    order_type: intent.orderType,
    post_only: intent.postOnly,
    time_in_force: intent.timeInForce,
    requested_quantity: intent.requestedQuantity,
    requested_notional: intent.requestedNotional,
    requested_price: intent.requestedPrice,
    idempotency_key: intent.idempotencyKey,
    expected_loss_bps_of_equity: intent.metadata.expected_loss_bps_of_equity,
  };

  return {
    ...intent,
    costInput: {
      expectedReturnBps: "40",
      entryFeeBps: "5",
      exitFeeBps: "5",
      spreadCostBpsP75: "2",
      expectedSlippageBpsP95: "2",
      cancelRequotePenaltyBps: "1",
      safetyBufferBps: "10",
    },
    risk: {
      account: {
        equityKrw: "1000000",
        dailyRealizedPnlBps: "0",
        weeklyRealizedPnlBps: "0",
        maxDrawdownBps: "0",
        capturedAt: "2026-06-15T00:00:00.000Z",
      },
      positions: [],
      strategy: {
        strategyId: intent.strategyId,
        consecutiveLosses: 0,
        capturedAt: "2026-06-15T00:00:00.000Z",
      },
      infrastructureSignals: [],
      thresholdSnapshot: {
        thresholds: {
          dailyLossLimitBps: "100",
          weeklyLossLimitBps: "300",
          maxDrawdownBps: "500",
          maxOrderNotionalBpsOfEquity: "100",
          maxExpectedLossBpsOfEquity: "20",
          btcEthMaxPositionBpsOfEquity: "2000",
          altMaxPositionBpsOfEquity: "500",
          totalAltMaxPositionBpsOfEquity: "1500",
          maxConsecutiveStrategyLosses: 3,
        },
        capturedAt: "2026-06-15T00:00:00.000Z",
        source: "live-ops-scripts.test",
      },
    },
    costSnapshot: {
      source: "cost_model",
      exchange_id: intent.exchangeId,
      market: intent.market,
      trade_allowed: true,
      reason_code: "cost_margin_ok",
      order_intent: orderIntentEvidence,
    },
    riskApproval: {
      source: "risk_gate",
      approved: true,
      action: "ALLOW",
      status: "PASS",
      failed_evaluation_reason_codes: [],
      order_intent: orderIntentEvidence,
    },
  };
}

function createCleanupRuntimeIntentWithKey(idempotencyKey: string, dateScope: string) {
  const intent = createCleanupRuntimeIntent() as Record<string, any>;
  const orderIntentEvidence = {
    ...(intent.costSnapshot.order_intent as Record<string, unknown>),
    idempotency_key: idempotencyKey,
  };

  return {
    ...intent,
    idempotencyKey,
    metadata: {
      ...(intent.metadata as Record<string, unknown>),
      idempotency_date_scope: dateScope,
      idempotency_date_source: "live_ops_runtime_preflight",
    },
    costSnapshot: {
      ...(intent.costSnapshot as Record<string, unknown>),
      order_intent: orderIntentEvidence,
    },
    riskApproval: {
      ...(intent.riskApproval as Record<string, unknown>),
      order_intent: orderIntentEvidence,
    },
  };
}

function createCliSellIntent({ idempotencyKey }: { idempotencyKey: string }) {
  const intent = {
    exchangeId: "upbit_krw_spot",
    market: "KRW-BTC",
    strategyId: "live_ops_autonomous_24x7_core",
    side: "SELL",
    orderType: "LIMIT",
    requestedQuantity: "0.0001",
    requestedNotional: "9900",
    requestedPrice: "99000000",
    idempotencyKey,
    reason: "autonomous_24x7_take_profit",
    postOnly: true,
    timeInForce: "POST_ONLY",
    metadata: {
      expected_loss_bps_of_equity: "5",
      position_effect: "EXIT",
      exit_reason_code: "autonomous_24x7_take_profit",
      exit_rule_id: "take_profit",
      position_scope: {
        market: "KRW-BTC",
        strategy_id: "live_ops_autonomous_24x7_core",
        total_quantity: "0.0001",
      },
    },
  };
  const orderIntentEvidence = {
    exchange_id: intent.exchangeId,
    market: intent.market,
    strategy_id: intent.strategyId,
    side: intent.side,
    order_type: intent.orderType,
    post_only: intent.postOnly,
    time_in_force: intent.timeInForce,
    requested_quantity: intent.requestedQuantity,
    requested_notional: intent.requestedNotional,
    requested_price: intent.requestedPrice,
    idempotency_key: intent.idempotencyKey,
    expected_loss_bps_of_equity: intent.metadata.expected_loss_bps_of_equity,
    position_effect: intent.metadata.position_effect,
  };

  return {
    ...intent,
    costSnapshot: {
      source: "exit_cost_model",
      exit_cost_allowed: true,
      exit_cost_reason_code: "exit_cost_margin_ok",
      exit_cost_bps: "0",
      exit_slippage_bps: "0",
      position_scope: intent.metadata.position_scope,
      order_intent: orderIntentEvidence,
    },
    riskApproval: {
      source: "risk_gate",
      approved: true,
      action: "ALLOW",
      status: "PASS",
      failed_evaluation_reason_codes: [],
      warning_evaluation_reason_codes: [],
      order_intent: orderIntentEvidence,
    },
  };
}

function liveOrderEnv(): Record<string, string> {
  return {
    SEEMIRAI_UPBIT_ACCESS_KEY: "fake-access-key",
    SEEMIRAI_UPBIT_SECRET_KEY: "fake-secret-key",
    SEEMIRAI_UPBIT_KEY_SCOPE: "자산조회,주문조회,주문하기",
    SEEMIRAI_UPBIT_KEY_SCOPE_EVIDENCE_ID: "scope-evidence",
  };
}

function minimalEnv(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    TMPDIR: process.env.TMPDIR ?? path.join(process.cwd(), "test-results"),
  };
}

async function withFakeSystemTime(isoTimestamp: string, action: () => Promise<any>): Promise<any> {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(isoTimestamp));
  try {
    return await action();
  } finally {
    vi.useRealTimers();
  }
}
