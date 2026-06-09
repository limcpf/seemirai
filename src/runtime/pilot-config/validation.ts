import {
  ALLOWED_KEY_SCOPES,
  FORBIDDEN_KEY_SCOPES,
  M19_EXIT_PILOT_POSITION_SOURCES,
  PILOT_PROFILES,
  UPBIT_PILOT_IDENTIFIER_MAX_LENGTH,
  UPBIT_PILOT_ORDER_SMOKE_MIN_KRW_LIMIT,
  UPBIT_PILOT_ORDER_SMOKE_MAX_KRW_LIMIT,
  UnsafePilotRuntimeConfigError,
} from "./types.js";
import type {
  DisabledM19ExitPilotGuardConfig,
  EnabledPilotRuntimeConfig,
  M19ExitPilotGuardConfig,
  M19ExitPilotGuardConfigResult,
  M19ExitPilotPositionSource,
  PilotRuntimeConfig,
  PilotRuntimeProfile,
  PilotUpbitKeyScope,
} from "./types.js";

const KRW_MARKET_PATTERN = /^KRW-[A-Z0-9]+$/u;
const POSITIVE_DECIMAL_PATTERN = /^(?:0|[1-9]\d*)(?:\.\d+)?$/u;

/**
 * process env 형태의 입력을 v0.2 pilot runtime guard로 해석한다.
 *
 * 기본 env는 disabled config로 반환해 `PAPER_NO_KEY` runtime을 유지한다. profile, secret, smoke guard, scope evidence가
 * 일부만 들어온 상태는 private API가 암묵적으로 열리지 않도록 fail-closed 오류로 거부한다. 외부 API 호출이나 파일 접근은 없다.
 */
export function loadPilotRuntimeConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): PilotRuntimeConfig {
  const profile = readEnv(env, "SEEMIRAI_PILOT_PROFILE");
  const privateSmokeGuard = readEnv(env, "SEEMIRAI_RUN_UPBIT_PRIVATE_SMOKE");
  const orderSmokeGuard = readEnv(env, "SEEMIRAI_RUN_UPBIT_ORDER_SMOKE");
  const accessKey = readEnv(env, "SEEMIRAI_UPBIT_ACCESS_KEY");
  const secretKey = readEnv(env, "SEEMIRAI_UPBIT_SECRET_KEY");
  const rawKeyScopes = readEnv(env, "SEEMIRAI_UPBIT_KEY_SCOPE");
  const keyScopeEvidenceId = readEnv(env, "SEEMIRAI_UPBIT_KEY_SCOPE_EVIDENCE_ID");
  const policySyncMarket = readEnv(env, "SEEMIRAI_UPBIT_POLICY_SYNC_MARKET");
  const orderSmokeMarket = readEnv(env, "SEEMIRAI_UPBIT_ORDER_SMOKE_MARKET");
  const orderSmokeMaxKrw = readEnv(env, "SEEMIRAI_UPBIT_ORDER_SMOKE_MAX_KRW");
  const lookupOrderUuid = readEnv(env, "SEEMIRAI_UPBIT_LOOKUP_ORDER_UUID");
  const lookupOrderIdentifier = readEnv(env, "SEEMIRAI_UPBIT_LOOKUP_ORDER_IDENTIFIER");

  if (
    profile === undefined &&
    privateSmokeGuard === undefined &&
    orderSmokeGuard === undefined &&
    accessKey === undefined &&
    secretKey === undefined &&
    rawKeyScopes === undefined &&
    keyScopeEvidenceId === undefined &&
    policySyncMarket === undefined &&
    orderSmokeMarket === undefined &&
    orderSmokeMaxKrw === undefined &&
    lookupOrderUuid === undefined &&
    lookupOrderIdentifier === undefined
  ) {
    return {
      enabled: false,
      privateSmokeEnabled: false,
      orderSmokeEnabled: false,
    };
  }

  const violations: string[] = [];
  const parsedProfile = parsePilotProfile(profile, violations);
  const keyScopes = parseKeyScopes(rawKeyScopes, violations);

  if (privateSmokeGuard !== "1") {
    // private API key가 환경에 있어도 명시 smoke guard 없이는 client 조립으로 넘어가지 않도록 차단한다.
    violations.push("SEEMIRAI_RUN_UPBIT_PRIVATE_SMOKE=1 이 필요합니다");
  }

  if (accessKey === undefined) {
    violations.push("SEEMIRAI_UPBIT_ACCESS_KEY 가 필요합니다");
  }

  if (secretKey === undefined) {
    violations.push("SEEMIRAI_UPBIT_SECRET_KEY 가 필요합니다");
  }

  if (keyScopeEvidenceId === undefined) {
    violations.push("SEEMIRAI_UPBIT_KEY_SCOPE_EVIDENCE_ID 가 필요합니다");
  }

  if (parsedProfile !== undefined) {
    validateLookupOrderInput(parsedProfile, lookupOrderUuid, lookupOrderIdentifier, keyScopes, violations);
    validateProfileSpecificGuards({
      profile: parsedProfile,
      orderSmokeGuard,
      policySyncMarket,
      orderSmokeMarket,
      orderSmokeMaxKrw,
      keyScopes,
      violations,
    });
  }

  if (violations.length > 0) {
    throw new UnsafePilotRuntimeConfigError(violations);
  }

  return createEnabledPilotRuntimeConfig({
    profile: parsedProfile,
    accessKey,
    secretKey,
    keyScopes,
    keyScopeEvidenceId,
    policySyncMarket,
    orderSmokeMarket,
    orderSmokeMaxKrw,
    lookupOrderUuid,
    lookupOrderIdentifier,
    orderSmokeGuard,
  });
}

