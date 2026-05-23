import type {
  JsonRecord,
  MarketCode,
  RiskBlockAction,
  RiskEventSeverity,
  RiskGateEvaluation,
  TimestampInput,
} from "../../domain/index.js";
import type {
  LlmRiskAssistantAction,
  LlmRiskAssistantInputSource,
  LlmRiskAssistantProviderId,
  LlmRiskAssistantProviderRequest,
  LlmRiskAssistantProviderResponse,
  LlmRiskAssistantResult,
  LlmRiskAssistantResultType,
} from "./contracts.js";

/**
 * LLM 결과가 RiskGate 후보로 변환됐는지, 거래 신호 없이 증거로만 끝났는지를 나타낸다.
 *
 * no-signal은 provider failure, 비대상 result type, NO_ACTION처럼 runtime 차단/허용 상태를 바꾸면 안 되는 결과를
 * 구분하기 위한 순수 상태이며 외부 side effect가 없다.
 */
export type LlmRiskGateSignalStatus = "mapped" | "no_signal";

/**
 * LLM mapper가 runtime에 넘길 수 있는 안전 action이다.
 *
 * 이 union에는 주문 허용, 매수/매도, 포지션 확대가 없고, cancel/pause도 실행 명령이 아니라 후속 runtime 검증이 필요한
 * 계획 후보로만 표현된다.
 */
export type LlmRiskGateSignalAction =
  | "NO_ACTION"
  | "BLOCK_NEW_ORDER"
  | "PLAN_CANCEL_PENDING_ORDER"
  | "PLAN_PAUSE_STRATEGY"
  | "ALERT_ONLY"
  | "MANUAL_REVIEW_REQUIRED";

/**
 * LLM risk classification을 RiskGate 경계로 넘길 때 함께 붙이는 런타임 문맥이다.
 *
 * 이 문맥은 이미 runtime이 알고 있는 correlation/order/strategy 식별자를 보강할 뿐이며, mapper가 주문 후보나 broker
 * 요청을 새로 만들 수 없도록 가격, 수량, side 같은 주문 입력은 받지 않는다. 외부 side effect는 없다.
 */
export interface LlmRiskGateMappingContext {
  correlationId?: string | undefined;
  orderId?: string | undefined;
  strategyId?: string | undefined;
}

/**
 * LLM provider response를 RiskGate 안전 신호로 변환하기 위한 입력이다.
 *
 * request는 source/result type 최신성을 확인하는 기준이고 response는 provider normalization을 통과한 결과다. 이 입력은
 * DB write, broker cancel, strategy pause 실행을 직접 수행하지 않는 순수 mapper 경계다.
 */
export interface MapLlmRiskAssistantToRiskGateSignalInput {
  request: LlmRiskAssistantProviderRequest;
  response: LlmRiskAssistantProviderResponse;
  context?: LlmRiskGateMappingContext | undefined;
}

/**
 * LLM 결과를 RiskGate 쪽에서 소비할 수 있게 축약한 안전 신호다.
 *
 * `riskGateEvaluation`이 있는 경우에도 action은 `ALLOW`가 될 수 없고, cancel/pause는 실행 명령이 아니라 후속 runtime이
 * 별도 idempotency와 상태 전이를 검증해야 하는 계획 후보로만 표현된다.
 */
export interface LlmRiskGateSignal {
  status: LlmRiskGateSignalStatus;
  action: LlmRiskGateSignalAction;
  reasonCode: string;
  message: string;
  severity: RiskEventSeverity;
  providerId: LlmRiskAssistantProviderId;
  resultType: LlmRiskAssistantResultType;
  source: LlmRiskAssistantInputSource;
  sourceId: string;
  observedAt: TimestampInput;
  sourceIds: readonly string[];
  summary?: string | undefined;
  market?: MarketCode | undefined;
  strategyId?: string | undefined;
  orderId?: string | undefined;
  correlationId?: string | undefined;
  requiresHumanReview: boolean;
  riskGateEvaluation?: RiskGateEvaluation | undefined;
  metadata?: JsonRecord | undefined;
}

