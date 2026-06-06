import { describe, it, expect } from "vitest";
import {
  DecisionCategoryValue,
  DecisionFrameCategoryValue,
  SummaryStatusValue,
  EvidenceKindValue,
  isValidDecisionCategory,
  isValidDecisionFrameCategory,
  isValidEvidenceKind,
} from "../../src/application/decision-ledger.js";
import type {
  DecisionCategory,
  SummaryStatus,
  EvidenceKind,
  DecisionLedgerFrame,
  DecisionEvidenceItem,
  WhySummary,
  WhyMarketSummarySection,
  WhyMarketSummary,
  WhyStrategySummarySection,
  WhyStrategySummary,
  WhyCashSummarySection,
  WhyCashSummary,
} from "../../src/application/decision-ledger.js";

describe("DecisionLedger categories", () => {
  describe("DecisionCategory", () => {
    it("모든 안정 category 값이 상수 객체에 정의되어 있다", () => {
      const expected = [
        "BUY",
        "SELL",
        "HOLD",
        "CASH_HOLD",
        "DISCARD",
        "COST_REJECTED",
        "RISK_REJECTED",
        "EXECUTION_REJECTED",
        "EXECUTED",
        "EXPLANATION_FAILED",
      ] as const;

      for (const cat of expected) {
        expect(DecisionCategoryValue).toHaveProperty(cat);
        expect(DecisionCategoryValue[cat as keyof typeof DecisionCategoryValue]).toBe(cat);
      }
      expect(Object.keys(DecisionCategoryValue)).toHaveLength(expected.length);
    });

    it("isValidDecisionCategory가 유효한 값만 통과시킨다", () => {
      expect(isValidDecisionCategory("BUY")).toBe(true);
      expect(isValidDecisionCategory("SELL")).toBe(true);
      expect(isValidDecisionCategory("HOLD")).toBe(true);
      expect(isValidDecisionCategory("CASH_HOLD")).toBe(true);
      expect(isValidDecisionCategory("DISCARD")).toBe(true);
      expect(isValidDecisionCategory("COST_REJECTED")).toBe(true);
      expect(isValidDecisionCategory("RISK_REJECTED")).toBe(true);
      expect(isValidDecisionCategory("EXECUTION_REJECTED")).toBe(true);
      expect(isValidDecisionCategory("EXECUTED")).toBe(true);
      expect(isValidDecisionCategory("EXPLANATION_FAILED")).toBe(true);
    });

    it("isValidDecisionCategory가 유효하지 않은 값을 거부한다", () => {
      expect(isValidDecisionCategory("UNKNOWN")).toBe(false);
      expect(isValidDecisionCategory("")).toBe(false);
      expect(isValidDecisionCategory("buy")).toBe(false);
    });

    it("DecisionFrameCategory는 설명 실패 전용 category를 제외한다", () => {
      expect(DecisionFrameCategoryValue).not.toHaveProperty("EXPLANATION_FAILED");
      expect(isValidDecisionFrameCategory("BUY")).toBe(true);
      expect(isValidDecisionFrameCategory("EXPLANATION_FAILED")).toBe(false);
    });
  });

  describe("SummaryStatus", () => {
    it("모든 안정 status 값이 상수 객체에 정의되어 있다", () => {
      const expected = ["RECORDED", "PARTIAL", "UNAVAILABLE", "EXPLANATION_FAILED"] as const;

      for (const s of expected) {
        expect(SummaryStatusValue).toHaveProperty(s);
        expect(SummaryStatusValue[s as keyof typeof SummaryStatusValue]).toBe(s);
      }
      expect(Object.keys(SummaryStatusValue)).toHaveLength(expected.length);
    });
  });

  describe("EvidenceKind", () => {
    it("모든 안정 evidence kind 값이 상수 객체에 정의되어 있다", () => {
      const expected = [
        "STRATEGY_DECISION",
        "ORDER_INTENT",
        "DISCARD_REASON",
        "COST_BREAKDOWN",
        "RISK_DECISION",
        "EXECUTION_RESULT",
        "PNL_STATUS_CONTEXT",
        "EXPLANATION_SUMMARY",
        "EXPLANATION_FAILURE",
      ] as const;

      for (const k of expected) {
        expect(EvidenceKindValue).toHaveProperty(k);
        expect(EvidenceKindValue[k as keyof typeof EvidenceKindValue]).toBe(k);
      }
      expect(Object.keys(EvidenceKindValue)).toHaveLength(expected.length);
    });

    it("isValidEvidenceKind가 유효한 값만 통과시킨다", () => {
      expect(isValidEvidenceKind("STRATEGY_DECISION")).toBe(true);
      expect(isValidEvidenceKind("ORDER_INTENT")).toBe(true);
      expect(isValidEvidenceKind("DISCARD_REASON")).toBe(true);
      expect(isValidEvidenceKind("COST_BREAKDOWN")).toBe(true);
      expect(isValidEvidenceKind("RISK_DECISION")).toBe(true);
      expect(isValidEvidenceKind("EXECUTION_RESULT")).toBe(true);
      expect(isValidEvidenceKind("PNL_STATUS_CONTEXT")).toBe(true);
      expect(isValidEvidenceKind("EXPLANATION_SUMMARY")).toBe(true);
      expect(isValidEvidenceKind("EXPLANATION_FAILURE")).toBe(true);
    });

    it("isValidEvidenceKind가 유효하지 않은 값을 거부한다", () => {
      expect(isValidEvidenceKind("UNKNOWN_KIND")).toBe(false);
      expect(isValidEvidenceKind("")).toBe(false);
    });
  });
});

