import { randomUUID } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { BrokerPort } from "../../src/application/index.js";
import type {
  BrokerBalanceSnapshot,
  BrokerOrder,
  JsonRecord,
  OrderSubmission,
  PilotEvidenceStatus,
} from "../../src/domain/index.js";
import { redactPilotCorrelationId } from "../../src/domain/index.js";
import {
  UpbitPrivateRestClient,
  toUpbitPrivateUserActionErrorSummary,
} from "../../src/infrastructure/index.js";
import type {
  UpbitLiveBrokerPrivateClient,
  UpbitPrivateCancelOrderInput,
  UpbitPrivateCreateLimitOrderInput,
  UpbitPrivateGetOrderInput,
  UpbitPrivateListOpenOrdersInput,
  UpbitRateLimitStatus,
} from "../../src/infrastructure/index.js";
import {
  UnsafePilotOrderSmokeRequestError,
  UnsafePilotRuntimeConfigError,
  UnsafeUpbitLiveBrokerRuntimeError,
  createGuardedUpbitLiveBrokerRuntime,
  createPilotOrderSmokeRequestPlan,
  loadPilotRuntimeConfigFromEnv,
} from "../../src/runtime/index.js";
import type {
  EnabledPilotRuntimeConfig,
  PilotOrderSmokeRequestPlan,
  UpbitLiveBrokerRuntimeSafeSummary,
} from "../../src/runtime/index.js";
import {
  assertUpbitSmokeArtifactHasNoSecretText,
  writeUpbitSmokeArtifact,
} from "../helpers/upbit-smoke-artifacts.js";

const observedAt = "2026-06-02T00:00:00.000Z";
const defaultUpbitRateLimitStatus = {
  kind: "OK",
  remainingReq: {
    group: "default",
    deprecatedMin: 1800,
    sec: 9,
    exhausted: false,
  },
} satisfies UpbitRateLimitStatus;

const runUpbitLiveBrokerSmoke =
  process.env.SEEMIRAI_RUN_UPBIT_LIVE_BROKER_SMOKE === "1" &&
  process.env.SEEMIRAI_RUN_UPBIT_PRIVATE_SMOKE === "1" &&
  process.env.SEEMIRAI_RUN_UPBIT_ORDER_SMOKE === "1";
// live broker smoke는 주문 생성/취소 side effect가 가능하므로 세 guard가 모두 켜진 수동 실행에서만 열린다.
const describeUpbitLiveBrokerSmoke = runUpbitLiveBrokerSmoke ? describe : describe.skip;

/**
 * 운영자가 실제 live broker smoke 직전에 확정해 전달하는 주문 입력이다.
 *
 * price/volume/identifier를 코드가 자동 산정하지 않고, M14 order-smoke guard와 M15 broker guard가 같은 값을 검증한다.
 * 이 type은 env를 해석한 값만 담으며 외부 API side effect를 만들지 않는다.
 */
interface OperatorLiveBrokerSmokeInput {
  price: string;
  volume: string;
  identifier: string;
}

