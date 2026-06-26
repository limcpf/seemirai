import { createHash } from "node:crypto";
import type { JsonRecord, TimestampInput } from "../../domain/index.js";
import {
  formatLiveOpsBriefing,
  validateLiveOpsBriefingSnapshotSafety,
  type LiveOpsBriefingSnapshot,
} from "../live-ops-briefing.js";
import type {
  LlmRiskAssistantProviderId,
  LlmRiskAssistantProviderRequest,
  LlmRiskAssistantProviderResponse,
  LlmRiskAssistantResult,
} from "./contracts.js";
import { LLM_RISK_ASSISTANT_SCHEMA_VERSION } from "./contracts.js";

const liveOpsBriefingPromptMaxCharacters = 3_500;

/**
 * Live Ops briefing LLM request를 만들기 위한 입력이다.
 *
 * caller는 이미 deterministic `LiveOpsBriefingSnapshot`을 만든 뒤 이 경계를 호출한다. 이 타입은 provider 호출을 직접
 * 수행하지 않으며, prompt와 metadata를 생성해 후속 provider/audit 경계가 같은 fingerprint와 source id를 보존하게 한다.
 */
export interface CreateLiveOpsBriefingLlmRequestInput {
  snapshot: LiveOpsBriefingSnapshot;
  requestedAt: TimestampInput;
  timeoutMs: number;
  maxOutputBytes: number;
  correlationId?: string | undefined;
  metadata?: JsonRecord | undefined;
}

/**
 * LLM briefing draft가 operator-facing 결과에 붙은 상태다.
 *
 * `recommended_action`은 이 attachment에 포함하지 않는다. LLM은 설명 초안만 제공하며, action enum은 주문 허용이나 broker
 * 호출 경계로 전달되지 않아야 한다.
 */
export interface LiveOpsBriefingDraftAttachment {
  text: string;
  providerId: LlmRiskAssistantProviderId;
  sourceIds: readonly string[];
  observedAt: TimestampInput;
  reasonCodes: readonly string[];
  requiresHumanReview: boolean;
}

/**
 * LLM briefing draft를 deterministic briefing에 붙이는 입력이다.
 *
 * provider response는 이미 normalization을 통과했거나 failure로 낮아진 상태여야 한다. 이 함수는 Telegram 전송, audit write,
 * broker 호출 side effect를 수행하지 않는다.
 */
export interface AttachLlmLiveOpsBriefingDraftInput {
  deterministicText: string;
  request: LlmRiskAssistantProviderRequest;
  response: LlmRiskAssistantProviderResponse;
}

export type AttachLlmLiveOpsBriefingDraftResult =
  | {
      status: "attached";
      reasonCode: "llm_live_ops_briefing_draft_attached";
      deterministicText: string;
      text: string;
      draft: LiveOpsBriefingDraftAttachment;
    }
  | {
      status: "deterministic_only";
      reasonCode: string;
      skippedReason: "provider_failed" | "provider_disabled" | "unsupported_result_type" | "source_mismatch";
      deterministicText: string;
      text: string;
      draft?: undefined;
    };

/**
 * redacted Live Ops snapshot만 사용해 LLM briefing draft provider request를 만든다.
 *
 * prompt에는 deterministic formatter 결과와 safety issue summary만 들어간다. raw snapshot JSON을 그대로 넣지 않으며, prompt
 * fingerprint와 source/evidence/reason id는 request/input metadata에 보존한다. 이 함수는 provider 호출이나 audit write
 * side effect를 만들지 않는다.
 */
export function createLiveOpsBriefingLlmRequest(
  input: CreateLiveOpsBriefingLlmRequestInput,
): LlmRiskAssistantProviderRequest {
  const deterministicText = formatLiveOpsBriefing(input.snapshot, {
    maxCharacters: liveOpsBriefingPromptMaxCharacters,
  });
  const safetyIssues = validateLiveOpsBriefingSnapshotSafety(input.snapshot);
  const sourceId = createLiveOpsBriefingSourceId(input.snapshot, deterministicText, safetyIssues);
  const prompt = createLiveOpsBriefingPrompt({
    sourceId,
    deterministicText,
    safetyIssues: safetyIssues.map((issue) => ({
      path: issue.path,
      reason: issue.reason,
      redactedPreview: issue.redactedPreview,
    })),
  });
  const promptSha256 = hashText(prompt);
  const sourceIds = [...input.snapshot.trace.sourceIds];
  const evidenceIds = [...input.snapshot.trace.evidenceIds];
  const reasonCodes = [...input.snapshot.trace.reasonCodes];
  const metadata: JsonRecord = {
    snapshot_schema_version: input.snapshot.schemaVersion,
    snapshot_observed_at: input.snapshot.observedAt,
    prompt_sha256: promptSha256,
    briefing_sha256: hashText(deterministicText),
    source_ids: sourceIds,
    evidence_ids: evidenceIds,
    reason_codes: reasonCodes,
    safety_issue_count: safetyIssues.length,
  };
  if (input.metadata !== undefined) {
    // 호출자 metadata가 prompt/source/evidence 추적 필드를 덮으면 audit 재현성이 깨지므로 별도 namespace에만 보존한다.
    metadata.caller_metadata = input.metadata;
  }

  return {
    input: {
      source: "live_ops_status_snapshot",
      source_id: sourceId,
      observed_at: input.snapshot.observedAt,
      title: "Live Ops 브리핑 snapshot",
      content: deterministicText,
      metadata,
    },
    result_type: "live_ops_briefing_draft",
    prompt,
    requested_at: input.requestedAt,
    timeout_ms: input.timeoutMs,
    max_output_bytes: input.maxOutputBytes,
    correlation_id: input.correlationId,
    metadata,
  };
}