function readEnv(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const value = env[key]?.trim();
  return value === undefined || value.length === 0 ? undefined : value;
}

function parsePilotProfile(
  profile: string | undefined,
  violations: string[],
): PilotRuntimeProfile | undefined {
  if (profile === undefined) {
    violations.push("SEEMIRAI_PILOT_PROFILE 이 필요합니다");
    return undefined;
  }

  if (isPilotRuntimeProfile(profile)) {
    return profile;
  }

  violations.push("SEEMIRAI_PILOT_PROFILE 은 PILOT_READ_ONLY, PILOT_POLICY_SYNC, PILOT_ORDER_SMOKE 중 하나여야 합니다");
  return undefined;
}

function isPilotRuntimeProfile(profile: string): profile is PilotRuntimeProfile {
  return PILOT_PROFILES.includes(profile as PilotRuntimeProfile);
}

function parseKeyScopes(
  rawKeyScopes: string | undefined,
  violations: string[],
): readonly PilotUpbitKeyScope[] {
  if (rawKeyScopes === undefined) {
    violations.push("SEEMIRAI_UPBIT_KEY_SCOPE 가 필요합니다");
    return [];
  }

  const scopes = rawKeyScopes
    .split(/[,\s]+/u)
    .map((scope) => scope.trim())
    .filter((scope) => scope.length > 0);

  const uniqueScopes = [...new Set(scopes)];
  const allowedScopes: PilotUpbitKeyScope[] = [];

  for (const scope of uniqueScopes) {
    if (isForbiddenKeyScope(scope)) {
      // 출금/입출금/레버리지 권한은 v0.2 pilot side effect 범위를 벗어나므로 권한 문자열만 보여도 닫는다.
      violations.push(`금지된 Upbit key scope가 포함되어 있습니다: ${scope}`);
      continue;
    }

    if (!isAllowedKeyScope(scope)) {
      violations.push(`알 수 없는 Upbit key scope가 포함되어 있습니다: ${scope}`);
      continue;
    }

    allowedScopes.push(scope);
  }

  return allowedScopes;
}

function isAllowedKeyScope(scope: string): scope is PilotUpbitKeyScope {
  return ALLOWED_KEY_SCOPES.includes(scope as PilotUpbitKeyScope);
}

function isForbiddenKeyScope(scope: string): boolean {
  return FORBIDDEN_KEY_SCOPES.includes(scope as (typeof FORBIDDEN_KEY_SCOPES)[number]);
}

