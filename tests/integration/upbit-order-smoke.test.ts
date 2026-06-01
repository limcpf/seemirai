import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type {
  BrokerBalanceSnapshot,
  JsonRecord,
  OrderChancePolicy,
  PilotEvidenceStatus,
} from "../../src/domain/index.js";
import { redactPilotCorrelationId } from "../../src/domain/index.js";
import {
  UpbitPrivateRestClient,
  toBrokerBalanceSnapshot,
  toOrderChancePolicy,
  toUpbitPrivateUserActionErrorSummary,
} from "../../src/infrastructure/index.js";
import {
  UnsafePilotOrderSmokeRequestError,
  UnsafePilotRuntimeConfigError,
  createPilotOrderSmokeRequestPlan,
  loadPilotRuntimeConfigFromEnv,
} from "../../src/runtime/index.js";
import type {
  EnabledPilotRuntimeConfig,
  PilotOrderSmokeRequestPlan,
} from "../../src/runtime/index.js";
import { parseFinancialDecimal } from "../../src/shared/index.js";
import {
  assertUpbitSmokeArtifactHasNoSecretText,
  writeUpbitSmokeArtifact,
} from "../helpers/upbit-smoke-artifacts.js";

const runUpbitOrderSmoke =
  process.env.SEEMIRAI_RUN_UPBIT_PRIVATE_SMOKE === "1" &&
  process.env.SEEMIRAI_RUN_UPBIT_ORDER_SMOKE === "1";
// 두 guard가 모두 없으면 실계좌 주문 side effect를 만들 수 있는 test body 자체를 실행하지 않는다.
const describeUpbitOrderSmoke = runUpbitOrderSmoke ? describe : describe.skip;

/**
 * 운영자가 실제 order smoke 직전에 확정해 전달하는 주문 입력이다.
 *
 * 코드가 가격/수량/identifier를 자동 산정하지 않는 경계이며, 이 값은 plan 검증을 통과하기 전에는 Upbit 주문 API 호출로
 * 이어지면 안 된다. 타입 자체는 외부 side effect가 없다.
 */
interface OperatorOrderSmokeInput {
  price: string;
  volume: string;
  identifier: string;
}

describeUpbitOrderSmoke("Upbit order API smoke integration", () => {
  it("운영자가 명시한 단일 post_only 지정가 주문을 생성 후 같은 identifier로 취소한다", async () => {
    const correlationId = randomUUID();
    const occurredAt = new Date().toISOString();
    const artifact: JsonRecord = createBaseArtifact("UPBIT_ORDER_SMOKE", occurredAt, correlationId);
    let plan: PilotOrderSmokeRequestPlan | undefined;
    let createSucceeded = false;
    let failure: unknown;

    try {
      const config = loadEnabledOrderSmokeConfig();
      const operatorInput = loadOperatorOrderSmokeInput(process.env);
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

      artifact.profile = config.profile;
      artifact.keyScopeEvidenceId = config.keyScopeEvidenceId;
      artifact.orderPlan = {
        market: plan.createOrder.market,
        side: plan.createOrder.side,
        price: plan.createOrder.price,
        volume: plan.createOrder.volume,
        identifier: plan.createOrder.identifier,
        timeInForce: plan.createOrder.timeInForce,
        notionalKrw: plan.notionalKrw,
      };

      const client = createPrivateClient(config);
      const accountsResponse = await client.getAccounts();
      const balances = toBrokerBalanceSnapshot(accountsResponse.payload, { capturedAt: occurredAt });
      assertKrwBalanceCanCoverOrder(balances, plan.notionalKrw);
      artifact.accounts = summarizeBalanceSnapshot(balances);
      artifact.accountsRateLimit = accountsResponse.rateLimitStatus;

      const orderChanceResponse = await client.getOrderChance(
        requireConfigValue(config.policySyncMarket, "SEEMIRAI_UPBIT_POLICY_SYNC_MARKET"),
      );
      const orderChance = toOrderChancePolicy(orderChanceResponse.payload, { capturedAt: occurredAt });
      assertOrderChanceCanCoverPlan(orderChance, plan);
      artifact.orderChance = summarizeOrderChancePolicy(orderChance);
      artifact.orderChanceRateLimit = orderChanceResponse.rateLimitStatus;

      const createResponse = await client.createLimitOrder(plan.createOrder);
      createSucceeded = true;
      artifact.createdOrder = summarizeProviderOrderPayload(createResponse.payload);
      artifact.createRateLimit = createResponse.rateLimitStatus;

      let cancelFailure: unknown;
      try {
        const cancelResponse = await client.cancelOrder(plan.cancelOrder);
        artifact.cancelOrder = summarizeProviderOrderPayload(cancelResponse.payload);
        artifact.cancelRateLimit = cancelResponse.rateLimitStatus;
      } catch (error) {
        cancelFailure = error;
      }

      try {
        const lookupResponse = await client.getOrder(plan.lookupOrder);
        assertLookupConfirmsCanceledOrder(lookupResponse.payload, plan.createOrder.identifier);
        artifact.lookupOrder = summarizeProviderOrderPayload(lookupResponse.payload);
        artifact.lookupRateLimit = lookupResponse.rateLimitStatus;
      } catch (error) {
        if (cancelFailure === undefined) {
          cancelFailure = error;
        }
      }

      if (cancelFailure !== undefined) {
        throw cancelFailure;
      }

      artifact.status = "PASSED" satisfies PilotEvidenceStatus;
      artifact.message = "Upbit order smoke가 단일 주문 생성, 취소, 조회 경로를 완료했습니다.";
    } catch (error) {
      failure = error;
      artifact.status = createSucceeded
        ? ("MANUAL_REVIEW_REQUIRED" satisfies PilotEvidenceStatus)
        : ("FAILED" satisfies PilotEvidenceStatus);
      artifact.message = createSucceeded
        ? "주문 생성 이후 취소 또는 조회 확인이 실패해 추가 주문 없이 수동 점검으로 전환했습니다."
        : "주문 생성 전에 smoke가 실패했거나 거래소가 주문 생성을 거부했습니다.";
      artifact.action = createSucceeded
        ? "같은 identifier로 Upbit 웹 또는 private order lookup에서 주문 상태와 취소 여부를 수동 확인하세요."
        : "환경, 잔고, 주문 가능 정책, 운영자 입력값을 확인한 뒤 private read smoke부터 다시 실행하세요.";
      artifact.error = toSafeOrderSmokeErrorSummary(error, correlationId);
    } finally {
      const artifactPath = await writeUpbitSmokeArtifact({
        filePrefix: "upbit-order-smoke",
        artifact,
      });
      artifact.reportArtifactPath = artifactPath;
      assertUpbitSmokeArtifactHasNoSecretText(artifact);
    }

    if (failure !== undefined) {
      throw failure;
    }

    expect(artifact.status).toBe("PASSED");
  });
});

