import {
  toPilotEvidenceSafeSummary,
  type PilotEvidenceSnapshot,
  type PilotRuntimeSafeSummary,
  type TimestampInput,
} from "../../domain/index.js";
import type { PilotRuntimeConfig, PilotRuntimeProfile } from "./types.js";

/**
 * pilot runtime safe summary를 만들 때 필요한 관측 입력이다.
 *
 * `generatedAt`은 `/status` snapshot과 같은 시각 기준을 공유하고, `lastEvidence`는 이미 secret-safe snapshot이어야 한다.
 * 이 옵션은 순수 변환 함수의 입력일 뿐 DB 조회나 Upbit 호출 side effect를 만들지 않는다.
 */
export interface CreatePilotRuntimeSafeSummaryOptions {
  generatedAt: TimestampInput;
  lastEvidence?: PilotEvidenceSnapshot | null;
}

/**
 * pilot runtime config를 `/status`와 운영 CLI에 노출 가능한 요약으로 변환한다.
 *
 * enabled config에는 raw Upbit access/secret key가 들어 있으므로 이 함수는 credential 존재 여부만 boolean으로 낮춘다.
 * 반환값은 secret 원문, raw Authorization header, JWT를 포함하지 않는 것을 invariant로 유지하며 외부 side effect가 없다.
 */
export function createPilotRuntimeSafeSummary(
  config: PilotRuntimeConfig,
  options: CreatePilotRuntimeSafeSummaryOptions,
): PilotRuntimeSafeSummary {
  const generatedAt = toTimestampString(options.generatedAt);
  const lastEvidence = options.lastEvidence === undefined || options.lastEvidence === null
    ? null
    : toPilotEvidenceSafeSummary(options.lastEvidence);

  if (!config.enabled) {
    return {
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
      lastEvidence,
      trace: {
        source: "pilot_runtime_config",
        reason: "pilot_profile_disabled",
        generatedAt,
      },
    };
  }

  const orderSmokeReady = config.profile === "PILOT_ORDER_SMOKE" && config.orderSmokeEnabled;
  const policySyncReady = config.profile === "PILOT_POLICY_SYNC" || orderSmokeReady;
  // Upbit secret 원문은 summary 경계에서 boolean으로만 낮춰 HTTP/log/report로 흘러가지 않게 한다.
  const credentialsConfigured = config.upbitAccessKey.length > 0 && config.upbitSecretKey.length > 0;

  return {
    enabled: true,
    profile: config.profile,
    privateSmokeEnabled: config.privateSmokeEnabled,
    orderSmokeEnabled: config.orderSmokeEnabled,
    credentialsConfigured,
    keyScopes: [...config.keyScopes],
    keyScopeEvidenceId: config.keyScopeEvidenceId,
    policySyncMarket: config.policySyncMarket ?? null,
    orderSmokeMarket: config.orderSmokeMarket ?? null,
    orderSmokeMaxKrw: config.orderSmokeMaxKrw ?? null,
    lookupOrderConfigured: config.lookupOrderUuid !== undefined || config.lookupOrderIdentifier !== undefined,
    statusLabel: orderSmokeReady ? "주문 smoke 준비" : policySyncReady ? "정책 조회 준비" : "읽기 전용 준비",
    message: toPilotRuntimeSafeMessage(config.profile),
    action: toPilotRuntimeSafeAction(config.profile),
    lastEvidence,
    trace: {
      source: "pilot_runtime_config",
      reason: `pilot_profile_${config.profile.toLowerCase()}`,
      generatedAt,
      lookupOrderUuidConfigured: config.lookupOrderUuid !== undefined,
      lookupOrderIdentifierConfigured: config.lookupOrderIdentifier !== undefined,
    },
  };
}

function toPilotRuntimeSafeMessage(profile: PilotRuntimeProfile): string {
  if (profile === "PILOT_ORDER_SMOKE") {
    return "소액 지정가 주문 생성/취소 smoke guard가 켜져 있다. 실제 호출은 전용 smoke runner에서만 수행한다.";
  }

  if (profile === "PILOT_POLICY_SYNC") {
    return "orders/chance 정책 조회를 위한 private smoke guard가 켜져 있다. 주문 생성 권한은 열리지 않았다.";
  }

  return "계정 잔고와 선택적 기존 주문 조회를 위한 read-only private smoke guard가 켜져 있다.";
}

function toPilotRuntimeSafeAction(profile: PilotRuntimeProfile): string | null {
  if (profile === "PILOT_ORDER_SMOKE") {
    return "실행 전 최신 Upbit 권한 evidence, 대상 market, 소액 한도, idempotency key를 다시 확인한다.";
  }

  if (profile === "PILOT_POLICY_SYNC") {
    return "정책 snapshot을 저장하기 전 대상 market과 주문 권한 비활성 상태를 확인한다.";
  }

  return "계정 조회 결과를 audit/report artifact로 남길 때 secret과 raw Authorization header가 없는지 확인한다.";
}

function toTimestampString(timestamp: TimestampInput): string {
  return timestamp instanceof Date ? timestamp.toISOString() : timestamp;
}