interface CreateSignalOptions {
  request: LlmRiskAssistantProviderRequest;
  providerId: LlmRiskAssistantProviderId;
  resultType: LlmRiskAssistantResultType;
  sourceIds: readonly string[];
  observedAt: TimestampInput;
  status: LlmRiskGateSignalStatus;
  action: LlmRiskGateSignalAction;
  reasonCode: string;
  message: string;
  severity: RiskEventSeverity;
  requiresHumanReview: boolean;
  context?: LlmRiskGateMappingContext | undefined;
  result?: LlmRiskAssistantResult | undefined;
  riskGateEvaluation?: RiskGateEvaluation | undefined;
  metadata?: JsonRecord | undefined;
}

/**
 * LLM risk assistant 결과를 RiskGate 안전 신호로 변환한다.
 *
 * provider 실패, 비위험 result type, `NO_ACTION`은 거래 신호 없이 no-signal로 수렴한다. 위험 action도 주문 허용이나
 * broker side effect를 만들지 않고 차단, 취소 후보, 전략 일시정지 후보, 알림, 사람 확인 중 하나로만 변환한다.
 */
export function mapLlmRiskAssistantToRiskGateSignal(
  input: MapLlmRiskAssistantToRiskGateSignalInput,
): LlmRiskGateSignal {
  if (input.response.status === "failed") {
    // provider failure는 모델 판단을 신뢰할 수 없는 상태라 RiskGate 차단/허용 신호 대신 audit evidence만 남긴다.
    return createSignal({
      request: input.request,
      providerId: input.response.provider_id,
      resultType: input.request.result_type,
      sourceIds: [input.request.input.source_id],
      observedAt: input.response.failed_at,
      status: "no_signal",
      action: "NO_ACTION",
      reasonCode: input.response.reason_code,
      message: "LLM provider 실패는 거래 판단 없이 증거로만 남깁니다.",
      severity: "WARN",
      requiresHumanReview: false,
      context: input.context,
      metadata: {
        failure_class: input.response.failure_class,
      },
    });
  }

  const result = input.response.result;

  if (!isRiskGateEligibleResult(input.request.input.source, result.result_type)) {
    // 요약/리포트 초안은 RiskGate 입력이 아니므로 recommended action을 실행 경계로 전달하지 않는다.
    return createSignal({
      request: input.request,
      providerId: input.response.provider_id,
      resultType: result.result_type,
      sourceIds: result.source_ids,
      observedAt: result.observed_at,
      status: "no_signal",
      action: "NO_ACTION",
      reasonCode: "llm_risk_gate_unsupported_result_type",
      message: "LLM 결과 타입은 RiskGate 안전 신호 대상이 아닙니다.",
      severity: "INFO",
      requiresHumanReview: false,
      context: input.context,
      result,
    });
  }

  switch (result.recommended_action) {
    case "NO_ACTION":
      return createNoActionSignal(input, result);
    case "ALERT_ONLY":
      return createAlertSignal(input, result);
    case "BLOCK_NEW_ENTRY":
      return createBlockingSignal(input, result);
    case "CANCEL_PENDING":
      return createCancelPendingReviewSignal(input, result);
    case "PAUSE_STRATEGY":
      return createPauseStrategySignal(input, result);
  }
}

function createNoActionSignal(
  input: MapLlmRiskAssistantToRiskGateSignalInput,
  result: LlmRiskAssistantResult,
): LlmRiskGateSignal {
  return createSignal({
    request: input.request,
    providerId: input.response.provider_id,
    resultType: result.result_type,
    sourceIds: result.source_ids,
    observedAt: result.observed_at,
    status: "no_signal",
    action: "NO_ACTION",
    reasonCode: "llm_risk_gate_no_action",
    message: "LLM 분류 결과가 RiskGate 조치를 요구하지 않습니다.",
    severity: "INFO",
    requiresHumanReview: result.requires_human_review === true,
    context: input.context,
    result,
  });
}

function createAlertSignal(
  input: MapLlmRiskAssistantToRiskGateSignalInput,
  result: LlmRiskAssistantResult,
): LlmRiskGateSignal {
  return createSignal({
    request: input.request,
    providerId: input.response.provider_id,
    resultType: result.result_type,
    sourceIds: result.source_ids,
    observedAt: result.observed_at,
    status: "mapped",
    action: "ALERT_ONLY",
    reasonCode: "llm_risk_gate_alert_only",
    message: "LLM 분류 결과를 알림 후보로만 전달합니다.",
    severity: "WARN",
    requiresHumanReview: result.requires_human_review === true,
    context: input.context,
    result,
  });
}

