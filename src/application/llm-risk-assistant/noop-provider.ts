import {
  LLM_RISK_ASSISTANT_SCHEMA_VERSION,
  type LlmRiskAssistantProviderPort,
  type LlmRiskAssistantProviderRequest,
  type LlmRiskAssistantProviderResponse,
} from "./contracts.js";
import { createLlmProviderSuccess } from "./provider-normalization.js";

/**
 * LLM 기능을 비활성화했을 때 사용하는 provider 구현체다.
 *
 * `noop`은 외부 API, DB, broker, audit write를 수행하지 않고 같은 normalized response contract만 반환한다.
 * provider 교체 테스트와 운영 fail-safe 기본값에 사용한다.
 */
export class NoopLlmRiskAssistantProvider implements LlmRiskAssistantProviderPort {
  public readonly providerId = "noop" as const;

  public async generate(
    request: LlmRiskAssistantProviderRequest,
  ): Promise<LlmRiskAssistantProviderResponse> {
    return createLlmProviderSuccess({
      providerId: this.providerId,
      completedAt: request.requested_at,
      result: {
        schema_version: LLM_RISK_ASSISTANT_SCHEMA_VERSION,
        result_type: request.result_type,
        source_ids: [request.input.source_id],
        summary: "LLM provider가 비활성화되어 추가 조치를 만들지 않았습니다.",
        recommended_action: "NO_ACTION",
        observed_at: request.input.observed_at,
        market: request.input.market,
        reason_codes: ["llm_provider:noop"],
        requires_human_review: false,
      },
      metadata: {
        provider_mode: "disabled",
      },
    });
  }
}

/**
 * 기본 `noop` provider factory다.
 *
 * runtime config가 LLM provider를 끄거나 후속 provider discovery가 실패할 때도 같은 application port를 유지한다.
 */
export function createNoopLlmRiskAssistantProvider(): NoopLlmRiskAssistantProvider {
  return new NoopLlmRiskAssistantProvider();
}