describe("Upbit live broker smoke integration with fake adapter", () => {
  it("BrokerPort full flow를 fake private client로 실행하고 secret-safe artifact를 저장한다", async () => {
    const artifactDir = await mkdtemp(path.join(os.tmpdir(), "seemirai-upbit-live-broker-smoke-"));
    const env = {
      SEEMIRAI_UPBIT_ACCESS_KEY: "fixture-access-key-raw-value",
      SEEMIRAI_UPBIT_SECRET_KEY: "fixture-secret-key-raw-value",
      SEEMIRAI_UPBIT_SMOKE_ARTIFACT_DIR: artifactDir,
    } satisfies NodeJS.ProcessEnv;
    const fakeClient = createStatefulFakeUpbitLiveBrokerPrivateClient();
    const runtime = createGuardedUpbitLiveBrokerRuntime({
      liveBrokerEnabled: true,
      pilotConfig: createEnabledOrderSmokePilotConfig(),
      privateClientFactory: vi.fn(() => fakeClient),
      clock: () => observedAt,
    });
    const submission = createLiveBrokerSmokeSubmission({
      market: "KRW-BTC",
      price: "5000000",
      volume: "0.001",
      identifier: "live-broker-smoke-1",
      notionalKrw: "5000",
    });

    const balances = await runtime.broker.getBalances();
    const submittedOrder = await runtime.broker.submitOrder(submission);
    const openOrders = await runtime.broker.listOpenOrders("KRW-BTC");
    const lookupOrder = await runtime.broker.getOrder(submittedOrder.brokerOrderId);
    const canceledOrder = await runtime.broker.cancelOrder(submittedOrder.brokerOrderId);
    const openOrdersAfterCancel = await runtime.broker.listOpenOrders("KRW-BTC");
    const artifact = createLiveBrokerSmokeArtifact({
      kind: "UPBIT_LIVE_BROKER_FAKE_SMOKE",
      status: "PASSED",
      occurredAt: observedAt,
      correlationId: randomUUID(),
      runtimeSummary: runtime.summary,
      balances,
      submittedOrder,
      lookupOrder,
      canceledOrder,
      openOrders,
      openOrdersAfterCancel,
    });
    const artifactPath = await writeUpbitSmokeArtifact({
      filePrefix: "upbit-live-broker-fake-smoke",
      artifact,
      env,
    });
    const artifactText = await readFile(artifactPath, "utf8");

    expect(fakeClient.createLimitOrder).toHaveBeenCalledWith({
      market: "KRW-BTC",
      side: "bid",
      volume: "0.001",
      price: "5000000",
      identifier: "live-broker-smoke-1",
      timeInForce: "post_only",
    });
    expect(fakeClient.cancelOrder).toHaveBeenCalledWith({ uuid: "upbit-order-001" });
    expect(openOrders).toHaveLength(1);
    expect(openOrdersAfterCancel).toHaveLength(0);
    expect(submittedOrder.status).toBe("ACCEPTED");
    expect(canceledOrder.status).toBe("CANCELED");
    expect(artifactText).not.toContain("fixture-access-key-raw-value");
    expect(artifactText).not.toContain("fixture-secret-key-raw-value");
    expect(artifactText).not.toContain("Authorization");
    expect(artifactText).not.toContain("jwt");
    assertUpbitSmokeArtifactHasNoSecretText(JSON.parse(artifactText) as JsonRecord, env);
  });

  it("submit 성공 후 cancel 전 조회 실패가 나면 broker order id로 cleanup cancel을 시도한다", async () => {
    const fakeClient = createStatefulFakeUpbitLiveBrokerPrivateClient();
    const runtime = createGuardedUpbitLiveBrokerRuntime({
      liveBrokerEnabled: true,
      pilotConfig: createEnabledOrderSmokePilotConfig(),
      privateClientFactory: vi.fn(() => fakeClient),
      clock: () => observedAt,
    });
    const plan = createPilotOrderSmokeRequestPlan({
      pilotConfig: createEnabledOrderSmokePilotConfig(),
      intent: {
        market: "KRW-BTC",
        side: "bid",
        price: "5000000",
        volume: "0.001",
        identifier: "live-broker-smoke-1",
        timeInForce: "post_only",
      },
    });
    const submittedOrder = await runtime.broker.submitOrder(createLiveBrokerSmokeSubmissionFromPlan(plan));
    vi.mocked(fakeClient.getOrder).mockRejectedValueOnce(new Error("temporary lookup failure"));

    await expect(runtime.broker.getOrder(submittedOrder.brokerOrderId)).rejects.toThrow("temporary lookup failure");
    const artifact = createBaseArtifact("UPBIT_LIVE_BROKER_FAKE_SMOKE", observedAt, randomUUID());
    await attemptLiveBrokerSmokeCleanup({
      runtimeBroker: runtime.broker,
      runtimeBrokerOrder: submittedOrder,
      cancelConfirmed: false,
      artifact,
      correlationId: randomUUID(),
    });

    expect(fakeClient.cancelOrder).toHaveBeenCalledWith({ uuid: "upbit-order-001" });
    expect(artifact.cleanupBrokerCancelOrder).toMatchObject({
      brokerOrderId: "upbit-order-001",
      status: "CANCELED",
    });
  });
});

