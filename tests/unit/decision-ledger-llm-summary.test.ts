import { describe, it, expect, beforeAll } from "vitest";
import {
  DECISION_LEDGER_VERSION,
  type DecisionLedgerFrame,
  type DecisionEvidenceItem,
} from "../../src/application/decision-ledger.js";
import type {
  LlmRiskAssistantProviderPort,
  LlmRiskAssistantProviderRequest,
  LlmRiskAssistantProviderResponse,
  LlmRiskAssistantContractIssue,
} from "../../src/application/llm-risk-assistant/contracts.js";
import { createLlmProviderSuccess, createLlmProviderFailure } from "../../src/application/llm-risk-assistant/provider-normalization.js";

/**
 * Sub PR 04 LLM Boundary 테스트
 *
 * 결정론적 ledger evidence 기반 LLM 보조 summary가:
 * 1. noop provider로 외부 호출 없이 동작한다.
 * 2. provider failure 시 EXPLANATION_FAILURE evidence로 fail-closed 된다.
 * 3. LLM output에 매수/매도 추천이 포함되면 차단된다.
 * 4. LLM output에 목표가/포지션 크기가 포함되면 차단된다.
 * 5. LLM output이 지나치게 짧으면 거부된다.
 * 6. 성공 시 EXPLANATION_SUMMARY evidence가 생성된다.
 * 7. LLM failure가 결정론적 why summary를 막지 않는다 (fail-closed).
 */

const LLM_RISK_ASSISTANT_SCHEMA_VERSION = "m10.llm_risk_assistant.v1" as const;

/** EXPLANATION_SUMMARY evidence 생성을 위한 noop provider를 흉내내는 fake provider */
function createFakeSuccessProvider(summaryText: string): LlmRiskAssistantProviderPort {
  return {
    providerId: "noop" as const,
    async generate(request: LlmRiskAssistantProviderRequest): Promise<LlmRiskAssistantProviderResponse> {
      return createLlmProviderSuccess({
        providerId: "noop",
        completedAt: request.requested_at,
        result: {
          schema_version: LLM_RISK_ASSISTANT_SCHEMA_VERSION,
          result_type: request.result_type,
          source_ids: [request.input.source_id],
          summary: summaryText,
          recommended_action: "NO_ACTION",
          observed_at: request.input.observed_at,
          market: request.input.market,
          reason_codes: ["llm_summary_test"],
          requires_human_review: false,
        },
      });
    },
  };
}

/** EXPLANATION_FAILURE evidence 생성을 위한 fake failure provider */
function createFakeFailureProvider(
  reasonCode: string,
  message: string,
  failureClass: string = "provider_error",
): LlmRiskAssistantProviderPort {
  return {
    providerId: "noop" as const,
    async generate(_request: LlmRiskAssistantProviderRequest): Promise<LlmRiskAssistantProviderResponse> {
      return createLlmProviderFailure({
        providerId: "noop",
        failureClass: failureClass as LlmRiskAssistantProviderResponse extends { status: "failed"; failure_class: infer F } ? F : string,
        reasonCode,
        message,
        failedAt: new Date(),
      } as Parameters<typeof createLlmProviderFailure>[0]);
    },
  };
}

/** 테스트용 기본 frame fixture */
function createTestFrame(overrides: Partial<DecisionLedgerFrame> = {}): DecisionLedgerFrame {
  return {
    ledgerVersion: DECISION_LEDGER_VERSION,
    sourceRunId: "run-test-001",
    sourceFrameId: "frame-test-001",
    exchange: "UPBIT",
    market: "KRW-BTC",
    strategyId: "strategy.trend-following",
    category: "HOLD",
    summaryStatus: "RECORDED",
    observedAt: new Date("2026-06-06T00:00:00Z"),
    decisionAt: new Date("2026-06-06T00:00:01Z"),
    correlationId: "corr-test-001",
    reasonCounts: { insufficient_expected_return: 1 },
    dedupeKey: "test:upbit:krw-btc:trend-following:frame-test-001",
    trace: {},
    ...overrides,
  } as DecisionLedgerFrame;
}

