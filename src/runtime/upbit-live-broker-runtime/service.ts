import {
  UpbitPrivateRestClient,
  createUpbitLiveBroker,
} from "../../infrastructure/upbit/index.js";
import type {
  UpbitPrivateCredentials,
} from "../../infrastructure/upbit/index.js";
import type {
  EnabledPilotRuntimeConfig,
  PilotUpbitKeyScope,
} from "../pilot-config.js";
import {
  UnsafeUpbitLiveBrokerRuntimeError,
} from "./types.js";
import type {
  CreateGuardedUpbitLiveBrokerRuntimeInput,
  CreateUpbitLiveBrokerRuntimeSafeSummaryInput,
  GuardedUpbitLiveBrokerRuntime,
  UpbitLiveBrokerPrivateClientFactory,
  UpbitLiveBrokerRuntimeSafeSummary,
} from "./types.js";

const REQUIRED_LIVE_BROKER_SCOPES: readonly PilotUpbitKeyScope[] = ["자산조회", "주문조회", "주문하기"];

/**
 * 명시 guard를 모두 통과한 경우에만 `UpbitLiveBroker`를 조립한다.
 *
 * 기본 `PAPER_NO_KEY` runtime은 이 factory를 호출하지 않는다. 이 함수는 live broker adapter와 private client 객체를 만들 수
 * 있지만, 생성 중에는 network 요청을 보내지 않으며 guard 위반 시 private client factory도 호출하지 않는다.
 */
export function createGuardedUpbitLiveBrokerRuntime(
  input: CreateGuardedUpbitLiveBrokerRuntimeInput,
): GuardedUpbitLiveBrokerRuntime {
  const violations = collectUpbitLiveBrokerRuntimeViolations(input);

  if (violations.length > 0 || !input.pilotConfig.enabled) {
    // credential이 일부 있어도 guard가 완성되지 않으면 private client 객체조차 만들지 않아 기본 runtime 경계를 보존한다.
    throw new UnsafeUpbitLiveBrokerRuntimeError(
      violations.length > 0 ? violations : ["PILOT_ORDER_SMOKE guard가 필요합니다"],
    );
  }

  const privateClientFactory = input.privateClientFactory ?? createDefaultUpbitLiveBrokerPrivateClient;
  const privateClient = privateClientFactory({
    accessKey: input.pilotConfig.upbitAccessKey,
    secretKey: input.pilotConfig.upbitSecretKey,
  });
  const broker = createUpbitLiveBroker({
    privateClient,
    ...(input.exchangeId === undefined ? {} : { exchangeId: input.exchangeId }),
    ...(input.clock === undefined ? {} : { clock: input.clock }),
  });

  return {
    broker,
    summary: createUpbitLiveBrokerRuntimeSafeSummary(input),
  };
}

/**
 * UpbitLiveBroker runtime guard 상태를 secret-safe 요약으로 변환한다.
 *
 * credential 원문은 boolean으로만 낮추며, 운영자에게는 profile/scope/evidence와 필요한 다음 조치만 보여준다. 이 함수는
 * 순수 변환 함수이며 private client나 broker를 만들지 않는다.
 */
export function createUpbitLiveBrokerRuntimeSafeSummary(
  input: CreateUpbitLiveBrokerRuntimeSafeSummaryInput,
): UpbitLiveBrokerRuntimeSafeSummary {
  if (!input.pilotConfig.enabled) {
    return {
      enabled: false,
      profile: null,
      privateSmokeEnabled: false,
      orderSmokeEnabled: false,
      credentialsConfigured: false,
      keyScopes: [],
      keyScopeEvidenceId: null,
      statusLabel: "비활성",
      message: "Upbit live broker factory guard가 꺼져 있어 기본 PAPER_NO_KEY runtime이 실거래 broker를 조립하지 않는다.",
      action: "실거래 broker 검증이 필요할 때만 M15 live broker smoke guard와 pilot order-smoke profile을 함께 설정한다.",
      trace: {
        source: "upbit_live_broker_runtime",
        reason: "pilot_profile_disabled",
        liveBrokerEnabled: input.liveBrokerEnabled,
      },
    };
  }

  const violations = collectUpbitLiveBrokerRuntimeViolations(input);
  const ready = violations.length === 0;

  return {
    enabled: ready,
    profile: input.pilotConfig.profile,
    privateSmokeEnabled: input.pilotConfig.privateSmokeEnabled,
    orderSmokeEnabled: input.pilotConfig.orderSmokeEnabled,
    credentialsConfigured: input.pilotConfig.upbitAccessKey.length > 0 && input.pilotConfig.upbitSecretKey.length > 0,
    keyScopes: [...input.pilotConfig.keyScopes],
    keyScopeEvidenceId: input.pilotConfig.keyScopeEvidenceId,
    statusLabel: ready ? "live broker 조립 가능" : "live broker guard 미충족",
    message: ready
      ? "M15 Upbit live broker factory guard가 충족됐다. 실제 주문 제출은 별도 smoke/runner 경계에서만 수행한다."
      : "Upbit live broker factory guard가 완성되지 않아 private client를 만들 수 없다.",
    action: ready
      ? "실행 직전 대상 market, 소액 한도, identifier, key scope evidence를 다시 확인한다."
      : "추적 정보의 guard 위반 항목을 수정한 뒤 다시 조립한다.",
    trace: {
      source: "upbit_live_broker_runtime",
      reason: ready ? "guard_ready" : "guard_blocked",
      liveBrokerEnabled: input.liveBrokerEnabled,
      violations,
    },
  };
}

function collectUpbitLiveBrokerRuntimeViolations(
  input: CreateUpbitLiveBrokerRuntimeSafeSummaryInput,
): string[] {
  const violations: string[] = [];

  if (!input.liveBrokerEnabled) {
    violations.push("Upbit live broker runtime에는 liveBrokerEnabled=true guard가 필요합니다");
  }

  if (!input.pilotConfig.enabled) {
    violations.push("Upbit live broker runtime에는 활성화된 pilot config가 필요합니다");
    return violations;
  }

  validateEnabledPilotConfig(input.pilotConfig, violations);

  return violations;
}

function validateEnabledPilotConfig(config: EnabledPilotRuntimeConfig, violations: string[]): void {
  if (config.profile !== "PILOT_ORDER_SMOKE") {
    violations.push("Upbit live broker runtime에는 PILOT_ORDER_SMOKE profile이 필요합니다");
  }

  if (!config.privateSmokeEnabled || !config.orderSmokeEnabled) {
    // 주문 생성/취소 side effect는 read-only private smoke와 별도 order-smoke guard가 모두 켜져야만 열린다.
    violations.push("Upbit live broker runtime에는 private/order smoke guard가 모두 필요합니다");
  }

  if (config.upbitAccessKey.trim().length === 0 || config.upbitSecretKey.trim().length === 0) {
    violations.push("Upbit live broker runtime에는 Upbit credential 입력이 필요합니다");
  }

  if (config.keyScopeEvidenceId.trim().length === 0) {
    violations.push("Upbit live broker runtime에는 key scope evidence id가 필요합니다");
  }

  for (const requiredScope of REQUIRED_LIVE_BROKER_SCOPES) {
    if (!config.keyScopes.includes(requiredScope)) {
      violations.push(`Upbit live broker runtime key scope에 ${requiredScope} 권한이 필요합니다`);
    }
  }
}

function createDefaultUpbitLiveBrokerPrivateClient(
  credentials: UpbitPrivateCredentials,
): ReturnType<UpbitLiveBrokerPrivateClientFactory> {
  return new UpbitPrivateRestClient({ credentials });
}
