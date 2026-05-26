import type { ExecutionSafetyConfig } from "./types.js";

/**
 * paper trading 전용 execution safety 기본값이다.
 *
 * live trading과 시장가 신규 진입은 기본적으로 닫고, API key 없이도 paper runtime이 동작해야 한다는 MVP invariant를 표현한다.
 */
export const defaultPaperExecutionSafetyConfig: ExecutionSafetyConfig = {
  liveTradingEnabled: false,
  marketOrderEnabled: false,
  entryMarketOrderEnabled: false,
  paperNoKey: true,
};

/**
 * runtime에서 넘기는 부분 설정을 paper trading 안전 기본값과 병합한다.
 *
 * 호출자가 일부 toggle만 넘겨도 기본값은 paper-only fail-closed profile로 유지된다.
 */
export function createExecutionSafetyConfig(
  overrides: Partial<ExecutionSafetyConfig> = {},
): ExecutionSafetyConfig {
  return {
    ...defaultPaperExecutionSafetyConfig,
    ...overrides,
  };
}
