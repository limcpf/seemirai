import { describe, expect, it } from "vitest";
import {
  LLM_RISK_ASSISTANT_SCHEMA_VERSION,
  createLlmProviderFailure,
  createLlmProviderSuccess,
  mapLlmRiskAssistantToRiskGateSignal,
  type LlmRiskAssistantProviderRequest,
  type LlmRiskAssistantResult,
  type LlmRiskGateSignal,
} from "../../src/application/index.js";

const observedAt = "2026-05-23T00:00:00.000Z";

describe("M10 LLM RiskGate mapper", () => {
  it("maps BLOCK_NEW_ENTRY to a blocking RiskGate signal without creating an allow action", () => {
    const signal = mapLlmRiskAssistantToRiskGateSignal({
      request: createProviderRequest(),
      response: createLlmProviderSuccess({
        providerId: "codex_oauth",
        result: createResult({
          recommended_action: "BLOCK_NEW_ENTRY",
          requires_human_review: true,
        }),
        completedAt: observedAt,
      }),
      context: {
        correlationId: "corr-1",
        strategyId: "trend_following",
      },
    });

    expect(signal).toMatchObject({
      status: "mapped",
      action: "BLOCK_NEW_ORDER",
      reasonCode: "llm_risk_block_new_entry",
      requiresHumanReview: true,
      riskGateEvaluation: {
        status: "FAIL",
        action: "BLOCK_NEW_ORDER",
        severity: "BLOCKING",
      },
    });
    expect(JSON.stringify(signal)).not.toContain('"ALLOW"');
    expectNoOrderCandidateShape(signal);
  });

  it("maps CANCEL_PENDING to a cancel candidate plus manual review, not broker side effect input", () => {
    const signal = mapLlmRiskAssistantToRiskGateSignal({
      request: createProviderRequest(),
      response: createLlmProviderSuccess({
        providerId: "codex_oauth",
        result: createResult({
          recommended_action: "CANCEL_PENDING",
          metadata: {
            target_price: "100000000",
            position_size: "0.2",
            side: "BUY",
          },
        }),
        completedAt: observedAt,
      }),
      context: {
        orderId: "paper-order-1",
        correlationId: "corr-1",
      },
    });

    expect(signal).toMatchObject({
      status: "mapped",
      action: "PLAN_CANCEL_PENDING_ORDER",
      requiresHumanReview: true,
      riskGateEvaluation: {
        status: "FAIL",
        action: "MANUAL_REVIEW_REQUIRED",
        severity: "CRITICAL",
      },
    });
    expect(JSON.stringify(signal)).not.toContain('"ALLOW"');
    expectNoOrderCandidateShape(signal);
  });

  it("maps PAUSE_STRATEGY only when the strategy scope is explicit", () => {
    const request = createProviderRequest();
    const response = createLlmProviderSuccess({
      providerId: "codex_oauth",
      result: createResult({
        recommended_action: "PAUSE_STRATEGY",
      }),
      completedAt: observedAt,
    });

    expect(
      mapLlmRiskAssistantToRiskGateSignal({
        request,
        response,
        context: {
          strategyId: "mean_reversion",
        },
      }),
    ).toMatchObject({
      status: "mapped",
      action: "PLAN_PAUSE_STRATEGY",
      strategyId: "mean_reversion",
      riskGateEvaluation: {
        status: "FAIL",
        action: "PAUSE_STRATEGY",
      },
    });

    expect(
      mapLlmRiskAssistantToRiskGateSignal({
        request,
        response,
      }),
    ).toMatchObject({
      status: "mapped",
      action: "MANUAL_REVIEW_REQUIRED",
      requiresHumanReview: true,
      riskGateEvaluation: {
        status: "FAIL",
        action: "MANUAL_REVIEW_REQUIRED",
      },
    });
  });

  it("keeps ALERT_ONLY as an alert signal without RiskGate allow evaluation", () => {
    const signal = mapLlmRiskAssistantToRiskGateSignal({
      request: createProviderRequest(),
      response: createLlmProviderSuccess({
        providerId: "codex_oauth",
        result: createResult({
          recommended_action: "ALERT_ONLY",
        }),
        completedAt: observedAt,
      }),
    });

    expect(signal).toMatchObject({
      status: "mapped",
      action: "ALERT_ONLY",
      reasonCode: "llm_risk_gate_alert_only",
    });
    expect(signal.riskGateEvaluation).toBeUndefined();
    expect(JSON.stringify(signal)).not.toContain('"ALLOW"');
    expectNoOrderCandidateShape(signal);
  });

  it("returns no RiskGate signal for NO_ACTION, provider failure, and non-risk result types", () => {
    const request = createProviderRequest();

    const noActionSignal = mapLlmRiskAssistantToRiskGateSignal({
      request,
      response: createLlmProviderSuccess({
        providerId: "noop",
        result: createResult({
          recommended_action: "NO_ACTION",
        }),
        completedAt: observedAt,
      }),
    });
    expect(noActionSignal).toMatchObject({
      status: "no_signal",
      action: "NO_ACTION",
      reasonCode: "llm_risk_gate_no_action",
    });
    expect(noActionSignal.riskGateEvaluation).toBeUndefined();

    const providerFailureSignal = mapLlmRiskAssistantToRiskGateSignal({
      request,
      response: createLlmProviderFailure({
        providerId: "codex_oauth",
        failureClass: "timeout",
        reasonCode: "codex_oauth_provider_timeout",
        message: "timeout",
        failedAt: observedAt,
      }),
    });
    expect(providerFailureSignal).toMatchObject({
      status: "no_signal",
      action: "NO_ACTION",
      reasonCode: "codex_oauth_provider_timeout",
    });
    expect(providerFailureSignal.riskGateEvaluation).toBeUndefined();

    const dailyReportSignal = mapLlmRiskAssistantToRiskGateSignal({
      request: {
        ...request,
        result_type: "daily_report_draft",
      },
      response: createLlmProviderSuccess({
        providerId: "codex_oauth",
        result: createResult({
          result_type: "daily_report_draft",
          recommended_action: "BLOCK_NEW_ENTRY",
        }),
        completedAt: observedAt,
      }),
    });
    expect(dailyReportSignal).toMatchObject({
      status: "no_signal",
      action: "NO_ACTION",
      reasonCode: "llm_risk_gate_unsupported_result_type",
    });
    expect(dailyReportSignal.riskGateEvaluation).toBeUndefined();
  });

  it("allows market_event explanation to produce only safe RiskGate signals", () => {
    const signal = mapLlmRiskAssistantToRiskGateSignal({
      request: {
        ...createProviderRequest(),
        input: {
          ...createProviderRequest().input,
          source: "market_event",
          source_id: "upbit-market-event-1",
        },
        result_type: "event_explanation",
      },
      response: createLlmProviderSuccess({
        providerId: "codex_oauth",
        result: createResult({
          result_type: "event_explanation",
          source_ids: ["upbit-market-event-1"],
          recommended_action: "BLOCK_NEW_ENTRY",
        }),
        completedAt: observedAt,
      }),
    });

    expect(signal).toMatchObject({
      status: "mapped",
      action: "BLOCK_NEW_ORDER",
      riskGateEvaluation: {
        action: "BLOCK_NEW_ORDER",
      },
    });
    expect(JSON.stringify(signal)).not.toContain('"ALLOW"');
    expectNoOrderCandidateShape(signal);
  });
});