/** 테스트용 evidence fixture 목록 */
function createTestEvidenceItems(): DecisionEvidenceItem[] {
  return [
    {
      evidenceKind: "STRATEGY_DECISION",
      category: "HOLD",
      reasonCode: "insufficient_expected_return",
      userMessage: "기대 수익이 비용을 충당하지 못해 진입을 보류했습니다.",
      impact: "현재 시장 조건에서는 매수보다 현금 보유가 유리합니다.",
      action: "기대 수익이 개선될 때까지 대기하세요.",
      occurredAt: new Date("2026-06-06T00:00:00Z"),
      source: "strategy.trend-following",
      sourceId: "strategy.trend-following",
      payload: { expectedReturnBps: "15", requiredReturnBps: "30", decision: "HOLD" },
      evidenceFingerprint: "fp-strategy-test-001",
      trace: { frameId: "frame-test-001" },
    },
    {
      evidenceKind: "COST_BREAKDOWN",
      category: "COST_REJECTED",
      reasonCode: "cost_margin_insufficient",
      userMessage: "비용이 기대 수익을 초과하여 주문 후보를 차단했습니다.",
      impact: "스프레드와 수수료를 고려한 순기대수익이 마진을 확보하지 못했습니다.",
      action: "시장 변동성과 스프레드 조건을 확인하세요.",
      occurredAt: new Date("2026-06-06T00:00:00Z"),
      source: "cost-model",
      sourceId: "cost-eval-test-001",
      payload: { requiredReturnBps: "30", totalCostBps: "27", marginBps: "3" },
      evidenceFingerprint: "fp-cost-test-001",
      trace: { frameId: "frame-test-001" },
    },
  ];
}