function loadEnabledOrderSmokeConfig(): EnabledPilotRuntimeConfig {
  const config = loadPilotRuntimeConfigFromEnv(process.env);
  if (!config.enabled || config.profile !== "PILOT_ORDER_SMOKE") {
    // 실주문 smoke는 profile과 두 guard가 모두 명시된 별도 실행에서만 client를 조립한다.
    throw new UnsafePilotRuntimeConfigError(["PILOT_ORDER_SMOKE profile이 필요합니다"]);
  }

  return config;
}

function loadOperatorOrderSmokeInput(env: NodeJS.ProcessEnv): OperatorOrderSmokeInput {
  const price = readRequiredEnv(env, "SEEMIRAI_UPBIT_ORDER_SMOKE_PRICE");
  const volume = readRequiredEnv(env, "SEEMIRAI_UPBIT_ORDER_SMOKE_VOLUME");
  const identifier = readRequiredEnv(env, "SEEMIRAI_UPBIT_ORDER_SMOKE_IDENTIFIER");

  return {
    price,
    volume,
    identifier,
  };
}

function readRequiredEnv(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]?.trim();
  if (value === undefined || value.length === 0) {
    // price/volume/identifier 자동 산정을 금지해 운영자가 의도하지 않은 주문 입력이 만들어지지 않게 한다.
    throw new UnsafePilotRuntimeConfigError([`${key} 가 필요합니다`]);
  }

  return value;
}

