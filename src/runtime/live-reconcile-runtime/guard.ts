import type { PilotUpbitKeyScope } from "../pilot-config.js";
import { FORBIDDEN_KEY_SCOPES } from "../pilot-config/types.js";
import {
  ALLOWED_RECONCILE_KEY_SCOPES,
  FORBIDDEN_RECONCILE_KEY_SCOPES,
  UnsafeLiveReconcileRuntimeError,
} from "./types.js";
import type {
  EnabledLiveReconcileRuntimeConfig,
  LiveReconcileRuntimeConfig,
} from "./types.js";

/**
 * process env 형태의 입력을 M16 read-only reconcile runtime guard로 해석한다.
 *
 * 기본 env는 disabled config로 반환해 reconcile worker를 시작하지 않는다. reconcile guard, private smoke guard,
 * credential, scope evidence가 일부만 들어온 상태는 private API가 암묵적으로 열리지 않도록 fail-closed 오류로
 * 거부한다. 외부 API 호출이나 파일 접근은 없다.
 *
 * @param env process env (기본값 process.env)
 * @returns reconcile runtime config. enabled=false이면 reconcile worker를 시작하지 않는다.
 */
export function loadLiveReconcileRuntimeConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): LiveReconcileRuntimeConfig {
  const reconcileGuard = readEnv(env, "SEEMIRAI_RUN_UPBIT_LIVE_RECONCILE");
  const privateSmokeGuard = readEnv(env, "SEEMIRAI_RUN_UPBIT_PRIVATE_SMOKE");
  const accessKey = readEnv(env, "SEEMIRAI_UPBIT_ACCESS_KEY");
  const secretKey = readEnv(env, "SEEMIRAI_UPBIT_SECRET_KEY");
  const rawKeyScopes = readEnv(env, "SEEMIRAI_UPBIT_KEY_SCOPE");
  const keyScopeEvidenceId = readEnv(env, "SEEMIRAI_UPBIT_KEY_SCOPE_EVIDENCE_ID");

  // reconcile guard가 명시되지 않으면 기본 disabled 상태를 반환한다.
  if (reconcileGuard !== "1") {
    return { enabled: false };
  }

  const violations: string[] = [];

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

  const keyScopes = parseReconcileKeyScopes(rawKeyScopes, violations);

  if (keyScopeEvidenceId === undefined) {
    violations.push("SEEMIRAI_UPBIT_KEY_SCOPE_EVIDENCE_ID 가 필요합니다");
  }

  if (violations.length > 0) {
    throw new UnsafeLiveReconcileRuntimeError(violations);
  }

  return {
    enabled: true,
    upbitAccessKey: accessKey!,
    upbitSecretKey: secretKey!,
    keyScopes,
    keyScopeEvidenceId: keyScopeEvidenceId!,
  };
}

function readEnv(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const value = env[key]?.trim();
  return value === undefined || value.length === 0 ? undefined : value;
}

/**
 * reconcile runtime에서 허용/금지하는 key scope를 파싱하고 검증한다.
 *
 * `자산조회`, `주문조회`만 허용하며, `주문하기`는 read-only reconcile에서 금지한다.
 * 출금/입출금/레버리지 같은 기존 금지 scope도 함께 차단한다. 중복 scope는 무시한다.
 *
 * @param rawKeyScopes 쉼표/공백으로 구분된 key scope 문자열
 * @param violations 위반 항목을 누적할 배열
 * @returns 검증된 허용 scope 목록
 */
function parseReconcileKeyScopes(
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
      // 출금/입출금/레버리지 권한은 M16 reconcile side effect 범위를 벗어나므로 권한 문자열만 보여도 닫는다.
      violations.push(`금지된 Upbit key scope가 포함되어 있습니다: ${scope}`);
      continue;
    }

    if (isReconcileForbiddenKeyScope(scope)) {
      // `주문하기` 권한은 read-only reconcile에서 허용하지 않는다.
      violations.push(`LIVE_READ_ONLY_RECONCILE 에서는 Upbit key scope ${scope} 권한을 사용할 수 없습니다`);
      continue;
    }

    if (!isReconcileAllowedKeyScope(scope)) {
      violations.push(`알 수 없는 Upbit key scope가 포함되어 있습니다: ${scope}`);
      continue;
    }

    allowedScopes.push(scope);
  }

  // 필수 권한 검증
  for (const requiredScope of ALLOWED_RECONCILE_KEY_SCOPES) {
    if (!allowedScopes.includes(requiredScope)) {
      violations.push(`Upbit key scope에 ${requiredScope} 권한이 필요합니다`);
    }
  }

  return allowedScopes;
}

function isReconcileAllowedKeyScope(scope: string): scope is PilotUpbitKeyScope {
  return ALLOWED_RECONCILE_KEY_SCOPES.includes(scope as PilotUpbitKeyScope);
}

function isReconcileForbiddenKeyScope(scope: string): boolean {
  return FORBIDDEN_RECONCILE_KEY_SCOPES.includes(scope as PilotUpbitKeyScope);
}

function isForbiddenKeyScope(scope: string): boolean {
  return FORBIDDEN_KEY_SCOPES.includes(scope as (typeof FORBIDDEN_KEY_SCOPES)[number]);
}