function createProviderRequest(): LlmRiskAssistantProviderRequest {
  return {
    input: {
      source: "exchange_notice",
      source_id: "upbit-notice-1",
      observed_at: observedAt,
      market: "KRW-BTC",
      notice_url: "https://upbit.com/service_center/notice?id=1",
      title: "점검 공지",
      content: "KRW-BTC 점검 공지 본문",
    },
    result_type: "notice_risk_classification",
    prompt: "공식 공지 fixture를 schema에 맞춰 분류한다.",
    requested_at: observedAt,
    timeout_ms: 5_000,
    max_output_bytes: 16_000,
    correlation_id: "corr-1",
  };
}

function createResult(
  override: Partial<LlmRiskAssistantResult> = {},
): LlmRiskAssistantResult {
  return {
    schema_version: LLM_RISK_ASSISTANT_SCHEMA_VERSION,
    result_type: "notice_risk_classification",
    source_ids: ["upbit-notice-1"],
    summary: "공식 입력에 운영 리스크가 있습니다.",
    recommended_action: "ALERT_ONLY",
    observed_at: observedAt,
    market: "KRW-BTC",
    reason_codes: ["exchange_notice:maintenance"],
    evidence: ["Upbit 공식 공지에 점검 시간이 포함되어 있습니다."],
    ...override,
  };
}

function expectNoOrderCandidateShape(signal: LlmRiskGateSignal): void {
  const forbiddenKeys = new Set([
    "orderIntent",
    "orderCandidate",
    "requestedPrice",
    "requestedQuantity",
    "requestedNotional",
    "targetPrice",
    "target_price",
    "positionSize",
    "position_size",
    "side",
    "orderType",
  ]);

  expect(collectKeys(signal).filter((key) => forbiddenKeys.has(key))).toEqual([]);
}

function collectKeys(value: unknown): string[] {
  if (value === null || typeof value !== "object") {
    return [];
  }

  if (Array.isArray(value)) {
    return value.flatMap((item) => collectKeys(item));
  }

  return Object.entries(value).flatMap(([key, entryValue]) => [key, ...collectKeys(entryValue)]);
}
