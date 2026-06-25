import type {
  LiveOpsAppCoreBootPlan,
  LiveOpsAppCoreBootPlanInput,
  LiveOpsAppCoreBootStep,
} from "./types.js";

const liveOpsAppCoreBootSteps: readonly LiveOpsAppCoreBootStep[] = [
  {
    id: "config_env_validation",
    label: "config/env validation",
    owner: "support_shim",
  },
  {
    id: "db_readiness",
    label: "DB readiness",
    owner: "support_shim",
  },
  {
    id: "provider_readiness",
    label: "provider readiness",
    owner: "support_shim",
  },
  {
    id: "market_data",
    label: "market data",
    owner: "support_shim",
  },
  {
    id: "analysis_decision",
    label: "analysis/decision",
    owner: "support_shim",
  },
  {
    id: "live_execution",
    label: "live execution",
    owner: "support_shim",
  },
  {
    id: "reconcile_pnl_status",
    label: "reconcile/PnL/status",
    owner: "support_shim",
  },
  {
    id: "telegram_alert",
    label: "Telegram alert",
    owner: "support_shim",
  },
  {
    id: "tui_render",
    label: "TUI render",
    owner: "app_core",
  },
];

/**
 * production Live Ops app core의 boot lifecycle 계획을 만든다.
 *
 * 호출 경계는 CLI entry와 app core service 사이이며, 입력은 command 이름과 render mode다. 반환값은
 * config/env validation부터 Telegram/TUI까지 기존 support shim이 수행하던 side effect 순서를
 * TypeScript 테스트 경계에 고정한다. 이 함수는 순수 계획 생성만 수행하며 외부 side effect가 없다.
 */
export function createLiveOpsAppCoreBootPlan(input: LiveOpsAppCoreBootPlanInput): LiveOpsAppCoreBootPlan {
  return {
    commandName: input.commandName,
    renderMode: input.renderMode,
    steps: liveOpsAppCoreBootSteps.map((step) => ({ ...step })),
  };
}