describeUpbitLiveBrokerSmoke("Upbit live broker real smoke integration", () => {
  it("guarded UpbitLiveBroker로 단일 post_only 지정가 주문을 생성, 조회, 취소한다", async () => {
    const correlationId = randomUUID();
    const occurredAt = new Date().toISOString();
    const artifact = createBaseArtifact("UPBIT_LIVE_BROKER_SMOKE", occurredAt, correlationId);
    let plan: PilotOrderSmokeRequestPlan | undefined;
    let runtimeBroker: BrokerPort | undefined;
    let runtimeBrokerOrder: BrokerOrder | undefined;
    let privateClient: UpbitPrivateRestClient | undefined;
    let orderSideEffectPossible = false;
    let cancelConfirmed = false;
    let failure: unknown;

    try {
      const config = loadEnabledLiveBrokerSmokeConfig(process.env);
      const operatorInput = loadOperatorLiveBrokerSmokeInput(process.env);
      plan = createPilotOrderSmokeRequestPlan({
        pilotConfig: config,
        intent: {
          market: requireConfigValue(config.orderSmokeMarket, "SEEMIRAI_UPBIT_ORDER_SMOKE_MARKET"),
          side: "bid",
          price: operatorInput.price,
          volume: operatorInput.volume,
          identifier: operatorInput.identifier,
          timeInForce: "post_only",
        },
      });
      const runtime = createGuardedUpbitLiveBrokerRuntime({
        liveBrokerEnabled: true,
        pilotConfig: config,
        privateClientFactory: (credentials) => {
          privateClient = new UpbitPrivateRestClient({ credentials });
          return privateClient;
        },
      });
      runtimeBroker = runtime.broker;
      artifact.profile = config.profile;
      artifact.keyScopeEvidenceId = config.keyScopeEvidenceId;
      artifact.runtimeSummary = summarizeRuntimeSummary(runtime.summary);
      artifact.orderPlan = summarizeOrderSmokePlan(plan);

      const balances = await runtimeBroker.getBalances();
      artifact.balances = summarizeBalanceSnapshot(balances);

      orderSideEffectPossible = true;
      runtimeBrokerOrder = await runtimeBroker.submitOrder(createLiveBrokerSmokeSubmissionFromPlan(plan));
      artifact.submittedOrder = summarizeBrokerOrder(runtimeBrokerOrder);

      const lookupOrder = await runtimeBroker.getOrder(runtimeBrokerOrder.brokerOrderId);
      artifact.lookupOrder = summarizeOptionalBrokerOrder(lookupOrder);

      const canceledOrder = await runtimeBroker.cancelOrder(runtimeBrokerOrder.brokerOrderId);
      cancelConfirmed = true;
      artifact.canceledOrder = summarizeBrokerOrder(canceledOrder);

      const postCancelLookup = await runtimeBroker.getOrder(runtimeBrokerOrder.brokerOrderId);
      artifact.postCancelLookupOrder = summarizeOptionalBrokerOrder(postCancelLookup);
      artifact.status = "PASSED" satisfies PilotEvidenceStatus;
      artifact.message = "Upbit live broker smoke가 BrokerPort 경유 주문 생성, 조회, 취소를 완료했습니다.";
    } catch (error) {
      failure = error;
      artifact.status = orderSideEffectPossible
        ? ("MANUAL_REVIEW_REQUIRED" satisfies PilotEvidenceStatus)
        : ("FAILED" satisfies PilotEvidenceStatus);
      artifact.message = orderSideEffectPossible
        ? "live broker 주문 제출 이후 취소 또는 조회 확인이 실패해 추가 주문 없이 수동 점검으로 전환했습니다."
        : "live broker 주문 제출 전에 smoke가 실패했거나 거래소가 주문 생성을 거부했습니다.";
      artifact.action = orderSideEffectPossible
        ? "같은 identifier와 broker order id로 Upbit 웹 또는 private order lookup에서 주문 상태와 취소 여부를 수동 확인하세요."
        : "환경, guard, key scope evidence, 잔고, 운영자 입력값을 확인한 뒤 private/order smoke부터 다시 실행하세요.";
      artifact.error = toSafeLiveBrokerSmokeErrorSummary(error, correlationId);
      await attemptLiveBrokerSmokeCleanup({
        privateClient,
        plan,
        runtimeBroker,
        runtimeBrokerOrder,
        cancelConfirmed,
        artifact,
        correlationId,
      });
    } finally {
      const artifactPath = await writeUpbitSmokeArtifact({
        filePrefix: "upbit-live-broker-smoke",
        artifact,
      });
      artifact.reportArtifactPath = artifactPath;
      assertUpbitSmokeArtifactHasNoSecretText(artifact);
    }

    if (failure !== undefined) {
      throw failure;
    }

    expect(artifact.status).toBe("PASSED");
  }, 60_000);
});

