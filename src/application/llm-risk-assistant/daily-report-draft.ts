import type { DailyReportNotification } from "../ports/index.js";
import type {
  JsonRecord,
  TimestampInput,
} from "../../domain/index.js";
import type {
  LlmRiskAssistantProviderId,
  LlmRiskAssistantProviderRequest,
  LlmRiskAssistantProviderResponse,
  LlmRiskAssistantResult,
} from "./contracts.js";

export type LlmDailyReportDraftBoundaryStatus = "attached" | "deterministic_only";

export type LlmDailyReportDraftSkippedReason =
  | "provider_failed"
  | "unsupported_result_type";

/**
 * deterministic daily report에 덧붙일 수 있는 LLM 보조 초안이다.
 *
 * 이 타입은 사람이 읽을 보조 문단과 provider/source 추적 정보만 담는다. 주문 action, 목표가, 포지션 크기, 알림 전송
 * 상태는 포함하지 않아 daily report draft가 trading/runtime side effect로 확장되지 않는 invariant를 유지한다.
 */
export interface LlmDailyReportDraftAttachment {
  text: string;
  providerId: LlmRiskAssistantProviderId;
  sourceIds: readonly string[];
  observedAt: TimestampInput;
  reasonCodes: readonly string[];
  requiresHumanReview: boolean;
  metadata?: JsonRecord | undefined;
}

/**
 * deterministic daily report와 LLM draft 보조 결과를 함께 반환하는 순수 boundary 결과다.
 *
 * `notification`은 호출자가 이미 생성한 deterministic report payload를 그대로 보존한다. `draft`는 선택적 보조
 * 텍스트이며, provider 실패나 비대상 result type에서는 비워야 한다. 이 타입 자체는 Telegram 전송, DB write, job 상태
 * 전이를 수행하지 않는다.
 */
export interface DailyReportWithLlmDraft {
  notification: DailyReportNotification;
  status: LlmDailyReportDraftBoundaryStatus;
  reasonCode: string;
  draft?: LlmDailyReportDraftAttachment | undefined;
  skippedReason?: LlmDailyReportDraftSkippedReason | undefined;
  metadata?: JsonRecord | undefined;
}

/**
 * LLM daily report draft를 deterministic report 옆에 보조 초안으로만 붙인다.
 *
 * provider 실패와 비대상 result type은 deterministic report 성공을 실패로 바꾸지 않고 `deterministic_only`로 수렴한다.
 * 성공한 `daily_report_draft`도 기존 notification summary나 metadata를 변경하지 않으며, 외부 side effect 없이 새 결과
 * 객체만 반환한다.
 */
export function attachLlmDailyReportDraft(input: {
  notification: DailyReportNotification;
  request: LlmRiskAssistantProviderRequest;
  response: LlmRiskAssistantProviderResponse;
}): DailyReportWithLlmDraft {
  if (input.response.status === "failed") {
    // LLM draft 실패는 운영 리포트 생성 성공을 되돌리면 안 되므로 실패 증거만 분리하고 deterministic payload를 유지한다.
    return createDeterministicOnlyResult({
      notification: input.notification,
      reasonCode: input.response.reason_code,
      skippedReason: "provider_failed",
      metadata: {
        provider_id: input.response.provider_id,
        failure_class: input.response.failure_class,
      },
    });
  }

  if (!isDailyReportDraftResult(input.request, input.response.result)) {
    // daily report draft가 아닌 LLM 결과는 리포트 본문 보조 텍스트로 오해될 수 있어 첨부하지 않는다.
    return createDeterministicOnlyResult({
      notification: input.notification,
      reasonCode: "llm_daily_report_draft_unsupported_result_type",
      skippedReason: "unsupported_result_type",
      metadata: {
        provider_id: input.response.provider_id,
        request_result_type: input.request.result_type,
        response_result_type: input.response.result.result_type,
      },
    });
  }

  const draft = createDraftAttachment(input.response.provider_id, input.response.result);

  return {
    notification: input.notification,
    status: "attached",
    reasonCode: "llm_daily_report_draft_attached",
    draft,
    metadata: {
      schema_boundary: "llm_daily_report_draft_attachment",
      deterministic_report_date: input.notification.reportDate,
      provider_id: input.response.provider_id,
      source_ids: [...input.response.result.source_ids],
    },
  };
}

