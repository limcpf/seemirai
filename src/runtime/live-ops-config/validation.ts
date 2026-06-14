import { z } from "zod";
import { detectLegacyLiveOpsEnv, type LiveOpsLegacyEnvViolation } from "./legacy-env.js";
import { loadLiveOpsConfig, type LiveOpsConfig } from "./schema.js";
import { loadLiveOpsSecretsFromEnv, parseLiveOpsEnvFileContent, type LiveOpsSecrets } from "./secrets.js";
import { formatLiveOpsStartupFailureMessage } from "./user-facing.js";

const secretLikeConfigKeyPattern = /(?:secret|token|password|access[_-]?key|secret[_-]?key|database[_-]?url|authorization|jwt)/iu;

/**
 * production live ops startup contract 검증 입력이다.
 *
 * configInput은 저장소에 둘 수 있는 JSON 정책이고 env/envFileContent는 외부 secret 주입 경계다. 이 타입은 config/env를 분리해
 * 검증하기 위한 입력이며, DB 연결이나 provider 호출 side effect를 만들지 않는다.
 */
export interface LiveOpsStartupContractInput {
  configInput: unknown;
  env?: NodeJS.ProcessEnv;
  envFileContent?: string;
}

/**
 * production live ops startup contract 검증 결과다.
 *
 * `ready=true`는 config/env shape만 통과했다는 뜻이다. DB readiness, Upbit public/private probe, Telegram 실제 전송, TUI
 * nonblank 검증은 후속 sub PR에서 별도 evidence로 닫아야 한다.
 */
export type LiveOpsStartupContractValidationResult =
  | {
      ready: true;
      config: LiveOpsConfig;
      secretsConfigured: {
        databaseUrl: true;
        upbitAccessKey: true;
        upbitSecretKey: true;
        telegramBotToken: true;
        telegramChatId: true;
        tuiControlToken: boolean;
      };
      legacyEnvViolations: readonly [];
      secretConfigPaths: readonly [];
      message: string;
    }
  | {
      ready: false;
      legacyEnvViolations: readonly LiveOpsLegacyEnvViolation[];
      secretConfigPaths: readonly string[];
      errors: readonly string[];
      message: string;
    };

/**
 * production live ops config/env 계약 위반 오류다.
 *
 * 오류 객체에는 secret 값이 아니라 위반 경로와 env 이름만 들어간다. caller는 이 오류를 CLI/TUI 첫 화면에 그대로 노출해도 secret
 * 원문이 새지 않아야 한다.
 */
export class UnsafeLiveOpsConfigError extends Error {
  public readonly errors: readonly string[];

  public constructor(errors: readonly string[]) {
    super(formatLiveOpsStartupFailureMessage({ validationErrors: errors }));
    this.name = "UnsafeLiveOpsConfigError";
    this.errors = errors;
  }
}

/**
 * production live ops config/env startup contract를 검증한다.
 *
 * legacy milestone env, JSON 내부 secret-like key, production config schema, secret env presence를 순서대로 확인한다. 실패 시
 * private client, live broker, Telegram provider, TUI control side effect를 만들 수 없도록 `ready=false`로 수렴한다.
 */
export function validateLiveOpsStartupContract(
  input: LiveOpsStartupContractInput,
): LiveOpsStartupContractValidationResult {
  const env = input.env ?? {};
  const envFileResult =
    input.envFileContent === undefined
      ? { values: {}, errors: [] as string[] }
      : parseLiveOpsEnvFileContent(input.envFileContent);
  const mergedEnv = { ...env, ...envFileResult.values };
  const legacyEnvViolations = mergeLegacyEnvViolations([
    detectLegacyLiveOpsEnv(env),
    detectLegacyLiveOpsEnv(envFileResult.values),
  ]);
  const secretConfigPaths = findSecretLikeConfigPaths(input.configInput);
  const errors: string[] = [...envFileResult.errors];

  let config: LiveOpsConfig | undefined;
  try {
    config = loadLiveOpsConfig(input.configInput);
  } catch (error) {
    errors.push(formatZodOrError(error));
  }

  if (secretConfigPaths.length > 0) {
    // credential이 JSON에 있으면 redaction 실수로 PR/docs/artifact에 남을 수 있어 config load와 별개로 차단한다.
    errors.push(`production live ops JSON config에 secret-like key가 있습니다: ${secretConfigPaths.join(", ")}`);
  }

  if (legacyEnvViolations.length > 0) {
    // milestone env는 실제 readiness probe를 우회할 수 있으므로 값이 안전해 보여도 production path에서는 허용하지 않는다.
    errors.push(...legacyEnvViolations.map((violation) => violation.message));
  }

  let secrets: LiveOpsSecrets | undefined;
  if (config !== undefined) {
    try {
      secrets = loadLiveOpsSecretsFromEnv(mergedEnv, { requireTuiControlToken: config.tui.controls_enabled });
    } catch (error) {
      errors.push(formatZodOrError(error));
    }
  }

  if (config === undefined || secrets === undefined || errors.length > 0) {
    return {
      ready: false,
      legacyEnvViolations,
      secretConfigPaths,
      errors,
      message: formatLiveOpsStartupFailureMessage({ legacyEnvViolations, validationErrors: errors }),
    };
  }

  return {
    ready: true,
    config,
    secretsConfigured: {
      databaseUrl: true,
      upbitAccessKey: true,
      upbitSecretKey: true,
      telegramBotToken: true,
      telegramChatId: true,
      tuiControlToken: secrets.tuiControlToken !== undefined,
    },
    legacyEnvViolations: [],
    secretConfigPaths: [],
    message: "production live ops config/env 계약을 통과했습니다. DB/provider readiness는 boot sequence에서 다시 확인해야 합니다.",
  };
}