describe("generateLlmSummary", () => {
  let generateLlmSummary: typeof import("../../src/application/decision-ledger/llm-summary.js").generateLlmSummary;

  beforeAll(async () => {
    const mod = await import("../../src/application/decision-ledger/llm-summary.js");
    generateLlmSummary = mod.generateLlmSummary;
  });

  describe("성공 경로 — noop provider가 유효한 summary를 반환", () => {
    it("EXPLANATION_SUMMARY evidence를 생성한다", async () => {
      const provider = createFakeSuccessProvider(
        "현재 KRW-BTC 시장에서 기대 수익이 비용을 충당하지 못해 전략이 진입을 보류했습니다. " +
        "스프레드와 수수료를 고려한 순기대수익이 안전 마진을 확보하지 못한 상태입니다. " +
        "시장 변동성이 완화되고 스프레드가 축소될 때까지 현금 보유를 유지하는 것이 적절합니다.",
      );

      const result = await generateLlmSummary(provider, {
        frame: createTestFrame(),
        evidenceItems: createTestEvidenceItems(),
      });

      expect(result.status).toBe("success");
      if (result.status === "success") {
        expect(result.evidence.evidenceKind).toBe("EXPLANATION_SUMMARY");
        expect(result.evidence.category).toBe("HOLD");
        expect(result.evidence.reasonCode).toBe("llm_summary_generated");
        expect(result.evidence.userMessage).toContain("LLM 보조 설명");
        expect(result.evidence.source).toContain("llm-summary:noop");
        expect(result.evidence.payload).toHaveProperty("summary");
        expect(result.evidence.payload).toHaveProperty("providerId");
        expect(result.summaryText).toContain("보류");
        expect(result.summaryText.length).toBeGreaterThan(50);
      }
    });

    it("요약 결과에 한국어 상태 설명이 포함된다", async () => {
      const provider = createFakeSuccessProvider(
        "KRW-BTC 시장에서 trend-following 전략이 매수 신호를 생성했으나, " +
        "비용 평가 단계에서 수수료와 스프레드가 기대 수익을 초과하여 차단되었습니다.",
      );

      const result = await generateLlmSummary(provider, {
        frame: createTestFrame({ category: "COST_REJECTED" }),
        evidenceItems: createTestEvidenceItems(),
      });

      expect(result.status).toBe("success");
      if (result.status === "success") {
        expect(result.evidence.evidenceKind).toBe("EXPLANATION_SUMMARY");
        expect(result.summaryText).toContain("차단");
      }
    });
  });

  describe("fail-closed — provider 실패 시 EXPLANATION_FAILURE evidence", () => {
    it("provider failure 시 EXPLANATION_FAILURE evidence를 반환한다", async () => {
      const provider = createFakeFailureProvider(
        "llm_provider_timeout",
        "LLM provider 호출이 시간 초과되었습니다.",
        "timeout",
      );

      const result = await generateLlmSummary(provider, {
        frame: createTestFrame(),
        evidenceItems: createTestEvidenceItems(),
      });

      expect(result.status).toBe("failed");
      if (result.status === "failed") {
        expect(result.evidence.evidenceKind).toBe("EXPLANATION_FAILURE");
        expect(result.evidence.category).toBe("EXPLANATION_FAILED");
        expect(result.evidence.reasonCode).toBe("llm_provider_timeout");
        expect(result.evidence.userMessage).toContain("실패");
        expect(result.evidence.impact).toContain("결정론적 why summary는 정상 동작");
        expect(result.failureReason).toBe("llm_provider_timeout");
        expect(result.failureClass).toBe("timeout");
      }
    });

    it("provider_error failure도 EXPLANATION_FAILURE로 기록된다", async () => {
      const provider = createFakeFailureProvider(
        "provider_unavailable",
        "외부 LLM provider에 연결할 수 없습니다.",
        "provider_error",
      );

      const result = await generateLlmSummary(provider, {
        frame: createTestFrame(),
        evidenceItems: createTestEvidenceItems(),
      });

      expect(result.status).toBe("failed");
      if (result.status === "failed") {
        expect(result.evidence.evidenceKind).toBe("EXPLANATION_FAILURE");
        expect(result.evidence.category).toBe("EXPLANATION_FAILED");
        expect(result.failureClass).toBe("provider_error");
      }
    });

    it("invalid_json failure도 EXPLANATION_FAILURE로 기록된다", async () => {
      const provider = createFakeFailureProvider(
        "llm_provider_invalid_json",
        "LLM provider가 유효하지 않은 JSON을 반환했습니다.",
        "invalid_json",
      );

      const result = await generateLlmSummary(provider, {
        frame: createTestFrame(),
        evidenceItems: createTestEvidenceItems(),
      });

      expect(result.status).toBe("failed");
      if (result.status === "failed") {
        expect(result.evidence.reasonCode).toBe("llm_provider_invalid_json");
      }
    });

    it("provider가 예외를 던져도 EXPLANATION_FAILURE로 닫힌다", async () => {
      const provider: LlmRiskAssistantProviderPort = {
        providerId: "noop" as const,
        async generate(): Promise<LlmRiskAssistantProviderResponse> {
          throw new Error("provider crashed");
        },
      };

      const result = await generateLlmSummary(provider, {
        frame: createTestFrame(),
        evidenceItems: createTestEvidenceItems(),
      });

      expect(result.status).toBe("failed");
      if (result.status === "failed") {
        expect(result.evidence.evidenceKind).toBe("EXPLANATION_FAILURE");
        expect(result.evidence.category).toBe("EXPLANATION_FAILED");
        expect(result.evidence.reasonCode).toBe("llm_summary_provider_error");
        expect(result.failureClass).toBe("provider_error");
      }
    });
  });

  describe("fail-closed — order-like output 차단", () => {
    it("매수 추천 문구가 포함된 output은 차단된다", async () => {
      const provider = createFakeSuccessProvider(
        "현재 시장 상황이 좋습니다. 지금 매수하세요. KRW-BTC는 상승 추세에 있습니다.",
      );

      const result = await generateLlmSummary(provider, {
        frame: createTestFrame(),
        evidenceItems: createTestEvidenceItems(),
      });

      expect(result.status).toBe("failed");
      if (result.status === "failed") {
        expect(result.evidence.evidenceKind).toBe("EXPLANATION_FAILURE");
        expect(result.evidence.category).toBe("EXPLANATION_FAILED");
        expect(result.evidence.reasonCode).toBe("llm_summary_order_like_output_blocked");
        expect(result.evidence.userMessage).toContain("주문 지시");
        expect(result.failureClass).toBe("invalid_schema");
        expect(result.failureReason).toBe("llm_summary_order_like_output_blocked");
      }
    });

    it("매도 추천 문구가 포함된 output은 차단된다", async () => {
      const provider = createFakeSuccessProvider(
        "하락 추세가 예상되므로 지금 매도하는 것을 권장합니다.",
      );

      const result = await generateLlmSummary(provider, {
        frame: createTestFrame(),
        evidenceItems: createTestEvidenceItems(),
      });

      expect(result.status).toBe("failed");
      if (result.status === "failed") {
        expect(result.evidence.reasonCode).toBe("llm_summary_order_like_output_blocked");
      }
    });

    it("목표가가 포함된 output은 차단된다", async () => {
      const provider = createFakeSuccessProvider(
        "KRW-BTC의 적정 가격은 8,500만원으로 평가되며, 목표가: 90,000,000원에 도달할 것으로 예상됩니다.",
      );

      const result = await generateLlmSummary(provider, {
        frame: createTestFrame(),
        evidenceItems: createTestEvidenceItems(),
      });

      expect(result.status).toBe("failed");
      if (result.status === "failed") {
        expect(result.evidence.reasonCode).toBe("llm_summary_order_like_output_blocked");
      }
    });

    it("포지션 크기 제시가 포함된 output은 차단된다", async () => {
      const provider = createFakeSuccessProvider(
        "현재 포트폴리오에서 KRW-BTC 포지션 비중을 30%로 배분하는 것이 적절합니다.",
      );

      const result = await generateLlmSummary(provider, {
        frame: createTestFrame(),
        evidenceItems: createTestEvidenceItems(),
      });

      expect(result.status).toBe("failed");
      if (result.status === "failed") {
        expect(result.evidence.reasonCode).toBe("llm_summary_order_like_output_blocked");
      }
    });

    it("금액 지정 매매 추천이 포함된 output은 차단된다", async () => {
      const provider = createFakeSuccessProvider(
        "현재 가격에서 100,000원어치 BTC를 매수하는 것이 좋겠습니다.",
      );

      const result = await generateLlmSummary(provider, {
        frame: createTestFrame(),
        evidenceItems: createTestEvidenceItems(),
      });

      expect(result.status).toBe("failed");
      if (result.status === "failed") {
        expect(result.evidence.reasonCode).toBe("llm_summary_order_like_output_blocked");
      }
    });

    it("대문자 자산 단위 수량 지정 output도 소문자 변환 후 차단된다", async () => {
      const provider = createFakeSuccessProvider(
        "현재 판단 근거는 보류에 가깝지만, 단기 대응으로 0.1 BTC 매수를 실행하면 됩니다.",
      );

      const result = await generateLlmSummary(provider, {
        frame: createTestFrame(),
        evidenceItems: createTestEvidenceItems(),
      });

      expect(result.status).toBe("failed");
      if (result.status === "failed") {
        expect(result.evidence.reasonCode).toBe("llm_summary_order_like_output_blocked");
        expect(result.evidence.payload).toMatchObject({
          blockedReason: "금액 지정 매매 추천",
        });
      }
    });

    it("수익 보장 표현이 포함된 output은 차단된다", async () => {
      const provider = createFakeSuccessProvider(
        "이 전략을 따르면 확실한 수익을 얻을 수 있으며 손실은 나지 않습니다.",
      );

      const result = await generateLlmSummary(provider, {
        frame: createTestFrame(),
        evidenceItems: createTestEvidenceItems(),
      });

      expect(result.status).toBe("failed");
      if (result.status === "failed") {
        expect(result.evidence.reasonCode).toBe("llm_summary_order_like_output_blocked");
      }
    });
  });

  describe("fail-closed — output 길이 검증", () => {
    it("10자 미만의 지나치게 짧은 output은 거부된다", async () => {
      const provider = createFakeSuccessProvider("보류.");

      const result = await generateLlmSummary(provider, {
        frame: createTestFrame(),
        evidenceItems: createTestEvidenceItems(),
      });

      expect(result.status).toBe("failed");
      if (result.status === "failed") {
        expect(result.evidence.reasonCode).toBe("llm_summary_too_short");
        expect(result.failureClass).toBe("output_too_large");
      }
    });

    it("공백만 있는 output도 거부된다", async () => {
      const provider = createFakeSuccessProvider("   ");

      const result = await generateLlmSummary(provider, {
        frame: createTestFrame(),
        evidenceItems: createTestEvidenceItems(),
      });

      expect(result.status).toBe("failed");
      if (result.status === "failed") {
        expect(result.evidence.reasonCode).toBe("llm_summary_too_short");
      }
    });
  });

  describe("결정론적 summary 독립성 (fail-closed invariant)", () => {
    it("LLM failure가 결정론적 frame 정보를 변경하지 않는다", async () => {
      const frame = createTestFrame();
      const evidenceItems = createTestEvidenceItems();
      const frameCopy = structuredClone(frame);
      const evidenceCopy = structuredClone(evidenceItems);

      const provider = createFakeFailureProvider(
        "provider_error",
        "Provider unavailable",
        "provider_error",
      );

      const result = await generateLlmSummary(provider, { frame, evidenceItems });

      // LLM failure가 발생해도 원본 frame과 evidence는 변경되지 않아야 한다.
      expect(result.status).toBe("failed");
      expect(frame).toEqual(frameCopy);
      expect(evidenceItems).toEqual(evidenceCopy);
    });

    it("order-like output 차단도 결정론적 frame 정보를 변경하지 않는다", async () => {
      const frame = createTestFrame();
      const evidenceItems = createTestEvidenceItems();
      const frameCopy = structuredClone(frame);
      const evidenceCopy = structuredClone(evidenceItems);

      const provider = createFakeSuccessProvider("지금 매수하세요! 상승이 확실합니다.");

      const result = await generateLlmSummary(provider, { frame, evidenceItems });

      expect(result.status).toBe("failed");
      expect(frame).toEqual(frameCopy);
      expect(evidenceItems).toEqual(evidenceCopy);
    });
  });

  describe("prompt 구성", () => {
    it("frame과 evidence 정보가 prompt에 포함된다", async () => {
      let capturedPrompt = "";

      const captureProvider: LlmRiskAssistantProviderPort = {
        providerId: "noop" as const,
        async generate(request: LlmRiskAssistantProviderRequest): Promise<LlmRiskAssistantProviderResponse> {
          capturedPrompt = request.prompt;
          return createLlmProviderSuccess({
            providerId: "noop",
            completedAt: request.requested_at,
            result: {
              schema_version: LLM_RISK_ASSISTANT_SCHEMA_VERSION,
              result_type: request.result_type,
              source_ids: [request.input.source_id],
              summary: "KRW-BTC에서 기대 수익이 비용을 하회하여 trend-following 전략이 진입을 보류했습니다. 스프레드와 수수료를 고려한 순기대수익이 마진을 확보하지 못한 상태입니다.",
              recommended_action: "NO_ACTION",
              observed_at: request.input.observed_at,
              reason_codes: ["llm_summary_test"],
              requires_human_review: false,
            },
          });
        },
      };

      await generateLlmSummary(captureProvider, {
        frame: createTestFrame(),
        evidenceItems: createTestEvidenceItems(),
      });

      // prompt에 핵심 정보가 포함되어야 한다.
      expect(capturedPrompt).toContain("HOLD");
      expect(capturedPrompt).toContain("KRW-BTC");
      expect(capturedPrompt).toContain("strategy.trend-following");
      expect(capturedPrompt).toContain("전략 판단");
      expect(capturedPrompt).toContain("비용 평가");
      expect(capturedPrompt).toContain("기대 수익");
      expect(capturedPrompt).toContain("매수/매도 추천은 절대 하지 마세요");
    });

    it("LLM 설명 evidence는 prompt 입력에서 제외된다", async () => {
      let capturedPrompt = "";
      let capturedMetadata: LlmRiskAssistantProviderRequest["input"]["metadata"];

      const captureProvider: LlmRiskAssistantProviderPort = {
        providerId: "noop" as const,
        async generate(request: LlmRiskAssistantProviderRequest): Promise<LlmRiskAssistantProviderResponse> {
          capturedPrompt = request.prompt;
          capturedMetadata = request.input.metadata;
          return createLlmProviderSuccess({
            providerId: "noop",
            completedAt: request.requested_at,
            result: {
              schema_version: LLM_RISK_ASSISTANT_SCHEMA_VERSION,
              result_type: request.result_type,
              source_ids: [request.input.source_id],
              summary: "KRW-BTC에서 비용 평가와 전략 판단 근거를 기준으로 진입을 보류했습니다. LLM 보조 산출물은 판단 근거로 재사용하지 않았습니다.",
              recommended_action: "NO_ACTION",
              observed_at: request.input.observed_at,
              reason_codes: ["llm_summary_test"],
              requires_human_review: false,
            },
          });
        },
      };

      const explanationEvidenceItems: DecisionEvidenceItem[] = [
        {
          evidenceKind: "EXPLANATION_SUMMARY",
          category: "HOLD",
          reasonCode: "llm_summary_generated",
          userMessage: "이전 LLM 보조 설명입니다.",
          impact: null,
          action: null,
          occurredAt: new Date("2026-06-06T00:00:02Z"),
          source: "llm-summary:noop",
          sourceId: "noop",
          payload: { summary: "이전 LLM 요약" },
          evidenceFingerprint: "fp-llm-summary-existing",
          trace: { frameId: "frame-test-001" },
        },
        {
          evidenceKind: "EXPLANATION_FAILURE",
          category: "EXPLANATION_FAILED",
          reasonCode: "llm_summary_provider_error",
          userMessage: "이전 LLM provider 실패입니다.",
          impact: "결정론적 why summary는 정상 동작합니다.",
          action: "LLM provider 상태를 확인하세요.",
          occurredAt: new Date("2026-06-06T00:00:03Z"),
          source: "llm-summary",
          sourceId: null,
          payload: { failureClass: "provider_error" },
          evidenceFingerprint: "fp-llm-fail-existing",
          trace: { frameId: "frame-test-001" },
        },
      ];

      await generateLlmSummary(captureProvider, {
        frame: createTestFrame(),
        evidenceItems: [
          ...createTestEvidenceItems(),
          ...explanationEvidenceItems,
        ],
      });

      // LLM 보조 evidence가 다음 prompt에 들어가면 설명 실패/요약이 결정 근거처럼 순환한다.
      expect(capturedPrompt).toContain("전략 판단");
      expect(capturedPrompt).toContain("비용 평가");
      expect(capturedPrompt).not.toContain("설명 요약");
      expect(capturedPrompt).not.toContain("설명 실패");
      expect(capturedPrompt).not.toContain("이전 LLM");
      expect(capturedPrompt).not.toContain("llm_summary_provider_error");
      expect(capturedMetadata).toMatchObject({
        evidence_count: 2,
      });
    });
  });

  describe("evidence fingerprint", () => {
    it("성공 evidence에 유효한 fingerprint가 포함된다", async () => {
      const provider = createFakeSuccessProvider(
        "KRW-BTC에서 기대 수익이 비용을 하회하여 진입을 보류했습니다.",
      );

      const result = await generateLlmSummary(provider, {
        frame: createTestFrame(),
        evidenceItems: createTestEvidenceItems(),
      });

      expect(result.status).toBe("success");
      if (result.status === "success") {
        expect(result.evidence.evidenceFingerprint).toMatch(/^fp-llm-summary:/);
        expect(result.evidence.evidenceFingerprint.length).toBeGreaterThan(20);
      }
    });

    it("실패 evidence에 유효한 fingerprint가 포함된다", async () => {
      const provider = createFakeFailureProvider(
        "timeout",
        "Request timed out",
        "timeout",
      );

      const result = await generateLlmSummary(provider, {
        frame: createTestFrame(),
        evidenceItems: createTestEvidenceItems(),
      });

      expect(result.status).toBe("failed");
      if (result.status === "failed") {
        expect(result.evidence.evidenceFingerprint).toMatch(/^fp-llm-fail:/);
        expect(result.evidence.evidenceFingerprint.length).toBeGreaterThan(20);
      }
    });
  });

  describe("category invariant", () => {
    it("EXPLANATION_SUMMARY evidence category는 주문 판단을 대체하지 않는다 (HOLD)", async () => {
      const provider = createFakeSuccessProvider(
        "매수 신호가 있었지만 비용 평가를 통과하지 못해 진입하지 않았습니다.",
      );

      const result = await generateLlmSummary(provider, {
        frame: createTestFrame({ category: "COST_REJECTED" }),
        evidenceItems: createTestEvidenceItems(),
      });

      expect(result.status).toBe("success");
      if (result.status === "failed") {
        // 실패한 경우에도 EXPLANATION_FAILED + EXPLANATION_FAILURE 조합
        expect(result.evidence.category).toBe("EXPLANATION_FAILED");
      } else {
        // 성공 시 category는 HOLD (판단을 대체하지 않음)
        expect(result.evidence.category).toBe("HOLD");
      }
    });

    it("EXPLANATION_FAILURE evidence는 EXPLANATION_FAILED category를 가진다", async () => {
      const provider = createFakeFailureProvider(
        "timeout",
        "Request timed out",
        "timeout",
      );

      const result = await generateLlmSummary(provider, {
        frame: createTestFrame(),
        evidenceItems: createTestEvidenceItems(),
      });

      expect(result.status).toBe("failed");
      if (result.status === "failed") {
        expect(result.evidence.evidenceKind).toBe("EXPLANATION_FAILURE");
        expect(result.evidence.category).toBe("EXPLANATION_FAILED");
      }
    });
  });
});
