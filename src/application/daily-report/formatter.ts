import type { DailyReportAggregate, DailyReportCountItem, DailyReportDecimalMetric } from "./types.js";
import type { LiveAutonomousExitStatusSummary } from "../live-autonomous-exit-status.js";
import { formatLiveAutonomousExitStatusReportSection } from "../live-autonomous-exit-status.js";

/**
 * daily report summary에 붙일 선택 runtime summary다.
 *
 * 리포트 본문은 DB fact 집계가 없어도 safe summary를 추가로 받을 수 있다. caller가 이미 secret-safe로 낮춘 값만 전달해야 하며,
 * formatter는 외부 조회나 notification side effect 없이 문자열만 만든다.
 */
export interface FormatDailyReportSummaryOptions {
  liveAutonomousExit?: LiveAutonomousExitStatusSummary | null;
}

/**
 * 집계된 일간 리포트를 Telegram 본문에 들어갈 한국어 요약으로 변환한다.
 *
 * 이 formatter는 운영자가 먼저 봐야 하는 상태, 손익, 비용, 폐기/차단 원인을 한국어로 배치한다. 내부 code는 괄호나 metadata에만
 * 남기고, 데이터가 없는 metric은 `unavailable`을 명시해 실제 0과 수집 결측이 섞이지 않게 한다.
 */
export function formatDailyReportSummary(
  report: DailyReportAggregate,
  options: FormatDailyReportSummaryOptions = {},
): string {
  const sections = [
    `운영 기준일: ${report.window.reportDate} (KST)`,
    `조회 범위: ${report.window.kstStartAt} ~ ${report.window.kstEndAt}`,
    `UTC 조회 범위: ${report.window.utcStartAt} ~ ${report.window.utcEndAt}`,
    "",
    "거래 요약",
    `- 주문: ${report.orderCount}건${formatCountItemsInline(report.orderStatusCounts)}`,
    `- 체결: ${report.fillCount}건`,
    `- 보유 포지션: ${report.openPositionCount}개`,
    "",
    "손익",
    `- 실현 손익: ${formatMetric(report.realizedPnl)} (${report.realizedPnl.source} 기준)`,
    `- 추정 손익: ${formatMetric(report.estimatedPnl)} (${report.estimatedPnl.source} 기준)`,
    "",
    "비용/체결 품질",
    `- 수수료: ${formatFeeTotals(report.feeTotals)}`,
    `- 체결 명목 금액: ${formatMetric(report.totalFillNotional)}`,
    `- 수수료 비중: ${formatMetric(report.feeToFillNotionalBps)}`,
    `- 평균 슬리피지: ${formatMetric(report.averageSlippageBps)}`,
    `- 평균 스프레드 비용: ${formatMetric(report.averageSpreadCostBps)}`,
    `- 평균 취소/재호가 비용: ${formatMetric(report.averageCancelRequotePenaltyBps)}`,
    "",
    "폐기/차단",
    `- 폐기된 주문 후보: ${report.discardedCandidates.total}건${formatCountItemsInline(
      report.discardedCandidates.byReason,
    )}`,
    `- phase 1.5 알트 편입 기록: ${report.phase15AltApprovals.total}건${formatCountItemsInline(
      report.phase15AltApprovals.byAction,
    )}`,
    `- phase 1.5 대상 market: ${formatCountItemsText(report.phase15AltApprovals.byMarket)}`,
    `- pilot private API evidence: ${report.pilotEvidence.total}건${formatCountItemsInline(
      report.pilotEvidence.byStatus,
    )}`,
    `- pilot profile: ${formatCountItemsText(report.pilotEvidence.byProfile)}`,
    `- 리스크/차단 이벤트: ${report.riskEvents.total}건${formatCountItemsInline(report.riskEvents.byAction)}`,
    `- 주요 리스크 종류: ${formatCountItemsText(report.riskEvents.byRiskType)}`,
  ];

  if (options.liveAutonomousExit !== undefined && options.liveAutonomousExit !== null) {
    sections.push("", formatLiveAutonomousExitStatusReportSection(options.liveAutonomousExit));
  }

  return sections.join("\n");
}

function formatMetric(metric: DailyReportDecimalMetric): string {
  if (!metric.available || metric.value === null) {
    return "unavailable";
  }

  return `${metric.value}${metric.unit === undefined ? "" : ` ${metric.unit}`}`;
}

function formatFeeTotals(feeTotals: readonly { currency: string; amount: string }[]): string {
  if (feeTotals.length === 0) {
    return "0";
  }

  return feeTotals.map((fee) => `${fee.amount} ${fee.currency}`).join(", ");
}

function formatCountItemsInline(items: readonly DailyReportCountItem[]): string {
  if (items.length === 0) {
    return "";
  }

  return ` (${formatCountItemsText(items)})`;
}

function formatCountItemsText(items: readonly DailyReportCountItem[]): string {
  if (items.length === 0) {
    return "없음";
  }

  return items.map((item) => `${item.label} ${item.count}건`).join(", ");
}
