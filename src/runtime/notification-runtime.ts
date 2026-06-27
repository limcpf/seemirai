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
import {
  loadRuntimeNotificationConfig,
  loadRuntimeTelegramBriefingConfig,
} from "./notification-config.js";
import type { RuntimeTelegramBriefingConfig } from "./notification-config.js";
import {
  dispatchScheduledLiveOpsTelegramBriefing,
  planScheduledLiveOpsTelegramBriefing,
} from "./live-ops-telegram-alerts.js";
import type {
  DispatchScheduledLiveOpsTelegramBriefingSummary,
  ScheduledLiveOpsTelegramBriefingPlan,
} from "./live-ops-telegram-alerts.js";
import { createPostgresNotificationRetryJobQueue } from "./notification-retry-runtime.js";

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
 * runtime alert dispatch 객체에 붙는 정기 Telegram briefing 실행 경계다.
 *
 * config는 `RuntimeConfig`/env에서 정규화된 scheduled briefing 설정이고, plan/dispatch는 이미 생성된 deterministic briefing text와
 * source fingerprint를 기존 alert cooldown/retry/audit 경계로 낮춘다. provider나 DB write side effect는 dispatch 호출 때만
 * 발생하며, plan 호출은 순수하게 request shape만 만든다는 invariant를 유지한다.
 */
export interface RuntimeScheduledTelegramBriefingRuntime {
  readonly config: RuntimeTelegramBriefingConfig;
  plan(input: RuntimeScheduledTelegramBriefingPlanInput): ScheduledLiveOpsTelegramBriefingPlan;
  dispatch(input: RuntimeScheduledTelegramBriefingPlanInput): Promise<DispatchScheduledLiveOpsTelegramBriefingSummary>;
}

/**
 * runtime scheduled briefing plan/dispatch 요청이다.
 *
 * 호출자는 deterministic formatter/LLM guard를 이미 통과한 briefing text와 그 source fingerprint를 넘긴다. runtime은
 * environment/runMode와 scheduled config를 보강할 뿐, raw provider payload나 Telegram secret을 입력/출력에 포함하지 않는다.
 */
export interface RuntimeScheduledTelegramBriefingPlanInput {
  readonly observedAt: string;
  readonly briefingText: string;
  readonly briefingSourceFingerprint: string;
  readonly correlationId?: string;
}

/**
 * runtime 알림 dispatch 의존성에 scheduled briefing 실행 경계를 함께 붙인 결과다.
 *
 * kill switch/lifecycle alert와 같은 notifier, cooldown, retry, audit 객체를 공유해야 Telegram provider 실패와 cooldown evidence가
 * 서로 다른 runtime 표면에서 갈라지지 않는다.
 */
export interface RuntimeAlertDispatchOptions extends KillSwitchAlertDispatchOptions {
  readonly scheduledTelegramBriefing: RuntimeScheduledTelegramBriefingRuntime;
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
): RuntimeAlertDispatchOptions | undefined {
  const notificationConfig = loadRuntimeNotificationConfig(options.runtimeConfig, options.env);
  if (notificationConfig.telegram === undefined) {
    return undefined;
  }

  const environment = resolveAlertEnvironment(options.env);
  const runMode = options.runtimeConfig.mode.toLowerCase();
  const alertDispatch: KillSwitchAlertDispatchOptions = {
    environment,
    runMode,
    notifier: createTelegramNotifier(notificationConfig.telegram),
    durableCooldownStore: new PostgresAlertCooldownRepository(options.database),
    retryJobQueue: createPostgresNotificationRetryJobQueue(options.database),
    auditLog: new PostgresAuditLogRepository(options.database),
    ...(options.clock === undefined ? {} : { clock: options.clock }),
  };
  const briefingConfig = loadRuntimeTelegramBriefingConfig(options.runtimeConfig, options.env);

  return {
    ...alertDispatch,
    // scheduled briefing도 같은 provider/cooldown/audit 객체를 공유해야 config 활성화가 별도 테스트 helper에 머물지 않는다.
    scheduledTelegramBriefing: createRuntimeScheduledTelegramBriefingRuntime({
      config: briefingConfig,
      environment,
      runMode,
      alertDispatch,
    }),
  };
}

function createRuntimeScheduledTelegramBriefingRuntime(input: {
  config: RuntimeTelegramBriefingConfig;
  environment: string;
  runMode: string;
  alertDispatch: KillSwitchAlertDispatchOptions;
}): RuntimeScheduledTelegramBriefingRuntime {
  const plan = (planInput: RuntimeScheduledTelegramBriefingPlanInput): ScheduledLiveOpsTelegramBriefingPlan =>
    planScheduledLiveOpsTelegramBriefing({
      config: input.config,
      environment: input.environment,
      runMode: input.runMode,
      observedAt: planInput.observedAt,
      briefingText: planInput.briefingText,
      briefingSourceFingerprint: planInput.briefingSourceFingerprint,
      ...(planInput.correlationId === undefined ? {} : { correlationId: planInput.correlationId }),
    });

  return {
    config: input.config,
    plan,
    async dispatch(dispatchInput) {
      return dispatchScheduledLiveOpsTelegramBriefing({
        plan: plan(dispatchInput),
        alertDispatch: input.alertDispatch,
      });
    },
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
