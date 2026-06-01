import { describe, expect, it } from "vitest";
import {
  aggregateDailyReport,
  buildDailyReportNotification,
  createDailyReportJobPlan,
  createDailyReportWindow,
  formatDailyReportSummary,
  sendDailyReport,
  toKstReportDate,
} from "../../src/application/index.js";
import type {
  DailyReportDataProvider,
  DailyReportNotification,
  DailyReportSourceData,
  DailyReportWindow,
  NotificationResult,
  NotifierPort,
} from "../../src/application/index.js";

describe("daily report application", () => {
  it("converts a KST report date into the UTC half-open query window", () => {
    const window = createDailyReportWindow("2026-05-21");

    expect(window).toEqual({
      reportDate: "2026-05-21",
      timezone: "Asia/Seoul",
      kstStartAt: "2026-05-21T00:00:00+09:00",
      kstEndAt: "2026-05-22T00:00:00+09:00",
      utcStartAt: "2026-05-20T15:00:00.000Z",
      utcEndAt: "2026-05-21T15:00:00.000Z",
    });
    expect(toKstReportDate("2026-05-20T14:59:59.000Z")).toBe("2026-05-20");
    expect(toKstReportDate("2026-05-20T15:00:00.000Z")).toBe("2026-05-21");
    expect(() => createDailyReportWindow("2026-02-30")).toThrow("valid calendar date");
  });

  it("aggregates trading, PnL, cost, discarded candidate, and risk facts deterministically", () => {
    const report = aggregateDailyReport(createDailyReportWindow("2026-05-21"), fixtureSourceData());
    const summary = formatDailyReportSummary(report);

    expect(report).toMatchObject({
      orderCount: 2,
      fillCount: 2,
      openPositionCount: 1,
      realizedPnl: {
        value: "1250",
        source: "pnl_snapshots",
      },
      estimatedPnl: {
        value: "290",
        source: "pnl_snapshots.unrealized_pnl",
      },
      totalFillNotional: {
        value: "3000",
      },
      feeToFillNotionalBps: {
        value: "50",
      },
      averageSlippageBps: {
        value: "2",
        sampleCount: 2,
      },
      averageSpreadCostBps: {
        value: "3",
        sampleCount: 2,
      },
      averageCancelRequotePenaltyBps: {
        value: "0.5",
        sampleCount: 1,
      },
      discardedCandidates: {
        total: 2,
      },
      phase15AltApprovals: {
        total: 1,
      },
      riskEvents: {
        total: 2,
      },
      latestPnlSnapshotAt: "2026-05-21T14:30:00.000Z",
    });
    expect(report.feeTotals).toEqual([{ currency: "KRW", amount: "15" }]);
    expect(report.discardedCandidates.byReason.map((item) => item.label)).toEqual([
      "비용 차감 후 기대 수익 부족 (cost_margin_insufficient)",
      "스프레드 기준 초과 (spread_too_wide)",
    ]);
    expect(summary).toContain("운영 기준일: 2026-05-21 (KST)");
    expect(summary).toContain("실현 손익: 1250 KRW (pnl_snapshots 기준)");
    expect(summary).toContain("평균 슬리피지: 2 bps");
    expect(summary).toContain("폐기된 주문 후보: 2건");
    expect(summary).toContain("phase 1.5 알트 편입 기록: 1건");
    expect(summary).toContain("수동 승인 (APPROVE) 1건");
    expect(summary).toContain("주문 차단 (BLOCK_ORDER) 1건");
  });

  it("marks missing optional data as unavailable instead of pretending it is zero", () => {
    const report = aggregateDailyReport(createDailyReportWindow("2026-05-21"), emptySourceData());
    const summary = formatDailyReportSummary(report);

    expect(report.realizedPnl).toMatchObject({
      available: false,
      value: null,
      source: "unavailable",
    });
    expect(report.averageSlippageBps).toMatchObject({
      available: false,
      value: null,
    });
    expect(summary).toContain("주문: 0건");
    expect(summary).toContain("실현 손익: unavailable");
    expect(summary).toContain("수수료: 0");
    expect(summary).toContain("주요 리스크 종류: 없음");
  });

  it("selects tied PnL snapshots deterministically when captured_at is equal", () => {
    const window = createDailyReportWindow("2026-05-21");
    const lowerTieBreakSnapshot = {
      strategyId: "tie_strategy",
      market: "KRW-BTC",
      capturedAt: "2026-05-21T14:00:00.000Z",
      equity: "1000.00000000",
      realizedPnl: "300",
      unrealizedPnl: "10",
      drawdownBps: "5",
    };
    const higherTieBreakSnapshot = {
      strategyId: "tie_strategy",
      market: "KRW-BTC",
      capturedAt: "2026-05-21T14:00:00.000Z",
      equity: "2000",
      realizedPnl: "100",
      unrealizedPnl: "5",
      drawdownBps: "2",
    };

    const firstOrderReport = aggregateDailyReport(window, {
      ...emptySourceData(),
      pnlSnapshots: [lowerTieBreakSnapshot, higherTieBreakSnapshot],
    });
    const secondOrderReport = aggregateDailyReport(window, {
      ...emptySourceData(),
      pnlSnapshots: [higherTieBreakSnapshot, lowerTieBreakSnapshot],
    });

    expect(firstOrderReport.realizedPnl.value).toBe("100");
    expect(secondOrderReport.realizedPnl.value).toBe(firstOrderReport.realizedPnl.value);
    expect(secondOrderReport.estimatedPnl.value).toBe(firstOrderReport.estimatedPnl.value);
  });

  it("keeps PnL snapshot scopes separate when strategy or market contains delimiters", () => {
    const report = aggregateDailyReport(createDailyReportWindow("2026-05-21"), {
      ...emptySourceData(),
      pnlSnapshots: [
        {
          strategyId: "scope:a",
          market: "b",
          capturedAt: "2026-05-21T14:00:00.000Z",
          equity: "1000",
          realizedPnl: "100",
          unrealizedPnl: "10",
          drawdownBps: "1",
        },
        {
          strategyId: "scope",
          market: "a:b",
          capturedAt: "2026-05-21T14:00:00.000Z",
          equity: "2000",
          realizedPnl: "200",
          unrealizedPnl: "20",
          drawdownBps: "2",
        },
      ],
    });

    expect(report.realizedPnl.value).toBe("300");
    expect(report.estimatedPnl.value).toBe("30");
  });

  it("falls back to positions only for PnL scopes without snapshots", () => {
    const report = aggregateDailyReport(createDailyReportWindow("2026-05-21"), {
      ...emptySourceData(),
      positions: [
        {
          strategyId: "covered_by_snapshot",
          market: "KRW-BTC",
          quantity: "1",
          realizedPnl: "999",
          unrealizedPnl: "999",
          updatedAt: "2026-05-21T14:10:00.000Z",
        },
        {
          strategyId: "missing_snapshot",
          market: "KRW-ETH",
          quantity: "1",
          realizedPnl: "25",
          unrealizedPnl: "5",
          updatedAt: "2026-05-21T14:20:00.000Z",
        },
      ],
      pnlSnapshots: [
        {
          strategyId: "covered_by_snapshot",
          market: "KRW-BTC",
          capturedAt: "2026-05-21T14:00:00.000Z",
          equity: "1000",
          realizedPnl: "100",
          unrealizedPnl: "10",
          drawdownBps: "1",
        },
      ],
    });

    expect(report.realizedPnl).toMatchObject({
      value: "125",
      sampleCount: 2,
      source: "pnl_snapshots+positions",
    });
    expect(report.estimatedPnl).toMatchObject({
      value: "15",
      sampleCount: 2,
      source: "pnl_snapshots.unrealized_pnl+positions.unrealized_pnl",
    });
  });

  it("uses strategy aggregate PnL snapshot instead of double-counting market snapshots", () => {
    const report = aggregateDailyReport(createDailyReportWindow("2026-05-21"), {
      ...emptySourceData(),
      positions: [
        {
          strategyId: "trend_following",
          market: "KRW-BTC",
          quantity: "1",
          realizedPnl: "999",
          unrealizedPnl: "999",
          updatedAt: "2026-05-21T14:10:00.000Z",
        },
      ],
      pnlSnapshots: [
        {
          strategyId: "trend_following",
          market: null,
          capturedAt: "2026-05-21T14:30:00.000Z",
          equity: "10000",
          realizedPnl: "100",
          unrealizedPnl: "10",
          drawdownBps: "1",
        },
        {
          strategyId: "trend_following",
          market: "KRW-BTC",
          capturedAt: "2026-05-21T14:40:00.000Z",
          equity: "6000",
          realizedPnl: "60",
          unrealizedPnl: "6",
          drawdownBps: "1",
        },
      ],
    });

    expect(report.realizedPnl).toMatchObject({
      value: "100",
      sampleCount: 1,
      source: "pnl_snapshots",
    });
    expect(report.estimatedPnl).toMatchObject({
      value: "10",
      sampleCount: 1,
      source: "pnl_snapshots.unrealized_pnl",
    });
    expect(report.latestPnlSnapshotAt).toBe("2026-05-21T14:30:00.000Z");
  });

  it("renders order statuses with Korean-first labels and a Korean fallback", () => {
    const report = aggregateDailyReport(createDailyReportWindow("2026-05-21"), {
      ...emptySourceData(),
      orders: [
        {
          status: "VALIDATED",
          strategyId: "trend_following",
          market: "KRW-BTC",
          requestedNotional: "1000",
          createdAt: "2026-05-21T01:00:00.000Z",
        },
        {
          status: "BROKER_HELD",
          strategyId: "mean_reversion",
          market: "KRW-ETH",
          requestedNotional: "1000",
          createdAt: "2026-05-21T02:00:00.000Z",
        },
      ],
    });
    const summary = formatDailyReportSummary(report);

    expect(summary).toContain("주문 검증 완료 (VALIDATED) 1건");
    expect(summary).toContain("미분류 주문 상태 (BROKER_HELD) 1건");
  });

  it("creates a report-date idempotency key and replayable job payload", () => {
    const plan = createDailyReportJobPlan({
      reportDate: "2026-05-21",
      runAfter: "2026-05-21T15:01:00.000Z",
      maxAttempts: 5,
    });

    expect(plan).toEqual({
      jobType: "report.daily",
      idempotencyKey: "report.daily:2026-05-21",
      runAfter: "2026-05-21T15:01:00.000Z",
      maxAttempts: 5,
      payloadJson: {
        report_date: "2026-05-21",
        timezone: "Asia/Seoul",
        kst_start_at: "2026-05-21T00:00:00+09:00",
        kst_end_at: "2026-05-22T00:00:00+09:00",
        utc_start_at: "2026-05-20T15:00:00.000Z",
        utc_end_at: "2026-05-21T15:00:00.000Z",
      },
    });
  });

  it("builds and sends a Korean-first NotifierPort daily report payload", async () => {
    const provider = new FixtureDailyReportDataProvider(fixtureSourceData());
    const notifier = new CapturingNotifier();

    const built = await buildDailyReportNotification({
      reportDate: "2026-05-21",
      dataProvider: provider,
      generatedAt: "2026-05-21T15:01:00.000Z",
    });
    const sent = await sendDailyReport({
      reportDate: "2026-05-21",
      dataProvider: provider,
      generatedAt: "2026-05-21T15:01:00.000Z",
      notifier,
    });

    expect(built.notification).toMatchObject({
      reportDate: "2026-05-21",
      generatedAt: "2026-05-21T15:01:00.000Z",
      metadata: {
        source: "daily_report_aggregator",
        timezone: "Asia/Seoul",
        order_count: 2,
        fill_count: 2,
        discarded_candidate_count: 2,
        risk_event_count: 2,
      },
    });
    expect(built.notification.summary).toContain("거래 요약");
    expect(built.notification.summary).toContain("손익");
    expect(sent.result).toEqual({ delivered: true, providerMessageId: "daily-report-1" });
    expect(notifier.dailyReports).toHaveLength(1);
    expect(notifier.dailyReports[0]?.summary).toContain("비용/체결 품질");
  });
});

