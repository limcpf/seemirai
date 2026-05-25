import { describe, expect, it } from "vitest";
import {
  LLM_RISK_ASSISTANT_SCHEMA_VERSION,
  appendLlmRiskAssistantAudit,
  redactLlmRiskAssistantAuditText,
  redactLlmRiskAssistantAuditValue,
  toLlmRiskAssistantAuditEvent,
  type AuditEvent,
  type AuditLogPort,
  type LlmRiskAssistantProviderRequest,
  type LlmRiskAssistantProviderResponse,
} from "../../src/application/index.js";
import { toAuditEventRow } from "../../src/infrastructure/index.js";

const observedAt = "2026-05-23T00:00:00.000Z";
const requestedAt = "2026-05-23T00:00:05.000Z";
const completedAt = "2026-05-23T00:00:06.000Z";

describe("M10 LLM risk assistant audit persistence", () => {
  it("creates redacted audit evidence for normalized provider success", () => {
    const event = toLlmRiskAssistantAuditEvent({
      request: providerRequestWithSecrets(),
      response: providerSuccessWithSecrets(),
    });
    const row = toAuditEventRow(event);
    const serialized = JSON.stringify(row);

    expect(event).toMatchObject({
      eventType: "LLM_RISK_ASSISTANT",
      severity: "INFO",
      occurredAt: completedAt,
      actor: "llm-risk-assistant",
      reasonCode: "llm_risk_assistant_block_new_entry",
      correlationId: "corr-llm-1",
      metadata: {
        audit_kind: "LLM_RISK_ASSISTANT_PROVIDER_RESULT",
        schema_version: LLM_RISK_ASSISTANT_SCHEMA_VERSION,
        provider_id: "codex_oauth",
        status: "ok",
        result_type: "notice_risk_classification",
        source: {
          notice_url: expect.stringContaining("[REDACTED]"),
        },
      },
    });
    expect(row).toMatchObject({
      event_type: "LLM_RISK_ASSISTANT",
      severity: "INFO",
      correlation_id: "corr-llm-1",
      payload_json: {
        audit_kind: "LLM_RISK_ASSISTANT_PROVIDER_RESULT",
        actor: "llm-risk-assistant",
        reason_code: "llm_risk_assistant_block_new_entry",
        request: {
          prompt_sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
          redacted_prompt: expect.stringContaining("[REDACTED]"),
        },
        response: {
          result: {
            summary: expect.stringContaining("[REDACTED]"),
          },
        },
      },
    });
    expect(serialized).toContain("[REDACTED]");
    expect(serialized).not.toContain("upbit-access-key-raw");
    expect(serialized).not.toContain("codex-session-raw");
    expect(serialized).not.toContain("github_pat_raw");
    expect(serialized).not.toContain("sk-raw");
    expect(serialized).not.toContain("notice-token-raw");
  });

  it("appends LLM audit through AuditLogPort without direct DB coupling", async () => {
    const events: AuditEvent[] = [];
    const auditLog: AuditLogPort = {
      appendEvent: async (event) => {
        events.push(event);

        return {
          auditEventId: "audit-llm-1",
          appendedAt: completedAt,
        };
      },
    };

    await expect(
      appendLlmRiskAssistantAudit(auditLog, {
        request: providerRequestWithSecrets(),
        response: providerSuccessWithSecrets(),
      }),
    ).resolves.toEqual({
      auditEventId: "audit-llm-1",
      appendedAt: completedAt,
    });

    expect(events).toHaveLength(1);
    expect(events[0]?.eventType).toBe("LLM_RISK_ASSISTANT");
  });

  it("stores provider failure evidence without raw credential metadata", () => {
    const event = toLlmRiskAssistantAuditEvent({
      request: providerRequestWithSecrets(),
      response: {
        status: "failed",
        provider_id: "codex_oauth",
        failure_class: "provider_error",
        reason_code: "codex_oauth_provider_error",
        message: "Codex failed with Authorization: Bearer codex-session-raw",
        failed_at: completedAt,
        issues: [
          {
            path: "metadata.oauth_session",
            code: "custom",
            message: "session=codex-session-raw",
          },
        ],
        metadata: {
          token: "github_pat_raw",
          safe_detail: "exit code 1",
        },
      },
    });
    const serialized = JSON.stringify(toAuditEventRow(event));

    expect(event).toMatchObject({
      severity: "WARN",
      reasonCode: "codex_oauth_provider_error",
      metadata: {
        response: {
          failure_class: "provider_error",
          reason_code: "codex_oauth_provider_error",
          message: "Codex failed with [REDACTED]",
          metadata: {
            token: "[REDACTED]",
            safe_detail: "exit code 1",
          },
        },
      },
    });
    expect(serialized).not.toContain("codex-session-raw");
    expect(serialized).not.toContain("github_pat_raw");
  });

  it("redacts sensitive keys and token-like strings recursively", () => {
    const redacted = redactLlmRiskAssistantAuditValue({
      nested: {
        access_key: "upbit-access-key-raw",
        safe: "공지 본문",
        prompt: "api_key=upbit-access-key-raw Bearer codex-session-raw",
        json: '{"token":"json-token-raw","session": "json-session-raw"}',
        url: "https://example.test/notice?access_token=url-token-raw&api_key=url-key-raw",
      },
      items: [
        "sk-rawsecretsecret",
        "gho_1234567890abcdef",
        "ghu_1234567890abcdef",
        "ghs_1234567890abcdef",
        "ghr_1234567890abcdef",
        "plain",
      ],
    });

    expect(redacted).toEqual({
      nested: {
        access_key: "[REDACTED]",
        safe: "공지 본문",
        prompt: "[REDACTED] [REDACTED]",
        json: "{[REDACTED],[REDACTED]}",
        url: "https://example.test/notice?[REDACTED]&[REDACTED]",
      },
      items: ["[REDACTED]", "[REDACTED]", "[REDACTED]", "[REDACTED]", "[REDACTED]", "plain"],
    });
    expect(redactLlmRiskAssistantAuditText("Authorization: Bearer codex-session-raw")).toBe(
      "[REDACTED]",
    );
    expect(redactLlmRiskAssistantAuditText("Authorization: bearer codex-session-raw")).toBe(
      "[REDACTED]",
    );
    expect(redactLlmRiskAssistantAuditText("Authorization: Basic QWxhZGRpbjpvcGVuIHNlc2FtZQ==")).toBe(
      "[REDACTED]",
    );
    expect(
      redactLlmRiskAssistantAuditText(
        'provider returned {"api_key":"json-api-key-raw","safe":"kept"}',
      ),
    ).not.toContain("json-api-key-raw");
  });
});