/**
 * 실제 live broker smoke 실행에 필요한 env guard를 활성 config로 해석한다.
 *
 * live broker 전용 guard와 기존 M14 private/order guard가 모두 있어야 하며, 조건이 빠지면 private client 조립 전에 닫는다.
 */
function loadEnabledLiveBrokerSmokeConfig(env: NodeJS.ProcessEnv): EnabledPilotRuntimeConfig {
  if (env.SEEMIRAI_RUN_UPBIT_LIVE_BROKER_SMOKE !== "1") {
    throw new UnsafePilotRuntimeConfigError(["SEEMIRAI_RUN_UPBIT_LIVE_BROKER_SMOKE=1 이 필요합니다"]);
  }

  const config = loadPilotRuntimeConfigFromEnv(env);
  if (!config.enabled || config.profile !== "PILOT_ORDER_SMOKE") {
    // live broker smoke는 주문 생성 권한이 열리는 profile에서만 의미가 있으므로 read-only/policy profile은 닫는다.
    throw new UnsafePilotRuntimeConfigError(["PILOT_ORDER_SMOKE profile이 필요합니다"]);
  }

  return config;
}

/**
 * 운영자 live broker smoke 입력을 env에서 읽는다.
 *
 * 가격, 수량, identifier가 없으면 주문 입력을 자동 생성하지 않고 fail-closed 한다. 이 함수는 env만 읽으며 API 호출 side effect는 없다.
 */
function loadOperatorLiveBrokerSmokeInput(env: NodeJS.ProcessEnv): OperatorLiveBrokerSmokeInput {
  return {
    price: readRequiredEnv(env, "SEEMIRAI_UPBIT_ORDER_SMOKE_PRICE"),
    volume: readRequiredEnv(env, "SEEMIRAI_UPBIT_ORDER_SMOKE_VOLUME"),
    identifier: readRequiredEnv(env, "SEEMIRAI_UPBIT_ORDER_SMOKE_IDENTIFIER"),
  };
}

function readRequiredEnv(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]?.trim();
  if (value === undefined || value.length === 0) {
    // 주문 입력 자동 산정을 금지해 운영자가 승인하지 않은 실주문 파라미터가 만들어지지 않게 한다.
    throw new UnsafePilotRuntimeConfigError([`${key} 가 필요합니다`]);
  }

  return value;
}