function validateLookupOrderInput(
  profile: PilotRuntimeProfile,
  lookupOrderUuid: string | undefined,
  lookupOrderIdentifier: string | undefined,
  keyScopes: readonly PilotUpbitKeyScope[],
  violations: string[],
): void {
  if (lookupOrderUuid !== undefined && lookupOrderIdentifier !== undefined) {
    violations.push("주문 조회 식별자는 uuid 또는 identifier 중 하나만 지정해야 합니다");
  }

  if (
    lookupOrderIdentifier !== undefined &&
    lookupOrderIdentifier.length > UPBIT_PILOT_IDENTIFIER_MAX_LENGTH
  ) {
    // Upbit identifier 길이 제한은 API 호출 전에 닫아야 env guard가 smoke 실패를 앞단에서 막을 수 있다.
    violations.push(`SEEMIRAI_UPBIT_LOOKUP_ORDER_IDENTIFIER 는 ${UPBIT_PILOT_IDENTIFIER_MAX_LENGTH}자 이하여야 합니다`);
  }

  if ((lookupOrderUuid !== undefined || lookupOrderIdentifier !== undefined) && profile !== "PILOT_READ_ONLY") {
    // 운영자가 넘긴 기존 주문 식별자는 read-only 조회에만 쓰고, policy/order smoke가 임의 주문을 참조하지 못하게 닫는다.
    violations.push("SEEMIRAI_UPBIT_LOOKUP_ORDER_UUID/IDENTIFIER 는 PILOT_READ_ONLY 에서만 사용할 수 있습니다");
  }

  if ((lookupOrderUuid !== undefined || lookupOrderIdentifier !== undefined) && !keyScopes.includes("주문조회")) {
    // 기존 주문 조회는 read-only라 하더라도 주문조회 권한이 없으면 private endpoint 호출 전에 닫아야 한다.
    violations.push("주문 조회 식별자를 쓰려면 Upbit key scope에 주문조회가 필요합니다");
  }
}

interface ValidateProfileSpecificGuardsInput {
  profile: PilotRuntimeProfile;
  orderSmokeGuard: string | undefined;
  policySyncMarket: string | undefined;
  orderSmokeMarket: string | undefined;
  orderSmokeMaxKrw: string | undefined;
  keyScopes: readonly PilotUpbitKeyScope[];
  violations: string[];
}

function validateProfileSpecificGuards(input: ValidateProfileSpecificGuardsInput): void {
  requireScopes(input.keyScopes, requiredScopesForProfile(input.profile), input.violations);

  if (input.profile === "PILOT_READ_ONLY") {
    rejectScopes(input.keyScopes, ["주문하기"], input.violations, input.profile);
    rejectPolicySyncOnlyEnv(input);
    rejectOrderSmokeOnlyEnv(input);
    return;
  }

  validateMarket("SEEMIRAI_UPBIT_POLICY_SYNC_MARKET", input.policySyncMarket, input.violations);

  if (input.profile === "PILOT_POLICY_SYNC") {
    rejectScopes(input.keyScopes, ["주문하기"], input.violations, input.profile);
    rejectOrderSmokeOnlyEnv(input);
    return;
  }

  if (input.orderSmokeGuard !== "1") {
    // 실주문 생성/취소는 private read guard와 별도 승인 guard가 모두 있어야만 다음 단계로 넘어간다.
    input.violations.push("PILOT_ORDER_SMOKE 에는 SEEMIRAI_RUN_UPBIT_ORDER_SMOKE=1 이 필요합니다");
  }

  validateMarket("SEEMIRAI_UPBIT_ORDER_SMOKE_MARKET", input.orderSmokeMarket, input.violations);
  validateOrderSmokeMaxKrw(input.orderSmokeMaxKrw, input.violations);

  if (
    input.policySyncMarket !== undefined &&
    input.orderSmokeMarket !== undefined &&
    input.policySyncMarket !== input.orderSmokeMarket
  ) {
    input.violations.push("SEEMIRAI_UPBIT_POLICY_SYNC_MARKET 과 SEEMIRAI_UPBIT_ORDER_SMOKE_MARKET 은 같아야 합니다");
  }
}

