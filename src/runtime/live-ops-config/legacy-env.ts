export const LIVE_OPS_LEGACY_ENV_NAMES = [
  "SEEMIRAI_RUN_M22_AUTONOMOUS_PILOT",
  "SEEMIRAI_RUN_M22_AUTONOMOUS_DAEMON",
  "SEEMIRAI_RUN_UPBIT_PRIVATE_SMOKE",
  "SEEMIRAI_RUN_UPBIT_ORDER_SMOKE",
  "SEEMIRAI_PILOT_PROFILE",
  "PILOT_ORDER_SMOKE",
] as const;

export const LIVE_OPS_LEGACY_ENV_PATTERNS = [/^SEEMIRAI_M22_.*_READY$/u] as const;
export const LIVE_OPS_LEGACY_SMOKE_ENV_PATTERNS = [/^SEEMIRAI_RUN_UPBIT_.*_SMOKE$/u] as const;

/**
 * production live ops path에서 금지하는 legacy milestone env 위반이다.
 *
 * 이 값은 operator-facing validation message와 PR evidence에 남길 수 있는 safe projection만 담는다. env 값 원문은 secret이나
 * 운영 증거 id일 수 있으므로 포함하지 않는다.
 */
export interface LiveOpsLegacyEnvViolation {
  envName: string;
  message: string;
}

/**
 * M22/M23 milestone runner용 env가 production live ops 실행 환경에 섞였는지 찾는다.
 *
 * milestone env가 켜져 있으면 앱이 실제 DB/provider readiness 대신 과거 smoke flag를 신뢰할 위험이 있으므로 startup contract
 * 단계에서 fail-closed 한다. 함수는 env 이름만 읽고 외부 side effect를 만들지 않는다.
 */
export function detectLegacyLiveOpsEnv(env: NodeJS.ProcessEnv): LiveOpsLegacyEnvViolation[] {
  const violations: LiveOpsLegacyEnvViolation[] = [];

  for (const envName of LIVE_OPS_LEGACY_ENV_NAMES) {
    if (hasEnvValue(env, envName)) {
      // 값 원문은 evidence id나 운영 입력일 수 있어 validation 결과에는 env 이름만 남긴다.
      violations.push({
        envName,
        message: `${envName}은 production live ops readiness 입력으로 사용할 수 없습니다.`,
      });
    }
  }

  for (const envName of Object.keys(env)) {
    if (LIVE_OPS_LEGACY_ENV_PATTERNS.some((pattern) => pattern.test(envName)) && hasEnvValue(env, envName)) {
      // SEEMIRAI_M22_*_READY 계열 boolean은 DB/provider probe를 우회할 수 있어 모두 금지한다.
      violations.push({
        envName,
        message: `${envName}은 실제 DB/provider readiness probe로 대체해야 합니다.`,
      });
    }

    if (LIVE_OPS_LEGACY_SMOKE_ENV_PATTERNS.some((pattern) => pattern.test(envName)) && hasEnvValue(env, envName)) {
      // Upbit smoke guard는 owner-operated 검증 경계라 production boot readiness와 섞이면 provider side effect 의도가 불명확해진다.
      violations.push({
        envName,
        message: `${envName}은 production live ops smoke/readiness 입력으로 사용할 수 없습니다.`,
      });
    }
  }

  return dedupeViolations(violations).sort((left, right) => left.envName.localeCompare(right.envName));
}

function hasEnvValue(env: NodeJS.ProcessEnv, envName: string): boolean {
  const value = env[envName];
  return value !== undefined && value.trim().length > 0 && value.trim() !== "0";
}

function dedupeViolations(violations: readonly LiveOpsLegacyEnvViolation[]): LiveOpsLegacyEnvViolation[] {
  const seen = new Set<string>();
  const deduped: LiveOpsLegacyEnvViolation[] = [];
  for (const violation of violations) {
    if (seen.has(violation.envName)) {
      continue;
    }
    seen.add(violation.envName);
    deduped.push(violation);
  }
  return deduped;
}