function requireConfigValue(value: string | undefined, key: string): string {
  if (value === undefined) {
    throw new UnsafePilotRuntimeConfigError([`${key} 가 필요합니다`]);
  }

  return value;
}

/**
 * M14 order-smoke plan을 BrokerPort 제출 요청으로 변환한다.
 *
 * `identifier`는 그대로 `idempotencyKey`로 사용하고, post-only 지정가 매수 invariant를 domain `OrderSubmission`에 보존한다.
 * 변환 자체는 순수하며 외부 API 호출 side effect가 없다.
 */
function createLiveBrokerSmokeSubmissionFromPlan(plan: PilotOrderSmokeRequestPlan): OrderSubmission {
  return createLiveBrokerSmokeSubmission({
    market: plan.createOrder.market,
    price: plan.createOrder.price,
    volume: plan.createOrder.volume,
    identifier: plan.createOrder.identifier,
    notionalKrw: plan.notionalKrw,
  });
}

/**
 * 테스트와 real smoke가 공유하는 live broker 주문 제출 요청을 만든다.
 *
 * M15 범위에서는 자동 전략 루프를 열지 않으므로 strategy id와 reason은 smoke evidence 용도로만 고정한다. 반환값은 아직 제출되지
 * 않은 요청이며 side effect가 없다.
 */
function createLiveBrokerSmokeSubmission(input: {
  market: string;
  price: string;
  volume: string;
  identifier: string;
  notionalKrw: string;
}): OrderSubmission {
  return {
    intent: {
      exchangeId: "upbit_krw_spot",
      market: input.market,
      strategyId: "m15_live_broker_smoke",
      side: "BUY",
      orderType: "LIMIT",
      requestedPrice: input.price,
      requestedQuantity: input.volume,
      requestedNotional: input.notionalKrw,
      idempotencyKey: input.identifier,
      reason: "M15 live broker smoke",
      postOnly: true,
      timeInForce: "POST_ONLY",
    },
    costSnapshot: {
      source: "m15_live_broker_smoke",
    },
    riskApproval: {
      source: "m15_live_broker_smoke",
      status: "APPROVED",
    },
    submittedAt: observedAt,
  };
}

/**
 * fake Upbit private client를 stateful broker adapter로 만든다.
 *
 * 실제 네트워크 호출 없이 create/list/get/cancel이 같은 주문 UUID와 identifier를 공유하게 해 `UpbitLiveBroker` mapper와 runtime
 * guard의 full flow를 검증한다.
 */
function createStatefulFakeUpbitLiveBrokerPrivateClient(): UpbitLiveBrokerPrivateClient {
  let currentOrder: Record<string, unknown> | undefined;

  return {
    createLimitOrder: vi.fn(async (input: UpbitPrivateCreateLimitOrderInput) => {
      currentOrder = createUpbitCommandOrderPayload({
        market: input.market,
        side: input.side,
        price: input.price,
        volume: input.volume,
        remaining_volume: input.volume,
        identifier: input.identifier,
        time_in_force: input.timeInForce,
      });

      return {
        payload: currentOrder,
        rateLimitStatus: defaultUpbitRateLimitStatus,
      };
    }),
    cancelOrder: vi.fn(async (input: UpbitPrivateCancelOrderInput) => {
      if (currentOrder === undefined || !orderMatchesIdentifierInput(currentOrder, input)) {
        throw new Error("fake Upbit order not found");
      }

      currentOrder = {
        ...currentOrder,
        state: "cancel",
        remaining_volume: "0",
      };

      return {
        payload: currentOrder,
        rateLimitStatus: defaultUpbitRateLimitStatus,
      };
    }),
    getOrder: vi.fn(async (input: UpbitPrivateGetOrderInput) => {
      if (currentOrder === undefined || !orderMatchesIdentifierInput(currentOrder, input)) {
        throw new Error("fake Upbit order not found");
      }

      return {
        payload: createUpbitLookupOrderPayload(currentOrder),
        rateLimitStatus: defaultUpbitRateLimitStatus,
      };
    }),
    listOpenOrders: vi.fn(async (input: UpbitPrivateListOpenOrdersInput = {}) => {
      const marketMatches =
        currentOrder !== undefined &&
        (input.market === undefined || currentOrder.market === input.market);
      const orderIsOpen = currentOrder?.state === "wait" || currentOrder?.state === "watch";

      return {
        payload: marketMatches && orderIsOpen ? [createUpbitOpenOrderPayload(currentOrder)] : [],
        rateLimitStatus: defaultUpbitRateLimitStatus,
      };
    }),
    getAccounts: vi.fn(async () => ({
      payload: [
        {
          currency: "KRW",
          balance: "10000",
          locked: "0",
          avg_buy_price: "0",
          avg_buy_price_modified: false,
          unit_currency: "KRW",
        },
      ],
      rateLimitStatus: defaultUpbitRateLimitStatus,
    })),
  };
}