/**
 * LLM provider 결과를 deterministic briefing 위의 보조 초안으로만 붙인다.
 *
 * provider 실패, 다른 result type, source mismatch는 모두 deterministic briefing fallback으로 수렴한다. 성공하더라도
 * recommended action은 반환하지 않아 후속 Telegram/runtime 경계가 주문 신호로 오해하지 않게 한다.
 */
export function attachLlmLiveOpsBriefingDraft(
  input: AttachLlmLiveOpsBriefingDraftInput,
): AttachLlmLiveOpsBriefingDraftResult {
  if (input.response.status === "failed") {
    // LLM 실패는 briefing 생성을 실패시키지 않고 deterministic 문구를 그대로 전송하게 한다.
    return createDeterministicOnlyResult(input.deterministicText, input.response.reason_code, "provider_failed");
  }
  if (input.response.provider_id === "noop") {
    // disabled provider의 성공 응답은 LLM 초안이 아니므로 operator에게 deterministic briefing만 보여준다.
    return createDeterministicOnlyResult(
      input.deterministicText,
      "llm_live_ops_briefing_provider_disabled",
      "provider_disabled",
    );
  }

  const result = input.response.result;
  if (result.result_type !== "live_ops_briefing_draft") {
    // 다른 LLM 결과 타입은 operator briefing 초안으로 오해될 수 있어 첨부하지 않는다.
    return createDeterministicOnlyResult(
      input.deterministicText,
      "llm_live_ops_briefing_unsupported_result_type",
      "unsupported_result_type",
    );
  }

  if (!hasExactSourceMatch(result, input.request.input.source_id)) {
    // source mismatch는 stale prompt나 hallucinated context 가능성이 있어 deterministic 결과만 유지한다.
    return createDeterministicOnlyResult(
      input.deterministicText,
      "llm_live_ops_briefing_source_mismatch",
      "source_mismatch",
    );
  }

  const draft: LiveOpsBriefingDraftAttachment = {
    text: normalizeInlineText(result.summary),
    providerId: input.response.provider_id,
    sourceIds: [...result.source_ids],
    observedAt: result.observed_at,
    reasonCodes: [...(result.reason_codes ?? [])],
    requiresHumanReview: result.requires_human_review ?? false,
  };

  return {
    status: "attached",
    reasonCode: "llm_live_ops_briefing_draft_attached",
    deterministicText: input.deterministicText,
    text: [
      input.deterministicText,
      "",
      "LLM 보조 초안",
      draft.text,
    ].join("\n"),
    draft,
  };
}

function createLiveOpsBriefingPrompt(input: {
  sourceId: string;
  deterministicText: string;
  safetyIssues: readonly { path: string; reason: string; redactedPreview: string }[];
}): string {
  return [
    "아래 redacted Live Ops briefing snapshot을 한국어 운영 브리핑 초안으로 요약한다.",
    "JSON object만 출력한다. markdown, code fence, 설명 문장은 쓰지 않는다.",
    `schema_version은 ${LLM_RISK_ASSISTANT_SCHEMA_VERSION}만 사용한다.`,
    "result_type은 live_ops_briefing_draft만 사용한다.",
    `source_ids는 [\"${input.sourceId}\"]만 사용한다.`,
    "recommended_action은 NO_ACTION, BLOCK_NEW_ENTRY, CANCEL_PENDING, PAUSE_STRATEGY, ALERT_ONLY 중 하나만 사용한다.",
    "금지: BUY, SELL, INCREASE_POSITION, 목표가, 주문 수량, 직접 매수/매도 권고, LLM 단독 주문 허용.",
    "deterministic briefing이 source of truth이며 LLM은 사람이 읽을 보조 초안만 작성한다.",
    "",
    "redacted_deterministic_briefing:",
    input.deterministicText,
    "",
    "safety_issues:",
    formatSafetyIssuesForPrompt(input.safetyIssues),
  ].join("\n");
}

function formatSafetyIssuesForPrompt(
  issues: readonly { path: string; reason: string; redactedPreview: string }[],
): string {
  if (issues.length === 0) {
    return "없음";
  }

  return issues
    .map((issue) => `- path=${issue.path}; reason=${issue.reason}; preview=${issue.redactedPreview}`)
    .join("\n");
}

function createLiveOpsBriefingSourceId(
  snapshot: LiveOpsBriefingSnapshot,
  deterministicText: string,
  safetyIssues: readonly { path: string; reason: string; redactedPreview: string }[],
): string {
  return `live-ops-status-snapshot-${hashText(JSON.stringify({
    schemaVersion: snapshot.schemaVersion,
    observedAt: snapshot.observedAt,
    sourceIds: snapshot.trace.sourceIds,
    evidenceIds: snapshot.trace.evidenceIds,
    deterministicText,
    safetyIssues,
  })).slice(0, 24)}`;
}

function hasExactSourceMatch(result: LlmRiskAssistantResult, sourceId: string): boolean {
  return result.source_ids.length === 1 && result.source_ids[0] === sourceId;
}

function createDeterministicOnlyResult(
  deterministicText: string,
  reasonCode: string,
  skippedReason: "provider_failed" | "provider_disabled" | "unsupported_result_type" | "source_mismatch",
): AttachLlmLiveOpsBriefingDraftResult {
  return {
    status: "deterministic_only",
    reasonCode,
    skippedReason,
    deterministicText,
    text: deterministicText,
  };
}

function normalizeInlineText(value: string): string {
  return value.replace(/[\r\n]+/gu, " ").replace(/[ \t]{2,}/gu, " ").trim();
}

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
