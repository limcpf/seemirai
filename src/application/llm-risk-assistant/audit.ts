import { createHash } from "node:crypto";
import type { AuditEvent, AuditEventReceipt, AuditLogPort } from "../ports/index.js";
import type { JsonRecord, TimestampInput } from "../../domain/index.js";
import type {
  LlmRiskAssistantInput,
  LlmRiskAssistantProviderRequest,
  LlmRiskAssistantProviderResponse,
  LlmRiskAssistantResult,
} from "./contracts.js";
import { LLM_RISK_ASSISTANT_SCHEMA_VERSION } from "./contracts.js";

const REDACTED_VALUE = "[REDACTED]";
const MAX_REDACTED_TEXT_LENGTH = 4_000;

const sensitiveKeyFragments = [
  "authorization",
  "apikey",
  "accesskey",
  "secretkey",
  "clientsecret",
  "refreshtoken",
  "password",
  "privatekey",
  "cookie",
  "token",
  "secret",
  "session",
] as const;

const sensitiveStringPatterns = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]+/gu,
  /\bsk-[A-Za-z0-9_-]{12,}\b/gu,
  /\bghp_[A-Za-z0-9_]{20,}\b/gu,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/gu,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/gu,
  /\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/gu,
  /\b(?:token|secret|password|api[_-]?key|access[_-]?key|secret[_-]?key|authorization|cookie|session)\s*[:=]\s*[^\s,;]+/giu,
] as const;

export interface LlmRiskAssistantAuditInput {
  request: LlmRiskAssistantProviderRequest;
  response: LlmRiskAssistantProviderResponse;
  actor?: string | undefined;
  occurredAt?: TimestampInput | undefined;
  metadata?: JsonRecord | undefined;
}

/**
 * LLM provider 호출 결과를 append-only audit log에 남긴다.
 *
 * 이 함수는 기존 `AuditLogPort`만 호출하므로 DB table을 직접 알지 않는다. 저장 전에 prompt, input, normalized output,
 * provider metadata를 모두 redaction해 OAuth token/session 후보가 audit row로 흘러가지 않는 invariant를 유지한다.
 */
export async function appendLlmRiskAssistantAudit(
  auditLog: AuditLogPort,
  input: LlmRiskAssistantAuditInput,
): Promise<AuditEventReceipt> {
  return auditLog.appendEvent(toLlmRiskAssistantAuditEvent(input));
}

/**
 * LLM provider 결과를 `LLM_RISK_ASSISTANT` audit event로 변환한다.
 *
 * 성공과 실패 모두 같은 payload 구조를 사용해 후속 DB repository, report, review evidence가 provider raw body 없이도
 * source/result/failure를 추적할 수 있게 한다. 이 변환 자체는 외부 side effect가 없다.
 */
export function toLlmRiskAssistantAuditEvent(input: LlmRiskAssistantAuditInput): AuditEvent {
  const providerId = input.response.provider_id;
  const resultType =
    input.response.status === "ok" ? input.response.result.result_type : input.request.result_type;
  const reasonCode =
    input.response.status === "ok"
      ? `llm_risk_assistant_${input.response.result.recommended_action.toLowerCase()}`
      : input.response.reason_code;

  const event: AuditEvent = {
    eventType: "LLM_RISK_ASSISTANT",
    severity: input.response.status === "ok" ? "INFO" : "WARN",
    occurredAt: input.occurredAt ?? inferAuditOccurredAt(input.response, input.request),
    actor: input.actor ?? "llm-risk-assistant",
    reasonCode,
    metadata: {
      audit_kind: "LLM_RISK_ASSISTANT_PROVIDER_RESULT",
      schema_version: LLM_RISK_ASSISTANT_SCHEMA_VERSION,
      provider_id: providerId,
      status: input.response.status,
      result_type: resultType,
      source: toRedactedSourcePayload(input.request.input),
      request: {
        requested_at: input.request.requested_at,
        timeout_ms: input.request.timeout_ms,
        max_output_bytes: input.request.max_output_bytes,
        prompt_sha256: hashText(input.request.prompt),
        redacted_prompt: redactLlmRiskAssistantAuditText(input.request.prompt),
        metadata: redactLlmRiskAssistantAuditValue(input.request.metadata),
      },
      response: toRedactedResponsePayload(input.response),
      metadata: redactLlmRiskAssistantAuditValue(input.metadata),
    },
  };

  if (input.request.correlation_id !== undefined) {
    event.correlationId = input.request.correlation_id;
  }

  return event;
}

