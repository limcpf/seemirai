import type {
  LiveOpsRuntimeAdapterPort,
  LoadLiveOpsRuntimeAdapterInputsInput,
} from "./types.js";

/**
 * Live Ops foreground/TUI lifecycle 입력을 TypeScript runtime adapter 순서로 조립한다.
 *
 * 호출 경계는 app core service이며, 입력은 CLI options와 support-provided adapter port다. 출력은
 * `renderLiveOpsSummary`가 소비하는 lifecycle summary 입력이다. 실제 DB/provider/broker/Telegram
 * 호출은 adapter port가 수행하고, 이 함수는 production runtime 생성 조건, attach readonly 차단,
 * downstream 실패 시 close 보장 invariant를 유지한다.
 */
export async function loadLiveOpsRuntimeAdapterInputs(
  input: LoadLiveOpsRuntimeAdapterInputsInput,
): Promise<Record<string, unknown>> {
  const options = input.options;
  const adapter = input.adapter;
  const configPath = adapter.resolvePath(readRequiredStringOption(options, "configPath", "--config 경로가 필요합니다."));
  const envFilePath = adapter.resolvePath(readRequiredStringOption(options, "envFilePath", "--env-file 경로가 필요합니다."));
  let config = await adapter.loadConfigFile(configPath);
  const env = await adapter.loadEnvFile(envFilePath);
  adapter.validateConfig(config);
  adapter.validateEnv(env);
  if (options.suppressStartupTelegramAlert === true) {
    config = adapter.suppressStartupTelegramAlert(config);
  }
  if (options.attach !== undefined && options.attachReadonly !== true) {
    throw new Error("--attach는 live:ops:tui 명령에서만 사용할 수 있습니다.");
  }
  if (options.fixtureSmoke !== true && options.attach !== undefined) {
    // attach 화면은 기존 status source를 읽는 경로이므로 DB/provider lifecycle을 새로 열기 전에 종료한다.
    return adapter.loadAttachReadonlyInputs({
      configPath,
      envFilePath,
      config,
      env,
      attach: options.attach,
    });
  }

  const dbReadiness = await adapter.evaluateDbReadiness({
    databaseUrl: env.SEEMIRAI_DATABASE_URL,
    fixtureSmoke: options.fixtureSmoke,
  });
  adapter.assertDbReadinessReady(dbReadiness);

  const marketData = await adapter.evaluateMarketData({
    config,
    fixtureSmoke: options.fixtureSmoke,
    databaseUrl: env.SEEMIRAI_DATABASE_URL,
  });
  adapter.assertMarketDataReady(marketData, createFixtureSmokeOptions(options));

  const productionBrokerGuard = adapter.evaluateBrokerGuard({
    config,
    env,
    fixtureSmoke: options.fixtureSmoke,
  });
  let productionRuntime: Record<string, unknown> | undefined;
  try {
    productionRuntime = options.fixtureSmoke === true || productionBrokerGuard.ready !== true
      ? undefined
      : await adapter.createProductionRuntime({
          configPath,
          config,
          env,
          market: resolveDefaultMarket(config),
          fetchImpl: options.fetchImpl,
          artifactDir: options.artifactDir,
          clock: options.clock,
          cancelPollCount: options.cancelPollCount,
          cancelPollIntervalMs: options.cancelPollIntervalMs,
        });
    const autonomousAnalysisPreflight = await adapter.collectAutonomousAnalysisPreflight({
      config,
      fixtureSmoke: options.fixtureSmoke,
      marketData,
      productionRuntime,
    });
    const autonomousAnalysisPreflightRecord = asRecord(autonomousAnalysisPreflight);
    const analysisDecision = await adapter.evaluateAnalysisDecision({
      config,
      fixtureSmoke: options.fixtureSmoke,
      marketData,
      productionPreflight: autonomousAnalysisPreflightRecord?.preflight,
      productionPreflightError: autonomousAnalysisPreflightRecord?.error,
    });
    const orderIntents = adapter.getAnalysisOrderIntents(analysisDecision);
    const productionExecutionInputs = await adapter.createProductionExecutionInputs({
      config,
      env,
      fixtureSmoke: options.fixtureSmoke,
      analysisDecision,
      marketData,
      orderIntents,
      productionRuntime,
      preflight: autonomousAnalysisPreflightRecord?.preflight,
    });
    const liveExecution = await adapter.evaluateLiveExecution({
      config,
      fixtureSmoke: options.fixtureSmoke,
      analysisDecision,
      marketData,
      env,
      orderIntents: readArray(productionExecutionInputs.orderIntents),
      entryRuntime: productionExecutionInputs.entryRuntime,
      exitRuntime: productionExecutionInputs.exitRuntime,
      decisionHistoryWriter: productionExecutionInputs.decisionHistoryWriter,
      executionStatus: productionExecutionInputs.executionStatus,
      postSubmitReadiness: productionExecutionInputs.postSubmitReadiness,
      budgetSnapshot: productionExecutionInputs.budgetSnapshot,
      lossSnapshot: productionExecutionInputs.lossSnapshot,
      cleanupLifecycle: productionExecutionInputs.cleanupLifecycle,
    });
    const reconcilePnlStatus = await adapter.evaluateReconcilePnlStatus({
      config,
      fixtureSmoke: options.fixtureSmoke,
      liveExecution,
      privateReadProvider: productionRuntime?.privateReadProvider,
      reconcileStatusProvider: productionRuntime?.reconcileStatusProvider,
      pnlStatusProvider: productionRuntime?.pnlStatusProvider,
      budgetSnapshot: productionExecutionInputs.budgetSnapshot,
    });
    const telegramAlert = await adapter.evaluateTelegramAlert({
      config,
      env,
      fixtureSmoke: options.fixtureSmoke,
      liveExecution,
      orderIntent: readArray(productionExecutionInputs.orderIntents)[0],
      marketData,
      analysisDecision,
      reconcilePnlStatus,
      telegramDispatcher: productionRuntime?.telegramDispatcher,
      scheduledBriefingDispatcher: productionRuntime?.scheduledBriefingDispatcher,
    });

    return {
      configPath,
      envFilePath,
      config,
      env,
      dbReadiness,
      marketData,
      analysisDecision,
      liveExecution,
      reconcilePnlStatus,
      telegramAlert,
    };
  } finally {
    if (productionRuntime !== undefined) {
      // downstream 실패 시에도 DB pool과 provider handle을 닫아 다음 tick/명령의 중복 side effect를 막는다.
      await adapter.closeProductionRuntime(productionRuntime);
    }
  }
}

function readRequiredStringOption(options: Record<string, unknown>, key: string, message: string): string {
  const value = options[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(message);
  }
  return value;
}

function createFixtureSmokeOptions(options: Record<string, unknown>): { fixtureSmoke?: boolean } {
  const result: { fixtureSmoke?: boolean } = {};
  if (typeof options.fixtureSmoke === "boolean") {
    result.fixtureSmoke = options.fixtureSmoke;
  }
  return result;
}

function resolveDefaultMarket(config: Record<string, unknown>): string {
  const universe = asRecord(config.universe);
  const defaultMarket = universe?.default_market;
  return typeof defaultMarket === "string" && defaultMarket.length > 0 ? defaultMarket : "KRW-BTC";
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function readArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
