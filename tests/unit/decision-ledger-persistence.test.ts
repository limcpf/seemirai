import { describe, it, expect } from "vitest";
import {
  createDecisionLedgerWriterPort,
  DecisionLedgerPersistenceValidationError,
  toDecisionLedgerFrameRowInput,
  toDecisionLedgerEvidenceRowInput,
} from "../../src/infrastructure/db/decision-ledger.js";
import type {
  AppendDecisionLedgerEvidenceResult,
  AppendDecisionLedgerFrameResult,
  AppendDecisionLedgerFrameWithEvidenceResult,
} from "../../src/infrastructure/db/decision-ledger.js";
import type {
  DecisionLedgerFrame,
  DecisionEvidenceItem,
} from "../../src/application/decision-ledger.js";
import { DECISION_LEDGER_VERSION } from "../../src/application/decision-ledger.js";

describe("decision-ledger runner writer port adapter", () => {
  it("repository durable record id를 runner writer durableFrameId로 변환한다", async () => {
    const frame: DecisionLedgerFrame = {
      ledgerVersion: DECISION_LEDGER_VERSION,
      sourceRunId: "run-writer-adapter",
      sourceFrameId: "frame-writer-adapter",
      exchange: "UPBIT",
      market: "KRW-BTC",
      strategyId: "strategy.adapter",
      category: "HOLD",
      summaryStatus: "RECORDED",
      observedAt: new Date("2026-06-06T00:00:00Z"),
      decisionAt: new Date("2026-06-06T00:00:01Z"),
      correlationId: null,
      reasonCounts: { adapter_hold: 1 },
      dedupeKey: "UPBIT:run-writer-adapter:frame:frame-writer-adapter:strategy:strategy.adapter",
      trace: {
        correlationUnavailableReason: "주문 후보 0건",
      },
    };
    const evidence: DecisionEvidenceItem = {
      evidenceKind: "STRATEGY_DECISION",
      category: "HOLD",
      reasonCode: "adapter_hold",
      userMessage: "전략이 대기를 선택했습니다.",
      impact: null,
      action: null,
      occurredAt: new Date("2026-06-06T00:00:00Z"),
      source: "strategy.adapter",
      sourceId: "strategy.adapter",
      payload: { stage: "STRATEGY_DECISION" },
      evidenceFingerprint: "fp-adapter-hold",
      trace: { strategyId: "strategy.adapter" },
    };
    const frameWithEvidenceInputs: Array<{
      frame: DecisionLedgerFrame;
      evidenceItems: readonly { readonly item: DecisionEvidenceItem }[];
    }> = [];
    const writer = createDecisionLedgerWriterPort({
      async appendFrame(input): Promise<AppendDecisionLedgerFrameResult> {
        return {
          inserted: false,
          record: { id: "db-frame-adapter" } as AppendDecisionLedgerFrameResult["record"],
        };
      },
      async appendEvidenceItems(frameId, items): Promise<AppendDecisionLedgerEvidenceResult> {
        return {
          inserted: 0,
          skipped: 1,
          records: [],
        };
      },
      async appendFrameWithEvidence(input): Promise<AppendDecisionLedgerFrameWithEvidenceResult> {
        frameWithEvidenceInputs.push(input);
        return {
          frame: {
            inserted: false,
            record: { id: "db-frame-adapter" } as AppendDecisionLedgerFrameResult["record"],
          },
          evidence: {
            inserted: 0,
            skipped: 1,
            records: [],
          },
        };
      },
    });

    const result = await writer.appendFrameWithEvidence(frame, [evidence]);

    expect(frameWithEvidenceInputs).toEqual([
      {
        frame,
        evidenceItems: [{ item: evidence }],
      },
    ]);
    expect(result).toEqual({
      frame: { inserted: false, durableFrameId: "db-frame-adapter" },
      evidence: { inserted: 0, skipped: 1 },
    });
  });
});

