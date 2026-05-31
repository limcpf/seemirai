import { parseFinancialDecimal } from "../../shared/index.js";
import type {
  CalibrationEvidenceInput,
  CalibrationMetricSummary,
  CalibrationPolicyAnalysis,
  CalibrationReasonAxis,
  CalibrationReasonAxisSummary,
  CalibrationReasonBreakdown,
  CalibrationRiskInteraction,
  CalibrationThresholdCandidate,
} from "./types.js";
import { validateCalibrationEvidenceInput } from "./validator.js";

const reasonAxes = new Set<CalibrationReasonAxis>(["cost", "risk", "hold", "discard"]);

/**
 * #68 calibration 입력을 정책 판단에 필요한 reason 축과 threshold 후보로 분석한다.
 *
 * 이 함수는 검증된 summary만 처리하는 순수 application policy다. DB, 파일, 네트워크, 설정 write를 수행하지 않으며,
 * 음수 margin 또는 live API 호출 같은 위험 신호가 있으면 후속 후보 산정이 기본 운영값 완화로 이어지지 않도록 닫는다.
 */
export function analyzeCalibrationPolicy(input: CalibrationEvidenceInput): CalibrationPolicyAnalysis {
  const validation = validateCalibrationEvidenceInput(input);
  if (!validation.passed) {
    // 입력 검증 실패는 원천 metric이 부족하거나 paper-only invariant가 깨진 상태이므로 후보 산정을 시작하지 않는다.
    return {
      status: "failed",
      validation,
      dayReasonBreakdowns: [],
      averageMarginBps: readFailedAverageMarginBps(input),
      thresholdRelaxationBlocked: true,
      candidates: [],
      riskInteractions: [],
      operatorSummary: "calibration 입력 검증이 실패해 threshold 후보 산정을 중단했습니다.",
    };
  }

  const aggregateReasonBreakdown = splitCalibrationReasonCounts(input.aggregate.metrics);
  const averageMarginBps = input.aggregate.metrics.costSummary.averageMarginBps;
  // 비용 차감 후 기대값이 음수거나 산출되지 않으면 후보 수를 늘리는 방향을 fail-closed 한다.
  const thresholdRelaxationBlocked = averageMarginBps === null || parseFinancialDecimal(averageMarginBps).lt(0);
  const candidates = createThresholdCandidates({
    metrics: input.aggregate.metrics,
    reasonBreakdown: aggregateReasonBreakdown,
    thresholdRelaxationBlocked,
  });
  const riskInteractions = createRiskInteractions(aggregateReasonBreakdown);

  return {
    status: "ok",
    validation,
    aggregateReasonBreakdown,
    dayReasonBreakdowns: input.days.map((day) => ({
      day: day.day,
      breakdown: splitCalibrationReasonCounts(day.metrics),
    })),
    averageMarginBps,
    thresholdRelaxationBlocked,
    candidates,
    riskInteractions,
    operatorSummary: thresholdRelaxationBlocked
      ? "비용 차감 후 margin이 음수이거나 산출되지 않아 threshold 완화 후보는 기본 제안으로 승격하지 않습니다."
      : "비용 차감 후 margin이 음수가 아니지만 기본 운영값 변경은 별도 승인과 report 비교가 필요합니다.",
  };
}

/**
 * 검증 실패 입력에서 평균 margin bps를 best-effort로 읽는다.
 *
 * 실패 경로는 손상된 JSON/fixture도 받아야 하므로 nested metric 역참조를 신뢰하지 않는다.
 * 값이 유한 decimal 문자열일 때만 report trace로 보존하고, 그 외에는 null로 닫으며 외부 side effect는 없다.
 */
function readFailedAverageMarginBps(input: CalibrationEvidenceInput): string | null {
  const aggregate = (input as { aggregate?: unknown }).aggregate;
  if (aggregate === null || typeof aggregate !== "object" || Array.isArray(aggregate)) {
    return null;
  }
  const metrics = (aggregate as { metrics?: unknown }).metrics;
  if (metrics === null || typeof metrics !== "object" || Array.isArray(metrics)) {
    return null;
  }
  const costSummary = (metrics as { costSummary?: unknown }).costSummary;
  if (costSummary === null || typeof costSummary !== "object" || Array.isArray(costSummary)) {
    return null;
  }
  const averageMarginBps = (costSummary as { averageMarginBps?: unknown }).averageMarginBps;
  return typeof averageMarginBps === "string" && /^-?\d+(?:\.\d+)?$/u.test(averageMarginBps) ? averageMarginBps : null;
}