function orderMatchesIdentifierInput(order: Record<string, unknown>, input: UpbitPrivateCancelOrderInput | UpbitPrivateGetOrderInput): boolean {
  if (input.uuid !== undefined) {
    return order.uuid === input.uuid;
  }

  return input.identifier !== undefined && order.identifier === input.identifier;
}

function createUpbitCommandOrderPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    market: "KRW-BTC",
    uuid: "upbit-order-001",
    side: "bid",
    ord_type: "limit",
    price: "5000000",
    state: "wait",
    created_at: observedAt,
    volume: "0.001",
    remaining_volume: "0.001",
    executed_volume: "0",
    reserved_fee: "2.5",
    remaining_fee: "2.5",
    paid_fee: "0",
    locked: "5002.5",
    time_in_force: "post_only",
    identifier: "live-broker-smoke-1",
    prevented_volume: "0",
    prevented_locked: "0",
    trades_count: 0,
    ...overrides,
  };
}

function createUpbitLookupOrderPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...createUpbitCommandOrderPayload(overrides),
    trades: [],
  };
}

function createUpbitOpenOrderPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...createUpbitCommandOrderPayload(overrides),
  };
}

function createEnabledOrderSmokePilotConfig(
  overrides: Partial<EnabledPilotRuntimeConfig> = {},
): EnabledPilotRuntimeConfig {
  return {
    enabled: true,
    profile: "PILOT_ORDER_SMOKE",
    privateSmokeEnabled: true,
    orderSmokeEnabled: true,
    upbitAccessKey: "fixture-upbit-access-key",
    upbitSecretKey: "fixture-upbit-secret-key",
    keyScopes: ["자산조회", "주문조회", "주문하기"],
    keyScopeEvidenceId: "evidence-live-broker-001",
    policySyncMarket: "KRW-BTC",
    orderSmokeMarket: "KRW-BTC",
    orderSmokeMaxKrw: "5000",
    ...overrides,
  };
}

function createBaseArtifact(kind: string, occurredAt: string, correlationId: string): JsonRecord {
  return {
    schemaVersion: 1,
    kind,
    status: "FAILED" satisfies PilotEvidenceStatus,
    occurredAt,
    correlationId: redactPilotCorrelationId(correlationId),
    redactionVerified: true,
  };
}

