import {
  calculateM11FeatureSnapshot,
} from "../../application/index.js";
import type {
  FeatureCalculationResult,
} from "../../application/index.js";
import type {
  FeatureCostInput,
} from "../../application/features/index.js";
import type {
  JsonRecord,
  MarketDataEvent,
  Strategy,
  StrategyDecision,
} from "../../domain/index.js";
import {
  loadLiveOpsConfig,
} from "../live-ops-config.js";
import type {
  LiveOpsConfig,
} from "../live-ops-config.js";
import type {
  LiveOpsMarketDataCollectorSummary,
} from "../live-ops-market-data.js";

/**
 * live ops analysis/decision pipeline의 최종 상태 코드다.
 *
 * 책임:
 * - TUI/CLI가 pipeline 실행 결과를 안정적으로 분기하게 한다.
 * - `blocked`이면 live execution으로 order intent를 넘기지 않는 invariant를 유지한다.
 */
export type LiveOpsAnalysisDecisionStatus = "ready" | "blocked";

/**
 * live ops decision 표면에 노출하는 요약 범주다.
 *
 * 책임:
 * - 내부 strategy reason code 대신 운영자가 즉시 이해할 수 있는 후보 있음/보류/차단 상태를 표현한다.
 * - 이 값은 broker side effect와 무관하며 live execution은 `orderIntentCount`를 별도로 확인해야 한다.
 */
export type LiveOpsDecisionCategory = "ORDER_INTENT" | "HOLD" | "BLOCKED";

/**
 * live ops analysis/decision pipeline 입력 계약이다.
 *
 * 책임:
 * - DB-backed market data collector summary와 market event window를 feature 계산/strategy 평가 경계로 전달한다.
 * - caller가 이미 계산한 feature snapshot을 주입할 수 있어 DB cursor 기반 source와 fixture source가 같은 pipeline을 재사용한다.
 *
 * invariant:
 * - config는 `LiveOpsConfig`로 다시 검증되어 KRW-BTC 단일 market과 record_hold_decision 정책을 유지해야 한다.
 * - pipeline은 DB write, broker 호출, Upbit 호출, Telegram 전송 side effect를 만들지 않는다.
 */
export interface LiveOpsAnalysisDecisionInput {
  readonly config: LiveOpsConfig | unknown;
  readonly marketData: LiveOpsMarketDataCollectorSummary;
  readonly observedAt: string;
  readonly marketEvents: readonly MarketDataEvent[];
  readonly strategies: readonly Strategy[];
  readonly cost?: FeatureCostInput;
  readonly featureSnapshot?: FeatureCalculationResult;
  readonly trace?: JsonRecord;
}

/**
 * live ops analysis/decision pipeline의 개별 guard 결과다.
 *
 * 책임:
 * - market data, feature, strategy 평가의 실패 경계를 분리해 TUI/Telegram이 필요한 조치를 안내할 수 있게 한다.
 * - `details`에는 count와 상태 같은 안전한 evidence만 담고 raw market payload는 담지 않는다.
 */
