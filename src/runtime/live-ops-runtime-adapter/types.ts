import type { LiveOpsCliOptions } from "../live-ops-cli/types.js";

/**
 * Live Ops production runtime adapter가 support shim에서 제공받는 side effect port다.
 *
 * 호출 경계는 TypeScript app core/runtime adapter service와 `.mjs` compatibility support 사이이다.
 * 입력은 CLI options, config/env, readiness summary, production runtime handle이며, 출력은
 * 기존 summary renderer가 소비하는 lifecycle 입력 객체다. 실제 DB/provider/broker/Telegram side effect는
 * port 구현이 수행하고, TypeScript service는 호출 순서와 fail-closed/close invariant만 소유한다.
 */
export interface LiveOpsRuntimeAdapterPort {
  resolvePath(value: string): string;
  loadConfigFile(path: string): Promise<Record<string, unknown>>;
  loadEnvFile(path: string): Promise<Record<string, string>>;
  validateConfig(config: Record<string, unknown>): void;
  validateEnv(env: Record<string, string>): void;
  suppressStartupTelegramAlert(config: Record<string, unknown>): Record<string, unknown>;
  loadAttachReadonlyInputs(input: Record<string, unknown>): Promise<Record<string, unknown>>;
  evaluateDbReadiness(input: Record<string, unknown>): Promise<Record<string, unknown>>;
  assertDbReadinessReady(summary: Record<string, unknown>): void;
  evaluateMarketData(input: Record<string, unknown>): Promise<Record<string, unknown>>;
  assertMarketDataReady(summary: Record<string, unknown>, options: { fixtureSmoke?: boolean }): void;
  evaluateBrokerGuard(input: Record<string, unknown>): Record<string, unknown>;
  createProductionRuntime(input: Record<string, unknown>): Promise<Record<string, unknown>>;
  collectAutonomousAnalysisPreflight(input: Record<string, unknown>): Promise<Record<string, unknown> | undefined>;
  evaluateAnalysisDecision(input: Record<string, unknown>): Promise<Record<string, unknown>>;
  getAnalysisOrderIntents(summary: Record<string, unknown>): unknown[];
  createProductionExecutionInputs(input: Record<string, unknown>): Promise<Record<string, unknown>>;
  evaluateLiveExecution(input: Record<string, unknown>): Promise<Record<string, unknown>>;
  evaluateReconcilePnlStatus(input: Record<string, unknown>): Promise<Record<string, unknown>>;
  evaluateTelegramAlert(input: Record<string, unknown>): Promise<Record<string, unknown>>;
  closeProductionRuntime(runtime: Record<string, unknown>): Promise<void>;
}

/**
 * TypeScript runtime adapter service의 입력이다.
 *
 * options는 CLI parser가 만든 값이고, adapter는 support shim이 제공한 side effect port다. service는
 * 이 입력으로 config/env validation, DB readiness, provider readiness, market data, analysis,
 * execution, reconcile/PnL/status, Telegram 순서를 조립한다.
 */
export interface LoadLiveOpsRuntimeAdapterInputsInput {
  options: LiveOpsCliOptions;
  adapter: LiveOpsRuntimeAdapterPort;
}
