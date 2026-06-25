import type { LiveOpsCliOptions, LiveOpsSupportModule } from "../live-ops-cli/types.js";

/**
 * production Live Ops app core가 부팅 중 통과해야 하는 lifecycle 단계 식별자다.
 *
 * 호출 경계는 TypeScript app core service와 legacy support shim 사이이며, 입력은 CLI mode와 render mode다.
 * 출력은 테스트와 PR 리뷰가 side effect 순서를 비교할 때 쓰는 안정 식별자다. 이 값은 사용자-facing
 * 문구가 아니므로 CLI 첫 화면에는 그대로 노출하지 않고, 단계 순서는 기존 support shim의 운영 의미와
 * 동일하게 유지해야 한다. 자체 외부 side effect는 없다.
 */
export type LiveOpsAppCoreBootStepId =
  | "config_env_validation"
  | "db_readiness"
  | "provider_readiness"
  | "market_data"
  | "analysis_decision"
  | "live_execution"
  | "reconcile_pnl_status"
  | "telegram_alert"
  | "tui_render";

/**
 * app core boot 단계의 현재 소유 경계를 나타낸다.
 *
 * `support_shim`은 아직 `.mjs` compatibility module이 실제 side effect를 수행한다는 뜻이고,
 * `app_core`는 TypeScript app core가 orchestration을 직접 결정한다는 뜻이다. Sub PR 02에서는
 * 순서 계약을 먼저 고정하므로 app core는 renderer 선택과 fail-closed attach guard만 소유한다.
 */
export type LiveOpsAppCoreStepOwner = "support_shim" | "app_core";

/**
 * app core가 CLI에 위임할 출력 표면을 구분한다.
 *
 * JSON은 machine-readable summary 출력이고, text는 TUI/help처럼 사람이 직접 읽는 출력이다. 출력 mode는
 * support renderer 호출을 선택하는 입력이며, provider 원본 payload나 secret을 새로 만들지 않는 invariant를 유지한다.
 */
export type LiveOpsAppCoreRenderMode = "json" | "text";

/**
 * production Live Ops boot 단계 하나의 계약이다.
 *
 * 각 단계는 안정 id, 리뷰용 한국어 설명, 현재 소유 경계를 가진다. app core는 이 목록을 기준으로
 * support shim 호출 순서를 테스트에 노출하며, 단계 추가나 순서 변경은 side effect 의미 변경으로 보고
 * 별도 테스트와 문서 갱신을 필요로 한다.
 */
export interface LiveOpsAppCoreBootStep {
  id: LiveOpsAppCoreBootStepId;
  label: string;
  owner: LiveOpsAppCoreStepOwner;
}

/**
 * app core boot plan 생성 입력이다.
 *
 * 호출자는 CLI command 이름과 출력 mode를 전달한다. 반환 plan은 운영 side effect를 직접 실행하지 않고,
 * 이후 run 결과와 함께 어떤 command가 어떤 lifecycle 계약을 따랐는지 기록하는 용도로만 쓰인다.
 */
export interface LiveOpsAppCoreBootPlanInput {
  commandName: string;
  renderMode: LiveOpsAppCoreRenderMode;
}

/**
 * app core가 노출하는 production lifecycle 계획이다.
 *
 * command와 render mode는 CLI boundary를 식별하고, steps는 config/env validation부터 TUI render까지
 * 기존 production 의미의 순서를 보존한다. 이 객체는 테스트/리뷰 evidence용 순수 데이터이며 외부 side effect가 없다.
 */
export interface LiveOpsAppCoreBootPlan {
  commandName: string;
  renderMode: LiveOpsAppCoreRenderMode;
  steps: LiveOpsAppCoreBootStep[];
}

/**
 * foreground `live:ops` app core 실행 입력이다.
 *
 * support는 기존 `.mjs` compatibility surface이며, argv는 CLI가 전달한 원본 인자다. app core는 이 입력으로
 * parse, input load, summary render, output, readiness assertion 순서를 조립하고, support 외부로 직접
 * DB/provider/Telegram side effect를 만들지 않는다.
 */
export interface LiveOpsForegroundAppCoreInput {
  support: LiveOpsSupportModule;
  argv: readonly string[];
  commandName: string;
}

/**
 * attach 전용 `live:ops:tui` app core 실행 입력이다.
 *
 * TUI core는 attach 대상 없이는 production provider lifecycle을 새로 열지 않아야 하므로, support input load
 * 이전에 fail-closed guard를 적용한다. 정상 경로는 attachReadonly를 강제해 읽기 전용 status source만 사용한다.
 */
export interface LiveOpsTuiAppCoreInput {
  support: LiveOpsSupportModule;
  argv: readonly string[];
  commandName: string;
}

/**
 * app core 실행 결과 계약이다.
 *
 * CLI는 exitCode와 options를 이용해 후속 compatibility 출력을 보존하고, summary와 bootPlan은 테스트와
 * PR DnD에서 side effect 순서와 출력 표면을 확인하는 evidence로 쓴다. 결과 자체는 외부 side effect를
 * 만들지 않고, 실제 출력은 support renderer가 이미 수행한 뒤 반환된다.
 */
export interface LiveOpsAppCoreRunResult {
  exitCode: number;
  commandName: string;
  renderMode: LiveOpsAppCoreRenderMode;
  lifecycleExecuted: boolean;
  options: LiveOpsCliOptions;
  summary: unknown;
  bootPlan: LiveOpsAppCoreBootPlan;
}