export interface LiveOpsAnalysisDecisionCheck {
  readonly name: "config" | "market_data" | "features" | "strategy_decision";
  readonly status: "ok" | "blocked";
  readonly code: string;
  readonly message: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

/**
 * live ops analysis/decision pipeline의 secret-safe 요약이다.
 *
 * 책임:
 * - feature 계산과 strategy 평가가 live execution으로 넘길 order intent를 만들었는지 표현한다.
 * - HOLD도 `recordHoldDecision=true`이면 운영 evidence로 남길 수 있음을 표시하지만, 이 summary 자체는 저장 side effect를 만들지 않는다.
 */
export interface LiveOpsAnalysisDecisionSummary {
  readonly status: LiveOpsAnalysisDecisionStatus;
  readonly ready: boolean;
  readonly market: string;
  readonly observedAt: string;
  readonly latestDecisionAt: string | null;
  readonly decisionCategory: LiveOpsDecisionCategory;
  readonly featureStatus: FeatureCalculationResult["status"] | "not_run";
  readonly evaluatedStrategyCount: number;
  readonly holdCount: number;
  readonly blockCount: number;
  readonly orderIntentCount: number;
  readonly recordHoldDecision: boolean;
  readonly message: string;
  readonly checks: readonly LiveOpsAnalysisDecisionCheck[];
  readonly trace: JsonRecord;
}

/**
 * live ops analysis/decision pipeline을 실행한다.
 *
 * @param input production live ops config, market data summary, event window, strategy 목록
 * @returns live execution으로 넘길 order intent 수와 HOLD/차단 evidence 요약
 */
export async function runLiveOpsAnalysisDecisionPipeline(
  input: LiveOpsAnalysisDecisionInput,
): Promise<LiveOpsAnalysisDecisionSummary> {
  const config = loadLiveOpsConfig(input.config);
  const checks: LiveOpsAnalysisDecisionCheck[] = [
    okCheck("config", "production live ops analysis 설정을 확인했습니다.", "live_ops_analysis_config_ok", {
      market: config.universe.default_market,
      recordHoldDecision: config.analysis.record_hold_decision,
    }),
  ];

  if (!input.marketData.ready) {
    // 시세 collector가 차단 상태이면 일부 feature를 계산해도 주문 후보 근거가 될 수 없어 strategy 평가를 시작하지 않는다.
    checks.push(blockedCheck(
      "market_data",
      "market data collector가 준비되지 않아 analysis/decision을 시작하지 않습니다.",
      "live_ops_market_data_not_ready",
    ));
    return buildSummary(config, input, checks, {
      featureStatus: "not_run",
      decisions: [],
      decisionCategory: "HOLD",
      latestDecisionAt: null,
      readyOverride: false,
    });
  }

  checks.push(okCheck("market_data", "market data collector summary를 확인했습니다.", "live_ops_market_data_ready", {
    tradeCount: input.marketData.persisted.tradeCount,
    orderbookCount: input.marketData.persisted.orderbookCount,
  }));

  const featureSnapshot = input.featureSnapshot ?? calculateM11FeatureSnapshot(
    createFeatureCalculationInput(input),
  );

  if (featureSnapshot.status !== "ok") {
    // feature 실패를 0으로 보정하면 후보가 열릴 수 있으므로 HOLD evidence로 남기고 live execution 전진을 막는다.
    checks.push(blockedCheck(
      "features",
      "feature snapshot이 실패해 strategy 후보 생성을 보류합니다.",
      "live_ops_feature_snapshot_failed",
      { failureCount: featureSnapshot.failureReasons.length },
    ));
    return buildSummary(config, input, checks, {
      featureStatus: featureSnapshot.status,
      decisions: [],
      decisionCategory: "HOLD",
      latestDecisionAt: input.observedAt,
      readyOverride: false,
    });
  }

  checks.push(okCheck("features", "feature snapshot을 계산했습니다.", "live_ops_feature_snapshot_ok", {
    featureCount: Object.keys(featureSnapshot.features).length,
  }));

  const decisions = await evaluateStrategies(input, config, featureSnapshot).catch((error) => {
    // strategy 예외는 후보 없음으로 숨기지 않고 pipeline 차단 사유로 남긴다.
    checks.push(blockedCheck(
      "strategy_decision",
      "strategy decision 평가 중 오류가 발생해 live execution으로 전진하지 않습니다.",
      "live_ops_strategy_decision_failed",
      { reason: safeErrorName(error) },
    ));
    return undefined;
  });

  if (decisions === undefined) {
    return buildSummary(config, input, checks, {
      featureStatus: featureSnapshot.status,
      decisions: [],
      decisionCategory: "BLOCKED",
      latestDecisionAt: input.observedAt,
      readyOverride: false,
    });
  }

  const decisionCategory = resolveDecisionCategory(decisions);
  checks.push(okCheck("strategy_decision", "strategy decision 평가를 완료했습니다.", "live_ops_strategy_decision_ok", {
    evaluatedStrategyCount: decisions.length,
    orderIntentCount: countOrderIntents(decisions),
  }));

  return buildSummary(config, input, checks, {
    featureStatus: featureSnapshot.status,
    decisions,
    decisionCategory,
    latestDecisionAt: input.observedAt,
  });
}

async function evaluateStrategies(
  input: LiveOpsAnalysisDecisionInput,
  config: LiveOpsConfig,
  featureSnapshot: FeatureCalculationResult,
): Promise<readonly StrategyDecision[]> {
  const decisions: StrategyDecision[] = [];

  for (const strategy of input.strategies) {
    const decision = await strategy.evaluate({
      strategyId: strategy.id,
      exchangeId: "upbit_krw_spot",
      market: config.universe.default_market,
      observedAt: input.observedAt,
      marketEvents: input.marketEvents,
      features: featureSnapshot.features,
      metadata: {
        source: "live_ops_analysis_decision",
      },
    });
    decisions.push(decision);
  }

  return decisions;
}

function createFeatureCalculationInput(input: LiveOpsAnalysisDecisionInput): {
  observedAt: string;
  events: readonly MarketDataEvent[];
  cost?: FeatureCostInput;
  metadata: JsonRecord;
} {
  const featureInput: {
    observedAt: string;
    events: readonly MarketDataEvent[];
    cost?: FeatureCostInput;
    metadata: JsonRecord;
  } = {
    observedAt: input.observedAt,
    events: input.marketEvents,
    metadata: {
      source: "live_ops_analysis_decision",
    },
  };

  if (input.cost !== undefined) {
    featureInput.cost = input.cost;
  }

  return featureInput;
}

function buildSummary(
  config: LiveOpsConfig,
  input: LiveOpsAnalysisDecisionInput,
  checks: readonly LiveOpsAnalysisDecisionCheck[],
  result: {
    featureStatus: LiveOpsAnalysisDecisionSummary["featureStatus"];
    decisions: readonly StrategyDecision[];
    decisionCategory: LiveOpsDecisionCategory;
    latestDecisionAt: string | null;
    readyOverride?: boolean;
  },
): LiveOpsAnalysisDecisionSummary {
  const ready = result.readyOverride ?? checks.every((check) => check.status === "ok");
  const holdCount = result.decisions.filter((decision) => decision.kind === "HOLD").length;
  const blockCount = result.decisions.filter((decision) => decision.kind === "BLOCK").length;
  const orderIntentCount = countOrderIntents(result.decisions);

  return {
    status: ready ? "ready" : "blocked",
    ready,
    market: config.universe.default_market,
    observedAt: input.observedAt,
    latestDecisionAt: result.latestDecisionAt,
    decisionCategory: result.decisionCategory,
    featureStatus: result.featureStatus,
    evaluatedStrategyCount: result.decisions.length,
    holdCount,
    blockCount,
    orderIntentCount,
    recordHoldDecision: config.analysis.record_hold_decision && orderIntentCount === 0,
    message: toSummaryMessage(result.decisionCategory, orderIntentCount, ready),
    checks,
    trace: {
      source: "live_ops_analysis_decision",
      marketDataStatus: input.marketData.status,
      marketDataReady: input.marketData.ready,
      featureStatus: result.featureStatus,
      ...(input.trace ?? {}),
    },
  };
}

function resolveDecisionCategory(decisions: readonly StrategyDecision[]): LiveOpsDecisionCategory {
  if (countOrderIntents(decisions) > 0) {
    return "ORDER_INTENT";
  }

  if (decisions.length > 0 && decisions.every((decision) => decision.kind === "BLOCK")) {
    return "BLOCKED";
  }

  return "HOLD";
}

function countOrderIntents(decisions: readonly StrategyDecision[]): number {
  return decisions.reduce(
    (count, decision) => count + (decision.kind === "ORDER_INTENT" ? decision.orderIntents.length : 0),
    0,
  );
}

function toSummaryMessage(
  decisionCategory: LiveOpsDecisionCategory,
  orderIntentCount: number,
  ready: boolean,
): string {
  if (!ready) {
    return "analysis/decision pipeline이 live execution으로 전진할 수 없습니다.";
  }

  if (decisionCategory === "ORDER_INTENT") {
    return `analysis/decision pipeline이 주문 후보 ${orderIntentCount}개를 만들었습니다.`;
  }

  if (decisionCategory === "BLOCKED") {
    return "strategy decision이 후보 생성을 차단했습니다.";
  }

  return "strategy decision이 HOLD로 기록됐고 주문 후보는 없습니다.";
}

function okCheck(
  name: LiveOpsAnalysisDecisionCheck["name"],
  message: string,
  code: string,
  details?: Readonly<Record<string, unknown>>,
): LiveOpsAnalysisDecisionCheck {
  const check: LiveOpsAnalysisDecisionCheck = {
    name,
    status: "ok",
    code,
    message,
  };
  return details === undefined ? check : { ...check, details };
}

function blockedCheck(
  name: LiveOpsAnalysisDecisionCheck["name"],
  message: string,
  code: string,
  details?: Readonly<Record<string, unknown>>,
): LiveOpsAnalysisDecisionCheck {
  const check: LiveOpsAnalysisDecisionCheck = {
    name,
    status: "blocked",
    code,
    message,
  };
  return details === undefined ? check : { ...check, details };
}

function safeErrorName(error: unknown): string {
  return error instanceof Error ? error.name : "UnknownError";
}