/**
 * LLM audit 저장 전에 문자열 안의 secret-like 값을 마스킹한다.
 *
 * 값 전체를 버리지 않고 주변 문맥은 보존해 운영자가 source와 실패 원인을 추적할 수 있게 하되, token/session 후보는
 * 고정 마커로 대체한다. 외부 side effect는 없다.
 */
export function redactLlmRiskAssistantAuditText(value: string): string {
  let redacted = value;

  for (const pattern of sensitiveStringPatterns) {
    redacted = redacted.replace(pattern, REDACTED_VALUE);
  }

  if (redacted.length > MAX_REDACTED_TEXT_LENGTH) {
    return `${redacted.slice(0, MAX_REDACTED_TEXT_LENGTH)}...[TRUNCATED]`;
  }

  return redacted;
}

/**
 * LLM audit payload에 넣을 JSON 값을 재귀적으로 redaction한다.
 *
 * key 이름이 secret/token/session 계열이면 값 전체를 제거하고, 일반 문자열은 token-like 패턴만 마스킹한다. 이 함수는
 * audit persistence 경계에서 재사용하는 순수 변환이며 provider raw payload를 별도로 보존하지 않는다.
 */
export function redactLlmRiskAssistantAuditValue(value: unknown): unknown {
  if (value === undefined || value === null) {
    return value;
  }

  if (typeof value === "string") {
    return redactLlmRiskAssistantAuditText(value);
  }

  if (typeof value !== "object") {
    return value;
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (Array.isArray(value)) {
    return value.map((item) => redactLlmRiskAssistantAuditValue(item));
  }

  const redacted: JsonRecord = {};

  for (const [key, entryValue] of Object.entries(value as JsonRecord)) {
    if (isSensitiveKey(key)) {
      redacted[key] = REDACTED_VALUE;
      continue;
    }

    redacted[key] = redactLlmRiskAssistantAuditValue(entryValue);
  }

  return redacted;
}

function toRedactedSourcePayload(input: LlmRiskAssistantInput): JsonRecord {
  const payload: JsonRecord = {
    source: input.source,
    source_id: input.source_id,
    observed_at: input.observed_at,
    content: redactLlmRiskAssistantAuditText(input.content),
    metadata: redactLlmRiskAssistantAuditValue(input.metadata),
  };

  assignIfDefined(payload, "market", input.market);
  assignIfDefined(payload, "notice_url", input.notice_url);
  assignIfDefined(payload, "title", redactOptionalText(input.title));

  return payload;
}

function toRedactedResponsePayload(response: LlmRiskAssistantProviderResponse): JsonRecord {
  if (response.status === "ok") {
    return {
      status: response.status,
      completed_at: response.completed_at,
      result: toRedactedResultPayload(response.result),
      metadata: redactLlmRiskAssistantAuditValue(response.metadata),
    };
  }

  return {
    status: response.status,
    failed_at: response.failed_at,
    failure_class: response.failure_class,
    reason_code: response.reason_code,
    message: redactLlmRiskAssistantAuditText(response.message),
    issues: redactLlmRiskAssistantAuditValue(response.issues),
    metadata: redactLlmRiskAssistantAuditValue(response.metadata),
  };
}

function toRedactedResultPayload(result: LlmRiskAssistantResult): JsonRecord {
  const payload: JsonRecord = {
    schema_version: result.schema_version,
    result_type: result.result_type,
    source_ids: [...result.source_ids],
    summary: redactLlmRiskAssistantAuditText(result.summary),
    recommended_action: result.recommended_action,
    observed_at: result.observed_at,
  };

  assignIfDefined(payload, "market", result.market);
  assignIfDefined(payload, "reason_codes", result.reason_codes);
  assignIfDefined(payload, "requires_human_review", result.requires_human_review);
  assignIfDefined(
    payload,
    "evidence",
    result.evidence?.map((evidence) => redactLlmRiskAssistantAuditText(evidence)),
  );
  assignIfDefined(payload, "metadata", redactLlmRiskAssistantAuditValue(result.metadata));

  return payload;
}

function inferAuditOccurredAt(
  response: LlmRiskAssistantProviderResponse,
  request: LlmRiskAssistantProviderRequest,
): TimestampInput {
  return response.status === "ok" ? response.completed_at : response.failed_at ?? request.requested_at;
}

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isSensitiveKey(key: string): boolean {
  const normalized = key.replace(/[^a-z0-9]/giu, "").toLowerCase();

  return sensitiveKeyFragments.some((fragment) => normalized.includes(fragment));
}

function redactOptionalText(value: string | undefined): string | undefined {
  return value === undefined ? undefined : redactLlmRiskAssistantAuditText(value);
}

function assignIfDefined(target: JsonRecord, key: string, value: unknown): void {
  if (value !== undefined) {
    target[key] = value;
  }
}
