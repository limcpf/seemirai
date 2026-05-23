import { z, type ZodIssue } from "zod";
import type { JsonRecord } from "../../domain/index.js";
import {
  LLM_RISK_ASSISTANT_SCHEMA_VERSION,
  llmForbiddenTradeActions,
  llmRiskAssistantActions,
  llmRiskAssistantInputSources,
  llmRiskAssistantResultTypes,
  type LlmForbiddenTradeAction,
  type LlmRiskAssistantContractIssue,
  type LlmRiskAssistantInput,
  type LlmRiskAssistantResult,
} from "./contracts.js";

const JsonRecordSchema: z.ZodType<JsonRecord> = z.record(z.string(), z.unknown());
const StableIdSchema = z.string().trim().min(1).max(512);
const BoundedTextSchema = z.string().trim().min(1).max(20_000);
const TimestampSchema = z.union([z.string().datetime({ offset: true }), z.date()]);
const MarketCodeSchema = z.string().regex(/^KRW-[A-Z0-9]+$/u, "KRW market code is required");
const NoticeUrlSchema = z.string().url().max(2_048);
const ReasonCodeSchema = z.string().trim().min(1).max(128).regex(/^[a-z0-9_:-]+$/u);

export const LlmRiskAssistantInputSourceSchema = z.enum(llmRiskAssistantInputSources);
export const LlmRiskAssistantResultTypeSchema = z.enum(llmRiskAssistantResultTypes);
export const LlmRiskAssistantActionSchema = z.enum(llmRiskAssistantActions);

/**
 * LLM 요청 생성 전 공식 입력만 통과시키는 schema다.
 *
 * `.strict()`는 비공식 source나 예상 밖 payload가 prompt builder까지 흘러들어 provider 호출 비용과 audit 오염을 만들기
 * 전에 차단하기 위한 fail-closed 경계다.
 */
export const LlmRiskAssistantInputSchema: z.ZodType<LlmRiskAssistantInput> = z
  .object({
    source: LlmRiskAssistantInputSourceSchema,
    source_id: StableIdSchema,
    observed_at: TimestampSchema,
    content: BoundedTextSchema,
    market: MarketCodeSchema.optional(),
    notice_url: NoticeUrlSchema.optional(),
    title: z.string().trim().min(1).max(500).optional(),
    metadata: JsonRecordSchema.optional(),
  })
  .strict();

/**
 * provider normalized output을 주문 비허용 LLM 결과로 제한하는 schema다.
 *
 * 허용 action enum과 `.strict()`를 함께 사용해 `BUY`, 목표가, 포지션 크기 같은 거래 지시 후보가 결과 payload에 섞이면
 * 정상화하지 않고 즉시 거부한다.
 */
export const LlmRiskAssistantResultSchema: z.ZodType<LlmRiskAssistantResult> = z
  .object({
    schema_version: z.literal(LLM_RISK_ASSISTANT_SCHEMA_VERSION),
    result_type: LlmRiskAssistantResultTypeSchema,
    source_ids: z.array(StableIdSchema).min(1),
    summary: BoundedTextSchema,
    recommended_action: LlmRiskAssistantActionSchema,
    observed_at: TimestampSchema,
    market: MarketCodeSchema.optional(),
    reason_codes: z.array(ReasonCodeSchema).min(1).max(20).optional(),
    requires_human_review: z.boolean().optional(),
    evidence: z.array(z.string().trim().min(1).max(2_000)).max(20).optional(),
    metadata: JsonRecordSchema.optional(),
  })
  .strict();

/**
 * LLM contract schema 검증 실패다.
 *
 * 외부 payload 전체를 error에 보존하지 않고 정규화된 issue만 노출한다. 호출자는 이 예외를 provider failure evidence로
 * 저장하되 주문 후보 생성이나 주문 제출로 이어지지 않게 해야 한다.
 */
export class LlmRiskAssistantContractError extends Error {
  public readonly reasonCode: string;
  public readonly issues: readonly LlmRiskAssistantContractIssue[];

  public constructor(reasonCode: string, issues: readonly LlmRiskAssistantContractIssue[]) {
    super(`${reasonCode}: ${issues.map((issue) => issue.path).join(", ")}`);
    this.name = "LlmRiskAssistantContractError";
    this.reasonCode = reasonCode;
    this.issues = issues;
  }
}

/**
 * provider 호출 전 LLM 입력 contract를 검증한다.
 *
 * unsupported source는 이 함수에서 예외로 끝나야 하며, prompt builder나 provider adapter는 실패한 입력으로 외부 호출을
 * 시도하지 않는다. 이 함수는 검증만 수행하며 외부 side effect가 없다.
 */
export function parseLlmRiskAssistantInput(input: unknown): LlmRiskAssistantInput {
  const result = LlmRiskAssistantInputSchema.safeParse(input);

  if (!result.success) {
    // 비공식 입력 원천은 LLM 요청 생성 전에 멈춰야 주문 경계 우회와 audit 오염을 동시에 막을 수 있다.
    throw new LlmRiskAssistantContractError(
      "llm_risk_assistant_input_invalid",
      normalizeContractIssues(result.error.issues),
    );
  }

  return result.data;
}

/**
 * provider normalized output을 안전한 LLM 결과 contract로 검증한다.
 *
 * forbidden action, 알 수 없는 result type, 주문 유사 필드는 모두 같은 fail-closed 오류로 수렴한다. 이 함수는 결과를
 * 수정하거나 허용 action으로 대체하지 않는다.
 */
export function parseLlmRiskAssistantResult(input: unknown): LlmRiskAssistantResult {
  const result = LlmRiskAssistantResultSchema.safeParse(input);

  if (!result.success) {
    // 모델 응답을 보정하면 매매 지시가 차단 신호로 오인될 수 있으므로 schema 실패는 그대로 evidence로 남긴다.
    throw new LlmRiskAssistantContractError(
      "llm_risk_assistant_result_invalid",
      normalizeContractIssues(result.error.issues),
    );
  }

  return result.data;
}

/**
 * 특정 action 값이 명시적으로 금지된 거래 지시인지 확인한다.
 *
 * schema validation 전후의 테스트와 provider mapper guard에서 사용할 수 있는 순수 함수이며 외부 side effect가 없다.
 */
export function isForbiddenLlmTradeAction(action: unknown): action is LlmForbiddenTradeAction {
  return (
    typeof action === "string" &&
    llmForbiddenTradeActions.includes(action as LlmForbiddenTradeAction)
  );
}

/**
 * Zod 검증 실패를 raw payload 없는 contract issue 목록으로 축약한다.
 *
 * path/code/message만 남겨 로그와 리뷰 보고서에서 secret-like 문자열이 재노출되지 않게 한다.
 */
function normalizeContractIssues(issues: readonly ZodIssue[]): readonly LlmRiskAssistantContractIssue[] {
  return issues.map((issue) => ({
    path: issue.path.length > 0 ? issue.path.join(".") : "<root>",
    code: issue.code,
    message: issue.message,
  }));
}