describe("DecisionLedgerFrame type contract", () => {
  /**
   * DecisionLedgerFrame이 필수 필드를 모두 가지는지 compile-time 검증을 겸한
   * runtime shape test다. 이 테스트는 실제 persistence 없이 type contract만 확인한다.
   */
  it("최소 필수 필드를 가진 frame 객체가 type contract를 만족한다", () => {
    const frame: DecisionLedgerFrame = {
      ledgerVersion: "m18.decision_ledger.v1",
      sourceRunId: "run-2026-06-06-001",
      sourceFrameId: "frame-abc-123",
      exchange: "UPBIT",
      market: "KRW-BTC",
      strategyId: "strategy.mean-reversion",
      category: "HOLD",
      summaryStatus: "RECORDED",
      observedAt: new Date("2026-06-06T00:00:00Z"),
      decisionAt: new Date("2026-06-06T00:00:01Z"),
      correlationId: "corr-xyz-789",
      reasonCounts: { insufficient_expected_return: 1, wide_spread: 0 },
      dedupeKey: "upbit:krw-btc:strategy.mean-reversion:frame-abc-123",
      trace: { sourceTable: "decision_ledger_frames", correlationId: "corr-xyz-789" },
    };

    expect(frame.ledgerVersion).toBe("m18.decision_ledger.v1");
    expect(frame.market).toBe("KRW-BTC");
    expect(frame.category).toBe("HOLD");
    expect(frame.summaryStatus).toBe("RECORDED");
    expect(frame.reasonCounts["insufficient_expected_return"]).toBe(1);
    expect(frame.dedupeKey).toContain("frame-abc-123");
  });

  it("market과 strategyId가 null인 frame도 유효하다 (cash/global 판단)", () => {
    const frame: DecisionLedgerFrame = {
      ledgerVersion: "m18.decision_ledger.v1",
      sourceRunId: null,
      sourceFrameId: "frame-cash-001",
      exchange: "UPBIT",
      market: null,
      strategyId: null,
      category: "CASH_HOLD",
      summaryStatus: "RECORDED",
      observedAt: new Date("2026-06-06T01:00:00Z"),
      decisionAt: new Date("2026-06-06T01:00:01Z"),
      correlationId: null,
      reasonCounts: { all_strategies_hold: 2 },
      dedupeKey: "upbit::cash:frame-cash-001",
      trace: {
        sourceRunUnavailableReason: "runtime 실행 단위 식별자를 제공하지 않은 cash/global fixture입니다.",
        correlationUnavailableReason: "주문 후보 0건 cash/global frame이라 correlation id가 없습니다.",
      },
    };

    expect(frame.market).toBeNull();
    expect(frame.strategyId).toBeNull();
    expect(frame.correlationId).toBeNull();
    expect(frame.category).toBe("CASH_HOLD");
    expect(frame.trace.sourceRunUnavailableReason).toContain("cash/global fixture");
    expect(frame.trace.correlationUnavailableReason).toContain("주문 후보 0건");
  });

  it("sourceRunId가 null이면 trace에 누락 사유가 필요하다", () => {
    const frame: DecisionLedgerFrame = {
      ledgerVersion: "m18.decision_ledger.v1",
      sourceRunId: null,
      sourceFrameId: "frame-cash-002",
      exchange: "UPBIT",
      market: null,
      strategyId: null,
      category: "CASH_HOLD",
      summaryStatus: "RECORDED",
      observedAt: new Date("2026-06-06T01:00:00Z"),
      decisionAt: new Date("2026-06-06T01:00:01Z"),
      correlationId: null,
      reasonCounts: { no_order_intent: 1 },
      dedupeKey: "upbit::cash:frame-cash-002",
      trace: {
        sourceRunUnavailableReason: "로컬 fixture 실행이라 source run id가 없습니다.",
        correlationUnavailableReason: "주문 후보가 생성되지 않아 correlation id가 없습니다.",
      },
    };

    expect(frame.trace.sourceRunUnavailableReason).toContain("source run id");

    // @ts-expect-error sourceRunId가 null인 frame은 trace에 누락 사유를 반드시 남겨야 한다.
    const invalidFrame: DecisionLedgerFrame = { ...frame, trace: {} };
    expect(invalidFrame.sourceRunId).toBeNull();
  });

  it("correlationId가 null이면 trace에 누락 사유가 필요하다", () => {
    const frame: DecisionLedgerFrame = {
      ledgerVersion: "m18.decision_ledger.v1",
      sourceRunId: "run-001",
      sourceFrameId: "frame-hold-001",
      exchange: "UPBIT",
      market: "KRW-BTC",
      strategyId: "strategy.mean-reversion",
      category: "HOLD",
      summaryStatus: "RECORDED",
      observedAt: new Date("2026-06-06T01:00:00Z"),
      decisionAt: new Date("2026-06-06T01:00:01Z"),
      correlationId: null,
      reasonCounts: { strategy_hold: 1 },
      dedupeKey: "upbit:krw-btc:hold:frame-hold-001",
      trace: { correlationUnavailableReason: "전략 HOLD라 주문 correlation id가 생성되지 않았습니다." },
    };

    expect(frame.trace.correlationUnavailableReason).toContain("전략 HOLD");

    // @ts-expect-error correlationId가 null인 frame은 trace에 누락 사유를 반드시 남겨야 한다.
    const invalidFrame: DecisionLedgerFrame = { ...frame, trace: {} };
    expect(invalidFrame.correlationId).toBeNull();
  });

  it("EXPLANATION_FAILED는 frame category로 사용할 수 없다", () => {
    const frame = {
      ledgerVersion: "m18.decision_ledger.v1",
      sourceRunId: "run-001",
      sourceFrameId: "frame-llm-fail-001",
      exchange: "UPBIT",
      market: "KRW-BTC",
      strategyId: "strategy.mean-reversion",
      category: "EXPLANATION_FAILED",
      summaryStatus: "EXPLANATION_FAILED",
      observedAt: new Date("2026-06-06T01:00:00Z"),
      decisionAt: new Date("2026-06-06T01:00:01Z"),
      correlationId: "corr-llm-fail-001",
      reasonCounts: {},
      dedupeKey: "upbit:krw-btc:llm-fail:frame-llm-fail-001",
      trace: {},
    };

    // @ts-expect-error 설명 실패는 frame 판단 category가 아니라 evidence/status에만 남긴다.
    const invalidFrame: DecisionLedgerFrame = frame;
    expect(invalidFrame.category).toBe("EXPLANATION_FAILED");
  });

  it("reasonCounts가 빈 객체여도 유효하다", () => {
    const frame: DecisionLedgerFrame = {
      ledgerVersion: "m18.decision_ledger.v1",
      sourceRunId: "run-001",
      sourceFrameId: "frame-002",
      exchange: "UPBIT",
      market: "KRW-ETH",
      strategyId: "strategy.trend-following",
      category: "BUY",
      summaryStatus: "RECORDED",
      observedAt: new Date(),
      decisionAt: new Date(),
      correlationId: "corr-002",
      reasonCounts: {},
      dedupeKey: "upbit:krw-eth:trend:frame-002",
      trace: {},
    };

    expect(frame.reasonCounts).toEqual({});
  });
});