function createBlockingSignal(
  input: MapLlmRiskAssistantToRiskGateSignalInput,
  result: LlmRiskAssistantResult,
): LlmRiskGateSignal {
  const metadata = createRiskGateMetadata(input, result, "BLOCK_NEW_ENTRY");
  const evaluation = createFailEvaluation({
    reasonCode: "llm_risk_block_new_entry",
    message: "LLM 공식 입력 분류가 신규 진입 차단을 요구합니다.",
    action: "BLOCK_NEW_ORDER",
    severity: "BLOCKING",
    metadata,
  });

  return createSignal({
    request: input.request,
    providerId: input.response.provider_id,
    resultType: result.result_type,
    sourceIds: result.source_ids,
    observedAt: result.observed_at,
    status: "mapped",
    action: "BLOCK_NEW_ORDER",
    reasonCode: evaluation.reasonCode,
    message: evaluation.message,
    severity: evaluation.severity,
    requiresHumanReview: result.requires_human_review === true,
    context: input.context,
    result,
    riskGateEvaluation: evaluation,
  });
}

function createCancelPendingReviewSignal(
  input: MapLlmRiskAssistantToRiskGateSignalInput,
  result: LlmRiskAssistantResult,
): LlmRiskGateSignal {
  const metadata = createRiskGateMetadata(input, result, "CANCEL_PENDING");
  const evaluation = createFailEvaluation({
    reasonCode: "llm_risk_cancel_pending_requires_review",
    message: "LLM 공식 입력 분류가 미체결 주문 취소 후보를 만들었고 사람 확인이 필요합니다.",
    action: "MANUAL_REVIEW_REQUIRED",
    severity: "CRITICAL",
    metadata,
  });

  return createSignal({
    request: input.request,
    providerId: input.response.provider_id,
    resultType: result.result_type,
    sourceIds: result.source_ids,
    observedAt: result.observed_at,
    status: "mapped",
    action: "PLAN_CANCEL_PENDING_ORDER",
    reasonCode: evaluation.reasonCode,
    message: evaluation.message,
    severity: evaluation.severity,
    requiresHumanReview: true,
    context: input.context,
    result,
    riskGateEvaluation: evaluation,
  });
}

function createPauseStrategySignal(
  input: MapLlmRiskAssistantToRiskGateSignalInput,
  result: LlmRiskAssistantResult,
): LlmRiskGateSignal {
  const metadata = createRiskGateMetadata(input, result, "PAUSE_STRATEGY");

  if (input.context?.strategyId === undefined) {
    // strategy scope가 없으면 특정 전략 정지를 자동 결정할 수 없으므로 사람 확인으로 격상한다.
    const evaluation = createFailEvaluation({
      reasonCode: "llm_risk_pause_strategy_scope_missing",
      message: "LLM 공식 입력 분류가 전략 일시정지를 요구했지만 전략 범위가 없어 사람 확인이 필요합니다.",
      action: "MANUAL_REVIEW_REQUIRED",
      severity: "CRITICAL",
      metadata,
    });

    return createSignal({
      request: input.request,
      providerId: input.response.provider_id,
      resultType: result.result_type,
      sourceIds: result.source_ids,
      observedAt: result.observed_at,
      status: "mapped",
      action: "MANUAL_REVIEW_REQUIRED",
      reasonCode: evaluation.reasonCode,
      message: evaluation.message,
      severity: evaluation.severity,
      requiresHumanReview: true,
      context: input.context,
      result,
      riskGateEvaluation: evaluation,
    });
  }

  const evaluation = createFailEvaluation({
    reasonCode: "llm_risk_pause_strategy",
    message: "LLM 공식 입력 분류가 지정 전략의 일시정지를 요구합니다.",
    action: "PAUSE_STRATEGY",
    severity: "BLOCKING",
    metadata,
  });

  return createSignal({
    request: input.request,
    providerId: input.response.provider_id,
    resultType: result.result_type,
    sourceIds: result.source_ids,
    observedAt: result.observed_at,
    status: "mapped",
    action: "PLAN_PAUSE_STRATEGY",
    reasonCode: evaluation.reasonCode,
    message: evaluation.message,
    severity: evaluation.severity,
    requiresHumanReview: result.requires_human_review === true,
    context: input.context,
    result,
    riskGateEvaluation: evaluation,
  });
}

