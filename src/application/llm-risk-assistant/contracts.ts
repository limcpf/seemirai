import type { JsonRecord, MarketCode, TimestampInput } from "../../domain/index.js";

export const LLM_RISK_ASSISTANT_SCHEMA_VERSION = "m10.llm_risk_assistant.v1" as const;

export const llmRiskAssistantInputSources = [
  "exchange_notice",
  "developer_changelog",
  "market_event",
] as const;

export const llmRiskAssistantResultTypes = [
  "notice_summary",
  "notice_risk_classification",
  "event_explanation",
  "daily_report_draft",
] as const;

export const llmRiskAssistantActions = [
  "NO_ACTION",
  "BLOCK_NEW_ENTRY",
  "CANCEL_PENDING",
  "PAUSE_STRATEGY",
  "ALERT_ONLY",
] as const;

export const llmForbiddenTradeActions = ["BUY", "SELL", "INCREASE_POSITION"] as const;

/**
 * LLM 보조 계층이 지원하는 schema version이다.
 *
 * provider raw 응답, audit evidence, RiskGate mapper가 같은 버전을 참조해야 하며, version mismatch는 후속
 * normalization 단계에서 fail-closed 처리 대상이다. 이 값 자체는 외부 side effect가 없다.
 */
export type LlmRiskAssistantSchemaVersion = typeof LLM_RISK_ASSISTANT_SCHEMA_VERSION;

/**
 * LLM 요청으로 보낼 수 있는 공식 입력 원천이다.
 *
 * 일반 뉴스, SNS, 커뮤니티, 루머성 Telegram 같은 비공식 원천은 이 union에 포함하지 않는다. prompt builder는 provider
 * 호출 전에 이 값을 검증해 LLM이 주문 후보 생성 경계로 우회 진입하지 못하게 해야 한다.
 */
export type LlmRiskAssistantInputSource = (typeof llmRiskAssistantInputSources)[number];

/**
 * LLM 결과가 수행할 수 있는 보조 업무 유형이다.
 *
 * 결과 타입은 공지 요약, 리스크 분류, 이벤트 설명, daily report draft처럼 거래 판단을 대체하지 않는 표면으로 제한한다.
 */
export type LlmRiskAssistantResultType = (typeof llmRiskAssistantResultTypes)[number];

/**
 * LLM 결과가 RiskGate나 알림 경계에 전달할 수 있는 안전 action이다.
 *
 * 모든 값은 신규 주문 허용이 아니라 차단, 취소 후보, 전략 일시정지, 알림, 무동작 중 하나로 수렴한다.
 */
export type LlmRiskAssistantAction = (typeof llmRiskAssistantActions)[number];

/**
 * LLM 결과에 나타나면 즉시 거부해야 하는 거래 지시 action이다.
 *
 * 이 목록은 허용 enum과 별도로 테스트 근거로 보존한다. schema validation은 이 값들을 정상화하지 않고 provider 결과를
 * fail-closed로 거부해야 한다.
 */
export type LlmForbiddenTradeAction = (typeof llmForbiddenTradeActions)[number];

/**
 * LLM 요청 생성 전에 확정되어야 하는 공식 입력 payload다.
 *
 * 입력은 원천 식별자, 관측 시각, 원문 위치, redaction이 끝난 본문을 포함한다. 이 contract는 provider 호출 전 경계이며,
 * DB write나 외부 API 호출 같은 side effect를 직접 수행하지 않는다.
 */
export interface LlmRiskAssistantInput {
  source: LlmRiskAssistantInputSource;
  source_id: string;
  observed_at: TimestampInput;
  content: string;
  market?: MarketCode | undefined;
  notice_url?: string | undefined;
  title?: string | undefined;
  metadata?: JsonRecord | undefined;
}

/**
 * provider 응답을 schema validation 후 사용하는 normalized LLM 결과다.
 *
 * 이 결과는 주문 후보나 주문 허용 판단을 표현할 수 없다. 후속 mapper는 `recommended_action`을 차단/주의 신호로만
 * 변환해야 하며, 이 타입 자체는 persistence나 broker side effect를 만들지 않는다.
 */
export interface LlmRiskAssistantResult {
  schema_version: LlmRiskAssistantSchemaVersion;
  result_type: LlmRiskAssistantResultType;
  source_ids: readonly string[];
  summary: string;
  recommended_action: LlmRiskAssistantAction;
  observed_at: TimestampInput;
  market?: MarketCode | undefined;
  reason_codes?: readonly string[] | undefined;
  requires_human_review?: boolean | undefined;
  evidence?: readonly string[] | undefined;
  metadata?: JsonRecord | undefined;
}

/**
 * LLM contract validation 실패를 audit-friendly 형태로 정규화한 단일 issue다.
 *
 * raw provider payload나 secret 후보 문자열을 보존하지 않고 path, zod code, 메시지만 남겨 report와 log에 안전하게
 * 연결할 수 있다.
 */
export interface LlmRiskAssistantContractIssue {
  path: string;
  code: string;
  message: string;
}