/**
 * blocking reason을 cost/risk/hold/discard 축으로 분해한다.
 *
 * prefix가 없는 reason은 임의로 버리지 않고 `unknown`에 모아 report에서 추적할 수 있게 한다. explicit hold/discard
 * count는 totals에 별도 보존해 blocking count와 중복 합산하지 않는다.
 */
export function splitCalibrationReasonCounts(metrics: CalibrationMetricSummary): CalibrationReasonBreakdown {
  const groups = createEmptyBreakdown();

  for (const [rawReason, count] of Object.entries(metrics.blockingReasonCounts)) {
    const parsed = parseBlockingReason(rawReason);
    increment(groups[parsed.axis].counts, parsed.reasonCode, count);
  }

  return completeBreakdown(groups, {
    blockingCount: sumCounts(metrics.blockingReasonCounts),
    explicitHoldCount: sumCounts(metrics.holdReasonCounts),
    explicitDiscardCount: sumCounts(metrics.discardReasonCounts),
  });
}

/**
 * aggregate metric에서 threshold 후보와 판단 근거를 생성한다.
 *
 * 이 helper는 순수 계산만 수행하며 기본 운영 설정을 쓰지 않는다. 보수 후보와 공격 후보를 명시적으로 분리해 후속
 * report/profile 단계가 승인 경계를 유지할 수 있게 한다.
 */
function createThresholdCandidates(input: {
  metrics: CalibrationMetricSummary;
  reasonBreakdown: CalibrationReasonBreakdown;
  thresholdRelaxationBlocked: boolean;
}): CalibrationThresholdCandidate[] {
  const evidence = {
    averageMarginBps: input.metrics.costSummary.averageMarginBps,
    costRejectedCount: input.metrics.costRejectedCount,
    riskRejectedCount: input.metrics.riskRejectedCount,
    paperOrderSubmittedCount: input.metrics.paperOrderSubmittedCount,
    paperFillCount: input.metrics.paperFillCount,
    fillRate: input.metrics.fillRate,
    costBlockingCount: input.reasonBreakdown.cost.totalCount,
    riskBlockingCount: input.reasonBreakdown.risk.totalCount,
  };

  const candidates: CalibrationThresholdCandidate[] = [
    {
      key: "relax_alpha_thresholds",
      title: "전략 threshold 완화",
      status: input.thresholdRelaxationBlocked ? "blocked" : "separate_review",
      aggressiveness: "aggressive",
      direction: "decrease_requires_approval",
      rationale: input.thresholdRelaxationBlocked
        ? "평균 margin이 음수이거나 산출되지 않아 후보 수를 늘리는 완화는 기본 제안으로 승격하지 않습니다."
        : "완화는 주문 수를 늘리는 공격적 변경이므로 별도 report 비교와 승인이 필요합니다.",
      metricEvidence: evidence,
    },
    {
      key: "cost_safety_buffer_bps",
      title: "비용 안전마진",
      status: "recommended",
      aggressiveness: "conservative",
      direction: "increase_or_keep",
      rationale: "cost margin 부족이 반복되므로 안전마진은 낮추지 않고 유지하거나 높이는 방향만 검토합니다.",
      metricEvidence: evidence,
    },
    {
      key: "min_volume_spike_ratio",
      title: "거래대금 spike 하한",
      status: "recommended",
      aggressiveness: "conservative",
      direction: "increase_or_keep",
      rationale: "약한 유동성/관심도 후보를 줄이기 위해 거래대금 spike 기준은 보수적으로 유지하거나 높입니다.",
      metricEvidence: evidence,
    },
    {
      key: "min_session_liquidity_score",
      title: "세션 유동성 점수 하한",
      status: "recommended",
      aggressiveness: "conservative",
      direction: "increase_or_keep",
      rationale: "체결 품질 비교 전에는 얇은 시간대 후보를 늘리지 않도록 유동성 점수 하한을 낮추지 않습니다.",
      metricEvidence: evidence,
    },
    {
      key: "max_spread_bps",
      title: "스프레드 상한",
      status: "recommended",
      aggressiveness: "conservative",
      direction: "decrease_or_keep",
      rationale: "비용 차감 후 margin이 부족하므로 허용 spread 상한은 유지하거나 낮추는 방향만 검토합니다.",
      metricEvidence: evidence,
    },
    {
      key: "min_cost_adjusted_margin_bps",
      title: "비용 차감 후 margin 하한",
      status: "recommended",
      aggressiveness: "conservative",
      direction: "increase_or_keep",
      rationale: "비용 차감 후 기대값이 음수인 상태에서는 margin 하한을 낮춰 후보를 늘리지 않습니다.",
      metricEvidence: evidence,
    },
  ];

  return candidates;
}

