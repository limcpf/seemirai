import {
  toPilotEvidenceSafeSummary,
  type JsonRecord,
  type PilotEvidenceSnapshot,
  type PilotRuntimeSafeSummary,
  type TimestampInput,
} from "../../domain/index.js";
import type {
  M19ExitPilotGuardConfig,
  M19ExitPilotGuardConfigResult,
  PilotRuntimeConfig,
  PilotRuntimeProfile,
} from "./types.js";

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

/**
 * M19 exit pilot guard safe summary다.
 *
 * operator evidence id와 approval evidence id는 원문을 그대로 노출하지 않고 존재 여부만 boolean으로 낮춘다.
 * position source, 소액 한도는 운영자 확인용으로 노출하지만 credential 원문은 포함하지 않는다.
 */
export interface M19ExitPilotGuardSafeSummary {
  enabled: boolean;
  positionSource: string | null;
  maxKrw: string | null;
  operatorEvidenceConfigured: boolean;
  positionEvidenceConfigured: boolean;
  guardedBuySmokeEnabled: boolean;
  guardedBuyApprovalConfigured: boolean;
  statusLabel: string;
  message: string;
  action: string | null;
  trace: JsonRecord;
}

/**
 * M19 exit pilot guard 상태를 `/status`와 운영 CLI에 노출 가능한 요약으로 변환한다.
 *
 * operator, position, guarded buy approval evidence id는 credential과 마찬가지로 원문을 boolean으로만 낮춘다. 이 함수는
 * 순수 변환 함수이며 외부 side effect가 없다.
 */
export function createM19ExitPilotGuardSafeSummary(
  config: M19ExitPilotGuardConfigResult,
): M19ExitPilotGuardSafeSummary {
  if (!config.enabled) {
    return {
      enabled: false,
      positionSource: null,
      maxKrw: null,
      operatorEvidenceConfigured: false,
      positionEvidenceConfigured: false,
      guardedBuySmokeEnabled: false,
      guardedBuyApprovalConfigured: false,
      statusLabel: "M19 비활성",
      message:
        "M19 exit pilot guard가 꺼져 있어 exit smoke를 실행하지 않는다. 기본 runtime은 종이매매 장부로만 exit 규칙을 검증한다.",
      action: "실제 exit pilot 검증이 필요할 때만 SEEMIRAI_RUN_M19_EXIT_PILOT=1 과 포지션 기준, 소액 한도, 운영자 확인 증거를 함께 설정한다.",
      trace: {
        source: "m19_exit_pilot_guard",
        reason: "m19_exit_pilot_disabled",
      },
    };
  }

  const positionEvidenceReady =
    config.positionSource !== "EXISTING_SMALL_POSITION" || config.positionEvidenceId !== undefined;
  const guardedBuyReady =
    config.guardedBuySmokeEnabled ? config.guardedBuyApprovalEvidenceId !== undefined : true;
  const ready =
    positionEvidenceReady && guardedBuyReady;
  const reason = !positionEvidenceReady
    ? "existing_position_evidence_missing"
    : ready
      ? "guard_ready"
      : "guarded_buy_approval_missing";

  return {
    enabled: true,
    // 사용자-facing 필드는 한국어 라벨로 변환하고, 내부 enum은 trace에만 남긴다.
    positionSource: toKoreanPositionSource(config.positionSource),
    maxKrw: config.maxKrw,
    operatorEvidenceConfigured: config.operatorEvidenceId.length > 0,
    positionEvidenceConfigured: config.positionEvidenceId !== undefined,
    guardedBuySmokeEnabled: config.guardedBuySmokeEnabled,
    guardedBuyApprovalConfigured: config.guardedBuyApprovalEvidenceId !== undefined,
    statusLabel: toM19GuardStatusLabel(reason),
    message: toM19GuardMessage(config, reason),
    action: toM19GuardAction(reason),
    trace: {
      source: "m19_exit_pilot_guard",
      reason,
      // 내부 enum은 trace에만 보존한다.
      positionSourceRaw: config.positionSource,
    },
  };
}

/**
 * M19 position source enum 값을 사용자-facing 한국어 라벨로 변환한다.
 *
 * `EXISTING_SMALL_POSITION`은 "기존 소액 포지션", `PAPER_FIXTURE`는 "종이매매 장부"로 노출한다. 알 수 없는 값은 추적 정보에만
 * 남기고 한국어 설명으로 대체한다.
 */
function toKoreanPositionSource(source: string): string {
  if (source === "EXISTING_SMALL_POSITION") {
    return "기존 소액 포지션";
  }

  if (source === "PAPER_FIXTURE") {
    return "종이매매 장부";
  }

  // 알 수 없는 source는 trace에만 남기고 사용자 화면에는 일반 한글 표현으로 대체한다.
  return "알 수 없는 포지션 기준";
}

function toM19GuardStatusLabel(reason: string): string {
  if (reason === "existing_position_evidence_missing") {
    return "M19 기존 포지션 증거 대기";
  }

  if (reason === "guarded_buy_approval_missing") {
    return "M19 guarded buy 승인 대기";
  }

  return "M19 exit pilot 준비";
}

function toM19GuardMessage(config: M19ExitPilotGuardConfig, reason: string): string {
  if (reason === "existing_position_evidence_missing") {
    return "기존 소액 포지션 기준을 선택했지만 M16 reconcile 또는 운영자 position evidence가 없어 차단 상태다.";
  }

  if (reason === "guarded_buy_approval_missing") {
    return "M19 guarded buy smoke가 켜졌지만 승인 증거가 없어 차단(fail-closed) 상태다.";
  }

  return `M19 exit pilot guard가 충족됐다. 포지션 기준: ${toKoreanPositionSource(config.positionSource)}, 소액 한도: ${config.maxKrw} KRW, 운영자 확인 증거가 준비됐다.`;
}

function toM19GuardAction(reason: string): string {
  if (reason === "existing_position_evidence_missing") {
    return "M16 reconcile 결과 또는 운영자 position evidence id를 SEEMIRAI_M19_EXIT_PILOT_POSITION_EVIDENCE_ID 로 제공한다.";
  }

  if (reason === "guarded_buy_approval_missing") {
    return "guarded buy smoke를 실행하려면 SEEMIRAI_M19_GUARDED_BUY_APPROVAL_EVIDENCE_ID 를 제공하거나 guarded buy를 끈다.";
  }

  return "실행 직전 대상 market, 소액 한도, 포지션 기준, 기존 포지션 여부를 다시 확인한다.";
}
