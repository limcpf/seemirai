import { describe, expect, it } from "vitest";
import {
  LLM_RISK_ASSISTANT_SCHEMA_VERSION,
  attachLlmDailyReportDraft,
  createLlmProviderFailure,
  createLlmProviderSuccess,
  type DailyReportNotification,
  type LlmRiskAssistantProviderRequest,
  type LlmRiskAssistantResult,
} from "../../src/application/index.js";

const observedAt = "2026-05-23T00:00:00.000Z";

describe("M10 LLM daily report draft boundary", () => {
  it("attaches a successful LLM daily report draft without mutating the deterministic report", () => {
    const notification = createDailyReportNotification();
    const result = attachLlmDailyReportDraft({
      notification,
      request: createProviderRequest(),
      response: createLlmProviderSuccess({
        providerId: "codex_oauth",
        result: createDailyReportDraft({
          summary: "LLM 보조 초안: 비용은 안정적이지만 리스크 이벤트 검토가 필요합니다.",
          reason_codes: ["daily_report:risk_review"],
          requires_human_review: true,
        }),
        completedAt: observedAt,
      }),
    });

    expect(result).toMatchObject({
      notification,
      status: "attached",
      reasonCode: "llm_daily_report_draft_attached",
      draft: {
        text: "LLM 보조 초안: 비용은 안정적이지만 리스크 이벤트 검토가 필요합니다.",
        providerId: "codex_oauth",
        sourceIds: ["upbit-notice-1"],
        observedAt,
        reasonCodes: ["daily_report:risk_review"],
        requiresHumanReview: true,
      },
    });
    expect(result.notification).toBe(notification);
    expect(notification.summary).toBe("deterministic summary");
    expect(JSON.stringify(result)).not.toContain("recommended_action");
    expectNoTradeInstructionShape(result);
  });

  it("keeps the deterministic report when the LLM provider fails", () => {
    const notification = createDailyReportNotification();
    const result = attachLlmDailyReportDraft({
      notification,
      request: createProviderRequest(),
      response: createLlmProviderFailure({
        providerId: "codex_oauth",
        failureClass: "timeout",
        reasonCode: "codex_oauth_provider_timeout",
        message: "timeout",
        failedAt: observedAt,
      }),
    });

    expect(result).toMatchObject({
      notification,
      status: "deterministic_only",
      reasonCode: "codex_oauth_provider_timeout",
      skippedReason: "provider_failed",
    });
    expect(result.draft).toBeUndefined();
    expect(result.notification).toBe(notification);
    expect(notification.summary).toBe("deterministic summary");
    expectNoTradeInstructionShape(result);
  });

  it("does not attach non-daily-report LLM results even when they contain safe actions", () => {
    const notification = createDailyReportNotification();
    const result = attachLlmDailyReportDraft({
      notification,
      request: createProviderRequest(),
      response: createLlmProviderSuccess({
        providerId: "codex_oauth",
        result: {
          ...createDailyReportDraft({
            result_type: "notice_risk_classification",
            recommended_action: "BLOCK_NEW_ENTRY",
          }),
        },
        completedAt: observedAt,
      }),
    });

    expect(result).toMatchObject({
      notification,
      status: "deterministic_only",
      reasonCode: "llm_daily_report_draft_unsupported_result_type",
      skippedReason: "unsupported_result_type",
    });
    expect(result.draft).toBeUndefined();
    expect(result.notification).toBe(notification);
    expect(JSON.stringify(result)).not.toContain("BLOCK_NEW_ENTRY");
    expectNoTradeInstructionShape(result);
  });

  it("does not treat daily report draft actions as RiskGate or order instructions", () => {
    const result = attachLlmDailyReportDraft({
      notification: createDailyReportNotification(),
      request: createProviderRequest(),
      response: createLlmProviderSuccess({
        providerId: "codex_oauth",
        result: createDailyReportDraft({
          recommended_action: "CANCEL_PENDING",
          metadata: {
            target_price: "100000000",
            position_size: "0.5",
            side: "BUY",
          },
        }),
        completedAt: observedAt,
      }),
    });

    expect(result.status).toBe("attached");
    expect(result.draft).toMatchObject({
      text: "LLM daily report draft",
    });
    expect(JSON.stringify(result)).not.toContain("CANCEL_PENDING");
    expectNoTradeInstructionShape(result);
  });
});

function createDailyReportNotification(): DailyReportNotification {
  return {
    reportDate: "2026-05-23",
    summary: "deterministic summary",
    generatedAt: observedAt,
    metadata: {
      source: "daily_report_aggregator",
      order_count: 2,
      risk_event_count: 1,
    },
  };
}

function createProviderRequest(): LlmRiskAssistantProviderRequest {
  return {
    input: {
      source: "exchange_notice",
      source_id: "upbit-notice-1",
      observed_at: observedAt,
      title: "점검 공지",
      content: "공식 공지와 운영 리포트 fixture를 함께 요약한다.",
    },
    result_type: "daily_report_draft",
    prompt: "deterministic daily report를 대체하지 않는 보조 초안을 작성한다.",
    requested_at: observedAt,
    timeout_ms: 5_000,
    max_output_bytes: 16_000,
    correlation_id: "daily-report-2026-05-23",
  };
}

function createDailyReportDraft(
  override: Partial<LlmRiskAssistantResult> = {},
): LlmRiskAssistantResult {
  return {
    schema_version: LLM_RISK_ASSISTANT_SCHEMA_VERSION,
    result_type: "daily_report_draft",
    source_ids: ["upbit-notice-1"],
    summary: "LLM daily report draft",
    recommended_action: "NO_ACTION",
    observed_at: observedAt,
    reason_codes: ["daily_report:draft"],
    requires_human_review: false,
    evidence: ["deterministic report summary remains authoritative"],
    ...override,
  };
}

function expectNoTradeInstructionShape(value: unknown): void {
  const forbiddenKeys = new Set([
    "orderIntent",
    "orderCandidate",
    "riskGateEvaluation",
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

  expect(collectKeys(value).filter((key) => forbiddenKeys.has(key))).toEqual([]);
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
