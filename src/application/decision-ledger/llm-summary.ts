import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import type { DecisionLedgerFrame, DecisionEvidenceItem, DecisionLedgerJsonRecord } from "./types.js";
import {
  LLM_RISK_ASSISTANT_SCHEMA_VERSION,
  type LlmRiskAssistantProviderPort,
  type LlmRiskAssistantProviderResponse,
} from "../llm-risk-assistant/contracts.js";

const LLM_SUMMARY_PROMPT_MAX_CHARS = 20_000;
const LLM_SUMMARY_RESULT_TYPE = "event_explanation" as const;

/**
 * LLM summary 생성에 필요한 결정론적 ledger context다.
 *
 * 이 입력은 이미 append-only로 기록된 frame과 evidence item 목록에서 추출하며,
 * 외부 provider 호출 전에 frame/evidence가 `EXPLANATION_FAILED` category를
 * 오염시키지 않도록 검증한다.
 */
export interface LlmSummaryInput {
  /** 요약 대상 frame. */
  readonly frame: DecisionLedgerFrame;
  /** frame에 연결된 evidence item 목록. */
  readonly evidenceItems: readonly DecisionEvidenceItem[];
}

/**
 * LLM 보조 summary 생성 결과다.
 *
 * 성공 시 `EXPLANATION_SUMMARY` evidence item을 반환하고, 실패 시
 * `EXPLANATION_FAILURE` evidence item을 반환한다. 어떤 경로도
 * frame category를 변경하지 않으며, 결정론적 why summary는 항상 독립적으로 동작한다.
 */
export type LlmSummaryResult =
  | {
      readonly status: "success";
      /** EXPLANATION_SUMMARY evidence item. */
      readonly evidence: DecisionEvidenceItem;
      /** 실제로 생성된 한국어 summary text. */
      readonly summaryText: string;
    }
  | {
      readonly status: "failed";
      /** EXPLANATION_FAILURE evidence item. */
      readonly evidence: DecisionEvidenceItem;
      /** 실패 원인 reason code. */
      readonly failureReason: string;
      /** provider failure class (있으면). */
      readonly failureClass?: string;
    };

/**
 * LLM summary 생성 옵션.
 */
export interface LlmSummaryOptions {
  /** provider 호출 timeout (ms). 기본값 30_000 (30초). */
  readonly timeoutMs?: number;
  /** provider 응답 최대 byte 크기. 기본값 8_192 (8KB). */
  readonly maxOutputBytes?: number;
  /** summary 생성을 요청한 correlation id. 없으면 frame fingerprint를 사용한다. */
  readonly correlationId?: string;
}

/**
 * LLM provider를 통해 결정론적 ledger evidence의 보조 한국어 summary를 생성한다.
 *
 * ## 경계 (invariant)
 *
 * - LLM은 결정론적 why summary를 대체하지 않고 보조 초안만 제공한다.
 * - LLM failure는 `EXPLANATION_FAILURE` evidence로만 기록하며, `/status.why`의
 *   결정론적 summary가 정상 동작하는 것을 막지 않는다 (fail-closed).
 * - LLM output에 매수/매도/목표가/포지션크기 같은 주문 지시가 포함되면
 *   summary attachment에서 제외하고 fail-closed evidence로 남긴다.
 * - 이 함수는 순수 application logic이며, DB write나 broker side effect를
 *   직접 수행하지 않는다.
 *
 * @param provider LLM provider port (noop으로 외부 호출 없이 테스트 가능)
 * @param input 요약 대상 frame과 evidence
 * @param options 생성 옵션
 * @returns LlmSummaryResult
 */
