import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type {
  BrokerBalanceSnapshot,
  BrokerOrder,
  FeePolicy,
  JsonRecord,
  OrderChancePolicy,
  PilotEvidenceStatus,
} from "../../src/domain/index.js";
import { redactPilotCorrelationId } from "../../src/domain/index.js";
import {
  UpbitPrivateOrderLookupResponseSchema,
  UpbitPrivateRestClient,
  toBrokerBalanceSnapshot,
  toBrokerOrderFromLookup,
  toFeePolicyFromOrderChance,
  toOrderChancePolicy,
  toUpbitPrivateUserActionErrorSummary,
} from "../../src/infrastructure/index.js";
import { UnsafePilotRuntimeConfigError, loadPilotRuntimeConfigFromEnv } from "../../src/runtime/index.js";
import type { EnabledPilotRuntimeConfig } from "../../src/runtime/index.js";
import {
  assertUpbitSmokeArtifactHasNoSecretText,
  writeUpbitSmokeArtifact,
} from "../helpers/upbit-smoke-artifacts.js";

const runUpbitPrivateSmoke = process.env.SEEMIRAI_RUN_UPBIT_PRIVATE_SMOKE === "1";
// 명시 guard가 없으면 기본 검증과 CI가 Upbit private endpoint를 호출하지 않도록 suite 전체를 수집 단계에서 생략한다.
const describeUpbitPrivateSmoke = runUpbitPrivateSmoke ? describe : describe.skip;

describeUpbitPrivateSmoke("Upbit private API smoke integration", () => {
  it("account/policy/lookup private API 결과를 secret-safe artifact로 남긴다", async () => {
    const correlationId = randomUUID();
    const occurredAt = new Date().toISOString();
    const artifact: JsonRecord = createBaseArtifact("UPBIT_PRIVATE_SMOKE", occurredAt, correlationId);
    let failure: unknown;

    try {
      const config = loadEnabledPilotConfig();
      artifact.profile = config.profile;
      artifact.keyScopeEvidenceId = config.keyScopeEvidenceId;
      artifact.guard = {
        privateSmokeEnabled: config.privateSmokeEnabled,
        orderSmokeEnabled: config.orderSmokeEnabled,
      };

      const client = createPrivateClient(config);
      const accountsResponse = await client.getAccounts();
      const balances = toBrokerBalanceSnapshot(accountsResponse.payload, { capturedAt: occurredAt });
      artifact.accounts = summarizeBalanceSnapshot(balances);
      artifact.accountsRateLimit = accountsResponse.rateLimitStatus;

      if (config.profile !== "PILOT_READ_ONLY") {
        const policySyncMarket = requireConfigValue(config.policySyncMarket, "SEEMIRAI_UPBIT_POLICY_SYNC_MARKET");
        const orderChanceResponse = await client.getOrderChance(policySyncMarket);
        const orderChance = toOrderChancePolicy(orderChanceResponse.payload, { capturedAt: occurredAt });
        const feePolicy = toFeePolicyFromOrderChance(orderChanceResponse.payload, { capturedAt: occurredAt });
        artifact.orderChance = summarizeOrderChancePolicy(orderChance);
        artifact.fees = summarizeFeePolicy(feePolicy);
        artifact.orderChanceRateLimit = orderChanceResponse.rateLimitStatus;
      }

      if (config.lookupOrderUuid !== undefined || config.lookupOrderIdentifier !== undefined) {
        const lookupResponse = await client.getOrder({
          ...(config.lookupOrderUuid === undefined ? {} : { uuid: config.lookupOrderUuid }),
          ...(config.lookupOrderIdentifier === undefined ? {} : { identifier: config.lookupOrderIdentifier }),
        });
        UpbitPrivateOrderLookupResponseSchema.parse(lookupResponse.payload);
        const brokerOrder = toBrokerOrderFromLookup(lookupResponse.payload, { capturedAt: occurredAt });
        artifact.lookupOrder = summarizeBrokerOrder(brokerOrder);
        artifact.lookupRateLimit = lookupResponse.rateLimitStatus;
      }

      artifact.status = "PASSED" satisfies PilotEvidenceStatus;
      artifact.message = "Upbit private account/policy/lookup smoke가 완료됐습니다.";
    } catch (error) {
      failure = error;
      artifact.status = "FAILED" satisfies PilotEvidenceStatus;
      artifact.message = "Upbit private smoke가 실패해 후속 주문 경로로 진행하지 않았습니다.";
      artifact.error = toSafePrivateSmokeErrorSummary(error, correlationId);
    } finally {
      const artifactPath = await writeUpbitSmokeArtifact({
        filePrefix: "upbit-private-smoke",
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

function loadEnabledPilotConfig(): EnabledPilotRuntimeConfig {
  const config = loadPilotRuntimeConfigFromEnv(process.env);
  if (!config.enabled) {
    // smoke guard가 켜졌는데 disabled config로 해석되면 secret 누락보다 더 위험하므로 즉시 닫는다.
    throw new UnsafePilotRuntimeConfigError(["pilot runtime config가 활성화되지 않았습니다"]);
  }

  return config;
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
    // profile guard가 통과한 뒤 필수 market이 비어 있으면 코드/환경 불일치라 외부 호출 전에 중단한다.
    throw new UnsafePilotRuntimeConfigError([`${key} 가 필요합니다`]);
  }

  return value;
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

function summarizeFeePolicy(policy: FeePolicy): JsonRecord {
  return {
    exchangeId: policy.exchangeId,
    market: policy.market,
    bidFeeBps: policy.bidFeeBps,
    askFeeBps: policy.askFeeBps,
    makerBidFeeBps: policy.makerBidFeeBps ?? null,
    makerAskFeeBps: policy.makerAskFeeBps ?? null,
    updatedAt: policy.updatedAt,
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
  };
}

function toSafePrivateSmokeErrorSummary(error: unknown, correlationId: string): JsonRecord {
  if (error instanceof UnsafePilotRuntimeConfigError) {
    return {
      title: "pilot runtime 설정을 확인해야 합니다.",
      requiredAction: "secret 파일과 명시 guard, 권한 evidence id를 확인한 뒤 private smoke를 다시 실행하세요.",
      violations: error.violations,
      correlationId: redactPilotCorrelationId(correlationId),
    };
  }

  return toUpbitPrivateUserActionErrorSummary(error, {
    correlationId: redactPilotCorrelationId(correlationId),
  }) as unknown as JsonRecord;
}
