import { describe, expect, it } from "vitest";
import {
  LLM_RISK_ASSISTANT_SCHEMA_VERSION,
  createNoopLlmRiskAssistantProvider,
  normalizeLlmProviderTextOutput,
  type LlmRiskAssistantProviderRequest,
} from "../../src/application/index.js";
import {
  type CodexOAuthCommandRunner,
  CodexOAuthCommandTimeoutError,
  CodexOAuthLlmProvider,
  createCodexOAuthLlmProvider,
} from "../../src/infrastructure/index.js";

const observedAt = "2026-05-23T00:00:00.000Z";

describe("M10 LLM risk assistant provider runtime", () => {
  it("returns a normalized no-op result without external side effects", async () => {
    const provider = createNoopLlmRiskAssistantProvider();
    const result = await provider.generate(createProviderRequest());

    expect(result).toMatchObject({
      status: "ok",
      provider_id: "noop",
      result: {
        schema_version: LLM_RISK_ASSISTANT_SCHEMA_VERSION,
        result_type: "notice_risk_classification",
        source_ids: ["upbit-notice-1"],
        recommended_action: "NO_ACTION",
      },
    });
  });

  it("normalizes Codex OAuth output behind the same provider port", async () => {
    const provider = new CodexOAuthLlmProvider({
      now: () => new Date(observedAt),
      runner: createFakeRunner(
        JSON.stringify({
          schema_version: LLM_RISK_ASSISTANT_SCHEMA_VERSION,
          result_type: "notice_risk_classification",
          source_ids: ["upbit-notice-1"],
          summary: "공식 점검 공지이므로 신규 진입 차단 후보입니다.",
          recommended_action: "BLOCK_NEW_ENTRY",
          observed_at: observedAt,
          reason_codes: ["exchange_notice:maintenance"],
          requires_human_review: true,
        }),
      ),
    });

    const result = await provider.generate(createProviderRequest());

    expect(result).toMatchObject({
      status: "ok",
      provider_id: "codex_oauth",
      result: {
        result_type: "notice_risk_classification",
        recommended_action: "BLOCK_NEW_ENTRY",
      },
    });
  });

  it.each([
    {
      rawOutput: "공식 공지이므로 매수하지 마세요.",
      failureClass: "free_form_output",
      reasonCode: "llm_provider_free_form_output",
    },
    {
      rawOutput: "{ invalid json }",
      failureClass: "invalid_json",
      reasonCode: "llm_provider_invalid_json",
    },
    {
      rawOutput: "{\"schema_version\":",
      failureClass: "free_form_output",
      reasonCode: "llm_provider_free_form_output",
    },
    {
      rawOutput: JSON.stringify({
        schema_version: LLM_RISK_ASSISTANT_SCHEMA_VERSION,
        result_type: "notice_risk_classification",
        source_ids: ["upbit-notice-1"],
        summary: "거래 지시는 거부되어야 합니다.",
        recommended_action: "BUY",
        observed_at: observedAt,
      }),
      failureClass: "invalid_schema",
      reasonCode: "llm_risk_assistant_result_invalid",
    },
  ])(
    "fails closed on malformed or unsafe provider output: $reasonCode",
    ({ rawOutput, failureClass, reasonCode }) => {
      const result = normalizeLlmProviderTextOutput({
        providerId: "codex_oauth",
        input: createProviderRequest().input,
        resultType: "notice_risk_classification",
        rawOutput,
        maxOutputBytes: 16_000,
        observedAt,
      });

      expect(result).toMatchObject({
        status: "failed",
        provider_id: "codex_oauth",
        failure_class: failureClass,
        reason_code: reasonCode,
      });
    },
  );

  it("fails closed when provider output exceeds the configured byte limit", () => {
    const result = normalizeLlmProviderTextOutput({
      providerId: "codex_oauth",
      input: createProviderRequest().input,
      resultType: "notice_risk_classification",
      rawOutput: JSON.stringify({
        schema_version: LLM_RISK_ASSISTANT_SCHEMA_VERSION,
        result_type: "notice_risk_classification",
        source_ids: ["upbit-notice-1"],
        summary: "x".repeat(500),
        recommended_action: "ALERT_ONLY",
        observed_at: observedAt,
      }),
      maxOutputBytes: 128,
      observedAt,
    });

    expect(result).toMatchObject({
      status: "failed",
      failure_class: "output_too_large",
      reason_code: "llm_provider_output_too_large",
    });
  });

  it("turns Codex command timeout into failure evidence without a trading signal", async () => {
    const provider = new CodexOAuthLlmProvider({
      now: () => new Date(observedAt),
      runner: {
        run: async () => {
          throw new CodexOAuthCommandTimeoutError();
        },
      },
    });

    const result = await provider.generate(createProviderRequest());

    expect(result).toMatchObject({
      status: "failed",
      provider_id: "codex_oauth",
      failure_class: "timeout",
      reason_code: "codex_oauth_provider_timeout",
    });
  });
});

const codexSmoke = process.env.SEEMIRAI_RUN_CODEX_LLM_SMOKE === "1" ? it : it.skip;

describe("M10 Codex OAuth gated smoke", () => {
  codexSmoke(
    "normalizes a real Codex OAuth response only when explicitly enabled",
    async () => {
      const provider = createCodexOAuthLlmProvider();
      const result = await provider.generate({
        ...createProviderRequest(),
        prompt: [
          "아래 JSON schema와 정확히 같은 JSON object만 출력한다.",
          "설명 문장, markdown, code fence는 쓰지 않는다.",
          JSON.stringify({
            schema_version: LLM_RISK_ASSISTANT_SCHEMA_VERSION,
            result_type: "notice_risk_classification",
            source_ids: ["upbit-notice-1"],
            summary: "테스트용 공식 공지 요약입니다.",
            recommended_action: "ALERT_ONLY",
            observed_at: observedAt,
            reason_codes: ["exchange_notice:test"],
            requires_human_review: false,
          }),
        ].join("\n"),
        timeout_ms: 120_000,
      });

      expect(result.status).toBe("ok");
    },
    150_000,
  );
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

function createFakeRunner(finalMessage: string): CodexOAuthCommandRunner {
  return {
    run: async () => ({
      finalMessage,
      exitCode: 0,
    }),
  };
}