export async function generateLlmSummary(
  provider: LlmRiskAssistantProviderPort,
  input: LlmSummaryInput,
  options: LlmSummaryOptions = {},
): Promise<LlmSummaryResult> {
  const {
    timeoutMs = 30_000,
    maxOutputBytes = 8_192,
    correlationId,
  } = options;

  const { frame, evidenceItems } = input;

  // 과거 LLM 설명 산출물은 다음 LLM 입력 근거가 되면 경계가 순환하므로 결정론적 evidence만 prompt에 넣는다.
  const deterministicEvidenceItems = evidenceItems.filter(isDeterministicEvidenceItem);
  const prompt = buildLlmSummaryPrompt(frame, deterministicEvidenceItems);
  if (prompt.length > LLM_SUMMARY_PROMPT_MAX_CHARS) {
    return buildExplanationFailureEvidence({
      frameDedupeKey: frame.dedupeKey,
      sourceFrameId: frame.sourceFrameId,
      reasonCode: "llm_summary_prompt_too_large",
      userMessage: "LLM 설명 생성 입력이 허용 크기를 초과해 provider 호출을 생략했습니다.",
      failureClass: "output_too_large",
      occurredAt: new Date(),
      metadataPayload: {
        providerId: provider.providerId,
        promptLength: prompt.length,
        maxPromptChars: LLM_SUMMARY_PROMPT_MAX_CHARS,
        evidenceCount: deterministicEvidenceItems.length,
      },
    });
  }

  let response: LlmRiskAssistantProviderResponse;
  try {
    // provider 구현체가 failure union 대신 예외를 던져도 주문 판단 경계로 전파하지 않고 보조 설명 실패로만 접는다.
    response = await provider.generate({
      input: {
        source: "exchange_notice",
        source_id: frame.dedupeKey,
        observed_at: frame.decisionAt,
        content: prompt,
        market: frame.market ?? undefined,
        metadata: {
          frame_id: frame.sourceFrameId,
          evidence_count: deterministicEvidenceItems.length,
          category: frame.category,
        },
      },
      result_type: LLM_SUMMARY_RESULT_TYPE,
      prompt,
      requested_at: new Date(),
      timeout_ms: timeoutMs,
      max_output_bytes: maxOutputBytes,
      correlation_id: correlationId ?? `llm-summary:${frame.dedupeKey}`,
    });
  } catch (error) {
    return buildExplanationFailureEvidence({
      frameDedupeKey: frame.dedupeKey,
      sourceFrameId: frame.sourceFrameId,
      reasonCode: "llm_summary_provider_error",
      userMessage: "LLM provider 호출 중 예외가 발생해 보조 설명을 생성하지 못했습니다.",
      failureClass: "provider_error",
      occurredAt: new Date(),
      metadataPayload: {
        providerId: provider.providerId,
        failureClass: "provider_error",
        timeoutMs,
        maxOutputBytes,
        errorName: error instanceof Error ? error.name : "unknown",
      },
    });
  }

  if (response.status === "failed") {
    // provider failure → EXPLANATION_FAILURE evidence
    return buildExplanationFailureEvidence({
      frameDedupeKey: frame.dedupeKey,
      sourceFrameId: frame.sourceFrameId,
      reasonCode: response.reason_code,
      userMessage: `LLM 설명 생성이 실패했습니다: ${response.message}`,
      failureClass: response.failure_class,
      occurredAt: new Date(response.failed_at as string),
      metadataPayload: {
        providerId: response.provider_id,
        failureClass: response.failure_class,
        timeoutMs,
        maxOutputBytes,
      },
    });
  }

  const result = response.result;

  // provider success union도 현재 frame 설명 요청과 맞지 않으면 stale/mismatched 응답으로 닫는다.
  if (
    result.result_type !== LLM_SUMMARY_RESULT_TYPE ||
    result.source_ids.length !== 1 ||
    result.source_ids[0] !== frame.dedupeKey
  ) {
    return buildExplanationFailureEvidence({
      frameDedupeKey: frame.dedupeKey,
      sourceFrameId: frame.sourceFrameId,
      reasonCode: "llm_summary_response_mismatch",
      userMessage: "LLM provider 응답이 요청한 판단 설명과 일치하지 않아 요약에서 제외했습니다.",
      failureClass: "invalid_schema",
      occurredAt: new Date(),
      metadataPayload: {
        providerId: response.provider_id,
        expectedResultType: LLM_SUMMARY_RESULT_TYPE,
        actualResultType: result.result_type,
        expectedSourceId: frame.dedupeKey,
        sourceIds: [...result.source_ids],
      },
    });
  }

  // provider가 byte cap을 놓쳐도 append-only ledger에는 허용 크기를 넘는 LLM 본문을 저장하지 않는다.
  const summaryBytes = Buffer.byteLength(result.summary, "utf8");
  if (summaryBytes > maxOutputBytes) {
    return buildExplanationFailureEvidence({
      frameDedupeKey: frame.dedupeKey,
      sourceFrameId: frame.sourceFrameId,
      reasonCode: "llm_summary_output_too_large",
      userMessage: "LLM 설명 생성 결과가 허용 크기를 초과해 요약에서 제외했습니다.",
      failureClass: "output_too_large",
      occurredAt: new Date(),
      metadataPayload: {
        providerId: response.provider_id,
        summaryBytes,
        maxOutputBytes,
      },
    });
  }

  // LLM output에 주문 지시나 order-like 출력이 있는지 검사한다.
  const orderLikeIssue = detectOrderLikeOutput(result.summary);
  if (orderLikeIssue !== null) {
    // 주문 지시가 포함된 LLM output은 요약 attachment에서 제외하고 fail-closed evidence로 남긴다.
    return buildExplanationFailureEvidence({
      frameDedupeKey: frame.dedupeKey,
      sourceFrameId: frame.sourceFrameId,
      reasonCode: "llm_summary_order_like_output_blocked",
      userMessage: `LLM 설명 생성 결과에 주문 지시 유사 출력이 포함되어 요약에서 제외했습니다.`,
      failureClass: "invalid_schema",
      occurredAt: new Date(),
      metadataPayload: {
        providerId: response.provider_id,
        blockedReason: orderLikeIssue,
        resultType: result.result_type,
      },
    });
  }

  // 요약 text가 지나치게 짧으면 실질적인 설명이 없는 것으로 본다.
  if (result.summary.trim().length < 10) {
    return buildExplanationFailureEvidence({
      frameDedupeKey: frame.dedupeKey,
      sourceFrameId: frame.sourceFrameId,
      reasonCode: "llm_summary_too_short",
      userMessage: "LLM 설명 생성 결과가 지나치게 짧아 의미 있는 설명으로 보기 어렵습니다.",
      failureClass: "output_too_large",
      occurredAt: new Date(),
      metadataPayload: {
        providerId: response.provider_id,
        summaryLength: result.summary.length,
      },
    });
  }

  // EXPLANATION_SUMMARY evidence item을 생성한다.
  const evidence = buildExplanationSummaryEvidence({
    frameDedupeKey: frame.dedupeKey,
    sourceFrameId: frame.sourceFrameId,
    category: frame.category,
    summaryText: result.summary,
    occurredAt: new Date(),
    sourceId: response.provider_id,
    providerId: response.provider_id,
  });

  return {
    status: "success",
    evidence,
    summaryText: result.summary,
  };
}