function createLiveBrokerSmokeArtifact(input: {
  kind: string;
  status: PilotEvidenceStatus;
  occurredAt: string;
  correlationId: string;
  runtimeSummary: UpbitLiveBrokerRuntimeSafeSummary;
  balances: BrokerBalanceSnapshot;
  submittedOrder: BrokerOrder;
  lookupOrder: BrokerOrder | undefined;
  canceledOrder: BrokerOrder;
  openOrders: readonly BrokerOrder[];
  openOrdersAfterCancel: readonly BrokerOrder[];
}): JsonRecord {
  return {
    ...createBaseArtifact(input.kind, input.occurredAt, input.correlationId),
    status: input.status,
    message: "fake Upbit private client로 live broker BrokerPort full flow를 검증했습니다.",
    runtimeSummary: summarizeRuntimeSummary(input.runtimeSummary),
    balances: summarizeBalanceSnapshot(input.balances),
    submittedOrder: summarizeBrokerOrder(input.submittedOrder),
    lookupOrder: summarizeOptionalBrokerOrder(input.lookupOrder),
    canceledOrder: summarizeBrokerOrder(input.canceledOrder),
    openOrders: summarizeBrokerOrderList(input.openOrders),
    openOrdersAfterCancel: summarizeBrokerOrderList(input.openOrdersAfterCancel),
  };
}

function summarizeRuntimeSummary(summary: UpbitLiveBrokerRuntimeSafeSummary): JsonRecord {
  return {
    enabled: summary.enabled,
    profile: summary.profile,
    privateSmokeEnabled: summary.privateSmokeEnabled,
    orderSmokeEnabled: summary.orderSmokeEnabled,
    credentialsConfigured: summary.credentialsConfigured,
    keyScopeEvidenceId: summary.keyScopeEvidenceId,
    orderSmokeMarket: summary.orderSmokeMarket,
    orderSmokeMaxKrw: summary.orderSmokeMaxKrw,
    statusLabel: summary.statusLabel,
    traceReason: summary.trace.reason,
  };
}

function summarizeOrderSmokePlan(plan: PilotOrderSmokeRequestPlan): JsonRecord {
  return {
    market: plan.createOrder.market,
    side: plan.createOrder.side,
    price: plan.createOrder.price,
    volume: plan.createOrder.volume,
    identifier: plan.createOrder.identifier,
    timeInForce: plan.createOrder.timeInForce,
    notionalKrw: plan.notionalKrw,
  };
}

function summarizeBalanceSnapshot(snapshot: BrokerBalanceSnapshot): JsonRecord {
  const currencies = snapshot.balances.map((balance) => balance.currency).sort();
  return {
    exchangeId: snapshot.exchangeId,
    capturedAt: snapshot.capturedAt,
    accountCount: snapshot.balances.length,
    currencies,
    krwAccountPresent: currencies.includes("KRW"),
  };
}

function summarizeBrokerOrder(order: BrokerOrder): JsonRecord {
  return {
    brokerOrderId: order.brokerOrderId,
    idempotencyKey: order.idempotencyKey,
    exchangeId: order.exchangeId,
    market: order.market,
    side: order.side,
    orderType: order.orderType,
    status: order.status,
    requestedQuantity: order.requestedQuantity,
    remainingQuantity: order.remainingQuantity,
    requestedPrice: order.requestedPrice ?? null,
    acceptedAt: order.acceptedAt ?? null,
    updatedAt: order.updatedAt,
    operation: order.metadata?.upbitLiveBrokerOperation ?? null,
  };
}

function summarizeOptionalBrokerOrder(order: BrokerOrder | undefined): JsonRecord {
  if (order === undefined) {
    return {
      found: false,
    };
  }

  return {
    found: true,
    ...summarizeBrokerOrder(order),
  };
}

function summarizeBrokerOrderList(orders: readonly BrokerOrder[]): readonly JsonRecord[] {
  return orders.map((order) => summarizeBrokerOrder(order));
}

/**
 * live broker smoke cleanup 함수에 넘기는 실행 상태다.
 *
 * runtime broker와 private client 중 사용 가능한 정리 경계를 표현한다. 이미 취소가 확인된 주문에는 추가 side effect를 만들지
 * 않고, 취소 미확인 주문만 같은 smoke UUID/identifier 경계에서 정리해야 한다는 invariant를 유지한다.
 */
