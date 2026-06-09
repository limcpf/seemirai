import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import type {
  BrokerBalanceSnapshot,
  JsonRecord,
  OrderChancePolicy,
  PilotEvidenceStatus,
} from "../../src/domain/index.js";
import type { Decimal } from "decimal.js";
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
  loadM19ExitPilotGuardConfigFromEnv,
  loadPilotRuntimeConfigFromEnv,
  validateM19GuardedBuySmokeGuard,
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
const CANCEL_CONFIRMATION_ATTEMPTS = 8;
const CANCEL_CONFIRMATION_DELAY_MS = 500;
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
    let orderSideEffectPossible = false;
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

      // M19 guarded buy smoke 검증 — loader 결과를 그대로 guard에 넘기고,
      // FAILED_CLOSED면 API 호출 전에 차단한다. PASSED이면 M19 소액 한도를 추가 검증한다.
      const m19Guard = loadM19ExitPilotGuardConfigFromEnv(process.env);
      const m19Validation = validateM19GuardedBuySmokeGuard(m19Guard, "bid");
      artifact.m19Validation = {
        result: m19Validation.result,
        reason: m19Validation.reason,
        message: m19Validation.message,
      };
      if (m19Guard.enabled && !m19Validation.sideEffectPossible) {
        // M19 guard가 켜진 bid smoke는 PASSED 외 결과를 주문 생성으로 낮추지 않는다.
        throw new UnsafePilotRuntimeConfigError([m19Validation.message]);
      }
      if (m19Validation.result === "PASSED" && m19Guard.enabled) {
        // M19 소액 한도 검증 — M19_EXIT_PILOT_MAX_KRW와 UPBIT_ORDER_SMOKE_MAX_KRW 중 더 보수적인 상한 적용
        const m19MaxKrw = parseFinancialDecimal(m19Guard.maxKrw);
        if (parseFinancialDecimal(plan.notionalKrw).greaterThan(m19MaxKrw)) {
          throw new UnsafePilotOrderSmokeRequestError([
            `smoke 주문 총액이 M19 소액 한도(${m19Guard.maxKrw} KRW)를 초과합니다`,
          ]);
        }
      }

      const client = createPrivateClient(config);
      const accountsResponse = await client.getAccounts();
      const balances = toBrokerBalanceSnapshot(accountsResponse.payload, { capturedAt: occurredAt });
      artifact.accounts = summarizeBalanceSnapshot(balances);
      artifact.accountsRateLimit = accountsResponse.rateLimitStatus;

      const orderChanceResponse = await client.getOrderChance(
        requireConfigValue(config.policySyncMarket, "SEEMIRAI_UPBIT_POLICY_SYNC_MARKET"),
      );
      const orderChance = toOrderChancePolicy(orderChanceResponse.payload, { capturedAt: occurredAt });
      assertOrderChanceCanCoverPlan(orderChance, plan);
      assertKrwBalanceCanCoverOrder(balances, plan.notionalKrw, orderChance);
      artifact.orderChance = summarizeOrderChancePolicy(orderChance);
      artifact.orderChanceRateLimit = orderChanceResponse.rateLimitStatus;

      let createResponse: Awaited<ReturnType<UpbitPrivateRestClient["createLimitOrder"]>>;
      try {
        orderSideEffectPossible = true;
        createResponse = await client.createLimitOrder(plan.createOrder);
      } catch (error) {
        artifact.createError = toSafeOrderSmokeErrorSummary(error, correlationId);
        await attemptOrderCleanupAfterAmbiguousCreateFailure(client, plan, artifact, correlationId);
        throw error;
      }

      artifact.createdOrder = summarizeProviderOrderPayload(createResponse.payload);
      artifact.createRateLimit = createResponse.rateLimitStatus;

      let cancelFailure: unknown;
      try {
        const cancelResponse = await client.cancelOrder(plan.cancelOrder);
        artifact.cancelOrder = summarizeProviderOrderPayload(cancelResponse.payload);
        artifact.cancelRateLimit = cancelResponse.rateLimitStatus;
      } catch (error) {
        cancelFailure = error;
        artifact.cancelWarning = toSafeOrderSmokeErrorSummary(error, correlationId);
      }

      try {
        const lookupResponse = await waitForOrderSmokeCancelConfirmation({
          client,
          plan,
          artifact,
          correlationId,
        });
        artifact.lookupOrder = summarizeProviderOrderPayload(lookupResponse.payload);
        artifact.lookupRateLimit = lookupResponse.rateLimitStatus;
        cancelFailure = undefined;
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
      artifact.status = orderSideEffectPossible
        ? ("MANUAL_REVIEW_REQUIRED" satisfies PilotEvidenceStatus)
        : ("FAILED" satisfies PilotEvidenceStatus);
      artifact.message = orderSideEffectPossible
        ? "주문 생성 이후 취소 또는 조회 확인이 실패해 추가 주문 없이 수동 점검으로 전환했습니다."
        : "주문 생성 전에 smoke가 실패했거나 거래소가 주문 생성을 거부했습니다.";
      artifact.action = orderSideEffectPossible
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

function assertKrwBalanceCanCoverOrder(
  snapshot: BrokerBalanceSnapshot,
  notionalKrw: string,
  policy: OrderChancePolicy,
): void {
  const krwBalance = snapshot.balances.find((balance) => balance.currency === "KRW");
  const requiredReserveKrw = calculateRequiredBidReserveKrw(notionalKrw, policy);
  if (krwBalance === undefined) {
    // KRW 계정이 확인되지 않으면 잔고 부족과 권한 문제를 구분할 수 없어 주문 생성 전에 중단한다.
    throw new UnsafePilotOrderSmokeRequestError(["KRW 잔고 계정이 확인되지 않아 주문 생성 전에 중단했습니다"]);
  }

  if (parseFinancialDecimal(krwBalance.available).lessThan(requiredReserveKrw)) {
    // 주문 총액과 예약 수수료를 함께 감당하지 못하면 거래소 거부 전에 identifier 사용을 막는다.
    throw new UnsafePilotOrderSmokeRequestError(["KRW 주문 가능 잔고가 smoke 주문 총액과 예상 수수료 합계보다 작아 주문 생성 전에 중단했습니다"]);
  }

  if (
    policy.bidAvailableBalance !== undefined &&
    parseFinancialDecimal(policy.bidAvailableBalance).lessThan(requiredReserveKrw)
  ) {
    // orders/chance가 보는 주문 가능 KRW가 부족하면 계정 snapshot보다 거래소 정책 근거를 우선해 닫는다.
    throw new UnsafePilotOrderSmokeRequestError(["orders/chance 기준 주문 가능 KRW가 smoke 주문 총액과 예상 수수료 합계보다 작습니다"]);
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
 * 모호한 주문 생성 실패 뒤 같은 identifier의 주문을 취소/조회해 열린 주문 위험을 줄인다.
 *
 * `POST /v1/orders`가 throw해도 거래소에 도달했을 수 있으므로, 같은 smoke identifier로만 cancel과 lookup을 시도한다. 이
 * 함수는 새 주문을 만들지 않고 cleanup evidence만 artifact에 남기며, 실패해도 원래 create 오류를 덮어쓰지 않는다.
 */
async function attemptOrderCleanupAfterAmbiguousCreateFailure(
  client: UpbitPrivateRestClient,
  plan: PilotOrderSmokeRequestPlan,
  artifact: JsonRecord,
  correlationId: string,
): Promise<void> {
  let cleanupFailure: unknown;

  try {
    const cancelResponse = await client.cancelOrder(plan.cancelOrder);
    artifact.cleanupCancelOrder = summarizeProviderOrderPayload(cancelResponse.payload);
    artifact.cleanupCancelRateLimit = cancelResponse.rateLimitStatus;
  } catch (error) {
    cleanupFailure = error;
    artifact.cleanupCancelWarning = toSafeOrderSmokeErrorSummary(error, correlationId);
  }

  try {
    const lookupResponse = await client.getOrder(plan.lookupOrder);
    assertLookupConfirmsCanceledOrder(lookupResponse.payload, plan.createOrder.identifier);
    artifact.cleanupLookupOrder = summarizeProviderOrderPayload(lookupResponse.payload);
    artifact.cleanupLookupRateLimit = lookupResponse.rateLimitStatus;
    return;
  } catch (error) {
    cleanupFailure = error;
  }

  artifact.cleanupError = toSafeOrderSmokeErrorSummary(cleanupFailure, correlationId);
}

/**
 * Upbit cancel 직후 조회가 아직 wait/watch로 보일 수 있어 terminal cancel 상태를 짧게 polling한다.
 *
 * 이미 생성된 smoke identifier만 조회하므로 새 주문 side effect는 만들지 않는다. 제한 시간 안에 `cancel` 상태가 확인되지 않으면
 * 기존 manual review 경로로 넘겨 열린 주문 가능성을 보수적으로 다룬다.
 */
async function waitForOrderSmokeCancelConfirmation(input: {
  client: UpbitPrivateRestClient;
  plan: PilotOrderSmokeRequestPlan;
  artifact: JsonRecord;
  correlationId: string;
}): Promise<Awaited<ReturnType<UpbitPrivateRestClient["getOrder"]>>> {
  const attempts: JsonRecord[] = [];
  let lastResponse: Awaited<ReturnType<UpbitPrivateRestClient["getOrder"]>> | undefined;
  let lastError: unknown;

  for (let attempt = 1; attempt <= CANCEL_CONFIRMATION_ATTEMPTS; attempt += 1) {
    if (attempt > 1) {
      await sleep(CANCEL_CONFIRMATION_DELAY_MS);
    }

    try {
      lastResponse = await input.client.getOrder(input.plan.lookupOrder);
      const record = toProviderOrderRecord(lastResponse.payload);
      attempts.push({
        attempt,
        state: record?.state ?? "응답 형식 확인 불가",
      });
      input.artifact.cancelConfirmationAttempts = attempts;
      assertLookupConfirmsCanceledOrder(lastResponse.payload, input.plan.createOrder.identifier);
      return lastResponse;
    } catch (error) {
      lastError = error;
      attempts.push({
        attempt,
        state: "취소 미확인",
      });
      input.artifact.cancelConfirmationAttempts = attempts;
    }
  }

  if (lastError !== undefined) {
    throw lastError;
  }

  throw new UnsafePilotOrderSmokeRequestError(["취소 완료 조회를 확인하지 못해 수동 점검이 필요합니다"]);
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

/**
 * 지정가 매수 주문 전에 필요한 KRW 예비금을 계산한다.
 *
 * 주문 총액에 orders/chance 수수료율 중 보수적인 값을 더해, 잔고 부족으로 identifier를 소모하는 주문 시도를 줄인다. 순수
 * 계산 경계라 외부 API나 파일 side effect가 없다.
 */
function calculateRequiredBidReserveKrw(notionalKrw: string, policy: OrderChancePolicy): Decimal {
  const notional = parseFinancialDecimal(notionalKrw);
  const feeBps = readConservativeBidFeeBps(policy);

  return notional.add(notional.mul(feeBps).div(10_000));
}

/**
 * order smoke 잔고 검증에 사용할 보수적 매수 수수료 bps를 고른다.
 *
 * post_only 주문은 maker 수수료가 기대되지만 provider 정책 차이를 고려해 기본 bid fee와 maker bid fee 중 큰 값을 사용한다.
 * 입력 policy만 읽는 순수 함수다.
 */
function readConservativeBidFeeBps(policy: OrderChancePolicy): Decimal {
  const bidFeeBps = parseFinancialDecimal(policy.bidFeeBps);
  const makerBidFeeBps = policy.makerBidFeeBps === undefined ? bidFeeBps : parseFinancialDecimal(policy.makerBidFeeBps);

  return bidFeeBps.greaterThan(makerBidFeeBps) ? bidFeeBps : makerBidFeeBps;
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