/**
 * LLM prompt 입력으로 사용할 수 있는 결정론적 evidence인지 판정한다.
 *
 * `EXPLANATION_SUMMARY`와 `EXPLANATION_FAILURE`는 LLM 보조 계층이 만든 산출물이므로
 * 다음 prompt에 다시 투입하지 않는다. 이 함수는 순수 필터이며 외부 side effect가 없다.
 */
function isDeterministicEvidenceItem(item: DecisionEvidenceItem): boolean {
  switch (item.evidenceKind) {
    case "EXPLANATION_SUMMARY":
    case "EXPLANATION_FAILURE":
      return false;
    default:
      return true;
  }
}

/**
 * 결정론적 ledger evidence로 LLM prompt를 구성한다.
 *
 * prompt에는 한국어 상태/원인/영향/조치 구조를 유지하며,
 * raw payload, secret, 주문 detail은 포함하지 않는다.
 */
function buildLlmSummaryPrompt(
  frame: DecisionLedgerFrame,
  evidenceItems: readonly DecisionEvidenceItem[],
): string {
  const lines: string[] = [];

  lines.push("다음은 자동매매 시스템의 판단 기록입니다. 아래 evidence를 바탕으로");
  lines.push("왜 이 판단이 내려졌는지 한국어로 간결하게 설명해주세요.");
  lines.push("");
  lines.push("## 판단 요약");
  lines.push(`- 구분: ${frame.category}`);
  lines.push(`- 거래소: ${frame.exchange}`);
  if (frame.market !== null) {
    lines.push(`- 종목: ${frame.market}`);
  }
  if (frame.strategyId !== null) {
    lines.push(`- 전략: ${frame.strategyId}`);
  }
  lines.push(`- 관측 시각: ${frame.observedAt.toISOString()}`);
  lines.push(`- 판단 시각: ${frame.decisionAt.toISOString()}`);
  lines.push("");

  if (evidenceItems.length > 0) {
    lines.push("## 근거 evidence");
    for (const item of evidenceItems) {
      const kindLabel = evidenceKindToKorean(item.evidenceKind);
      lines.push(`### ${kindLabel}`);
      lines.push(`- 상태: ${item.category}`);
      if (item.reasonCode !== null) {
        lines.push(`- 사유: ${item.reasonCode}`);
      }
      lines.push(`- 설명: ${item.userMessage}`);
      if (item.impact !== null) {
        lines.push(`- 영향: ${item.impact}`);
      }
      if (item.action !== null) {
        lines.push(`- 조치: ${item.action}`);
      }
      lines.push(`- 출처: ${item.source}`);
      lines.push("");
    }
  }

  lines.push("## 요청");
  lines.push("위 evidence를 종합해, 왜 이 판단이 내려졌는지 한국어로 3-5문장 summary를 작성하세요.");
  lines.push("상태, 원인, 영향, 필요 조치를 포함하고, 투자 자문이나 매수/매도 추천은 절대 하지 마세요.");
  lines.push("");
  lines.push("## 출력 형식");
  lines.push("Markdown이나 자연어 본문 없이 JSON object 하나만 반환하세요.");
  lines.push("JSON은 아래 필드를 정확히 포함해야 합니다.");
  lines.push(`- schema_version: "${LLM_RISK_ASSISTANT_SCHEMA_VERSION}"`);
  lines.push(`- result_type: "${LLM_SUMMARY_RESULT_TYPE}"`);
  lines.push(`- source_ids: ["${frame.dedupeKey}"]`);
  lines.push("- summary: 위 조건을 만족하는 한국어 3-5문장 설명");
  lines.push('- recommended_action: "NO_ACTION"');
  lines.push(`- observed_at: "${frame.decisionAt.toISOString()}"`);
  if (frame.market !== null) {
    lines.push(`- market: "${frame.market}"`);
  }
  lines.push('- reason_codes: ["llm_summary_generated"]');
  lines.push("- requires_human_review: false");

  return lines.join("\n");
}