function requiredScopesForProfile(profile: PilotRuntimeProfile): readonly PilotUpbitKeyScope[] {
  if (profile === "PILOT_READ_ONLY") {
    return ["자산조회"];
  }

  if (profile === "PILOT_POLICY_SYNC") {
    return ["자산조회", "주문조회"];
  }

  return ["자산조회", "주문조회", "주문하기"];
}

function requireScopes(
  keyScopes: readonly PilotUpbitKeyScope[],
  requiredScopes: readonly PilotUpbitKeyScope[],
  violations: string[],
): void {
  for (const requiredScope of requiredScopes) {
    if (!keyScopes.includes(requiredScope)) {
      violations.push(`Upbit key scope에 ${requiredScope} 권한이 필요합니다`);
    }
  }
}

function rejectScopes(
  keyScopes: readonly PilotUpbitKeyScope[],
  rejectedScopes: readonly PilotUpbitKeyScope[],
  violations: string[],
  profile: PilotRuntimeProfile,
): void {
  for (const rejectedScope of rejectedScopes) {
    if (keyScopes.includes(rejectedScope)) {
      violations.push(`${profile} 에서는 Upbit key scope ${rejectedScope} 권한을 사용할 수 없습니다`);
    }
  }
}

function rejectPolicySyncOnlyEnv(input: ValidateProfileSpecificGuardsInput): void {
  if (input.policySyncMarket !== undefined) {
    // read-only smoke는 계정 조회와 선택적 주문 조회까지만 허용하므로 policy sync endpoint 입력도 별도 profile로 분리한다.
    input.violations.push(`${input.profile} 에서는 policy sync 전용 env를 사용할 수 없습니다`);
  }
}

function rejectOrderSmokeOnlyEnv(input: ValidateProfileSpecificGuardsInput): void {
  if (input.orderSmokeGuard === "1" || input.orderSmokeMarket !== undefined || input.orderSmokeMaxKrw !== undefined) {
    // read-only/policy 단계에서 주문 전용 env가 섞이면 후속 wrapper가 잘못 열린 profile로 해석할 수 있어 닫는다.
    input.violations.push(`${input.profile} 에서는 order smoke 전용 env를 사용할 수 없습니다`);
  }
}

function validateMarket(key: string, market: string | undefined, violations: string[]): void {
  if (market === undefined) {
    violations.push(`${key} 가 필요합니다`);
    return;
  }

  if (!KRW_MARKET_PATTERN.test(market)) {
    violations.push(`${key} 는 KRW- 로 시작하는 Upbit KRW 현물 market이어야 합니다`);
  }
}

function validateOrderSmokeMaxKrw(maxKrw: string | undefined, violations: string[]): void {
  if (maxKrw === undefined) {
    violations.push("SEEMIRAI_UPBIT_ORDER_SMOKE_MAX_KRW 가 필요합니다");
    return;
  }

  if (!POSITIVE_DECIMAL_PATTERN.test(maxKrw) || Number(maxKrw) <= 0) {
    violations.push("SEEMIRAI_UPBIT_ORDER_SMOKE_MAX_KRW 는 양수 KRW 금액이어야 합니다");
    return;
  }

  if (Number(maxKrw) < UPBIT_PILOT_ORDER_SMOKE_MIN_KRW_LIMIT) {
    violations.push("SEEMIRAI_UPBIT_ORDER_SMOKE_MAX_KRW 는 5000 KRW 이상이어야 합니다");
  }

  if (Number(maxKrw) > UPBIT_PILOT_ORDER_SMOKE_MAX_KRW_LIMIT) {
    violations.push("SEEMIRAI_UPBIT_ORDER_SMOKE_MAX_KRW 는 50000 KRW 이하여야 합니다");
  }
}