class FixtureDailyReportDataProvider implements DailyReportDataProvider {
  public constructor(private readonly sourceData: DailyReportSourceData) {}

  public async loadDailyReportSourceData(_window: DailyReportWindow): Promise<DailyReportSourceData> {
    return this.sourceData;
  }
}

class CapturingNotifier implements NotifierPort {
  public readonly dailyReports: DailyReportNotification[] = [];

  public async sendAlert(): Promise<NotificationResult> {
    return { delivered: true };
  }

  public async sendDailyReport(notification: DailyReportNotification): Promise<NotificationResult> {
    this.dailyReports.push(notification);
    return { delivered: true, providerMessageId: "daily-report-1" };
  }
}

function fixtureSourceData(): DailyReportSourceData {
  return {
    orders: [
      {
        status: "FILLED",
        strategyId: "trend_following",
        market: "KRW-BTC",
        requestedNotional: "2000",
        createdAt: "2026-05-21T01:00:00.000Z",
      },
      {
        status: "CANCELED",
        strategyId: "mean_reversion",
        market: "KRW-ETH",
        requestedNotional: "1000",
        createdAt: "2026-05-21T02:00:00.000Z",
      },
    ],
    fills: [
      {
        strategyId: "trend_following",
        market: "KRW-BTC",
        side: "BUY",
        price: "1000",
        quantity: "2",
        fee: "10",
        feeCurrency: "KRW",
        liquidity: "TAKER",
        filledAt: "2026-05-21T01:01:00.000Z",
      },
      {
        strategyId: "mean_reversion",
        market: "KRW-ETH",
        side: "SELL",
        price: "500",
        quantity: "2",
        fee: "5",
        feeCurrency: "KRW",
        liquidity: "MAKER",
        filledAt: "2026-05-21T02:01:00.000Z",
      },
    ],
    positions: [
      {
        strategyId: "trend_following",
        market: "KRW-BTC",
        quantity: "1",
        realizedPnl: "900",
        unrealizedPnl: "100",
        updatedAt: "2026-05-21T14:00:00.000Z",
      },
    ],
    pnlSnapshots: [
      {
        strategyId: "trend_following",
        market: "KRW-BTC",
        capturedAt: "2026-05-21T13:00:00.000Z",
        equity: "100000",
        realizedPnl: "900",
        unrealizedPnl: "100",
        drawdownBps: "10",
      },
      {
        strategyId: "trend_following",
        market: "KRW-BTC",
        capturedAt: "2026-05-21T14:30:00.000Z",
        equity: "101000",
        realizedPnl: "1200",
        unrealizedPnl: "300",
        drawdownBps: "8",
      },
      {
        strategyId: "mean_reversion",
        market: "KRW-ETH",
        capturedAt: "2026-05-21T14:00:00.000Z",
        equity: "50000",
        realizedPnl: "50",
        unrealizedPnl: "-10",
        drawdownBps: "3",
      },
    ],
    auditEvents: [
      {
        eventType: "ORDER_DECISION",
        severity: "WARN",
        payloadJson: {
          audit_kind: "ORDER_CANDIDATE_DISCARDED",
          reason_code: "spread_too_wide",
        },
        occurredAt: "2026-05-21T03:00:00.000Z",
      },
      {
        eventType: "ORDER_DECISION",
        severity: "WARN",
        payloadJson: {
          audit_kind: "ORDER_CANDIDATE_DISCARDED",
          reason_code: "cost_margin_insufficient",
        },
        occurredAt: "2026-05-21T03:10:00.000Z",
      },
      {
        eventType: "NOTIFICATION_DELIVERY",
        severity: "INFO",
        payloadJson: {
          reason_code: "sent",
        },
        occurredAt: "2026-05-21T03:20:00.000Z",
      },
      {
        eventType: "PHASE_1_5_ALT_APPROVAL",
        severity: "INFO",
        payloadJson: {
          audit_kind: "PHASE_1_5_ALT_APPROVAL",
          action: "APPROVE",
          market: "KRW-SOL",
        },
        occurredAt: "2026-05-21T03:30:00.000Z",
      },
    ],
    riskEvents: [
      {
        riskType: "spread",
        severity: "WARN",
        action: "BLOCK_ORDER",
        market: "KRW-BTC",
        strategyId: "trend_following",
        payloadJson: {
          reason_code: "spread_too_wide",
        },
        occurredAt: "2026-05-21T03:00:00.000Z",
      },
      {
        riskType: "notification",
        severity: "ERROR",
        action: "MANUAL_REVIEW_REQUIRED",
        market: null,
        strategyId: null,
        payloadJson: {
          reason_code: "notification_failure_threshold_exceeded",
        },
        occurredAt: "2026-05-21T04:00:00.000Z",
      },
    ],
    executionQuality: [
      {
        strategyId: "trend_following",
        market: "KRW-BTC",
        slippageBps: "1",
        spreadCostBps: "4",
        cancelRequotePenaltyBps: "0.5",
      },
      {
        strategyId: "mean_reversion",
        market: "KRW-ETH",
        slippageBps: "3",
        spreadCostBps: "2",
      },
    ],
  };
}

function emptySourceData(): DailyReportSourceData {
  return {
    orders: [],
    fills: [],
    positions: [],
    pnlSnapshots: [],
    auditEvents: [],
    riskEvents: [],
    executionQuality: [],
  };
}