/**
 * evidence kind를 한국어 label로 변환한다.
 */
function evidenceKindToKorean(kind: string): string {
  switch (kind) {
    case "STRATEGY_DECISION": return "전략 판단";
    case "ORDER_INTENT": return "주문 후보";
    case "DISCARD_REASON": return "폐기 사유";
    case "COST_BREAKDOWN": return "비용 평가";
    case "RISK_DECISION": return "리스크 평가";
    case "EXECUTION_RESULT": return "실행 결과";
    case "PNL_STATUS_CONTEXT": return "PnL 상태";
    case "EXPLANATION_SUMMARY": return "설명 요약";
    case "EXPLANATION_FAILURE": return "설명 실패";
    default: return kind;
  }
}

/**
 * EXPLANATION_SUMMARY evidence item을 생성한다.
 *
 * 이 evidence는 LLM이 생성한 보조 한국어 설명을 담으며,
 * frame category는 원래 판단 category를 그대로 유지한다.
 */
function buildExplanationSummaryEvidence(options: {
  frameDedupeKey: string;
  sourceFrameId: string;
  category: DecisionLedgerFrame["category"];
  summaryText: string;
  occurredAt: Date;
  sourceId: string;
  providerId: string;
}): DecisionEvidenceItem {
  const evidenceFingerprint = `fp-llm-summary:${options.frameDedupeKey}:${hashSimple(options.summaryText)}`;

  return {
    evidenceKind: "EXPLANATION_SUMMARY",
    category: options.category, // 설명 요약은 주문 판단을 대체하지 않고 원 frame category만 추적용으로 보존한다.
    reasonCode: "llm_summary_generated",
    userMessage: "LLM 보조 설명이 생성되었습니다.",
    impact: null,
    action: null,
    occurredAt: options.occurredAt,
    source: `llm-summary:${options.providerId}`,
    sourceId: options.sourceId,
    payload: {
      summary: options.summaryText,
      providerId: options.providerId,
    } as DecisionLedgerJsonRecord,
    evidenceFingerprint,
    trace: {
      sourceFrameId: options.sourceFrameId,
      providerId: options.providerId,
    } as DecisionLedgerJsonRecord,
  };
}