interface AttemptLiveBrokerSmokeCleanupInput {
  privateClient?: Pick<UpbitLiveBrokerPrivateClient, "cancelOrder"> | undefined;
  plan?: PilotOrderSmokeRequestPlan | undefined;
  runtimeBroker?: BrokerPort | undefined;
  runtimeBrokerOrder?: BrokerOrder | undefined;
  cancelConfirmed: boolean;
  artifact: JsonRecord;
  correlationId: string;
}

/**
 * live broker smoke 실패 시 남을 수 있는 실주문을 같은 smoke evidence로 정리한다.
 *
 * submit이 성공했지만 조회/후속 검증이 실패한 경우에는 wrapper가 기록한 broker order id로 먼저 취소하고, submit 응답을 받지 못한
 * 모호한 실패에서는 M14 order-smoke identifier cleanup으로 내려간다. 새 주문은 만들지 않고 취소 evidence만 artifact에 남긴다.
 */
async function attemptLiveBrokerSmokeCleanup(input: AttemptLiveBrokerSmokeCleanupInput): Promise<void> {
  if (input.cancelConfirmed) {
    return;
  }

  if (input.runtimeBroker !== undefined && input.runtimeBrokerOrder !== undefined) {
    try {
      // submit 성공 후 조회 실패처럼 아직 취소 전인 경로는 같은 runtime wrapper가 허용한 UUID로 먼저 정리한다.
      const cleanupCancel = await input.runtimeBroker.cancelOrder(input.runtimeBrokerOrder.brokerOrderId);
      input.artifact.cleanupBrokerCancelOrder = summarizeBrokerOrder(cleanupCancel);
      return;
    } catch (error) {
      input.artifact.cleanupBrokerCancelWarning = toSafeLiveBrokerSmokeErrorSummary(error, input.correlationId);
    }
  }

  if (input.privateClient === undefined || input.plan === undefined) {
    return;
  }

  try {
    const cleanupCancelInput =
      input.runtimeBrokerOrder === undefined
        ? input.plan.cancelOrder
        : { uuid: input.runtimeBrokerOrder.brokerOrderId };

    // submit 응답이 없거나 wrapper cleanup이 실패한 경우에도 같은 UUID/identifier 경계로만 정리한다.
    const cleanupCancel = await input.privateClient.cancelOrder(cleanupCancelInput);
    input.artifact.cleanupCancelOrder = summarizeProviderOrderPayload(cleanupCancel.payload);
    input.artifact.cleanupCancelRateLimit = cleanupCancel.rateLimitStatus;
  } catch (error) {
    input.artifact.cleanupError = toSafeLiveBrokerSmokeErrorSummary(error, input.correlationId);
  }
}

function summarizeProviderOrderPayload(payload: unknown): JsonRecord {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return {
      payloadShape: "unexpected",
    };
  }

  const record = payload as Record<string, unknown>;
  return {
    payloadShape: "object",
    uuid: typeof record.uuid === "string" ? record.uuid : null,
    identifier: typeof record.identifier === "string" ? record.identifier : null,
    market: typeof record.market === "string" ? record.market : null,
    side: typeof record.side === "string" ? record.side : null,
    state: typeof record.state === "string" ? record.state : null,
  };
}

function toSafeLiveBrokerSmokeErrorSummary(error: unknown, correlationId: string): JsonRecord {
  if (
    error instanceof UnsafePilotRuntimeConfigError ||
    error instanceof UnsafePilotOrderSmokeRequestError ||
    error instanceof UnsafeUpbitLiveBrokerRuntimeError
  ) {
    return {
      title: "live broker smoke 실행 조건을 확인해야 합니다.",
      requiredAction: "live broker, private/order smoke guard, market, budget, price, volume, identifier, key scope evidence를 확인하세요.",
      violations: error.violations,
      correlationId: redactPilotCorrelationId(correlationId),
    };
  }

  return toUpbitPrivateUserActionErrorSummary(error, {
    correlationId: redactPilotCorrelationId(correlationId),
  }) as unknown as JsonRecord;
}