describe("decision-ledger row mapper", () => {
  /**
   * toDecisionLedgerFrameRowInput이 domain DecisionLedgerFrame을
   * DB insert row로 올바르게 변환하는지 검증한다.
   */
  describe("toDecisionLedgerFrameRowInput", () => {
    it("기본 market/strategy frame을 DB row로 변환한다", () => {
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

      const row = toDecisionLedgerFrameRowInput(frame);

      expect(row.ledger_version).toBe(DECISION_LEDGER_VERSION);
      expect(row.source_run_id).toBe("run-2026-06-06-001");
      expect(row.source_frame_id).toBe("frame-abc-123");
      expect(row.exchange).toBe("UPBIT");
      expect(row.market).toBe("KRW-BTC");
      expect(row.strategy_id).toBe("strategy.mean-reversion");
      expect(row.category).toBe("HOLD");
      expect(row.summary_status).toBe("RECORDED");
      expect(row.observed_at).toEqual(new Date("2026-06-06T00:00:00Z"));
      expect(row.decision_at).toEqual(new Date("2026-06-06T00:00:01Z"));
      expect(row.correlation_id).toBe("corr-xyz-789");
      expect(row.dedupe_key).toBe("upbit:krw-btc:strategy.mean-reversion:frame-abc-123");
      expect(row.reason_counts_json).toEqual({ insufficient_expected_return: 1, wide_spread: 0 });
      expect(row.trace_json).toEqual({
        sourceTable: "decision_ledger_frames",
        correlationId: "corr-xyz-789",
      });
      // summary_json은 빈 객체로 시작
      expect(row.summary_json).toEqual({});
    });

    it("market과 strategyId가 null인 cash/global frame을 DB row로 변환한다", () => {
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

      const row = toDecisionLedgerFrameRowInput(frame);

      expect(row.source_run_id).toBeNull();
      expect(row.market).toBeNull();
      expect(row.strategy_id).toBeNull();
      expect(row.correlation_id).toBeNull();
      expect(row.category).toBe("CASH_HOLD");
      expect(row.reason_counts_json).toEqual({ all_strategies_hold: 2 });
      expect(row.trace_json).toHaveProperty("sourceRunUnavailableReason");
      expect(row.trace_json).toHaveProperty("correlationUnavailableReason");
    });

    it("reasonCounts가 빈 객체여도 DB row 변환이 성공한다", () => {
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

      const row = toDecisionLedgerFrameRowInput(frame);

      expect(row.reason_counts_json).toEqual({});
      expect(row.trace_json).toEqual({});
    });

    it("sourceRunId와 correlationId가 null인데 trace 사유가 없으면 변환을 거부한다", () => {
      const frame = {
        ledgerVersion: DECISION_LEDGER_VERSION,
        sourceRunId: null,
        sourceFrameId: "frame-invalid-null-trace",
        exchange: "UPBIT",
        market: null,
        strategyId: null,
        category: "CASH_HOLD",
        summaryStatus: "RECORDED",
        observedAt: new Date("2026-06-06T01:00:00Z"),
        decisionAt: new Date("2026-06-06T01:00:01Z"),
        correlationId: null,
        reasonCounts: { all_strategies_hold: 1 },
        dedupeKey: "upbit::cash:frame-invalid-null-trace",
        trace: {},
      } as unknown as DecisionLedgerFrame;

      expect(() => toDecisionLedgerFrameRowInput(frame)).toThrow(
        DecisionLedgerPersistenceValidationError,
      );
    });

    it("sourceRunId와 correlationId가 undefined이면 null 사유 contract 우회를 거부한다", () => {
      const frame = {
        ledgerVersion: DECISION_LEDGER_VERSION,
        sourceFrameId: "frame-invalid-undefined-identifiers",
        exchange: "UPBIT",
        market: null,
        strategyId: null,
        category: "CASH_HOLD",
        summaryStatus: "RECORDED",
        observedAt: new Date("2026-06-06T01:00:00Z"),
        decisionAt: new Date("2026-06-06T01:00:01Z"),
        reasonCounts: { all_strategies_hold: 1 },
        dedupeKey: "upbit::cash:frame-invalid-undefined-identifiers",
        trace: {
          sourceRunUnavailableReason: "runtime 실행 단위 식별자가 없는 테스트 frame입니다.",
          correlationUnavailableReason: "주문 후보 0건 frame이라 correlation id가 없습니다.",
        },
      } as unknown as DecisionLedgerFrame;

      expect(() => toDecisionLedgerFrameRowInput(frame)).toThrow(
        DecisionLedgerPersistenceValidationError,
      );
    });

    it("frame category에 EXPLANATION_FAILED가 들어오면 변환을 거부한다", () => {
      const frame = {
        ledgerVersion: DECISION_LEDGER_VERSION,
        sourceRunId: "run-001",
        sourceFrameId: "frame-invalid-category",
        exchange: "UPBIT",
        market: "KRW-BTC",
        strategyId: "strategy.mean-reversion",
        category: "EXPLANATION_FAILED",
        summaryStatus: "RECORDED",
        observedAt: new Date("2026-06-06T01:00:00Z"),
        decisionAt: new Date("2026-06-06T01:00:01Z"),
        correlationId: "corr-invalid-category",
        reasonCounts: {},
        dedupeKey: "upbit:krw-btc:invalid-category",
        trace: {},
      } as unknown as DecisionLedgerFrame;

      expect(() => toDecisionLedgerFrameRowInput(frame)).toThrow(
        DecisionLedgerPersistenceValidationError,
      );
    });
  });

  /**
   * toDecisionLedgerEvidenceRowInput이 domain DecisionEvidenceItem을
   * DB insert row로 올바르게 변환하는지 검증한다.
   */
  describe("toDecisionLedgerEvidenceRowInput", () => {
    const frameId = "550e8400-e29b-41d4-a716-446655440000";

    it("STRATEGY_DECISION evidence를 DB row로 변환한다", () => {
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
        trace: { strategyId: "strategy.mean-reversion" },
      };

      const row = toDecisionLedgerEvidenceRowInput(frameId, item);

      expect(row.frame_id).toBe(frameId);
      expect(row.evidence_kind).toBe("STRATEGY_DECISION");
      expect(row.category).toBe("HOLD");
      expect(row.reason_code).toBe("insufficient_expected_return");
      expect(row.user_message).toContain("보류");
      expect(row.impact).toContain("현금 보유");
      expect(row.action).toContain("대기");
      expect(row.source).toBe("strategy.mean-reversion");
      expect(row.source_id).toBe("strategy.mean-reversion");
      expect(row.evidence_fingerprint).toBe("fp-strategy-abc-123");
      expect(row.payload_json).toEqual({
        expectedReturnBps: "15",
        requiredReturnBps: "30",
        decision: "HOLD",
      });
    });

    it("EXPLANATION_FAILURE evidence를 DB row로 변환한다", () => {
      const item: DecisionEvidenceItem = {
        evidenceKind: "EXPLANATION_FAILURE",
        category: "EXPLANATION_FAILED",
        reasonCode: "llm_timeout",
        userMessage: "LLM 설명 생성이 시간 초과로 실패했습니다.",
        impact: "자동 설명이 생성되지 않았습니다.",
        action: "LLM provider 상태를 확인하세요.",
        occurredAt: new Date("2026-06-06T03:00:00Z"),
        source: "llm-summary",
        sourceId: null,
        payload: { provider: "codex_oauth", timeoutMs: 30000 },
        evidenceFingerprint: "fp-llm-fail-001",
        trace: {},
      };

      const row = toDecisionLedgerEvidenceRowInput(frameId, item);

      expect(row.evidence_kind).toBe("EXPLANATION_FAILURE");
      expect(row.category).toBe("EXPLANATION_FAILED");
      expect(row.source_id).toBeNull();
      expect(row.reason_code).toBe("llm_timeout");
      expect(row.payload_json).toEqual({ provider: "codex_oauth", timeoutMs: 30000 });
    });

    it("impact와 action이 null인 evidence도 DB row 변환이 성공한다", () => {
      const item: DecisionEvidenceItem = {
        evidenceKind: "ORDER_INTENT",
        category: "BUY",
        reasonCode: null,
        userMessage: "매수 주문 후보가 생성되었습니다.",
        impact: null,
        action: null,
        occurredAt: new Date(),
        source: "order-intent",
        sourceId: "intent-001",
        payload: { side: "buy", notionalKrw: "100000" },
        evidenceFingerprint: "fp-intent-001",
        trace: {},
      };

      const row = toDecisionLedgerEvidenceRowInput(frameId, item);

      expect(row.impact).toBeNull();
      expect(row.action).toBeNull();
      expect(row.reason_code).toBeNull();
    });

    it("payload와 trace는 JSON-safe 값만 허용한다 (Date, function 없음)", () => {
      const item: DecisionEvidenceItem = {
        evidenceKind: "COST_BREAKDOWN",
        category: "COST_REJECTED",
        reasonCode: "insufficient_expected_return",
        userMessage: "비용이 기대 수익을 초과하여 차단했습니다.",
        impact: null,
        action: null,
        occurredAt: new Date(),
        source: "cost-model",
        sourceId: "cost-001",
        payload: {
          requiredReturnBps: "30",
          rejected: true,
          components: [{ name: "spread", bps: "12" }],
        },
        evidenceFingerprint: "fp-cost-001",
        trace: { frameId: "frame-001", attempts: 1 },
      };

      const row = toDecisionLedgerEvidenceRowInput(frameId, item);

      expect(row.payload_json).toEqual({
        requiredReturnBps: "30",
        rejected: true,
        components: [{ name: "spread", bps: "12" }],
      });
      expect(row.trace_json).toEqual({ frameId: "frame-001", attempts: 1 });

      // payload와 trace가 object 형태인지 확인
      expect(typeof row.payload_json).toBe("object");
      expect(typeof row.trace_json).toBe("object");
      // Date나 function이 아닌지 확인
      expect(row.payload_json).not.toBeInstanceOf(Date);
      expect(typeof row.trace_json).not.toBe("function");
    });

    it("payload에 Date가 들어오면 DB row 변환을 거부한다", () => {
      const item = {
        evidenceKind: "COST_BREAKDOWN",
        category: "COST_REJECTED",
        reasonCode: "insufficient_expected_return",
        userMessage: "비용이 기대 수익을 초과하여 차단했습니다.",
        impact: null,
        action: null,
        occurredAt: new Date("2026-06-06T04:00:00Z"),
        source: "cost-model",
        sourceId: "cost-001",
        payload: { observedAt: new Date("2026-06-06T04:00:00Z") },
        evidenceFingerprint: "fp-invalid-date-payload",
        trace: {},
      } as unknown as DecisionEvidenceItem;

      expect(() => toDecisionLedgerEvidenceRowInput(frameId, item)).toThrow(
        DecisionLedgerPersistenceValidationError,
      );
    });

    it("payload와 trace의 secret/raw payload 후보 key를 거부한다", () => {
      const item = {
        evidenceKind: "RISK_DECISION",
        category: "RISK_REJECTED",
        reasonCode: "risk_block",
        userMessage: "리스크 한도 초과로 주문을 차단했습니다.",
        impact: null,
        action: null,
        occurredAt: new Date("2026-06-06T04:00:00Z"),
        source: "risk-gate",
        sourceId: "risk-001",
        payload: { rawProviderPayload: { status: "failed" } },
        evidenceFingerprint: "fp-invalid-secret-key",
        trace: { authorization: "redacted" },
      } as unknown as DecisionEvidenceItem;

      expect(() => toDecisionLedgerEvidenceRowInput(frameId, item)).toThrow(
        DecisionLedgerPersistenceValidationError,
      );
    });

    it("사용자-facing 문구와 출처 문자열의 secret 후보를 거부한다", () => {
      const itemWithSecretMessage = {
        evidenceKind: "RISK_DECISION",
        category: "RISK_REJECTED",
        reasonCode: "risk_block",
        userMessage: "Authorization: Bearer dummySecretToken1234567890",
        impact: null,
        action: null,
        occurredAt: new Date("2026-06-06T04:00:00Z"),
        source: "risk-gate",
        sourceId: "risk-001",
        payload: {},
        evidenceFingerprint: "fp-invalid-secret-message",
        trace: {},
      } as unknown as DecisionEvidenceItem;
      const itemWithSecretSource = {
        ...itemWithSecretMessage,
        userMessage: "리스크 한도 초과로 주문을 차단했습니다.",
        source: "risk-gate?token=dummySecretToken1234567890",
        evidenceFingerprint: "fp-invalid-secret-source",
      } as unknown as DecisionEvidenceItem;

      expect(() => toDecisionLedgerEvidenceRowInput(frameId, itemWithSecretMessage)).toThrow(
        DecisionLedgerPersistenceValidationError,
      );
      expect(() => toDecisionLedgerEvidenceRowInput(frameId, itemWithSecretSource)).toThrow(
        DecisionLedgerPersistenceValidationError,
      );
    });

    it("secret 후보 key를 거부할 때 오류 메시지에 key 원문을 남기지 않는다", () => {
      const secretLikeKey = "token_actual_secret_value_1234567890";
      const item = {
        evidenceKind: "RISK_DECISION",
        category: "RISK_REJECTED",
        reasonCode: "risk_block",
        userMessage: "리스크 한도 초과로 주문을 차단했습니다.",
        impact: null,
        action: null,
        occurredAt: new Date("2026-06-06T04:00:00Z"),
        source: "risk-gate",
        sourceId: "risk-001",
        payload: { [secretLikeKey]: "redacted" },
        evidenceFingerprint: "fp-invalid-secret-key-redacted",
        trace: {},
      } as unknown as DecisionEvidenceItem;

      expect(() => toDecisionLedgerEvidenceRowInput(frameId, item)).toThrow(
        DecisionLedgerPersistenceValidationError,
      );
      try {
        toDecisionLedgerEvidenceRowInput(frameId, item);
      } catch (error) {
        expect((error as Error).message).toContain("[redacted_key]");
        expect((error as Error).message).not.toContain(secretLikeKey);
      }
    });

    it("EXPLANATION_FAILURE와 EXPLANATION_FAILED 전용 조합을 런타임에도 강제한다", () => {
      const item = {
        evidenceKind: "RISK_DECISION",
        category: "EXPLANATION_FAILED",
        reasonCode: "llm_timeout",
        userMessage: "설명 생성 실패를 리스크 evidence로 저장하려 했습니다.",
        impact: null,
        action: null,
        occurredAt: new Date("2026-06-06T04:00:00Z"),
        source: "risk-gate",
        sourceId: null,
        payload: {},
        evidenceFingerprint: "fp-invalid-explanation-combo",
        trace: {},
      } as unknown as DecisionEvidenceItem;

      expect(() => toDecisionLedgerEvidenceRowInput(frameId, item)).toThrow(
        DecisionLedgerPersistenceValidationError,
      );
    });
  });
});