/**
 * EXPLANATION_FAILURE evidence item을 생성한다.
 *
 * category는 반드시 `EXPLANATION_FAILED`, evidenceKind는 `EXPLANATION_FAILURE`다.
 * 이 evidence는 주문 판단을 대체하지 않으며, 결정론적 why summary는 독립적으로 동작한다.
 */
function buildExplanationFailureEvidence(options: {
  frameDedupeKey: string;
  sourceFrameId: string;
  reasonCode: string;
  userMessage: string;
  failureClass: string;
  occurredAt: Date;
  metadataPayload: DecisionLedgerJsonRecord;
}): Extract<LlmSummaryResult, { status: "failed" }> {
  const evidenceFingerprint = `fp-llm-fail:${options.frameDedupeKey}:${hashSimple(`${options.reasonCode}:${options.failureClass}`)}`;

  const evidence: DecisionEvidenceItem = {
    evidenceKind: "EXPLANATION_FAILURE",
    category: "EXPLANATION_FAILED",
    reasonCode: options.reasonCode,
    userMessage: options.userMessage,
    impact: "결정론적 why summary는 정상 동작하며, LLM 보조 설명만 생성되지 않았습니다.",
    action: "LLM provider 상태를 확인하거나 수동으로 설명을 검토하세요.",
    occurredAt: options.occurredAt,
    source: "llm-summary",
    sourceId: null,
    payload: options.metadataPayload,
    evidenceFingerprint,
    trace: {
      sourceFrameId: options.sourceFrameId,
      failureClass: options.failureClass,
    } as DecisionLedgerJsonRecord,
  };

  return {
    status: "failed",
    evidence,
    failureReason: options.reasonCode,
    failureClass: options.failureClass,
  };
}

/**
 * LLM summary text에서 주문 지시나 order-like 출력을 탐지한다.
 *
 * 탐지되면 실패 이유 문자열을 반환하고, 없으면 null을 반환한다.
 * 이 함수는 순수 검사 함수이며 외부 side effect가 없다.
 */