function providerRequestWithSecrets(): LlmRiskAssistantProviderRequest {
  return {
    input: {
      source: "exchange_notice",
      source_id: "upbit-notice-1",
      observed_at: observedAt,
      market: "KRW-BTC",
      notice_url:
        "https://upbit.com/service_center/notice?id=1&access_token=notice-token-raw&api_key=notice-key-raw",
      title: "점검 공지 Authorization: Bearer codex-session-raw",
      content:
        "공식 점검 공지입니다. access_key=upbit-access-key-raw Authorization: Bearer codex-session-raw",
      metadata: {
        token: "github_pat_raw",
        stable_notice_id: "notice-1",
      },
    },
    result_type: "notice_risk_classification",
    prompt:
      "공지 내용을 분류한다. api_key=upbit-access-key-raw Authorization: Bearer codex-session-raw",
    requested_at: requestedAt,
    timeout_ms: 5_000,
    max_output_bytes: 16_000,
    correlation_id: "corr-llm-1",
    metadata: {
      oauth_session: "codex-session-raw",
      retry_count: 0,
    },
  };
}

function providerSuccessWithSecrets(): LlmRiskAssistantProviderResponse {
  return {
    status: "ok",
    provider_id: "codex_oauth",
    completed_at: completedAt,
    result: {
      schema_version: LLM_RISK_ASSISTANT_SCHEMA_VERSION,
      result_type: "notice_risk_classification",
      source_ids: ["upbit-notice-1"],
      summary: "점검 공지입니다. token=github_pat_raw",
      recommended_action: "BLOCK_NEW_ENTRY",
      observed_at: observedAt,
      market: "KRW-BTC",
      reason_codes: ["exchange_notice:maintenance"],
      requires_human_review: true,
      evidence: ["Authorization: Bearer codex-session-raw"],
      metadata: {
        secret_key: "sk-rawsecretsecret",
        stable_evidence_id: "evidence-1",
      },
    },
    metadata: {
      provider_mode: "codex_oauth",
      session: "codex-session-raw",
    },
  };
}
