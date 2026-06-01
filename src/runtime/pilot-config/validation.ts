import {
  ALLOWED_KEY_SCOPES,
  FORBIDDEN_KEY_SCOPES,
  PILOT_PROFILES,
  UPBIT_PILOT_IDENTIFIER_MAX_LENGTH,
  UPBIT_PILOT_ORDER_SMOKE_MIN_KRW_LIMIT,
  UPBIT_PILOT_ORDER_SMOKE_MAX_KRW_LIMIT,
  UnsafePilotRuntimeConfigError,
} from "./types.js";
import type { EnabledPilotRuntimeConfig, PilotRuntimeConfig, PilotRuntimeProfile, PilotUpbitKeyScope } from "./types.js";

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
