import type {
  KillSwitchAlertDispatchOptions,
  KillSwitchControlProvider,
} from "../application/index.js";
import {
  PostgresAlertCooldownRepository,
  PostgresAuditLogRepository,
  createPostgresKillSwitchControlProvider,
  createTelegramNotifier,
} from "../infrastructure/index.js";
import type { Database } from "../infrastructure/index.js";
import type { RuntimeConfig } from "./config.js";
import { loadRuntimeNotificationConfig } from "./notification-config.js";

/**
 * PAPER_NO_KEY kill switch control provider를 Telegram alert dispatch와 함께 조립하기 위한 입력이다.
 *
 * database는 kill switch durable state, audit/risk evidence, alert cooldown을 모두 같은 PostgreSQL에 보존하기 위한 handle이다.
 * Telegram secret은 runtime config나 env에서 읽지만, 이 factory는 원문 secret을 반환값이나 로그로 노출하지 않는다.
 */
export interface PaperNoKeyKillSwitchControlProviderOptions {
  database: Database;
  runtimeConfig: RuntimeConfig;
  env?: NodeJS.ProcessEnv;
  clock?: () => Date;
  actor?: string;
}

/**
 * HTTP `/kill-switch` provider를 운영 알림 경로까지 포함해 조립한다.
 *
 * Telegram 설정이 없으면 kill switch durable control만 활성화하고, 설정이 있으면 accepted 전이를 `dispatchAlertWithCooldown`로
 * 이어 붙인다. 이렇게 조립해야 P0/P1 운영 상태 전이가 테스트 전용 helper에 머물지 않고 실제 runtime control path에서
 * Telegram/cooldown/audit 경계를 통과한다.
 */
export function createPaperNoKeyKillSwitchControlProvider(
  options: PaperNoKeyKillSwitchControlProviderOptions,
): KillSwitchControlProvider {
  const alertDispatch = createRuntimeAlertDispatchOptions(options);
  return createPostgresKillSwitchControlProvider({
    database: options.database,
    ...(options.clock === undefined ? {} : { clock: options.clock }),
    ...(options.actor === undefined ? {} : { actor: options.actor }),
    ...(alertDispatch === undefined ? {} : { alertDispatch }),
  });
}

/**
 * runtime config/env를 alert dispatch service 의존성으로 변환한다.
 *
 * bot token과 chat id가 모두 있을 때만 Telegram notifier를 만든다. 알림이 비활성인 배포에서도 kill switch route 자체는 사용할 수
 * 있어야 하므로, 설정이 부족하면 undefined를 반환해 caller가 control provider를 alert 없이 조립하게 한다.
 */
export function createRuntimeAlertDispatchOptions(
  options: PaperNoKeyKillSwitchControlProviderOptions,
): KillSwitchAlertDispatchOptions | undefined {
  const notificationConfig = loadRuntimeNotificationConfig(options.runtimeConfig, options.env);
  if (notificationConfig.telegram === undefined) {
    return undefined;
  }

  return {
    environment: resolveAlertEnvironment(options.env),
    runMode: options.runtimeConfig.mode.toLowerCase(),
    notifier: createTelegramNotifier(notificationConfig.telegram),
    durableCooldownStore: new PostgresAlertCooldownRepository(options.database),
    auditLog: new PostgresAuditLogRepository(options.database),
    ...(options.clock === undefined ? {} : { clock: options.clock }),
  };
}

function resolveAlertEnvironment(env: NodeJS.ProcessEnv | undefined): string {
  const source = env ?? process.env;
  return nonEmptyEnvValue(source.SEEMIRAI_ENV) ?? nonEmptyEnvValue(source.NODE_ENV) ?? "local";
}

function nonEmptyEnvValue(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}