/**
 * risk gate reason을 전략 threshold 후보와 분리된 검토 항목으로 변환한다.
 *
 * 주문 금액/예상 손실 한도는 risk budget의 호출 경계에 속하므로 alpha threshold 완화 후보로 흡수하지 않는다.
 */
function createRiskInteractions(reasonBreakdown: CalibrationReasonBreakdown): CalibrationRiskInteraction[] {
  return Object.entries(reasonBreakdown.risk.counts)
    .filter(([, count]) => count > 0)
    .map(([reasonCode, count]) => {
      if (reasonCode === "expected_loss_limit_exceeded") {
        return {
          kind: "expected_loss_limit_review",
          reasonCode,
          count,
          action: "예상 손실 한도와 전략 threshold 후보를 분리해 검토합니다.",
          rationale: "예상 손실 한도 초과는 alpha threshold 완화로 해결할 문제가 아니라 risk budget 검토 대상입니다.",
        };
      }
      if (reasonCode === "order_notional_limit_exceeded") {
        return {
          kind: "order_notional_limit_review",
          reasonCode,
          count,
          action: "주문 금액 한도와 position sizing 설정을 별도 검토합니다.",
          rationale: "주문 금액 한도 초과는 전략 threshold보다 주문 크기와 risk gate 설정의 상호작용입니다.",
        };
      }
      return {
        kind: "risk_reason_review",
        reasonCode,
        count,
        action: "risk gate 차단 원인을 threshold 후보와 분리해 검토합니다.",
        rationale: "risk gate reason은 후보 생성 조건과 독립적인 운영 안전장치일 수 있습니다.",
      };
    });
}

function parseBlockingReason(rawReason: string): { axis: CalibrationReasonAxis; reasonCode: string } {
  const separatorIndex = rawReason.indexOf(":");
  if (separatorIndex <= 0) {
    return { axis: "unknown", reasonCode: rawReason };
  }

  const axis = rawReason.slice(0, separatorIndex) as CalibrationReasonAxis;
  const reasonCode = rawReason.slice(separatorIndex + 1);
  if (!reasonAxes.has(axis) || reasonCode.length === 0) {
    return { axis: "unknown", reasonCode: rawReason };
  }
  return { axis, reasonCode };
}

function createEmptyBreakdown(): Record<CalibrationReasonAxis, { counts: Record<string, number> }> {
  return {
    cost: { counts: {} },
    risk: { counts: {} },
    hold: { counts: {} },
    discard: { counts: {} },
    unknown: { counts: {} },
  };
}

function completeBreakdown(
  groups: Record<CalibrationReasonAxis, { counts: Record<string, number> }>,
  totals: CalibrationReasonBreakdown["totals"],
): CalibrationReasonBreakdown {
  return {
    cost: completeAxis(groups.cost.counts),
    risk: completeAxis(groups.risk.counts),
    hold: completeAxis(groups.hold.counts),
    discard: completeAxis(groups.discard.counts),
    unknown: completeAxis(groups.unknown.counts),
    totals,
  };
}

function completeAxis(counts: Record<string, number>): CalibrationReasonAxisSummary {
  return {
    counts: sortCounts(counts),
    totalCount: sumCounts(counts),
  };
}

function increment(counts: Record<string, number>, key: string, amount: number): void {
  counts[key] = (counts[key] ?? 0) + amount;
}

function sumCounts(counts: Record<string, number>): number {
  return Object.values(counts).reduce((sum, count) => sum + count, 0);
}

function sortCounts(counts: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)));
}