describe("DecisionEvidenceItem type contract", () => {
  it("STRATEGY_DECISION evidence item이 type contract를 만족한다", () => {
    const item: DecisionEvidenceItem = {
      evidenceKind: "STRATEGY_DECISION",
      category: "HOLD",
      reasonCode: "insufficient_expected_return",
      userMessage: "기대 수익이 비용을 충당하지 못해 진입을 보류했습니다.",
      impact: "현재 시장 조건에서는 매수보다 현금 보유가 유리합니다.",
      action: "기대 수익이 개선될 때까지 대기하세요.",
      occurredAt: new Date("2026-06-06T00:00:00Z"),
      source: "strategy.mean-reversion",
      sourceId: "strategy.mean-reversion",
      payload: { expectedReturnBps: "15", requiredReturnBps: "30", decision: "HOLD" },
      evidenceFingerprint: "fp-strategy-abc-123",
      trace: { frameId: "frame-abc-123" },
    };

    expect(item.evidenceKind).toBe("STRATEGY_DECISION");
    expect(item.category).toBe("HOLD");
    expect(item.userMessage).toContain("보류");
  });

  it("RISK_DECISION evidence item이 type contract를 만족한다", () => {
    const item: DecisionEvidenceItem = {
      evidenceKind: "RISK_DECISION",
      category: "RISK_REJECTED",
      reasonCode: "exposure_limit_exceeded",
      userMessage: "종목 노출 한도를 초과하여 주문이 차단되었습니다.",
      impact: "현재 KRW-BTC 포지션이 노출 상한에 근접했습니다.",
      action: "기존 포지션을 축소하거나 노출 한도를 조정하세요.",
      occurredAt: new Date("2026-06-06T01:00:00Z"),
      source: "risk-gate",
      sourceId: "risk-context-xyz",
      payload: {
        currentExposureBps: "4800",
        maxExposureBps: "5000",
        orderExposureBps: "500",
        approved: false,
      },
      evidenceFingerprint: "fp-risk-xyz-456",
      trace: { correlationId: "corr-xyz-789" },
    };

    expect(item.evidenceKind).toBe("RISK_DECISION");
    expect(item.category).toBe("RISK_REJECTED");
    expect(item.payload["approved"]).toBe(false);
  });

  it("EXECUTION_RESULT evidence item이 type contract를 만족한다", () => {
    const item: DecisionEvidenceItem = {
      evidenceKind: "EXECUTION_RESULT",
      category: "EXECUTED",
      reasonCode: null,
      userMessage: "paper 주문이 제출되어 체결되었습니다.",
      impact: null,
      action: null,
      occurredAt: new Date("2026-06-06T02:00:00Z"),
      source: "paper-broker",
      sourceId: "paper-order-001",
      payload: {
        orderId: "order-001",
        side: "buy",
        status: "FILLED",
        filledQuantity: "0.001",
        filledPrice: "85000000",
      },
      evidenceFingerprint: "fp-exec-001",
      trace: { orderId: "order-001", correlationId: "corr-xyz-789" },
    };

    expect(item.category).toBe("EXECUTED");
    expect(item.evidenceKind).toBe("EXECUTION_RESULT");
    expect(item.reasonCode).toBeNull();
  });

  it("EXPLANATION_FAILURE evidence item이 type contract를 만족한다", () => {
    const item: DecisionEvidenceItem = {
      evidenceKind: "EXPLANATION_FAILURE",
      category: "EXPLANATION_FAILED",
      reasonCode: "llm_timeout",
      userMessage: "LLM 설명 생성이 시간 초과로 실패했습니다.",
      impact: "자동 설명이 생성되지 않았습니다. 결정론적 evidence는 정상 기록되었습니다.",
      action: "LLM provider 상태를 확인하거나 수동으로 설명을 검토하세요.",
      occurredAt: new Date("2026-06-06T03:00:00Z"),
      source: "llm-summary",
      sourceId: null,
      payload: { provider: "codex_oauth", timeoutMs: 30000, failureClass: "timeout" },
      evidenceFingerprint: "fp-llm-fail-001",
      trace: {},
    };

    expect(item.evidenceKind).toBe("EXPLANATION_FAILURE");
    expect(item.category).toBe("EXPLANATION_FAILED");
  });

  it("impact와 action이 null인 evidence item도 유효하다", () => {
    const item: DecisionEvidenceItem = {
      evidenceKind: "ORDER_INTENT",
      category: "BUY",
      reasonCode: null,
      userMessage: "매수 주문 후보가 생성되었습니다.",
      impact: null,
      action: null,
      occurredAt: new Date(),
      source: "strategy.mean-reversion",
      sourceId: "intent-001",
      payload: { side: "buy", direction: "LONG", notionalKrw: "100000" },
      evidenceFingerprint: "fp-intent-001",
      trace: {},
    };

    expect(item.impact).toBeNull();
    expect(item.action).toBeNull();
  });
});