interface CreateEnabledPilotRuntimeConfigInput {
  profile: PilotRuntimeProfile | undefined;
  accessKey: string | undefined;
  secretKey: string | undefined;
  keyScopes: readonly PilotUpbitKeyScope[];
  keyScopeEvidenceId: string | undefined;
  policySyncMarket: string | undefined;
  orderSmokeMarket: string | undefined;
  orderSmokeMaxKrw: string | undefined;
  lookupOrderUuid: string | undefined;
  lookupOrderIdentifier: string | undefined;
  orderSmokeGuard: string | undefined;
}

function createEnabledPilotRuntimeConfig(
  input: CreateEnabledPilotRuntimeConfigInput,
): EnabledPilotRuntimeConfig {
  if (
    input.profile === undefined ||
    input.accessKey === undefined ||
    input.secretKey === undefined ||
    input.keyScopeEvidenceId === undefined
  ) {
    throw new UnsafePilotRuntimeConfigError(["pilot runtime config 조립 전 필수 env 검증이 완료되지 않았습니다"]);
  }

  const config: EnabledPilotRuntimeConfig = {
    enabled: true,
    profile: input.profile,
    privateSmokeEnabled: true,
    orderSmokeEnabled: input.profile === "PILOT_ORDER_SMOKE" && input.orderSmokeGuard === "1",
    upbitAccessKey: input.accessKey,
    upbitSecretKey: input.secretKey,
    keyScopes: input.keyScopes,
    keyScopeEvidenceId: input.keyScopeEvidenceId,
  };

  assignIfDefined(config, "policySyncMarket", input.policySyncMarket);
  assignIfDefined(config, "orderSmokeMarket", input.orderSmokeMarket);
  assignIfDefined(config, "orderSmokeMaxKrw", input.orderSmokeMaxKrw);
  assignIfDefined(config, "lookupOrderUuid", input.lookupOrderUuid);
  assignIfDefined(config, "lookupOrderIdentifier", input.lookupOrderIdentifier);

  return config;
}

function assignIfDefined<T extends object, K extends keyof T>(target: T, key: K, value: T[K] | undefined): void {
  if (value !== undefined) {
    target[key] = value;
  }
}

/**
 * M19 exit pilot guard 설정을 env에서 읽고 검증한다.
 *
 * `SEEMIRAI_RUN_M19_EXIT_PILOT=1`이 없으면 비활성 상태를 반환한다. 활성화 시 position source, 소액 한도, 운영자
 * evidence id를 모두 확인한다. `EXISTING_SMALL_POSITION`은 M16 reconcile 또는 운영자 position evidence id가 없으면
 * 닫고, guarded buy smoke는 별도 approval evidence 없이는 fail-closed 조건을 강제한다. 이 함수는 env 해석만
 * 수행하며 외부 API 호출이나 파일 접근 side effect를 만들지 않는다.
 */
