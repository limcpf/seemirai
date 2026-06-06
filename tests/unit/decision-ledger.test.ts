import { describe, it, expect } from "vitest";
import {
  DECISION_LEDGER_VERSION,
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
      ledgerVersion: DECISION_LEDGER_VERSION,
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

    expect(frame.ledgerVersion).toBe(DECISION_LEDGER_VERSION);
    expect(frame.market).toBe("KRW-BTC");
    expect(frame.category).toBe("HOLD");
    expect(frame.summaryStatus).toBe("RECORDED");
    expect(frame.reasonCounts["insufficient_expected_return"]).toBe(1);
    expect(frame.dedupeKey).toContain("frame-abc-123");
  });

  it("market과 strategyId가 null인 frame도 유효하다 (cash/global 판단)", () => {
    const frame: DecisionLedgerFrame = {
      ledgerVersion: DECISION_LEDGER_VERSION,
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
      ledgerVersion: DECISION_LEDGER_VERSION,
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
      ledgerVersion: DECISION_LEDGER_VERSION,
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

  it("frame trace는 JSON-safe 값만 허용한다", () => {
    const frame: DecisionLedgerFrame = {
      ledgerVersion: DECISION_LEDGER_VERSION,
      sourceRunId: "run-001",
      sourceFrameId: "frame-json-trace-001",
      exchange: "UPBIT",
      market: "KRW-BTC",
      strategyId: "strategy.mean-reversion",
      category: "HOLD",
      summaryStatus: "RECORDED",
      observedAt: new Date("2026-06-06T01:00:00Z"),
      decisionAt: new Date("2026-06-06T01:00:01Z"),
      correlationId: "corr-json-trace-001",
      reasonCounts: {},
      dedupeKey: "upbit:krw-btc:json-trace:frame-json-trace-001",
      trace: { sourceTable: "decision_ledger_frames", retryCount: 0, sourceIds: ["frame-json-trace-001"] },
    };

    const invalidFrame: DecisionLedgerFrame = {
      ...frame,
      trace: {
        // @ts-expect-error JSONB trace에는 function 같은 비 JSON 값을 넣지 않는다.
        callback: () => undefined,
      },
    };
    expect(typeof invalidFrame.trace.callback).toBe("function");
  });

  it("EXPLANATION_FAILED는 frame category로 사용할 수 없다", () => {
    const frame = {
      ledgerVersion: DECISION_LEDGER_VERSION,
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
      ledgerVersion: DECISION_LEDGER_VERSION,
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

  it("ledgerVersion은 안정 literal만 허용한다", () => {
    const frame: DecisionLedgerFrame = {
      ledgerVersion: DECISION_LEDGER_VERSION,
      sourceRunId: "run-001",
      sourceFrameId: "frame-version-001",
      exchange: "UPBIT",
      market: "KRW-BTC",
      strategyId: "strategy.mean-reversion",
      category: "HOLD",
      summaryStatus: "RECORDED",
      observedAt: new Date("2026-06-06T01:00:00Z"),
      decisionAt: new Date("2026-06-06T01:00:01Z"),
      correlationId: "corr-version-001",
      reasonCounts: {},
      dedupeKey: "upbit:krw-btc:version:frame-version-001",
      trace: {},
    };

    // @ts-expect-error contract version은 임의 string이 아니라 stable literal만 허용한다.
    const invalidFrame: DecisionLedgerFrame = { ...frame, ledgerVersion: "m18.decision_ledger.v2" };
    expect(invalidFrame.ledgerVersion).toBe("m18.decision_ledger.v2");
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

  it("EXPLANATION_FAILURE와 EXPLANATION_FAILED는 전용 조합으로만 허용한다", () => {
    // @ts-expect-error 설명 실패 category는 일반 risk evidence에 붙일 수 없다.
    const invalidRiskEvidence: DecisionEvidenceItem = {
      evidenceKind: "RISK_DECISION",
      category: "EXPLANATION_FAILED",
      reasonCode: "llm_timeout",
      userMessage: "리스크 판단이 아니라 설명 생성 실패입니다.",
      impact: null,
      action: null,
      occurredAt: new Date("2026-06-06T03:10:00Z"),
      source: "risk-gate",
      sourceId: null,
      payload: {},
      evidenceFingerprint: "fp-invalid-risk-llm-001",
      trace: {},
    };

    // @ts-expect-error EXPLANATION_FAILURE evidence는 BUY 같은 주문 판단 category를 가질 수 없다.
    const invalidExplanationEvidence: DecisionEvidenceItem = {
      evidenceKind: "EXPLANATION_FAILURE",
      category: "BUY",
      reasonCode: "llm_timeout",
      userMessage: "LLM 설명 생성이 시간 초과로 실패했습니다.",
      impact: null,
      action: null,
      occurredAt: new Date("2026-06-06T03:11:00Z"),
      source: "llm-summary",
      sourceId: null,
      payload: {},
      evidenceFingerprint: "fp-invalid-llm-buy-001",
      trace: {},
    };

    expect(invalidRiskEvidence.category).toBe("EXPLANATION_FAILED");
    expect(invalidExplanationEvidence.category).toBe("BUY");
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

  it("payload와 trace는 JSON-safe 값만 허용한다", () => {
    const item: DecisionEvidenceItem = {
      evidenceKind: "COST_BREAKDOWN",
      category: "COST_REJECTED",
      reasonCode: "insufficient_expected_return",
      userMessage: "기대 수익이 비용을 충당하지 못해 주문 후보를 차단했습니다.",
      impact: "현재 시장 조건에서는 신규 진입하지 않습니다.",
      action: "비용 조건이 개선될 때까지 대기하세요.",
      occurredAt: new Date("2026-06-06T04:00:00Z"),
      source: "cost-model",
      sourceId: "cost-evaluation-001",
      payload: {
        requiredReturnBps: "30",
        rejected: true,
        components: [{ name: "spread", bps: "12" }],
      },
      evidenceFingerprint: "fp-json-safe-001",
      trace: { frameId: "frame-json-safe-001", attempts: 1, sourceIds: ["cost-evaluation-001"] },
    };

    const invalidPayloadItem: DecisionEvidenceItem = {
      ...item,
      payload: {
        // @ts-expect-error JSONB payload에는 Date 객체를 넣지 않는다.
        observedAt: new Date("2026-06-06T04:00:00Z"),
      },
    };
    const invalidTraceItem: DecisionEvidenceItem = {
      ...item,
      trace: {
        // @ts-expect-error JSONB trace에는 function 같은 비 JSON 값을 넣지 않는다.
        callback: () => undefined,
      },
    };

    expect(item.payload["rejected"]).toBe(true);
    expect(invalidPayloadItem.payload["observedAt"]).toBeInstanceOf(Date);
    expect(typeof invalidTraceItem.trace.callback).toBe("function");
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
      latestDecisionAt: "2026-06-06T00:00:00.000Z",
      trace: { category: "BUY", correlationId: "corr-001" },
    };

    const strategySummary: WhyStrategySummary = {
      strategyId: "strategy.trend-following",
      statusLabel: "활성",
      message: "상승 추세가 감지되어 매수 신호를 생성했습니다.",
      impact: "현재 추세 강도는 중간 수준입니다.",
      action: null,
      latestDecisionAt: "2026-06-06T00:00:00.000Z",
      trace: { category: "BUY" },
    };

    const cashSummary: WhyCashSummary = {
      statusLabel: "현금 보유",
      message: "모든 전략이 현금 보유를 선택했습니다.",
      impact: "기대 수익이 비용을 하회하여 신규 진입을 보류 중입니다.",
      action: "시장 조건이 개선될 때까지 기다리세요.",
      latestDecisionAt: "2026-06-06T00:00:00.000Z",
      holdReasons: [
        { label: "기대 수익 부족", count: 2, trace: { reasonCode: "insufficient_expected_return" } },
        { label: "스프레드 확대", count: 1, trace: { reasonCode: "wide_spread" } },
      ] as const,
      trace: { category: "CASH_HOLD" },
    };

    const marketSection: WhyMarketSummarySection = {
      readStatus: "OK",
      statusLabel: "조회 완료",
      message: "시장별 최근 판단 이유를 조회했습니다.",
      impact: null,
      action: null,
      items: [marketSummary],
      trace: { querySource: "decision_ledger_frames" },
    };

    const strategySection: WhyStrategySummarySection = {
      readStatus: "OK",
      statusLabel: "조회 완료",
      message: "전략별 최근 판단 이유를 조회했습니다.",
      impact: null,
      action: null,
      items: [strategySummary],
      trace: { querySource: "decision_ledger_frames" },
    };

    const cashSection: WhyCashSummarySection = {
      readStatus: "OK",
      statusLabel: "조회 완료",
      message: "현금 보유 이유를 조회했습니다.",
      impact: null,
      action: null,
      item: cashSummary,
      trace: { querySource: "decision_ledger_frames" },
    };

    const summary: WhySummary = {
      markets: marketSection,
      strategies: strategySection,
      cash: cashSection,
      generatedAt: "2026-06-06T04:00:00.000Z",
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
    const cashReasons = summary.cash.item!.holdReasons;
    expect(cashReasons[0]!.label).toBe("기대 수익 부족");
    expect(cashReasons[0]!.count).toBe(2);
    expect(cashReasons[0]!.trace.reasonCode).toBe("insufficient_expected_return");
    expect("holdReasonCounts" in summary.cash.item!).toBe(false);
    expect("category" in marketSummary).toBe(false);
    expect(marketSummary.trace.category).toBe("BUY");
    expect(summary.readStatus).toBe("OK");
  });

  it("cash summary가 null이어도 유효하다", () => {
    const summary: WhySummary = {
      markets: {
        readStatus: "NOT_FOUND",
        statusLabel: "기록 없음",
        message: "시장별 판단 이유가 아직 기록되지 않았습니다.",
        impact: null,
        action: null,
        items: [],
        trace: {},
      },
      strategies: {
        readStatus: "NOT_FOUND",
        statusLabel: "기록 없음",
        message: "전략별 판단 이유가 아직 기록되지 않았습니다.",
        impact: null,
        action: null,
        items: [],
        trace: {},
      },
      cash: {
        readStatus: "NOT_FOUND",
        statusLabel: "기록 없음",
        message: "현금 보유 이유가 아직 기록되지 않았습니다.",
        impact: null,
        action: null,
        item: null,
        trace: {},
      },
      generatedAt: new Date().toISOString(),
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
      markets: {
        readStatus: "UNAVAILABLE",
        statusLabel: "조회 불가",
        message: "시장별 판단 이유를 일시적으로 읽지 못했습니다.",
        impact: "시장별 최신 판단 설명이 비어 있을 수 있습니다.",
        action: "잠시 후 다시 확인하거나 ledger DB 상태를 점검하세요.",
        items: [],
        trace: { reason: "market_query_failed" },
      },
      strategies: {
        readStatus: "OK",
        statusLabel: "조회 완료",
        message: "전략별 판단 이유 조회가 완료되었습니다.",
        impact: null,
        action: null,
        items: [],
        trace: {},
      },
      cash: {
        readStatus: "UNAVAILABLE",
        statusLabel: "조회 불가",
        message: "현금 보유 이유를 일시적으로 읽지 못했습니다.",
        impact: "현금 보유 이유가 비어 있을 수 있습니다.",
        action: "잠시 후 다시 확인하거나 ledger DB 상태를 점검하세요.",
        item: null,
        trace: { reason: "cash_query_failed" },
      },
      generatedAt: new Date().toISOString(),
      readStatus: "UNAVAILABLE",
      trace: { reason: "no_ledger_data" },
    };

    expect(summary.readStatus).toBe("UNAVAILABLE");
    expect(summary.markets.readStatus).toBe("UNAVAILABLE");
    expect(summary.markets.action).toContain("ledger DB");
    expect(summary.strategies.readStatus).toBe("OK");
    expect(summary.cash.readStatus).toBe("UNAVAILABLE");
    expect(summary.cash.message).toContain("현금 보유 이유");
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

describe("Frame builder (producer)", () => {
  it("실행 성공 runner 결과에서 EXECUTED frame과 evidence를 생성한다", async () => {
    const {
      buildDecisionLedgerFromRunnerResult,
    } = await import("../../src/application/decision-ledger/frame-builder.js");

    const result = {
      framesProcessed: 2,
      metrics: {
        strategyEvaluationCount: 2,
        orderCandidateCount: 1,
        orderIntentCount: 1,
        holdReasonCounts: {},
        discardReasonCounts: {},
        costRejectedCount: 0,
        riskRejectedCount: 0,
        paperOrderSubmittedCount: 1,
        paperFillCount: 1,
        fillRate: 1,
        costSummary: { evaluatedCount: 1, allowedCount: 1, rejectedCount: 0, averageCostBps: "10", averageRequiredReturnBps: "20", averageMarginBps: "10" },
        slippageSummary: { observedFillCount: 1, averageSlippageBps: "0", minSlippageBps: "0", maxSlippageBps: "0" },
        pnlSummary: { startingCashKrw: "1000000", endingCashKrw: "990000", positionMarketValueKrw: "10000", realizedPnlKrw: "0", unrealizedPnlKrw: "0", totalPnlKrw: "0", totalReturnBps: "0", totalFeesKrw: "5", submittedOrderCount: 1, filledOrderCount: 1 },
        blockingReasonCounts: {},
        liveOrderApiCalls: 0 as const,
      },
      ledgerWriteStatus: "NOT_CONFIGURED" as const,
      trace: [
        { frameId: "frame-001", strategyId: "strategy.trend-following", stage: "FRAME_RECEIVED", status: "received", observedAt: "2026-06-06T00:00:00Z" },
        { frameId: "frame-001", strategyId: "strategy.trend-following", stage: "STRATEGY_DECISION", status: "BUY", reasonCode: "trend_up", message: "상승 추세 감지", observedAt: "2026-06-06T00:00:01Z" },
        { frameId: "frame-001", strategyId: "strategy.trend-following", stage: "ORDER_INTENT_CONVERSION", status: "CONVERTED", reasonCode: "order_intent_promoted", message: "주문 후보 생성됨", observedAt: "2026-06-06T00:00:02Z", metadata: { promoted_count: 1, rejection_count: 0, intent_directions: ["BUY"] } },
        { frameId: "frame-001", strategyId: "strategy.trend-following", stage: "COST_DECISION", status: "ALLOWED", reasonCode: "cost_ok", message: "비용 통과", observedAt: "2026-06-06T00:00:03Z", metadata: { trade_allowed: true, cost_bps: "10", margin_bps: "10" } },
        { frameId: "frame-001", strategyId: "strategy.trend-following", stage: "RISK_DECISION", status: "APPROVED", reasonCode: "risk_ok", message: "RiskGate approved", observedAt: "2026-06-06T00:00:04Z", metadata: { approved: true } },
        { frameId: "frame-001", strategyId: "strategy.trend-following", stage: "EXECUTION_RESULT", status: "SUBMITTED", message: "Paper broker returned an execution result", observedAt: "2026-06-06T00:00:05Z", metadata: { broker_order_id: "order-001", broker_order_status: "FILLED", filled_quantity: "0.001", slippage_bps: "0" } },
      ] as const,
    };

    const { frames } = buildDecisionLedgerFromRunnerResult(
      result,
      "run-smoke-001",
      "UPBIT",
    );
    const frame = frames[0]!.frame;
    const evidenceItems = frames[0]!.evidenceItems;

    expect(frame.category).toBe("EXECUTED");
    expect(frame.summaryStatus).toBe("RECORDED");
    expect(frame.ledgerVersion).toBe(DECISION_LEDGER_VERSION);
    expect(frame.sourceRunId).toBe("run-smoke-001");
    expect(frame.exchange).toBe("UPBIT");
    expect(frame.dedupeKey).toContain("run-smoke-001");
    expect(frame.dedupeKey).toContain("frame-001");

    // FRAME_RECEIVED는 evidence로 변환되지 않는다
    const evidenceKinds = evidenceItems.map((item) => item.evidenceKind);
    expect(evidenceKinds).toContain("STRATEGY_DECISION");
    expect(evidenceKinds).toContain("ORDER_INTENT");
    expect(evidenceKinds).toContain("COST_BREAKDOWN");
    expect(evidenceKinds).toContain("RISK_DECISION");
    expect(evidenceKinds).toContain("EXECUTION_RESULT");
    expect(evidenceKinds).not.toContain("FRAME_RECEIVED");

    // 모든 evidence가 fingerprint를 가진다
    for (const item of evidenceItems as readonly DecisionEvidenceItem[]) {
      expect(item.evidenceFingerprint).toMatch(/^fp-/);
      expect(item.userMessage).toBeTruthy();
    }
  });

  it("주문 후보 0건 HOLD runner 결과에서 CASH_HOLD frame을 생성한다", async () => {
    const {
      buildDecisionLedgerFromRunnerResult,
    } = await import("../../src/application/decision-ledger/frame-builder.js");

    const result = {
      framesProcessed: 1,
      metrics: {
        strategyEvaluationCount: 1,
        orderCandidateCount: 0,
        orderIntentCount: 0,
        holdReasonCounts: { fixture_waiting_for_signal: 1 },
        discardReasonCounts: {},
        costRejectedCount: 0,
        riskRejectedCount: 0,
        paperOrderSubmittedCount: 0,
        paperFillCount: 0,
        fillRate: 0,
        costSummary: { evaluatedCount: 0, allowedCount: 0, rejectedCount: 0, averageCostBps: null, averageRequiredReturnBps: null, averageMarginBps: null },
        slippageSummary: { observedFillCount: 0, averageSlippageBps: null, minSlippageBps: null, maxSlippageBps: null },
        pnlSummary: { startingCashKrw: "1000000", endingCashKrw: "1000000", positionMarketValueKrw: "0", realizedPnlKrw: "0", unrealizedPnlKrw: "0", totalPnlKrw: "0", totalReturnBps: "0", totalFeesKrw: "0", submittedOrderCount: 0, filledOrderCount: 0 },
        blockingReasonCounts: { "hold:fixture_waiting_for_signal": 1 },
        liveOrderApiCalls: 0 as const,
      },
      ledgerWriteStatus: "NOT_CONFIGURED" as const,
      trace: [
        { frameId: "frame-hold-001", strategyId: "strategy.mean-reversion", stage: "FRAME_RECEIVED", status: "received", observedAt: "2026-06-06T01:00:00Z" },
        { frameId: "frame-hold-001", strategyId: "strategy.mean-reversion", stage: "STRATEGY_DECISION", status: "HOLD", reasonCode: "fixture_waiting_for_signal", message: "신호 대기 중", observedAt: "2026-06-06T01:00:01Z" },
      ] as const,
    };

    const { frames } = buildDecisionLedgerFromRunnerResult(
      result,
      "run-hold-001",
      "UPBIT",
    );
    expect(frames).toHaveLength(2);
    const strategyFrame = frames.find((item) => item.frame.strategyId === "strategy.mean-reversion")!.frame;
    const cashFrame = frames.find((item) => item.frame.strategyId === null)!.frame;
    const evidenceItems = frames.find((item) => item.frame.strategyId === "strategy.mean-reversion")!.evidenceItems;

    expect(strategyFrame.category).toBe("HOLD");
    expect(strategyFrame.summaryStatus).toBe("RECORDED");
    expect(strategyFrame.reasonCounts["fixture_waiting_for_signal"]).toBe(1);
    expect(strategyFrame.reasonCounts["hold:fixture_waiting_for_signal"]).toBeUndefined();
    expect(cashFrame.category).toBe("CASH_HOLD");
    expect(cashFrame.strategyId).toBeNull();
    expect(cashFrame.reasonCounts["fixture_waiting_for_signal"]).toBe(1);

    // HOLD decision은 STRATEGY_DECISION evidence로 남는다
    const strategyEvidence = evidenceItems.find(
      (item) => item.evidenceKind === "STRATEGY_DECISION",
    );
    expect(strategyEvidence).toBeDefined();
    expect(strategyEvidence!.category).toBe("HOLD");
  });

  it("리스크 차단 runner 결과에서 RISK_REJECTED frame을 생성한다", async () => {
    const {
      buildDecisionLedgerFromRunnerResult,
    } = await import("../../src/application/decision-ledger/frame-builder.js");

    const result = {
      framesProcessed: 1,
      metrics: {
        strategyEvaluationCount: 1,
        orderCandidateCount: 1,
        orderIntentCount: 1,
        holdReasonCounts: {},
        discardReasonCounts: {},
        costRejectedCount: 0,
        riskRejectedCount: 1,
        paperOrderSubmittedCount: 0,
        paperFillCount: 0,
        fillRate: 0,
        costSummary: { evaluatedCount: 1, allowedCount: 1, rejectedCount: 0, averageCostBps: "10", averageRequiredReturnBps: "20", averageMarginBps: "10" },
        slippageSummary: { observedFillCount: 0, averageSlippageBps: null, minSlippageBps: null, maxSlippageBps: null },
        pnlSummary: { startingCashKrw: "1000000", endingCashKrw: "1000000", positionMarketValueKrw: "0", realizedPnlKrw: "0", unrealizedPnlKrw: "0", totalPnlKrw: "0", totalReturnBps: "0", totalFeesKrw: "0", submittedOrderCount: 0, filledOrderCount: 0 },
        blockingReasonCounts: { "risk:expected_loss_limit_exceeded": 1 },
        liveOrderApiCalls: 0 as const,
      },
      ledgerWriteStatus: "NOT_CONFIGURED" as const,
      trace: [
        { frameId: "frame-risk-001", strategyId: "strategy.trend-following", stage: "FRAME_RECEIVED", status: "received", observedAt: "2026-06-06T02:00:00Z" },
        { frameId: "frame-risk-001", strategyId: "strategy.trend-following", stage: "STRATEGY_DECISION", status: "BUY", reasonCode: "trend_up", message: "상승 추세", observedAt: "2026-06-06T02:00:01Z" },
        { frameId: "frame-risk-001", stage: "ORDER_INTENT_CONVERSION", status: "CONVERTED", reasonCode: "BUY", message: "주문 후보 생성됨", observedAt: "2026-06-06T02:00:02Z" },
        { frameId: "frame-risk-001", stage: "COST_DECISION", status: "ALLOWED", reasonCode: "cost_ok", message: "비용 통과", observedAt: "2026-06-06T02:00:03Z" },
        { frameId: "frame-risk-001", strategyId: "strategy.trend-following", stage: "RISK_DECISION", status: "REJECTED", reasonCode: "expected_loss_limit_exceeded", message: "RiskGate rejected paper order intent", observedAt: "2026-06-06T02:00:04Z", metadata: { approved: false, failed_reason_codes: ["expected_loss_limit_exceeded"] } },
      ] as const,
    };

    const { frames: riskFrames } = buildDecisionLedgerFromRunnerResult(
      result,
      "run-risk-001",
      "UPBIT",
    );

    const frame = riskFrames[0]!.frame;
    const evidenceItems = riskFrames[0]!.evidenceItems;

    expect(frame.category).toBe("RISK_REJECTED");
    expect(frame.summaryStatus).toBe("RECORDED");

    const riskEvidence = evidenceItems.find(
      (item) => item.evidenceKind === "RISK_DECISION",
    );
    expect(riskEvidence).toBeDefined();
    expect(riskEvidence!.category).toBe("RISK_REJECTED");
    expect(riskEvidence!.reasonCode).toBe("expected_loss_limit_exceeded");
  });

  it("dedupe key가 sourceRunId와 sourceFrameId를 포함한다", async () => {
    const {
      buildDecisionLedgerFromRunnerResult,
    } = await import("../../src/application/decision-ledger/frame-builder.js");

    const result = {
      framesProcessed: 1,
      metrics: {
        strategyEvaluationCount: 1,
        orderCandidateCount: 0,
        orderIntentCount: 0,
        holdReasonCounts: { hold_reason: 1 },
        discardReasonCounts: {},
        costRejectedCount: 0,
        riskRejectedCount: 0,
        paperOrderSubmittedCount: 0,
        paperFillCount: 0,
        fillRate: 0,
        costSummary: { evaluatedCount: 0, allowedCount: 0, rejectedCount: 0, averageCostBps: null, averageRequiredReturnBps: null, averageMarginBps: null },
        slippageSummary: { observedFillCount: 0, averageSlippageBps: null, minSlippageBps: null, maxSlippageBps: null },
        pnlSummary: { startingCashKrw: "1000000", endingCashKrw: "1000000", positionMarketValueKrw: "0", realizedPnlKrw: "0", unrealizedPnlKrw: "0", totalPnlKrw: "0", totalReturnBps: "0", totalFeesKrw: "0", submittedOrderCount: 0, filledOrderCount: 0 },
        blockingReasonCounts: {},
        liveOrderApiCalls: 0 as const,
      },
      ledgerWriteStatus: "NOT_CONFIGURED" as const,
      trace: [
        { frameId: "frame-dedupe-001", strategyId: "s1", stage: "FRAME_RECEIVED", status: "received", observedAt: "2026-06-06T03:00:00Z" },
        { frameId: "frame-dedupe-001", strategyId: "s1", stage: "STRATEGY_DECISION", status: "HOLD", reasonCode: "hold_reason", message: "보유", observedAt: "2026-06-06T03:00:01Z" },
      ] as const,
    };

    const { frames: dedupeFrames } = buildDecisionLedgerFromRunnerResult(
      result,
      "run-dedupe-001",
      "UPBIT",
    );

    const frame = dedupeFrames[0]!.frame;

    // dedupe key 형식: {prefix}:frame:{sourceFrameId}:strategy:{strategyId}
    expect(frame.dedupeKey).toBe("UPBIT:run-dedupe-001:frame:frame-dedupe-001:strategy:s1");
  });

  it("같은 input frame의 다중 strategy를 별도 ledger frame으로 보존한다", async () => {
    const {
      buildDecisionLedgerFromRunnerResult,
    } = await import("../../src/application/decision-ledger/frame-builder.js");

    const result = {
      framesProcessed: 1,
      metrics: {
        strategyEvaluationCount: 2,
        orderCandidateCount: 1,
        orderIntentCount: 1,
        holdReasonCounts: { wait_for_s1: 1 },
        discardReasonCounts: {},
        costRejectedCount: 1,
        riskRejectedCount: 0,
        paperOrderSubmittedCount: 0,
        paperFillCount: 0,
        fillRate: 0,
        costSummary: { evaluatedCount: 1, allowedCount: 0, rejectedCount: 1, averageCostBps: "40", averageRequiredReturnBps: "30", averageMarginBps: "-10" },
        slippageSummary: { observedFillCount: 0, averageSlippageBps: null, minSlippageBps: null, maxSlippageBps: null },
        pnlSummary: { startingCashKrw: "1000000", endingCashKrw: "1000000", positionMarketValueKrw: "0", realizedPnlKrw: "0", unrealizedPnlKrw: "0", totalPnlKrw: "0", totalReturnBps: "0", totalFeesKrw: "0", submittedOrderCount: 0, filledOrderCount: 0 },
        blockingReasonCounts: { "risk:must_not_leak": 1 },
        liveOrderApiCalls: 0 as const,
      },
      ledgerWriteStatus: "NOT_CONFIGURED" as const,
      trace: [
        { frameId: "multi-strategy-frame", stage: "FRAME_RECEIVED", status: "received", observedAt: "2026-06-06T06:00:00Z", metadata: { market: "KRW-BTC" } },
        { frameId: "multi-strategy-frame", strategyId: "strategy.hold", stage: "STRATEGY_DECISION", status: "HOLD", reasonCode: "wait_for_s1", message: "대기", observedAt: "2026-06-06T06:00:01Z" },
        { frameId: "multi-strategy-frame", strategyId: "strategy.buy", stage: "STRATEGY_DECISION", status: "BUY", reasonCode: "trend_up", message: "매수", observedAt: "2026-06-06T06:00:02Z" },
        { frameId: "multi-strategy-frame", strategyId: "strategy.buy", stage: "ORDER_INTENT_CONVERSION", status: "CONVERTED", reasonCode: "order_intent_promoted", message: "변환", observedAt: "2026-06-06T06:00:03Z", metadata: { intent_directions: ["BUY"] } },
        { frameId: "multi-strategy-frame", strategyId: "strategy.buy", stage: "COST_DECISION", status: "REJECT", reasonCode: "cost_margin_insufficient", message: "비용 차단", observedAt: "2026-06-06T06:00:04Z", metadata: { trade_allowed: false } },
      ] as const,
    };

    const { frames } = buildDecisionLedgerFromRunnerResult(
      result,
      "run-multi-strategy",
      "UPBIT",
    );

    expect(frames).toHaveLength(2);
    const holdFrame = frames.find((item) => item.frame.strategyId === "strategy.hold")!.frame;
    const buyFrame = frames.find((item) => item.frame.strategyId === "strategy.buy")!.frame;

    expect(holdFrame.category).toBe("HOLD");
    expect(holdFrame.reasonCounts).toEqual({ wait_for_s1: 1 });
    expect(holdFrame.dedupeKey).toBe("UPBIT:run-multi-strategy:frame:multi-strategy-frame:strategy:strategy.hold");
    expect(buyFrame.category).toBe("COST_REJECTED");
    expect(buyFrame.reasonCounts).toEqual({ cost_margin_insufficient: 1 });
    expect(buyFrame.reasonCounts["risk:must_not_leak"]).toBeUndefined();
    expect(buyFrame.dedupeKey).toBe("UPBIT:run-multi-strategy:frame:multi-strategy-frame:strategy:strategy.buy");
  });

  it("같은 input frame의 모든 strategy가 HOLD면 strategy HOLD와 cash summary를 분리한다", async () => {
    const {
      buildDecisionLedgerFromRunnerResult,
    } = await import("../../src/application/decision-ledger/frame-builder.js");

    const result = {
      framesProcessed: 1,
      metrics: {
        strategyEvaluationCount: 2,
        orderCandidateCount: 0,
        orderIntentCount: 0,
        holdReasonCounts: { wait_for_signal: 1, wide_spread: 1 },
        discardReasonCounts: {},
        costRejectedCount: 0,
        riskRejectedCount: 0,
        paperOrderSubmittedCount: 0,
        paperFillCount: 0,
        fillRate: 0,
        costSummary: { evaluatedCount: 0, allowedCount: 0, rejectedCount: 0, averageCostBps: null, averageRequiredReturnBps: null, averageMarginBps: null },
        slippageSummary: { observedFillCount: 0, averageSlippageBps: null, minSlippageBps: null, maxSlippageBps: null },
        pnlSummary: { startingCashKrw: "1000000", endingCashKrw: "1000000", positionMarketValueKrw: "0", realizedPnlKrw: "0", unrealizedPnlKrw: "0", totalPnlKrw: "0", totalReturnBps: "0", totalFeesKrw: "0", submittedOrderCount: 0, filledOrderCount: 0 },
        blockingReasonCounts: { "hold:wait_for_signal": 1, "hold:wide_spread": 1 },
        liveOrderApiCalls: 0 as const,
      },
      ledgerWriteStatus: "NOT_CONFIGURED" as const,
      trace: [
        { frameId: "all-hold-frame", stage: "FRAME_RECEIVED", status: "received", observedAt: "2026-06-06T08:00:00Z", metadata: { market: "KRW-BTC" } },
        { frameId: "all-hold-frame", strategyId: "strategy.mean-reversion", stage: "STRATEGY_DECISION", status: "HOLD", reasonCode: "wait_for_signal", message: "신호 대기", observedAt: "2026-06-06T08:00:01Z" },
        { frameId: "all-hold-frame", strategyId: "strategy.trend-following", stage: "STRATEGY_DECISION", status: "HOLD", reasonCode: "wide_spread", message: "스프레드 확대", observedAt: "2026-06-06T08:00:02Z" },
      ] as const,
    };

    const { frames } = buildDecisionLedgerFromRunnerResult(
      result,
      "run-all-hold",
      "UPBIT",
    );

    expect(frames).toHaveLength(3);
    const meanReversionFrame = frames.find((item) => item.frame.strategyId === "strategy.mean-reversion")!;
    const trendFrame = frames.find((item) => item.frame.strategyId === "strategy.trend-following")!;
    const cashFrame = frames.find((item) => item.frame.strategyId === null)!;

    expect(meanReversionFrame.frame.category).toBe("HOLD");
    expect(meanReversionFrame.frame.reasonCounts).toEqual({ wait_for_signal: 1 });
    expect(trendFrame.frame.category).toBe("HOLD");
    expect(trendFrame.frame.reasonCounts).toEqual({ wide_spread: 1 });
    expect(cashFrame.frame.category).toBe("CASH_HOLD");
    expect(cashFrame.frame.reasonCounts).toEqual({ wait_for_signal: 1, wide_spread: 1 });
    expect(cashFrame.evidenceItems).toHaveLength(0);
  });

  it("execution validation reject를 BUY/SELL이 아닌 EXECUTION_REJECTED frame으로 기록한다", async () => {
    const {
      buildDecisionLedgerFromRunnerResult,
    } = await import("../../src/application/decision-ledger/frame-builder.js");

    const result = {
      framesProcessed: 1,
      metrics: {
        strategyEvaluationCount: 1,
        orderCandidateCount: 1,
        orderIntentCount: 1,
        holdReasonCounts: {},
        discardReasonCounts: { cost_snapshot_missing: 1 },
        costRejectedCount: 0,
        riskRejectedCount: 0,
        paperOrderSubmittedCount: 0,
        paperFillCount: 0,
        fillRate: 0,
        costSummary: { evaluatedCount: 1, allowedCount: 1, rejectedCount: 0, averageCostBps: "10", averageRequiredReturnBps: "20", averageMarginBps: "10" },
        slippageSummary: { observedFillCount: 0, averageSlippageBps: null, minSlippageBps: null, maxSlippageBps: null },
        pnlSummary: { startingCashKrw: "1000000", endingCashKrw: "1000000", positionMarketValueKrw: "0", realizedPnlKrw: "0", unrealizedPnlKrw: "0", totalPnlKrw: "0", totalReturnBps: "0", totalFeesKrw: "0", submittedOrderCount: 0, filledOrderCount: 0 },
        blockingReasonCounts: { "discard:cost_snapshot_missing": 1 },
        liveOrderApiCalls: 0 as const,
      },
      ledgerWriteStatus: "NOT_CONFIGURED" as const,
      trace: [
        { frameId: "execution-reject-frame", strategyId: "strategy.buy", stage: "FRAME_RECEIVED", status: "received", observedAt: "2026-06-06T07:00:00Z" },
        { frameId: "execution-reject-frame", strategyId: "strategy.buy", stage: "STRATEGY_DECISION", status: "BUY", reasonCode: "trend_up", message: "매수", observedAt: "2026-06-06T07:00:01Z" },
        { frameId: "execution-reject-frame", strategyId: "strategy.buy", stage: "ORDER_INTENT_CONVERSION", status: "CONVERTED", reasonCode: "order_intent_promoted", message: "변환", observedAt: "2026-06-06T07:00:02Z", metadata: { intent_directions: ["BUY"] } },
        { frameId: "execution-reject-frame", strategyId: "strategy.buy", stage: "COST_DECISION", status: "ALLOW", reasonCode: "cost_margin_ok", message: "비용 통과", observedAt: "2026-06-06T07:00:03Z", metadata: { trade_allowed: true } },
        { frameId: "execution-reject-frame", strategyId: "strategy.buy", stage: "RISK_DECISION", status: "PASS", reasonCode: "ALLOW", message: "리스크 통과", observedAt: "2026-06-06T07:00:04Z", metadata: { approved: true } },
        { frameId: "execution-reject-frame", strategyId: "strategy.buy", stage: "EXECUTION_RESULT", status: "REJECTED", reasonCode: "cost_snapshot_missing", message: "실행 검증 실패", observedAt: "2026-06-06T07:00:05Z" },
      ] as const,
    };

    const { frames } = buildDecisionLedgerFromRunnerResult(
      result,
      "run-execution-reject",
      "UPBIT",
    );

    const frame = frames[0]!.frame;
    const executionEvidence = frames[0]!.evidenceItems.find(
      (item) => item.evidenceKind === "EXECUTION_RESULT",
    );

    expect(frame.category).toBe("EXECUTION_REJECTED");
    expect(frame.reasonCounts).toEqual({ cost_snapshot_missing: 1 });
    expect(executionEvidence!.category).toBe("EXECUTION_REJECTED");
  });

  it("접수됐지만 아직 미체결인 주문을 EXECUTION_REJECTED로 오분류하지 않는다", async () => {
    const {
      buildDecisionLedgerFromRunnerResult,
    } = await import("../../src/application/decision-ledger/frame-builder.js");

    const result = {
      framesProcessed: 1,
      metrics: {
        strategyEvaluationCount: 1,
        orderCandidateCount: 1,
        orderIntentCount: 1,
        holdReasonCounts: {},
        discardReasonCounts: {},
        costRejectedCount: 0,
        riskRejectedCount: 0,
        paperOrderSubmittedCount: 1,
        paperFillCount: 0,
        fillRate: 0,
        costSummary: { evaluatedCount: 1, allowedCount: 1, rejectedCount: 0, averageCostBps: "10", averageRequiredReturnBps: "20", averageMarginBps: "10" },
        slippageSummary: { observedFillCount: 0, averageSlippageBps: null, minSlippageBps: null, maxSlippageBps: null },
        pnlSummary: { startingCashKrw: "1000000", endingCashKrw: "1000000", positionMarketValueKrw: "0", realizedPnlKrw: "0", unrealizedPnlKrw: "0", totalPnlKrw: "0", totalReturnBps: "0", totalFeesKrw: "0", submittedOrderCount: 1, filledOrderCount: 0 },
        blockingReasonCounts: {},
        liveOrderApiCalls: 0 as const,
      },
      ledgerWriteStatus: "NOT_CONFIGURED" as const,
      trace: [
        { frameId: "submitted-open-frame", strategyId: "strategy.buy", stage: "FRAME_RECEIVED", status: "received", observedAt: "2026-06-06T09:00:00Z" },
        { frameId: "submitted-open-frame", strategyId: "strategy.buy", stage: "STRATEGY_DECISION", status: "ORDER_INTENT", reasonCode: "trend_up", message: "매수", observedAt: "2026-06-06T09:00:01Z", metadata: { intent_directions: ["BUY"], order_intent_count: 1 } },
        { frameId: "submitted-open-frame", strategyId: "strategy.buy", stage: "ORDER_INTENT_CONVERSION", status: "CONVERTED", reasonCode: "order_intent_promoted", message: "변환", observedAt: "2026-06-06T09:00:02Z", metadata: { intent_directions: ["BUY"] } },
        { frameId: "submitted-open-frame", strategyId: "strategy.buy", stage: "COST_DECISION", status: "ALLOW", reasonCode: "cost_margin_ok", message: "비용 통과", observedAt: "2026-06-06T09:00:03Z", metadata: { trade_allowed: true, intent_side: "BUY" } },
        { frameId: "submitted-open-frame", strategyId: "strategy.buy", stage: "RISK_DECISION", status: "PASS", reasonCode: "ALLOW", message: "리스크 통과", observedAt: "2026-06-06T09:00:04Z", metadata: { approved: true, intent_side: "BUY" } },
        { frameId: "submitted-open-frame", strategyId: "strategy.buy", stage: "EXECUTION_RESULT", status: "SUBMITTED", reasonCode: "paper_order_accepted", message: "접수", observedAt: "2026-06-06T09:00:05Z", metadata: { broker_order_id: "open-order-001", broker_order_status: "ACCEPTED", filled_quantity: "0.0", intent_side: "BUY" } },
      ] as const,
    };

    const { frames } = buildDecisionLedgerFromRunnerResult(
      result,
      "run-submitted-open",
      "UPBIT",
    );
    const frame = frames[0]!.frame;
    const executionEvidence = frames[0]!.evidenceItems.find(
      (item) => item.evidenceKind === "EXECUTION_RESULT",
    );
    const strategyEvidence = frames[0]!.evidenceItems.find(
      (item) => item.evidenceKind === "STRATEGY_DECISION",
    );

    expect(frame.category).toBe("BUY");
    expect(strategyEvidence!.category).toBe("BUY");
    expect(executionEvidence!.category).toBe("BUY");
  });

  it("SELL 주문 후보의 cost/risk 승인 evidence category를 SELL로 보존한다", async () => {
    const {
      buildDecisionLedgerFromRunnerResult,
    } = await import("../../src/application/decision-ledger/frame-builder.js");

    const result = {
      framesProcessed: 1,
      metrics: {
        strategyEvaluationCount: 1,
        orderCandidateCount: 1,
        orderIntentCount: 1,
        holdReasonCounts: {},
        discardReasonCounts: {},
        costRejectedCount: 0,
        riskRejectedCount: 0,
        paperOrderSubmittedCount: 0,
        paperFillCount: 0,
        fillRate: 0,
        costSummary: { evaluatedCount: 1, allowedCount: 1, rejectedCount: 0, averageCostBps: "10", averageRequiredReturnBps: "20", averageMarginBps: "10" },
        slippageSummary: { observedFillCount: 0, averageSlippageBps: null, minSlippageBps: null, maxSlippageBps: null },
        pnlSummary: { startingCashKrw: "1000000", endingCashKrw: "1000000", positionMarketValueKrw: "0", realizedPnlKrw: "0", unrealizedPnlKrw: "0", totalPnlKrw: "0", totalReturnBps: "0", totalFeesKrw: "0", submittedOrderCount: 0, filledOrderCount: 0 },
        blockingReasonCounts: {},
        liveOrderApiCalls: 0 as const,
      },
      ledgerWriteStatus: "NOT_CONFIGURED" as const,
      trace: [
        { frameId: "sell-side-frame", strategyId: "strategy.sell", stage: "FRAME_RECEIVED", status: "received", observedAt: "2026-06-06T10:00:00Z" },
        { frameId: "sell-side-frame", strategyId: "strategy.sell", stage: "STRATEGY_DECISION", status: "SELL", reasonCode: "trend_down", message: "매도", observedAt: "2026-06-06T10:00:01Z" },
        { frameId: "sell-side-frame", strategyId: "strategy.sell", stage: "ORDER_INTENT_CONVERSION", status: "CONVERTED", reasonCode: "order_intent_promoted", message: "변환", observedAt: "2026-06-06T10:00:02Z", metadata: { intent_directions: ["SELL"] } },
        { frameId: "sell-side-frame", strategyId: "strategy.sell", stage: "COST_DECISION", status: "ALLOW", reasonCode: "cost_margin_ok", message: "비용 통과", observedAt: "2026-06-06T10:00:03Z", metadata: { trade_allowed: true, intent_side: "SELL" } },
        { frameId: "sell-side-frame", strategyId: "strategy.sell", stage: "RISK_DECISION", status: "PASS", reasonCode: "ALLOW", message: "리스크 통과", observedAt: "2026-06-06T10:00:04Z", metadata: { approved: true, intent_side: "SELL" } },
      ] as const,
    };

    const { frames } = buildDecisionLedgerFromRunnerResult(
      result,
      "run-sell-side",
      "UPBIT",
    );

    const costEvidence = frames[0]!.evidenceItems.find((item) => item.evidenceKind === "COST_BREAKDOWN");
    const riskEvidence = frames[0]!.evidenceItems.find((item) => item.evidenceKind === "RISK_DECISION");
    expect(costEvidence!.category).toBe("SELL");
    expect(riskEvidence!.category).toBe("SELL");
  });

  it("evidence fingerprint는 모두 고유하고 중복이 없다", async () => {
    const {
      buildDecisionLedgerFromRunnerResult,
    } = await import("../../src/application/decision-ledger/frame-builder.js");

    const result = {
      framesProcessed: 2,
      metrics: {
        strategyEvaluationCount: 2,
        orderCandidateCount: 2,
        orderIntentCount: 2,
        holdReasonCounts: {},
        discardReasonCounts: {},
        costRejectedCount: 0,
        riskRejectedCount: 0,
        paperOrderSubmittedCount: 2,
        paperFillCount: 2,
        fillRate: 1,
        costSummary: { evaluatedCount: 2, allowedCount: 2, rejectedCount: 0, averageCostBps: "10", averageRequiredReturnBps: "20", averageMarginBps: "10" },
        slippageSummary: { observedFillCount: 2, averageSlippageBps: "0", minSlippageBps: "0", maxSlippageBps: "0" },
        pnlSummary: { startingCashKrw: "1000000", endingCashKrw: "980000", positionMarketValueKrw: "20000", realizedPnlKrw: "0", unrealizedPnlKrw: "0", totalPnlKrw: "0", totalReturnBps: "0", totalFeesKrw: "10", submittedOrderCount: 2, filledOrderCount: 2 },
        blockingReasonCounts: {},
        liveOrderApiCalls: 0 as const,
      },
      ledgerWriteStatus: "NOT_CONFIGURED" as const,
      trace: [
        { frameId: "fp-frame-001", strategyId: "s1", stage: "FRAME_RECEIVED", status: "received", observedAt: "2026-06-06T04:00:00Z" },
        { frameId: "fp-frame-001", strategyId: "s1", stage: "STRATEGY_DECISION", status: "BUY", reasonCode: "trend_up", message: "매수", observedAt: "2026-06-06T04:00:01Z" },
        { frameId: "fp-frame-001", strategyId: "s1", stage: "ORDER_INTENT_CONVERSION", status: "CONVERTED", message: "변환", observedAt: "2026-06-06T04:00:02Z" },
        { frameId: "fp-frame-001", strategyId: "s1", stage: "COST_DECISION", status: "ALLOWED", message: "비용", observedAt: "2026-06-06T04:00:03Z" },
        { frameId: "fp-frame-001", strategyId: "s1", stage: "RISK_DECISION", status: "APPROVED", message: "리스크", observedAt: "2026-06-06T04:00:04Z" },
        { frameId: "fp-frame-001", strategyId: "s1", stage: "EXECUTION_RESULT", status: "SUBMITTED", message: "실행", observedAt: "2026-06-06T04:00:05Z" },
        { frameId: "fp-frame-002", strategyId: "s2", stage: "FRAME_RECEIVED", status: "received", observedAt: "2026-06-06T05:00:00Z" },
        { frameId: "fp-frame-002", strategyId: "s2", stage: "STRATEGY_DECISION", status: "SELL", reasonCode: "trend_down", message: "매도", observedAt: "2026-06-06T05:00:01Z" },
        { frameId: "fp-frame-002", strategyId: "s2", stage: "ORDER_INTENT_CONVERSION", status: "CONVERTED", message: "변환", observedAt: "2026-06-06T05:00:02Z" },
        { frameId: "fp-frame-002", strategyId: "s2", stage: "COST_DECISION", status: "ALLOWED", message: "비용", observedAt: "2026-06-06T05:00:03Z" },
        { frameId: "fp-frame-002", strategyId: "s2", stage: "RISK_DECISION", status: "APPROVED", message: "리스크", observedAt: "2026-06-06T05:00:04Z" },
        { frameId: "fp-frame-002", strategyId: "s2", stage: "EXECUTION_RESULT", status: "SUBMITTED", message: "실행", observedAt: "2026-06-06T05:00:05Z" },
      ] as const,
    };

    const { frames: fpFrames } = buildDecisionLedgerFromRunnerResult(
      result,
      "run-fp-001",
      "UPBIT",
    );

    const evidenceItems = fpFrames[0]!.evidenceItems;

    const fingerprints = evidenceItems.map((item: DecisionEvidenceItem) => item.evidenceFingerprint);
    const uniqueFingerprints = new Set(fingerprints);
    expect(uniqueFingerprints.size).toBe(fingerprints.length);
  });
});

describe("User-facing message mapper", () => {
  it("모든 category에 대한 한국어 label이 정의되어 있다", async () => {
    const { toCategoryLabel } = await import("../../src/application/decision-ledger/user-facing.js");

    expect(toCategoryLabel("BUY")).toBe("매수 판단");
    expect(toCategoryLabel("SELL")).toBe("매도 판단");
    expect(toCategoryLabel("HOLD")).toBe("보유");
    expect(toCategoryLabel("CASH_HOLD")).toBe("현금 보유");
    expect(toCategoryLabel("DISCARD")).toBe("주문 폐기");
    expect(toCategoryLabel("COST_REJECTED")).toBe("비용 차단");
    expect(toCategoryLabel("RISK_REJECTED")).toBe("리스크 차단");
    expect(toCategoryLabel("EXECUTION_REJECTED")).toBe("실행 거부");
    expect(toCategoryLabel("EXECUTED")).toBe("실행 완료");
    expect(toCategoryLabel("EXPLANATION_FAILED")).toBe("설명 생성 실패");
  });

  it("HOLD category에 대한 why status message가 한국어로 제공된다", async () => {
    const { toWhyStatusMessages } = await import("../../src/application/decision-ledger/user-facing.js");

    const messages = toWhyStatusMessages("HOLD", "KRW-BTC");
    expect(messages.statusLabel).toBe("보유");
    expect(messages.message).toContain("KRW-BTC");
    expect(messages.message).toContain("진입 또는 청산하지 않기로");
    expect(messages.action).toContain("대기");
  });

  it("category가 null이면 기록 없음 메시지를 반환한다", async () => {
    const { toWhyStatusMessages } = await import("../../src/application/decision-ledger/user-facing.js");

    const messages = toWhyStatusMessages(null, "KRW-ETH");
    expect(messages.statusLabel).toBe("기록 없음");
    expect(messages.message).toContain("KRW-ETH");
    expect(messages.action).toContain("다시 조회");
  });

  it("알려진 reason code를 한국어 label로 변환한다", async () => {
    const { toHoldReasonLabel } = await import("../../src/application/decision-ledger/user-facing.js");

    expect(toHoldReasonLabel("fixture_waiting_for_signal")).toBe("신호 대기 중");
    expect(toHoldReasonLabel("insufficient_expected_return")).toBe("기대 수익 부족");
    expect(toHoldReasonLabel("wide_spread")).toBe("스프레드 확대");
    expect(toHoldReasonLabel("cost_margin_insufficient")).toBe("비용 마진 부족");
    expect(toHoldReasonLabel("exposure_limit_exceeded")).toBe("노출 한도 초과");
  });

  it("알려지지 않은 reason code는 그대로 반환한다", async () => {
    const { toHoldReasonLabel } = await import("../../src/application/decision-ledger/user-facing.js");

    expect(toHoldReasonLabel("custom_unknown_code")).toBe("custom_unknown_code");
  });
});

describe("WhySummary build function", () => {
  it("market projection으로 WhySummary를 빌드한다", async () => {
    const { buildWhySummary } = await import("../../src/application/decision-ledger/why-summary.js");

    const summary = buildWhySummary(
      {
        markets: [
          {
            market: "KRW-BTC",
            category: "BUY",
            summaryStatus: "RECORDED",
            reasonCounts: {},
            latestDecisionAt: new Date("2026-06-06T00:00:00Z"),
            trace: { correlationId: "corr-001" },
          },
        ],
        strategies: [
          {
            strategyId: "strategy.trend-following",
            category: "BUY",
            summaryStatus: "RECORDED",
            reasonCounts: {},
            latestDecisionAt: new Date("2026-06-06T00:00:00Z"),
            trace: {},
          },
        ],
        cashFrames: [
          {
            category: "CASH_HOLD",
            summaryStatus: "RECORDED",
            reasonCounts: { fixture_waiting_for_signal: 2, wide_spread: 1 },
            latestDecisionAt: new Date("2026-06-06T00:00:00Z"),
            trace: {},
          },
        ],
      },
      "2026-06-06T04:00:00.000Z",
    );

    expect(summary.readStatus).toBe("OK");
    expect(summary.markets.readStatus).toBe("OK");
    expect(summary.markets.items).toHaveLength(1);
    expect(summary.markets.items[0]!.market).toBe("KRW-BTC");
    expect(summary.markets.items[0]!.statusLabel).toBe("매수 판단");
    expect(summary.strategies.items).toHaveLength(1);
    expect(summary.cash.readStatus).toBe("OK");
    expect(summary.cash.item).not.toBeNull();
    expect(summary.cash.item!.holdReasons).toHaveLength(2);
    expect(summary.cash.item!.holdReasons[0]!.label).toBe("신호 대기 중");
    expect(summary.cash.item!.holdReasons[0]!.count).toBe(2);
    expect(summary.cash.item!.holdReasons[1]!.label).toBe("스프레드 확대");
    expect(summary.cash.item!.holdReasons[1]!.count).toBe(1);
  });

  it("빈 projection은 NOT_FOUND summary를 반환한다", async () => {
    const { buildWhySummary } = await import("../../src/application/decision-ledger/why-summary.js");

    const summary = buildWhySummary(
      { markets: [], strategies: [], cashFrames: [] },
      "2026-06-06T04:00:00.000Z",
    );

    expect(summary.readStatus).toBe("NOT_FOUND");
    expect(summary.markets.readStatus).toBe("NOT_FOUND");
    expect(summary.markets.items).toHaveLength(0);
    expect(summary.strategies.readStatus).toBe("NOT_FOUND");
    expect(summary.strategies.items).toHaveLength(0);
    expect(summary.cash.readStatus).toBe("NOT_FOUND");
    expect(summary.cash.item).toBeNull();
  });

  it("일부 why section에 데이터가 있으면 최상위 readStatus를 OK로 유지한다", async () => {
    const { buildWhySummary } = await import("../../src/application/decision-ledger/why-summary.js");

    const summary = buildWhySummary(
      {
        markets: [
          {
            market: "KRW-BTC",
            category: "BUY",
            summaryStatus: "RECORDED",
            reasonCounts: {},
            latestDecisionAt: new Date("2026-06-06T00:00:00Z"),
            trace: {},
          },
        ],
        strategies: [
          {
            strategyId: "strategy.trend-following",
            category: "BUY",
            summaryStatus: "RECORDED",
            reasonCounts: {},
            latestDecisionAt: new Date("2026-06-06T00:00:00Z"),
            trace: {},
          },
        ],
        cashFrames: [],
      },
      "2026-06-06T04:00:00.000Z",
    );

    expect(summary.readStatus).toBe("OK");
    expect(summary.markets.readStatus).toBe("OK");
    expect(summary.strategies.readStatus).toBe("OK");
    expect(summary.cash.readStatus).toBe("NOT_FOUND");
  });

  it("cash hold reason count가 0인 항목은 제외한다", async () => {
    const { buildWhySummary } = await import("../../src/application/decision-ledger/why-summary.js");

    const summary = buildWhySummary(
      {
        markets: [],
        strategies: [],
        cashFrames: [
          {
            category: "CASH_HOLD",
            summaryStatus: "RECORDED",
            reasonCounts: { active_reason: 3, zero_reason: 0 },
            latestDecisionAt: new Date("2026-06-06T00:00:00Z"),
            trace: {},
          },
        ],
      },
      "2026-06-06T04:00:00.000Z",
    );

    expect(summary.cash.item).not.toBeNull();
    expect(summary.cash.item!.holdReasons).toHaveLength(1);
    expect(summary.cash.item!.holdReasons[0]!.label).toBe("active_reason");
    expect(summary.cash.item!.holdReasons[0]!.count).toBe(3);
  });
});
