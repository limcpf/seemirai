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
    expected_loss_bps_of_equity: intent.metadata.expected_loss_bps_of_equity,
  };
}
const intent = {
  exchangeId: "upbit_krw_spot",
  market: "KRW-BTC",
  strategyId: "live_ops_fixture_strategy",
  side: "BUY",
  orderType: "LIMIT",
  requestedPrice: "100000000",
  requestedQuantity: "0.0001",
  requestedNotional: "10000",
  idempotencyKey: "ops-aaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  reason: "test order intent",
  postOnly: true,
  timeInForce: "POST_ONLY",
  metadata: {
    expected_loss_bps_of_equity: "5",
  },
};
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
});
function createRuntimeRequest(overrides = {}) {
  return {
    config: {
      enabled: true,
      allowed_markets: ["KRW-BTC"],
      max_order_krw: "10000",
      daily_autonomous_notional_limit_krw: "30000",
      max_open_position_notional_krw: "30000",
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
      referencePrice: intent.requestedPrice,
      reason: intent.reason,
      expectedLossBpsOfEquity: intent.metadata.expected_loss_bps_of_equity,
      orderType: "LIMIT",
      postOnly: true,
      timeInForce: "POST_ONLY",
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
  topLevelSubmittedBlocked,
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
      topLevelSubmittedBlocked: {
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
    expect(output.reservations).toEqual([
      {
        attemptId: "ops-aaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        idempotencyKey: "ops-aaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        market: "KRW-BTC",
        strategyId: "live_ops_fixture_strategy",
        requestedNotionalKrw: "10000",
      },
    ]);
    expect(output.submitted).toHaveLength(1);
    expect(output.submitted[0]?.intent).toMatchObject({
      exchangeId: "upbit_krw_spot",
      market: "KRW-BTC",
      side: "BUY",
      orderType: "LIMIT",
      postOnly: true,
      timeInForce: "POST_ONLY",
      idempotencyKey: "ops-aaaaaaaaaaaaaaaaaaaaaaaaaaaa",
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
    expect(output.topLevelSubmittedBlocked).toMatchObject({
      status: "blocked",
      liveOrderCapable: true,
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