export function loadM19ExitPilotGuardConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): M19ExitPilotGuardConfigResult {
  const m19ExitPilot = readEnv(env, "SEEMIRAI_RUN_M19_EXIT_PILOT");
  const guardedBuySmokeRaw = readEnv(env, "SEEMIRAI_RUN_M19_GUARDED_BUY_SMOKE");
  if (m19ExitPilot !== "1") {
    if (guardedBuySmokeRaw === "1") {
      // M19 guarded buy marker만 켜진 상태를 SKIPPED로 낮추면 일반 order smoke가 신규 buy를 만들 수 있어 fail-closed 한다.
      throw new UnsafePilotRuntimeConfigError([
        "SEEMIRAI_RUN_M19_GUARDED_BUY_SMOKE=1 을 사용하려면 SEEMIRAI_RUN_M19_EXIT_PILOT=1 이 필요합니다",
      ]);
    }

    return { enabled: false };
  }

  const violations: string[] = [];

  const positionSource = parseM19PositionSource(
    readEnv(env, "SEEMIRAI_M19_EXIT_PILOT_POSITION_SOURCE"),
    violations,
  );

  const maxKrw = readEnv(env, "SEEMIRAI_M19_EXIT_PILOT_MAX_KRW");
  if (maxKrw === undefined) {
    violations.push("SEEMIRAI_M19_EXIT_PILOT_MAX_KRW 가 필요합니다");
  } else {
    validateM19MaxKrw(maxKrw, violations);
  }

  const operatorEvidenceId = readEnv(env, "SEEMIRAI_M19_EXIT_PILOT_OPERATOR_EVIDENCE_ID");
  if (operatorEvidenceId === undefined) {
    violations.push("SEEMIRAI_M19_EXIT_PILOT_OPERATOR_EVIDENCE_ID 가 필요합니다");
  }

  const positionEvidenceId = readEnv(env, "SEEMIRAI_M19_EXIT_PILOT_POSITION_EVIDENCE_ID");
  if (positionSource === "EXISTING_SMALL_POSITION" && positionEvidenceId === undefined) {
    // 기존 포지션 source는 실제 보유 상태가 전제이므로 M16 reconcile 또는 운영자 확인 evidence 없이 열지 않는다.
    violations.push(
      "EXISTING_SMALL_POSITION 을 사용하려면 SEEMIRAI_M19_EXIT_PILOT_POSITION_EVIDENCE_ID 가 필요합니다",
    );
  }

  const guardedBuySmokeEnabled = guardedBuySmokeRaw === "1";
  const guardedBuyApprovalEvidenceId = readEnv(env, "SEEMIRAI_M19_GUARDED_BUY_APPROVAL_EVIDENCE_ID");

  // guarded buy smoke approval evidence 누락은 config load 예외가 아니라
  // validateM19GuardedBuySmokeGuard가 FAILED_CLOSED로 판단한다. loader는 config만 반환한다.
  if (violations.length > 0) {
    throw new UnsafePilotRuntimeConfigError(violations);
  }

  const config: M19ExitPilotGuardConfig = {
    enabled: true,
    positionSource: positionSource!,
    maxKrw: maxKrw!,
    operatorEvidenceId: operatorEvidenceId!,
    guardedBuySmokeEnabled,
  };

  if (positionEvidenceId !== undefined) {
    config.positionEvidenceId = positionEvidenceId;
  }

  if (guardedBuyApprovalEvidenceId !== undefined) {
    config.guardedBuyApprovalEvidenceId = guardedBuyApprovalEvidenceId;
  }

  return config;
}

function parseM19PositionSource(
  raw: string | undefined,
  violations: string[],
): M19ExitPilotPositionSource | undefined {
  if (raw === undefined) {
    violations.push("SEEMIRAI_M19_EXIT_PILOT_POSITION_SOURCE 가 필요합니다");
    return undefined;
  }

  if (!isM19PositionSource(raw)) {
    violations.push(
      `SEEMIRAI_M19_EXIT_PILOT_POSITION_SOURCE 는 ${M19_EXIT_PILOT_POSITION_SOURCES.join(" 또는 ")} 이어야 합니다`,
    );
    return undefined;
  }

  return raw;
}

function isM19PositionSource(value: string): value is M19ExitPilotPositionSource {
  return M19_EXIT_PILOT_POSITION_SOURCES.includes(value as M19ExitPilotPositionSource);
}

function validateM19MaxKrw(maxKrw: string, violations: string[]): void {
  if (!POSITIVE_DECIMAL_PATTERN.test(maxKrw) || Number(maxKrw) <= 0) {
    violations.push("SEEMIRAI_M19_EXIT_PILOT_MAX_KRW 는 양수 KRW 금액이어야 합니다");
    return;
  }

  if (Number(maxKrw) < UPBIT_PILOT_ORDER_SMOKE_MIN_KRW_LIMIT) {
    violations.push("SEEMIRAI_M19_EXIT_PILOT_MAX_KRW 는 5000 KRW 이상이어야 합니다");
  }

  if (Number(maxKrw) > UPBIT_PILOT_ORDER_SMOKE_MAX_KRW_LIMIT) {
    violations.push("SEEMIRAI_M19_EXIT_PILOT_MAX_KRW 는 50000 KRW 이하여야 합니다");
  }
}