/**
 * production live ops config/env contract를 통과하지 못하면 예외로 중단한다.
 *
 * entrypoint는 이 함수가 성공한 뒤에만 DB readiness, provider probe, TUI shell render 같은 후속 boot sequence로 넘어가야 한다.
 */
export function assertLiveOpsStartupContract(input: LiveOpsStartupContractInput): {
  config: LiveOpsConfig;
  secrets: LiveOpsSecrets;
} {
  const result = validateLiveOpsStartupContract(input);
  if (!result.ready) {
    throw new UnsafeLiveOpsConfigError(result.errors);
  }

  const envFileResult =
    input.envFileContent === undefined
      ? { values: {}, errors: [] as string[] }
      : parseLiveOpsEnvFileContent(input.envFileContent);
  const mergedEnv = { ...(input.env ?? {}), ...envFileResult.values };
  return {
    config: result.config,
    secrets: loadLiveOpsSecretsFromEnv(mergedEnv, { requireTuiControlToken: result.config.tui.controls_enabled }),
  };
}

/**
 * process env와 env file 양쪽의 legacy env 위반을 하나의 evidence 목록으로 합친다.
 *
 * production shell에 남아 있던 milestone flag가 env file override로 사라져 보이면 readiness 우회가 가능하므로 merge 전에 각
 * 경계를 따로 검사한 뒤 env 이름 기준으로 중복만 제거한다.
 */
function mergeLegacyEnvViolations(
  sources: readonly (readonly LiveOpsLegacyEnvViolation[])[],
): LiveOpsLegacyEnvViolation[] {
  const violationsByName = new Map<string, LiveOpsLegacyEnvViolation>();
  for (const source of sources) {
    for (const violation of source) {
      if (!violationsByName.has(violation.envName)) {
        violationsByName.set(violation.envName, violation);
      }
    }
  }
  return [...violationsByName.values()].sort((left, right) => left.envName.localeCompare(right.envName));
}

/**
 * JSON config 객체에서 secret-like key 경로를 찾는다.
 *
 * 값은 검사하지 않고 key 이름만 본다. secret 값 자체를 읽거나 반환하지 않아 validation report가 credential 유출 경로가 되지 않게
 * 한다.
 */
export function findSecretLikeConfigPaths(input: unknown): string[] {
  const paths: string[] = [];
  collectSecretLikeConfigPaths(input, "$", paths);
  return paths;
}

function collectSecretLikeConfigPaths(input: unknown, path: string, paths: string[]): void {
  if (Array.isArray(input)) {
    input.forEach((value, index) => collectSecretLikeConfigPaths(value, `${path}[${index}]`, paths));
    return;
  }

  if (input === null || typeof input !== "object") {
    return;
  }

  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    const nextPath = `${path}.${key}`;
    if (secretLikeConfigKeyPattern.test(key)) {
      paths.push(nextPath);
      continue;
    }
    collectSecretLikeConfigPaths(value, nextPath, paths);
  }
}

function formatZodOrError(error: unknown): string {
  if (error instanceof z.ZodError) {
    return error.issues.map((issue) => `${issue.path.join(".") || "config"}: ${issue.message}`).join("; ");
  }
  if (error instanceof Error) {
    return error.message;
  }
  return "알 수 없는 live ops config/env 오류";
}