function createPrivateClient(config: EnabledPilotRuntimeConfig): UpbitPrivateRestClient {
  return new UpbitPrivateRestClient({
    credentials: {
      accessKey: config.upbitAccessKey,
      secretKey: config.upbitSecretKey,
    },
  });
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

function requireConfigValue(value: string | undefined, key: string): string {
  if (value === undefined) {
    throw new UnsafePilotRuntimeConfigError([`${key} 가 필요합니다`]);
  }

  return value;
}

function assertKrwBalanceCanCoverOrder(snapshot: BrokerBalanceSnapshot, notionalKrw: string): void {
  const krwBalance = snapshot.balances.find((balance) => balance.currency === "KRW");
  if (krwBalance === undefined) {
    // KRW 계정이 확인되지 않으면 잔고 부족과 권한 문제를 구분할 수 없어 주문 생성 전에 중단한다.
    throw new UnsafePilotOrderSmokeRequestError(["KRW 잔고 계정이 확인되지 않아 주문 생성 전에 중단했습니다"]);
  }

  if (parseFinancialDecimal(krwBalance.available).lessThan(parseFinancialDecimal(notionalKrw))) {
    // 주문 생성 전 계정 잔고를 한 번 더 확인해 거래소 거부를 기다리지 않고 소액 smoke를 닫는다.
    throw new UnsafePilotOrderSmokeRequestError(["KRW 주문 가능 잔고가 smoke 주문 총액보다 작아 주문 생성 전에 중단했습니다"]);
  }
}

function assertOrderChanceCanCoverPlan(policy: OrderChancePolicy, plan: PilotOrderSmokeRequestPlan): void {
  if (!policy.allowedOrderTypes.includes("LIMIT")) {
    // orders/chance가 지정가 주문을 허용하지 않으면 post_only 주문을 만들지 않는다.
    throw new UnsafePilotOrderSmokeRequestError(["orders/chance 정책이 지정가 주문을 허용하지 않습니다"]);
  }

  if (
    policy.minimumBidNotional !== undefined &&
    parseFinancialDecimal(plan.notionalKrw).lessThan(parseFinancialDecimal(policy.minimumBidNotional))
  ) {
    throw new UnsafePilotOrderSmokeRequestError(["smoke 주문 총액이 orders/chance 최소 주문금액보다 작습니다"]);
  }

  if (
    policy.maximumBidNotional !== undefined &&
    parseFinancialDecimal(plan.notionalKrw).greaterThan(parseFinancialDecimal(policy.maximumBidNotional))
  ) {
    throw new UnsafePilotOrderSmokeRequestError(["smoke 주문 총액이 orders/chance 최대 주문금액보다 큽니다"]);
  }
}

/**
 * 주문 조회 응답이 같은 smoke run의 취소 완료 주문인지 확인한다.
 *
 * create/cancel 후 lookup이 다른 identifier를 가리키거나 취소 상태가 아니면 성공 evidence로 저장하지 않고 manual review로
 * 전환한다. 이 함수는 provider payload 검증만 수행하며 추가 API 호출 side effect는 없다.
 */
function assertLookupConfirmsCanceledOrder(payload: unknown, expectedIdentifier: string): void {
  const record = toProviderOrderRecord(payload);
  if (record === undefined) {
    throw new UnsafePilotOrderSmokeRequestError(["주문 조회 응답 형식을 확인하지 못해 수동 점검으로 전환합니다"]);
  }

  if (record.identifier !== expectedIdentifier) {
    // 취소 확인은 같은 smoke run identifier와 묶여야 하므로 다른 주문이 조회되면 성공 evidence로 쓰지 않는다.
    throw new UnsafePilotOrderSmokeRequestError(["주문 조회 응답 identifier가 smoke run identifier와 다릅니다"]);
  }

  if (record.state !== "cancel") {
    // 주문이 취소 상태로 확인되지 않으면 계정에 주문이 남았을 수 있어 closeout을 통과시키지 않는다.
    throw new UnsafePilotOrderSmokeRequestError(["주문 조회 응답이 취소 완료 상태가 아니므로 수동 점검이 필요합니다"]);
  }
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

function summarizeOrderChancePolicy(policy: OrderChancePolicy): JsonRecord {
  return {
    exchangeId: policy.exchangeId,
    market: policy.market,
    allowedOrderTypes: policy.allowedOrderTypes,
    minimumBidNotional: policy.minimumBidNotional ?? null,
    maximumBidNotional: policy.maximumBidNotional ?? null,
    capturedAt: policy.capturedAt,
  };
}

function summarizeProviderOrderPayload(payload: unknown): JsonRecord {
  const record = toProviderOrderRecord(payload);
  if (record === undefined) {
    return {
      payloadShape: "unexpected",
    };
  }

  const summary: JsonRecord = {
    payloadShape: "object",
  };

  assignIfString(summary, "uuid", record.uuid);
  assignIfString(summary, "identifier", record.identifier);
  assignIfString(summary, "market", record.market);
  assignIfString(summary, "side", record.side);
  assignIfString(summary, "ordType", record.ord_type);
  assignIfString(summary, "state", record.state);
  assignIfString(summary, "price", record.price);
  assignIfString(summary, "volume", record.volume);
  assignIfString(summary, "remainingVolume", record.remaining_volume);
  assignIfString(summary, "executedVolume", record.executed_volume);
  assignIfString(summary, "timeInForce", record.time_in_force);
  assignIfNumber(summary, "tradesCount", record.trades_count);

  return summary;
}

/**
 * provider 주문 응답을 summary/검증용 record로 낮춘다.
 *
 * raw payload를 artifact에 보존하지 않기 위해 객체 shape 여부만 확인하고, caller가 필요한 안전 필드만 선택하도록 한다.
 * 순수 변환 경계라 외부 side effect는 없다.
 */
function toProviderOrderRecord(payload: unknown): Record<string, unknown> | undefined {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return undefined;
  }

  return payload as Record<string, unknown>;
}

function assignIfString(target: JsonRecord, key: string, value: unknown): void {
  if (typeof value === "string") {
    target[key] = value;
  }
}

function assignIfNumber(target: JsonRecord, key: string, value: unknown): void {
  if (typeof value === "number") {
    target[key] = value;
  }
}

function toSafeOrderSmokeErrorSummary(error: unknown, correlationId: string): JsonRecord {
  if (error instanceof UnsafePilotRuntimeConfigError || error instanceof UnsafePilotOrderSmokeRequestError) {
    return {
      title: "order smoke 실행 조건을 확인해야 합니다.",
      requiredAction: "guard, market, budget, price, volume, identifier, 잔고, orders/chance 정책을 확인한 뒤 새 smoke run으로 재시도하세요.",
      violations: error.violations,
      correlationId: redactPilotCorrelationId(correlationId),
    };
  }

  return toUpbitPrivateUserActionErrorSummary(error, {
    correlationId: redactPilotCorrelationId(correlationId),
  }) as unknown as JsonRecord;
}