/**
 * LLM 결과가 daily report draft 첨부 대상인지 확인한다.
 *
 * request와 response가 모두 `daily_report_draft`일 때만 true를 반환한다. provider normalization이 mismatch를 이미
 * 실패로 바꾸더라도 이 boundary는 stale response 재사용을 막기 위해 한 번 더 닫힌 조건을 적용한다.
 */
function isDailyReportDraftResult(
  request: LlmRiskAssistantProviderRequest,
  result: LlmRiskAssistantResult,
): boolean {
  return request.result_type === "daily_report_draft" && result.result_type === "daily_report_draft";
}

/**
 * provider 결과를 사람이 읽을 LLM draft attachment로 축약한다.
 *
 * `recommended_action`은 의도적으로 출력하지 않는다. daily report draft의 역할은 deterministic report를 보조하는 설명
 * 텍스트뿐이며, action을 노출하면 리포트 초안이 운영 차단이나 주문 판단 신호로 재사용될 수 있기 때문이다.
 */
function createDraftAttachment(
  providerId: LlmRiskAssistantProviderId,
  result: LlmRiskAssistantResult,
): LlmDailyReportDraftAttachment {
  const draft: LlmDailyReportDraftAttachment = {
    text: result.summary,
    providerId,
    sourceIds: [...result.source_ids],
    observedAt: result.observed_at,
    reasonCodes: [...(result.reason_codes ?? [])],
    requiresHumanReview: result.requires_human_review === true,
  };

  assignIfDefined(draft, "metadata", createDraftMetadata(result));

  return draft;
}

/**
 * LLM draft attachment에 넣을 audit-friendly metadata를 만든다.
 *
 * metadata는 evidence 개수와 source id만 보존한다. provider result metadata는 모델이 만든 자유 JSON이라 target price,
 * position size 같은 order-like key가 숨어 있을 수 있으므로 이 boundary에서 재노출하지 않는다.
 */
function createDraftMetadata(result: LlmRiskAssistantResult): JsonRecord {
  return {
    result_type: result.result_type,
    source_ids: [...result.source_ids],
    evidence_count: result.evidence?.length ?? 0,
  };
}

/**
 * LLM draft를 붙이지 않고 deterministic report만 반환하는 결과를 만든다.
 *
 * provider failure나 비대상 result type을 예외로 던지면 기존 report runner가 성공한 deterministic report까지 실패시킬
 * 위험이 있다. 그래서 이 helper는 실패 이유를 metadata로 남기고 notification 객체는 그대로 보존한다.
 */
function createDeterministicOnlyResult(input: {
  notification: DailyReportNotification;
  reasonCode: string;
  skippedReason: LlmDailyReportDraftSkippedReason;
  metadata: JsonRecord;
}): DailyReportWithLlmDraft {
  return {
    notification: input.notification,
    status: "deterministic_only",
    reasonCode: input.reasonCode,
    skippedReason: input.skippedReason,
    metadata: {
      schema_boundary: "llm_daily_report_draft_attachment",
      deterministic_report_date: input.notification.reportDate,
      ...input.metadata,
    },
  };
}

/**
 * undefined가 아닌 optional 값만 출력 객체에 붙이는 순수 조립 helper다.
 *
 * optional field를 undefined로 남기면 audit JSON과 테스트 fixture에서 "값 없음"과 "명시적 undefined"가 섞인다. 이 helper는
 * 필요한 값만 보존해 후속 persistence/리포트 formatter가 같은 payload 형태를 보게 한다.
 */
function assignIfDefined<T extends object, K extends keyof T>(target: T, key: K, value: T[K] | undefined): void {
  if (value !== undefined) {
    target[key] = value;
  }
}
