export const LIVE_OPS_REQUIRED_SECRET_ENV_NAMES = [
  "SEEMIRAI_DATABASE_URL",
  "SEEMIRAI_UPBIT_ACCESS_KEY",
  "SEEMIRAI_UPBIT_SECRET_KEY",
  "SEEMIRAI_TELEGRAM_BOT_TOKEN",
  "SEEMIRAI_TELEGRAM_CHAT_ID",
] as const;

/**
 * production live ops secret/env 입력이다.
 *
 * JSON config와 분리된 credential boundary이며, 값은 runtime 조립 시에만 메모리로 전달된다. 이 타입을 status, TUI, Telegram,
 * audit payload에 그대로 넣으면 secret 노출이므로 caller는 boolean/readiness projection으로 낮춰야 한다.
 */
export interface LiveOpsSecrets {
  databaseUrl: string;
  upbitAccessKey: string;
  upbitSecretKey: string;
  telegramBotToken: string;
  telegramChatId: string;
  tuiControlToken?: string;
}

/**
 * env 파일 parse 결과다.
 *
 * `values`에는 shell-format env에서 해석한 key/value만 담는다. source line은 오류 위치 확인을 위한 숫자만 남기며, secret 값을
 * validation 오류에 포함하지 않는 것이 invariant다.
 */
export interface LiveOpsEnvFileParseResult {
  values: NodeJS.ProcessEnv;
  errors: readonly string[];
}

/**
 * live ops secret loader 옵션이다.
 *
 * TUI control이 설정상 열려 있으면 local control token이 필요하다. fixture smoke처럼 control을 닫은 검증은 이 값을 false로 두어
 * broker나 control side effect 없이 config/env contract만 확인할 수 있다.
 */
export interface LoadLiveOpsSecretsOptions {
  requireTuiControlToken?: boolean;
}

/**
 * shell-format env 파일 내용을 안전한 key/value projection으로 해석한다.
 *
 * `export KEY=value`, 단순 single/double quoted value, 주석과 빈 줄만 지원한다. shell command substitution이나 variable expansion은
 * 의도적으로 지원하지 않아 env 파일 parse 과정이 code execution 경계가 되지 않게 한다.
 */
export function parseLiveOpsEnvFileContent(content: string): LiveOpsEnvFileParseResult {
  const values: NodeJS.ProcessEnv = {};
  const errors: string[] = [];
  const lines = content.split(/\r?\n/u);

  lines.forEach((line, index) => {
    const lineNumber = index + 1;
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) {
      return;
    }

    const normalized = trimmed.startsWith("export ") ? trimmed.slice("export ".length).trim() : trimmed;
    const separatorIndex = normalized.indexOf("=");
    if (separatorIndex <= 0) {
      errors.push(`${lineNumber}번 줄은 KEY=value 형식이어야 합니다.`);
      return;
    }

    const key = normalized.slice(0, separatorIndex).trim();
    const rawValue = normalized.slice(separatorIndex + 1).trim();
    if (!/^[A-Z_][A-Z0-9_]*$/u.test(key)) {
      errors.push(`${lineNumber}번 줄의 env key 형식이 올바르지 않습니다.`);
      return;
    }

    values[key] = parseEnvValue(rawValue);
  });

  return { values, errors };
}

/**
 * process env projection에서 production live ops secret을 로드한다.
 *
 * 필수 credential이 비어 있으면 broker/client 조립 전 단계에서 실패해야 한다. 오류는 env 이름만 포함하며 실제 secret 값은 반환된
 * 성공 객체 안에만 존재한다.
 */
export function loadLiveOpsSecretsFromEnv(
  env: NodeJS.ProcessEnv,
  options: LoadLiveOpsSecretsOptions = {},
): LiveOpsSecrets {
  const missing: string[] = LIVE_OPS_REQUIRED_SECRET_ENV_NAMES.filter((envName) => !hasEnvValue(env, envName));
  if (options.requireTuiControlToken === true && !hasEnvValue(env, "SEEMIRAI_TUI_CONTROL_TOKEN")) {
    // TUI control이 켜진 상태에서 local token이 없으면 pause/resume/kill confirmation을 안전하게 닫을 수 없다.
    missing.push("SEEMIRAI_TUI_CONTROL_TOKEN");
  }

  if (missing.length > 0) {
    throw new Error(`production live ops secret env가 부족합니다: ${missing.join(", ")}`);
  }

  return {
    databaseUrl: requiredEnv(env, "SEEMIRAI_DATABASE_URL"),
    upbitAccessKey: requiredEnv(env, "SEEMIRAI_UPBIT_ACCESS_KEY"),
    upbitSecretKey: requiredEnv(env, "SEEMIRAI_UPBIT_SECRET_KEY"),
    telegramBotToken: requiredEnv(env, "SEEMIRAI_TELEGRAM_BOT_TOKEN"),
    telegramChatId: requiredEnv(env, "SEEMIRAI_TELEGRAM_CHAT_ID"),
    ...(hasEnvValue(env, "SEEMIRAI_TUI_CONTROL_TOKEN")
      ? { tuiControlToken: requiredEnv(env, "SEEMIRAI_TUI_CONTROL_TOKEN") }
      : {}),
  };
}

function parseEnvValue(rawValue: string): string {
  if (
    (rawValue.startsWith('"') && rawValue.endsWith('"')) ||
    (rawValue.startsWith("'") && rawValue.endsWith("'"))
  ) {
    return rawValue.slice(1, -1);
  }

  const commentIndex = rawValue.indexOf(" #");
  return commentIndex >= 0 ? rawValue.slice(0, commentIndex).trim() : rawValue;
}

function hasEnvValue(env: NodeJS.ProcessEnv, envName: string): boolean {
  return env[envName] !== undefined && env[envName]?.trim().length !== 0;
}

function requiredEnv(env: NodeJS.ProcessEnv, envName: string): string {
  const value = env[envName];
  if (value === undefined || value.trim().length === 0) {
    throw new Error(`${envName} is required`);
  }
  return value;
}