describe("WhySummary type contract", () => {
  it("시장별/전략별 summary와 cash summary가 포함된 전체 응답이 type contract를 만족한다", () => {
    const marketSummary: WhyMarketSummary = {
      market: "KRW-BTC",
      statusLabel: "보유",
      message: "최근 trend-following 전략이 매수 신호를 생성했습니다.",
      impact: "현재 0.001 BTC를 보유 중입니다.",
      action: null,
      latestDecisionAt: new Date("2026-06-06T00:00:00Z"),
      trace: { category: "BUY", correlationId: "corr-001" },
    };

    const strategySummary: WhyStrategySummary = {
      strategyId: "strategy.trend-following",
      statusLabel: "활성",
      message: "상승 추세가 감지되어 매수 신호를 생성했습니다.",
      impact: "현재 추세 강도는 중간 수준입니다.",
      action: null,
      latestDecisionAt: new Date("2026-06-06T00:00:00Z"),
      trace: { category: "BUY" },
    };

    const cashSummary: WhyCashSummary = {
      statusLabel: "현금 보유",
      message: "모든 전략이 현금 보유를 선택했습니다.",
      impact: "기대 수익이 비용을 하회하여 신규 진입을 보류 중입니다.",
      action: "시장 조건이 개선될 때까지 기다리세요.",
      latestDecisionAt: new Date("2026-06-06T00:00:00Z"),
      holdReasonCounts: {
        insufficient_expected_return: 2,
        wide_spread: 1,
      },
      trace: { category: "CASH_HOLD" },
    };

    const marketSection: WhyMarketSummarySection = {
      readStatus: "OK",
      items: [marketSummary],
      trace: { querySource: "decision_ledger_frames" },
    };

    const strategySection: WhyStrategySummarySection = {
      readStatus: "OK",
      items: [strategySummary],
      trace: { querySource: "decision_ledger_frames" },
    };

    const cashSection: WhyCashSummarySection = {
      readStatus: "OK",
      item: cashSummary,
      trace: { querySource: "decision_ledger_frames" },
    };

    const summary: WhySummary = {
      markets: marketSection,
      strategies: strategySection,
      cash: cashSection,
      generatedAt: new Date("2026-06-06T04:00:00Z"),
      readStatus: "OK",
      trace: { querySource: "decision_ledger_frames" },
    };

    expect(summary.markets.items).toHaveLength(1);
    expect(summary.markets.items[0]!.market).toBe("KRW-BTC");
    expect(summary.markets.readStatus).toBe("OK");
    expect(summary.strategies.items).toHaveLength(1);
    expect(summary.strategies.readStatus).toBe("OK");
    expect(summary.cash.item).not.toBeNull();
    expect(summary.cash.readStatus).toBe("OK");
    // noUncheckedIndexedAccess 환경이므로 bracket 접근으로 undefined 허용
    const cashCounts = summary.cash.item!.holdReasonCounts;
    expect(cashCounts["insufficient_expected_return"]).toBe(2);
    expect("category" in marketSummary).toBe(false);
    expect(marketSummary.trace.category).toBe("BUY");
    expect(summary.readStatus).toBe("OK");
  });

  it("cash summary가 null이어도 유효하다", () => {
    const summary: WhySummary = {
      markets: { readStatus: "NOT_FOUND", items: [], trace: {} },
      strategies: { readStatus: "NOT_FOUND", items: [], trace: {} },
      cash: { readStatus: "NOT_FOUND", item: null, trace: {} },
      generatedAt: new Date(),
      readStatus: "NOT_FOUND",
      trace: {},
    };

    expect(summary.cash.item).toBeNull();
    expect(summary.cash.readStatus).toBe("NOT_FOUND");
    expect(summary.readStatus).toBe("NOT_FOUND");
    expect(summary.markets.items).toHaveLength(0);
  });

  it("UNAVAILABLE 상태 summary도 type contract를 만족한다", () => {
    const summary: WhySummary = {
      markets: { readStatus: "UNAVAILABLE", items: [], trace: { reason: "market_query_failed" } },
      strategies: { readStatus: "OK", items: [], trace: {} },
      cash: { readStatus: "UNAVAILABLE", item: null, trace: { reason: "cash_query_failed" } },
      generatedAt: new Date(),
      readStatus: "UNAVAILABLE",
      trace: { reason: "no_ledger_data" },
    };

    expect(summary.readStatus).toBe("UNAVAILABLE");
    expect(summary.markets.readStatus).toBe("UNAVAILABLE");
    expect(summary.strategies.readStatus).toBe("OK");
    expect(summary.cash.readStatus).toBe("UNAVAILABLE");
  });

  it("시장별 summary의 action이 null이어도 유효하다", () => {
    const marketSummary: WhyMarketSummary = {
      market: "KRW-ETH",
      statusLabel: "관찰 중",
      message: "현재 이 시장에 대한 판단이 생성되지 않았습니다.",
      impact: null,
      action: null,
      latestDecisionAt: null,
      trace: { category: null },
    };

    expect(marketSummary.latestDecisionAt).toBeNull();
    expect(marketSummary.trace.category).toBeNull();
    expect(marketSummary.action).toBeNull();
  });
});
