import type { JsonRecord, TimestampInput } from "../../domain/index.js";
import {
  type LlmRiskAssistantContractIssue,
  type LlmRiskAssistantInput,
  type LlmRiskAssistantProviderFailure,
  type LlmRiskAssistantProviderFailureClass,
  type LlmRiskAssistantProviderId,
  type LlmRiskAssistantProviderResponse,
  type LlmRiskAssistantProviderSuccess,
  type LlmRiskAssistantResultType,
} from "./contracts.js";
import {
  LlmRiskAssistantContractError,
  parseLlmRiskAssistantResult,
} from "./schemas.js";

export interface NormalizeLlmProviderTextOutputOptions {
  providerId: LlmRiskAssistantProviderId;
  input: LlmRiskAssistantInput;
  resultType: LlmRiskAssistantResultType;
  rawOutput: string;
  maxOutputBytes: number;
  observedAt: TimestampInput;
  metadata?: JsonRecord | undefined;
}

export interface CreateLlmProviderFailureOptions {
  providerId: LlmRiskAssistantProviderId;
  failureClass: LlmRiskAssistantProviderFailureClass;
  reasonCode: string;
  message: string;
  failedAt: TimestampInput;
  issues?: readonly LlmRiskAssistantContractIssue[] | undefined;
  metadata?: JsonRecord | undefined;
}

/**
 * provider text output을 normalized LLM result로 변환한다.
 *
 * 이 함수는 provider별 raw 응답을 application schema에 맞추는 유일한 경계다. JSON이 아니거나 schema가 맞지 않거나
 * 주문 지시가 섞인 응답은 모두 fail-closed failure로 반환하며 외부 side effect가 없다.
 */
export function normalizeLlmProviderTextOutput(
  options: NormalizeLlmProviderTextOutputOptions,
): LlmRiskAssistantProviderResponse {
  const outputBytes = Buffer.byteLength(options.rawOutput, "utf8");

  if (outputBytes > options.maxOutputBytes) {
    // 과대 응답은 audit 저장과 리뷰 보고서에서 raw 본문 재노출 위험을 만들기 전에 버린다.
    return createLlmProviderFailure({
      providerId: options.providerId,
      failureClass: "output_too_large",
      reasonCode: "llm_provider_output_too_large",
      message: "LLM provider output exceeded the configured byte limit.",
      failedAt: options.observedAt,
      metadata: {
        output_bytes: outputBytes,
        max_output_bytes: options.maxOutputBytes,
      },
    });
  }

  const trimmedOutput = options.rawOutput.trim();

  if (!looksLikeJsonObject(trimmedOutput)) {
    // 자유 형식 응답은 차단 신호인지 거래 조언인지 안정적으로 구분할 수 없으므로 schema 보정 없이 실패시킨다.
    return createLlmProviderFailure({
      providerId: options.providerId,
      failureClass: "free_form_output",
      reasonCode: "llm_provider_free_form_output",
      message: "LLM provider returned a free-form response instead of a JSON object.",
      failedAt: options.observedAt,
      metadata: {
        output_bytes: outputBytes,
      },
    });
  }

  const parsed = parseJsonObject(trimmedOutput);

  if (parsed.status === "invalid_json") {
    // JSON으로 보이는 응답도 파싱 실패 시 일부 필드만 신뢰하지 않고 전체 provider 결과를 폐기한다.
    return createLlmProviderFailure({
      providerId: options.providerId,
      failureClass: "invalid_json",
      reasonCode: "llm_provider_invalid_json",
      message: "LLM provider returned invalid JSON.",
      failedAt: options.observedAt,
      metadata: {
        output_bytes: outputBytes,
      },
    });
  }

  try {
    const result = parseLlmRiskAssistantResult(parsed.value);
    const mismatchIssue = validateProviderResultRequestMatch({
      input: options.input,
      resultType: options.resultType,
      resultSourceIds: result.source_ids,
      resultTypeFromProvider: result.result_type,
    });

    if (mismatchIssue !== undefined) {
      // provider가 다른 source/result type 결과를 내면 stale prompt나 hallucinated context 가능성이 있어 실패로 남긴다.
      return createLlmProviderFailure({
        providerId: options.providerId,
        failureClass: "invalid_schema",
        reasonCode: "llm_provider_result_mismatch",
        message: "LLM provider result did not match the requested source or result type.",
        failedAt: options.observedAt,
        issues: [mismatchIssue],
        metadata: {
          output_bytes: outputBytes,
        },
      });
    }

    return createLlmProviderSuccess({
      providerId: options.providerId,
      result,
      completedAt: options.observedAt,
      metadata: {
        output_bytes: outputBytes,
        ...options.metadata,
      },
    });
  } catch (error) {
    if (error instanceof LlmRiskAssistantContractError) {
      return createLlmProviderFailure({
        providerId: options.providerId,
        failureClass: "invalid_schema",
        reasonCode: error.reasonCode,
        message: "LLM provider result failed the normalized result schema.",
        failedAt: options.observedAt,
        issues: error.issues,
        metadata: {
          output_bytes: outputBytes,
        },
      });
    }

    throw error;
  }
}

/**
 * provider success response를 만든다.
 *
 * 성공 response도 broker나 persistence side effect를 만들지 않고, 후속 application service가 audit/mapping 경계를 선택한다.
 */
export function createLlmProviderSuccess(options: {
  providerId: LlmRiskAssistantProviderId;
  result: LlmRiskAssistantProviderSuccess["result"];
  completedAt: TimestampInput;
  metadata?: JsonRecord | undefined;
}): LlmRiskAssistantProviderSuccess {
  return {
    status: "ok",
    provider_id: options.providerId,
    result: options.result,
    completed_at: options.completedAt,
    metadata: options.metadata,
  };
}

/**
 * provider failure response를 만든다.
 *
 * 호출자는 raw output 대신 failure class, reason code, issue path만 저장해 secret-like 문자열과 OAuth 세션 정보가 로그나
 * audit에 남지 않게 해야 한다.
 */
export function createLlmProviderFailure(
  options: CreateLlmProviderFailureOptions,
): LlmRiskAssistantProviderFailure {
  return {
    status: "failed",
    provider_id: options.providerId,
    failure_class: options.failureClass,
    reason_code: options.reasonCode,
    message: options.message,
    failed_at: options.failedAt,
    issues: options.issues,
    metadata: options.metadata,
  };
}

function looksLikeJsonObject(output: string): boolean {
  return output.startsWith("{") && output.endsWith("}");
}

type ParseJsonObjectResult =
  | {
      status: "ok";
      value: unknown;
    }
  | {
      status: "invalid_json";
    };

function parseJsonObject(output: string): ParseJsonObjectResult {
  try {
    return {
      status: "ok",
      value: JSON.parse(output) as unknown,
    };
  } catch {
    return {
      status: "invalid_json",
    };
  }
}

function validateProviderResultRequestMatch(options: {
  input: LlmRiskAssistantInput;
  resultType: LlmRiskAssistantResultType;
  resultSourceIds: readonly string[];
  resultTypeFromProvider: LlmRiskAssistantResultType;
}): LlmRiskAssistantContractIssue | undefined {
  if (options.resultTypeFromProvider !== options.resultType) {
    return {
      path: "result_type",
      code: "custom",
      message: "result type does not match request",
    };
  }

  if (
    options.resultSourceIds.length !== 1 ||
    options.resultSourceIds[0] !== options.input.source_id
  ) {
    return {
      path: "source_ids",
      code: "custom",
      message: "source ids must exactly match the requested input source id",
    };
  }

  return undefined;
}
