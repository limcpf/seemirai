import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("production live ops script skeleton", () => {
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
    expect(result.stdout).toContain("Reconcile/PnL/status: 상태 요약 확인 - provider 호출 없음");
    expect(result.stdout).toContain("Telegram 알림: fixture alert plan 확인");
    expect(result.stdout).toContain("Market data: 체결 1 / 호가 1 / 상태 1");
    expect(result.stdout).toContain("Analysis/decision: 보류 / 주문 후보 0");
    expect(result.stdout).toContain("Live execution: 후보 없음 / 주문 후보 0 / broker 제출 0");
    expect(result.stdout).toContain("Reconcile/PnL/status: fixture 요약 / 대사 정상 / PnL 관측 대기 / open 주문 0 / provider 호출 0");
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
    expect(result.stdout).toContain("Reconcile/PnL/status: 상태 요약 확인 - provider 호출 없음");
    expect(result.stdout).toContain("Telegram 알림: fixture alert plan 확인");
    expect(result.stdout).not.toContain("fake-local-control-token");
  });

  it("production live ops closeout source scan은 private order/Telegram 직접 호출 경계가 없음을 확인한다", async () => {
    const productionFiles = [
      "scripts/run-live-ops-support.mjs",
      "scripts/run-live-ops.mjs",
      "scripts/run-live-ops-tui.mjs",
      "src/runtime/live-ops-market-data.ts",
      "src/runtime/live-ops-market-data/collector.ts",
      "src/runtime/live-ops-analysis-decision.ts",
      "src/runtime/live-ops-analysis-decision/pipeline.ts",
      "src/runtime/live-ops-live-execution.ts",
      "src/runtime/live-ops-live-execution/service.ts",
      "src/runtime/live-ops-telegram-alerts.ts",
      "src/runtime/live-ops-telegram-alerts/plan.ts",
    ];
    const forbiddenPatterns = [
      /POST\s+\/v1\/orders/u,
      /DELETE\s+\/v1\/order/u,
      /Authorization/u,
      /Bearer/u,
      /UpbitPrivateRestClient/u,
      /createGuardedUpbitLiveBrokerRuntime/u,
      /sendMessage/u,
      /fetch\s*\(/u,
    ];

    for (const filePath of productionFiles) {
      const content = await readFile(path.join(process.cwd(), filePath), "utf8");
      for (const forbiddenPattern of forbiddenPatterns) {
        expect(content, `${filePath} must not match ${forbiddenPattern.source}`).not.toMatch(forbiddenPattern);
      }
    }
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
const directBrokerPortMissingResult = await createLiveOpsCliEntryRuntime({
  budgetReservation,
}).submitEntryCandidate(createRuntimeRequest());
const strategyDecisionKey = "live_ops_fixture_strategy:upbit_krw_spot:KRW-BTC:BUY:2026-06-15T00:00:00.000Z";
const strategyKeyIntent = {
  ...intent,
  idempotencyKey: strategyDecisionKey,
  timeInForce: "GTC",
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
  directBrokerPortMissingResult,
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
      directBrokerPortMissingResult: {
        status: string;
        violations: string[];
        trace: {
          reason: string;
        };
      };
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
    expect(output.directBrokerPortMissingResult).toMatchObject({
      status: "BLOCKED",
      violations: ["broker_port_missing"],
      trace: {
        reason: "broker_port_missing",
      },
    });
    expect(output.strategyKeyWrapperSummary).toMatchObject({
      status: "submitted",
      submittedOrderCount: 1,
    });
    expect(output.strategyKeyWrapperSummary.idempotencyKey).toMatch(/^ops-[a-f0-9]{26}$/u);
    expect(output.submittedWithStrategyWrapper).toHaveLength(1);
    expect(output.submittedWithStrategyWrapper[0]?.intent.idempotencyKey).toBe(output.strategyKeyWrapperSummary.idempotencyKey);
    expect(output.submittedWithStrategyWrapper[0]?.intent.timeInForce).toBe("GTC");
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
    expect(result.stdout).not.toContain("fake-secret-key");
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

function minimalEnv(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    TMPDIR: process.env.TMPDIR ?? path.join(process.cwd(), "test-results"),
  };
}