function detectOrderLikeOutput(summaryText: string): string | null {
  const lowerText = summaryText.toLowerCase();

  // 1. 명시적 매수/매도 추천 문구
  const tradeRecommendPatterns: Array<{ pattern: RegExp; label: string }> = [
    { pattern: /매수(?:를|을)?\s*(하세|추천|권장|해야|하십시오|바랍니다)/, label: "매수 추천 문구" },
    { pattern: /매도(?:를|을)?\s*(하세|추천|권장|해야|하십시오|바랍니다)/, label: "매도 추천 문구" },
    { pattern: /매수\s*하는\s*것(?:이|을)?(?:\s*(추천|권장|해야|하십시오|바랍니다))?/, label: "매수 추천 문구" },
    { pattern: /매도\s*하는\s*것(?:이|을)?(?:\s*(추천|권장|해야|하십시오|바랍니다))?/, label: "매도 추천 문구" },
    { pattern: /buy\s*(now|immediately|recommend|should|must)/i, label: "영문 매수 추천" },
    { pattern: /sell\s*(now|immediately|recommend|should|must)/i, label: "영문 매도 추천" },
    { pattern: /지금\s*(사세요|팔|매수|매도)/, label: "즉시 주문 추천" },
  ];

  for (const { pattern, label } of tradeRecommendPatterns) {
    if (pattern.test(lowerText)) {
      return label;
    }
  }

  // 2. 목표가 / 포지션 크기 제안
  const positionPatterns: Array<{ pattern: RegExp; label: string }> = [
    { pattern: /목표가(?:는|가|를|은)?\s*[:：]?\s*[\d,]+/, label: "목표가 제시" },
    { pattern: /목표\s*가격(?:은|는|이|가|을|를)?\s*[:：]?\s*[\d,]+/, label: "목표 가격 제시" },
    { pattern: /target\s*price\s*(?:is|=|[:：])?\s*[\d,]+/i, label: "영문 목표가 제시" },
    { pattern: /포지션\s*(크기|사이즈|비중)(?:은|는|이|가|을|를)?\s*(?:[:：]|=)?\s*[\d.]+%?/, label: "포지션 크기 제시" },
    { pattern: /position\s*size\s*(?:is|=|[:：])?\s*[\d.]+%?/i, label: "영문 포지션 크기 제시" },
    // "30%로 배분", "30% 비중" 등 조사가 끼어든 패턴도 탐지
    { pattern: /[\d.]+\s*%.{0,5}(비중|배분|할당)/, label: "비중 배분 제시" },
    // lowerText 기준으로 검사하므로 영문 자산 단위는 소문자와 한국어 조사 변형까지 함께 차단한다.
    { pattern: /[\d.,]+\s*(btc|eth|krw|원)(?:\s*(?:어치|을|를))?(?:\s*(?:btc|eth|krw)(?:을|를)?)?\s*(매수|매도|사세요|파세요|구매)/, label: "금액 지정 매매 추천" },
  ];

  for (const { pattern, label } of positionPatterns) {
    if (pattern.test(lowerText)) {
      return label;
    }
  }

  // 3. 수익 보장 표현
  const guaranteePatterns: Array<{ pattern: RegExp; label: string }> = [
    // "확실한 수익", "반드시 수익", "무조건 오릅니다" 등 조사/형용사가 끼어들 수 있다
    { pattern: /(확실|반드시|무조건|100%).{0,5}(수익|이익|오릅니다|상승)/, label: "수익 보장 표현" },
    // "손실은 나지 않습니다", "손실이 없습니다" 등
    { pattern: /손실.{0,3}(없|나지\s+않)/, label: "손실 부인 표현" },
  ];

  for (const { pattern, label } of guaranteePatterns) {
    if (pattern.test(lowerText)) {
      return label;
    }
  }

  return null;
}

/**
 * evidence fingerprint 용 간단 해시를 생성한다.
 *
 * SHA-256 hex digest를 사용해 장기 runner에서 fingerprint 충돌 가능성을 낮춘다.
 * 이 함수는 순수 계산이며 외부 side effect가 없다.
 */
function hashSimple(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex").slice(0, 32);
}
