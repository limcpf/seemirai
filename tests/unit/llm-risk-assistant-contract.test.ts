import { describe, expect, it } from "vitest";
import {
  LLM_RISK_ASSISTANT_SCHEMA_VERSION,
  LlmRiskAssistantContractError,
  isForbiddenLlmTradeAction,
  parseLlmRiskAssistantInput,
  parseLlmRiskAssistantResult,
} from "../../src/application/index.js";

const observedAt = "2026-05-23T00:00:00.000Z";

describe("M10 LLM risk assistant contract", () => {
  it("accepts only official input sources before prompt creation", () => {
    expect(
      parseLlmRiskAssistantInput({
        source: "exchange_notice",
        source_id: "upbit-notice-2026-05-23-maintenance",
        observed_at: observedAt,
        market: "KRW-BTC",
        notice_url: "https://upbit.com/service_center/notice?id=1",
        title: "Upbit 점검 공지",
        content: "KRW-BTC 마켓 점검 공지 본문",
      }),
    ).toMatchObject({
      source: "exchange_notice",
      source_id: "upbit-notice-2026-05-23-maintenance",
    });

    expect(() =>
      parseLlmRiskAssistantInput({
        source: "general_news",
        source_id: "news-1",
        observed_at: observedAt,
        content: "비공식 뉴스 본문",
      }),
    ).toThrow(LlmRiskAssistantContractError);
  });

  it("accepts live ops briefing snapshot input and draft result only as auxiliary output", () => {
    expect(
      parseLlmRiskAssistantInput({
        source: "live_ops_status_snapshot",
        source_id: "live-ops-status-snapshot-2026-05-23T00:00:00.000Z",
        observed_at: observedAt,
        title: "Live Ops 브리핑 snapshot",
        content: "Live Ops 브리핑 deterministic snapshot",
        metadata: {
          source_ids: ["live_ops_status_summary", "decision_ledger_why_summary"],
        },
      }),
    ).toMatchObject({
      source: "live_ops_status_snapshot",
    });

    expect(
      parseLlmRiskAssistantResult({
        schema_version: LLM_RISK_ASSISTANT_SCHEMA_VERSION,
        result_type: "live_ops_briefing_draft",
        source_ids: ["live-ops-status-snapshot-2026-05-23T00:00:00.000Z"],
        summary: "현재 daemon은 작동 중이며 신규 진입은 차단 상태입니다.",
        recommended_action: "ALERT_ONLY",
        observed_at: observedAt,
        reason_codes: ["live_ops_briefing:operator_summary"],
        requires_human_review: true,
      }),
    ).toMatchObject({
      result_type: "live_ops_briefing_draft",
      recommended_action: "ALERT_ONLY",
    });
  });

  it("accepts only auxiliary result types and safe actions", () => {
    expect(
      parseLlmRiskAssistantResult({
        schema_version: LLM_RISK_ASSISTANT_SCHEMA_VERSION,
        result_type: "notice_risk_classification",
        source_ids: ["upbit-notice-2026-05-23-maintenance"],
        summary: "점검 중 신규 진입을 막아야 하는 공지입니다.",
        recommended_action: "BLOCK_NEW_ENTRY",
        observed_at: observedAt,
        market: "KRW-BTC",
        reason_codes: ["exchange_notice:maintenance"],
        requires_human_review: true,
        evidence: ["Upbit 공식 공지에 점검 시간이 포함되어 있습니다."],
      }),
    ).toMatchObject({
      result_type: "notice_risk_classification",
      recommended_action: "BLOCK_NEW_ENTRY",
    });

    expect(() =>
      parseLlmRiskAssistantResult({
        schema_version: LLM_RISK_ASSISTANT_SCHEMA_VERSION,
        result_type: "trade_recommendation",
        source_ids: ["upbit-notice-1"],
        summary: "허용되지 않는 결과 타입",
        recommended_action: "ALERT_ONLY",
        observed_at: observedAt,
      }),
    ).toThrow(LlmRiskAssistantContractError);
  });

  it.each(["BUY", "SELL", "INCREASE_POSITION"])(
    "rejects forbidden trade action %s without normalization",
    (recommendedAction) => {
      expect(isForbiddenLlmTradeAction(recommendedAction)).toBe(true);

      expect(() =>
        parseLlmRiskAssistantResult({
          schema_version: LLM_RISK_ASSISTANT_SCHEMA_VERSION,
          result_type: "notice_risk_classification",
          source_ids: ["upbit-notice-1"],
          summary: "거래 지시는 LLM 결과로 허용하지 않습니다.",
          recommended_action: recommendedAction,
          observed_at: observedAt,
        }),
      ).toThrow(LlmRiskAssistantContractError);
    },
  );

  it("rejects order-like fields that could be mistaken for strategy output", () => {
    expect(() =>
      parseLlmRiskAssistantResult({
        schema_version: LLM_RISK_ASSISTANT_SCHEMA_VERSION,
        result_type: "event_explanation",
        source_ids: ["upbit-market-event-1"],
        summary: "시장 이벤트 설명",
        recommended_action: "ALERT_ONLY",
        observed_at: observedAt,
        target_price: "100000000",
        position_size: "0.1",
      }),
    ).toThrow(LlmRiskAssistantContractError);

    expect(isForbiddenLlmTradeAction("BLOCK_NEW_ENTRY")).toBe(false);
  });

  it("rejects briefing draft text that contains direct trade advice or price/quantity targets", () => {
    expect(() =>
      parseLlmRiskAssistantResult({
        schema_version: LLM_RISK_ASSISTANT_SCHEMA_VERSION,
        result_type: "live_ops_briefing_draft",
        source_ids: ["live-ops-status-snapshot-1"],
        summary: "지금 KRW-BTC를 매수하세요. 목표가 100000000원, 주문 수량 0.1 BTC입니다.",
        recommended_action: "ALERT_ONLY",
        observed_at: observedAt,
      }),
    ).toThrow(LlmRiskAssistantContractError);
  });

  it.each([
    {
      summary: "KRW-BTC 매수를 추천합니다.",
      reason: "조사가 붙은 매수 추천",
    },
    {
      summary: "현재 조건에서는 진입을 권고합니다.",
      reason: "조사가 붙은 진입 권고",
    },
    {
      summary: "목표가는 100000000원입니다.",
      reason: "조사가 붙은 목표가",
    },
    {
      summary: "주문 수량은 0.1 BTC입니다.",
      reason: "조사가 붙은 주문 수량",
    },
  ])("rejects particle-marked Korean unsafe briefing text: $reason", ({ summary }) => {
    expect(() =>
      parseLlmRiskAssistantResult({
        schema_version: LLM_RISK_ASSISTANT_SCHEMA_VERSION,
        result_type: "live_ops_briefing_draft",
        source_ids: ["live-ops-status-snapshot-1"],
        summary,
        recommended_action: "ALERT_ONLY",
        observed_at: observedAt,
      }),
    ).toThrow(LlmRiskAssistantContractError);
  });
});