function isRiskGateEligibleResult(
  source: LlmRiskAssistantInputSource,
  resultType: LlmRiskAssistantResultType,
): boolean {
  if (resultType === "notice_risk_classification") {
    return source === "exchange_notice" || source === "developer_changelog";
  }

  return resultType === "event_explanation" && source === "market_event";
}

function createSignal(options: CreateSignalOptions): LlmRiskGateSignal {
  const signal: LlmRiskGateSignal = {
    status: options.status,
    action: options.action,
    reasonCode: options.reasonCode,
    message: options.message,
    severity: options.severity,
    providerId: options.providerId,
    resultType: options.resultType,
    source: options.request.input.source,
    sourceId: options.request.input.source_id,
    observedAt: options.observedAt,
    sourceIds: [...options.sourceIds],
    requiresHumanReview: options.requiresHumanReview,
  };

  assignIfDefined(signal, "summary", options.result?.summary);
  assignIfDefined(signal, "market", options.result?.market ?? options.request.input.market);
  assignIfDefined(signal, "strategyId", options.context?.strategyId);
  assignIfDefined(signal, "orderId", options.context?.orderId);
  assignIfDefined(signal, "correlationId", options.context?.correlationId ?? options.request.correlation_id);
  assignIfDefined(signal, "riskGateEvaluation", options.riskGateEvaluation);
  assignIfDefined(signal, "metadata", createSignalMetadata(options));

  return signal;
}

function createSignalMetadata(options: CreateSignalOptions): JsonRecord | undefined {
  const metadata: JsonRecord = {
    schema_boundary: "llm_risk_assistant_risk_gate_mapper",
    provider_id: options.providerId,
    result_type: options.resultType,
    source: options.request.input.source,
    source_id: options.request.input.source_id,
    source_ids: [...options.sourceIds],
    recommended_action: options.result?.recommended_action ?? "NO_ACTION",
    requires_human_review: options.requiresHumanReview,
  };
  assignIfDefined(metadata, "reason_codes", options.result?.reason_codes);
  assignIfDefined(metadata, "evidence_count", options.result?.evidence?.length);
  assignIfDefined(metadata, "mapping", options.metadata);

  return metadata;
}

function createRiskGateMetadata(
  input: MapLlmRiskAssistantToRiskGateSignalInput,
  result: LlmRiskAssistantResult,
  mappedFromAction: LlmRiskAssistantAction,
): JsonRecord {
  const metadata: JsonRecord = {
    source: "llm_risk_assistant",
    provider_id: input.response.provider_id,
    result_type: result.result_type,
    source_ids: [...result.source_ids],
    recommended_action: mappedFromAction,
    requires_human_review: result.requires_human_review === true,
  };
  assignIfDefined(metadata, "market", result.market ?? input.request.input.market);
  assignIfDefined(metadata, "strategy_id", input.context?.strategyId);
  assignIfDefined(metadata, "order_id", input.context?.orderId);
  assignIfDefined(metadata, "correlation_id", input.context?.correlationId ?? input.request.correlation_id);
  assignIfDefined(metadata, "reason_codes", result.reason_codes);
  assignIfDefined(metadata, "evidence_count", result.evidence?.length);

  return metadata;
}

function createFailEvaluation(input: {
  reasonCode: string;
  message: string;
  action: Exclude<RiskBlockAction, "ALLOW" | "HARD_STOP">;
  severity: RiskEventSeverity;
  metadata: JsonRecord;
}): RiskGateEvaluation {
  return {
    status: "FAIL",
    reasonCode: input.reasonCode,
    message: input.message,
    severity: input.severity,
    action: input.action,
    metadata: input.metadata,
  };
}

function assignIfDefined<T extends object, K extends keyof T>(target: T, key: K, value: T[K] | undefined): void {
  if (value !== undefined) {
    target[key] = value;
  }
}
