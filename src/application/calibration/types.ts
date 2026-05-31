import type { PaperDecisionCostSummary, PaperDecisionSlippageSummary } from "../paper-decision-runner.js";

/**
 * M11 threshold calibration이 신뢰할 수 있는 입력으로 인정하는 metric 묶음이다.
 *
 * #68 closeout 문서와 원천 summary JSON은 같은 필드명을 제공해야 하며, 후속 후보 산정 PR은 이 타입만 소비한다.
 * 주문/체결 수, 비용, 슬리피지, hold/discard/cost/risk 차단 사유를 모두 포함해야 run shape가 달라진 비교를
 * 실수로 calibration 근거로 쓰지 않는다. 이 타입은 순수 데이터 contract라 외부 side effect를 갖지 않는다.
 */
export interface CalibrationMetricSummary {
  costSummary: PaperDecisionCostSummary;
  slippageSummary: PaperDecisionSlippageSummary;
  holdReasonCounts: Record<string, number>;
  discardReasonCounts: Record<string, number>;
  blockingReasonCounts: Record<string, number>;
  costRejectedCount: number;
  riskRejectedCount: number;
  paperOrderSubmittedCount: number;
  paperFillCount: number;
  fillRate: number;
  liveOrderApiCalls: number;
}

/**
 * aggregate summary 또는 day summary 하나를 calibration 입력으로 정규화한 결과다.
 *
 * `metrics`는 후속 threshold 후보 산정의 유일한 숫자 입력이며, `sourcePath`와 `trace`는 vault artifact와 내부
 * evidence 문서 중 어디에서 값을 가져왔는지 감사하기 위한 추적 정보다. 이 객체는 파일 읽기 이후의 값 표현이며
 * 자체적으로 파일 system side effect를 수행하지 않는다.
 */
export interface CalibrationRunSummary {
  sourceKind: "evidence_document" | "artifact_summary";
  sourcePath: string;
  day: number | null;
  status: string;
  startedAt: string | null;
  finishedAt: string | null;
  metrics: CalibrationMetricSummary;
  trace?: Record<string, unknown>;
}

/**
 * 내부 evidence 문서가 가리키는 source artifact 경계다.
 *
 * vault 경로는 저장소에 커밋하지 않고 추적 정보로만 보존한다. reader는 이 경로를 선택적으로 읽을 수 있지만,
 * 기본 calibration 입력은 내부 evidence 문서를 primary reference로 삼아 raw event log 분석 side effect를 만들지 않는다.
 */
export interface CalibrationSourceArtifacts {
  aggregateSummaryPath: string | null;
  aggregateReportPath: string | null;
  daySummaryPaths: readonly { day: number; path: string }[];
  dayReportPaths: readonly { day: number; path: string }[];
  comparisonReportPath: string | null;
  rawEventLogPath: string | null;
}

/**
 * M11 calibration 입력 문서와 선택적으로 읽은 원천 summary를 묶은 최상위 입력이다.
 *
 * `aggregate`와 `days`는 validator를 통과해야 후속 후보 산정으로 전달될 수 있다. `validationCommand`는 원천
 * artifact 재검증이 필요할 때 운영자가 같은 경로로 재현할 수 있게 보존하는 user-facing 추적 정보다.
 */
export interface CalibrationEvidenceInput {
  evidencePath: string;
  targetIssue: string | null;
  runPrefix: string | null;
  status: string | null;
  sourceArtifacts: CalibrationSourceArtifacts;
  validationCommand: string | null;
  aggregate: CalibrationRunSummary;
  days: readonly CalibrationRunSummary[];
}

/**
 * calibration 입력 검증 실패 하나를 표현한다.
 *
 * `fieldPath`는 machine-readable 추적 정보이고, `message`는 CLI/report가 한국어로 사용자 행동을 설명할 때
 * 그대로 활용할 수 있는 문장이다. validator는 오류를 던지는 대신 실패 목록을 반환해 여러 누락 metric을 한 번에 보여준다.
 */
export interface CalibrationInputValidationFailure {
  severity: "error";
  fieldPath: string;
  message: string;
  trace?: Record<string, unknown>;
}

/**
 * calibration 입력 검증 결과다.
 *
 * `passed=false`이면 후속 threshold 후보 산정은 반드시 중단해야 한다. 특히 live order API 호출이나 핵심 metric 누락은
 * paper-only closeout invariant가 깨진 상태이므로 보수적 기본값 제안으로 승격할 수 없다.
 */
export interface CalibrationInputValidationResult {
  passed: boolean;
  failures: readonly CalibrationInputValidationFailure[];
}

/**
 * calibration 차단 사유를 report와 정책 판단에서 다루는 최상위 축이다.
 *
 * 원천 metric prefix와 1:1로 대응하며, 알 수 없는 prefix는 버리지 않고 `unknown`으로 보존해 입력 손실 없이 후속
 * 검토로 넘긴다.
 */
export type CalibrationReasonAxis = "cost" | "risk" | "hold" | "discard" | "unknown";

/**
 * cost/risk/hold/discard 한 축의 차단 사유 집계다.
 *
 * key는 prefix를 제거한 안정 reason code이며, `totalCount`는 report가 축별 비중을 계산할 때 쓰는 합계다.
 * 이 타입은 입력 summary를 재분류한 결과일 뿐이며 외부 side effect나 설정 변경 권한을 갖지 않는다.
 */
export interface CalibrationReasonAxisSummary {
  counts: Record<string, number>;
  totalCount: number;
}

/**
 * M11 calibration report가 공통으로 사용할 차단 사유 분해 결과다.
 *
 * `blockingReasonCounts`의 `cost:`, `risk:`, `hold:`, `discard:` prefix를 기준으로 나누고, prefix가 없는 값은
 * `unknown`에 남겨 후속 report가 원천 metric 손실 없이 보여줄 수 있게 한다.
 */
export interface CalibrationReasonBreakdown {
  cost: CalibrationReasonAxisSummary;
  risk: CalibrationReasonAxisSummary;
  hold: CalibrationReasonAxisSummary;
  discard: CalibrationReasonAxisSummary;
  unknown: CalibrationReasonAxisSummary;
  totals: {
    blockingCount: number;
    explicitHoldCount: number;
    explicitDiscardCount: number;
  };
}

/**
 * threshold 후보가 주문 후보 수와 위험 노출에 미치는 정책적 방향성이다.
 *
 * `conservative`는 후보를 줄이거나 안전마진을 높이는 방향이고, `aggressive`는 후보 수를 늘릴 수 있어 별도 승인이
 * 필요한 방향이다.
 */
export type CalibrationCandidateAggressiveness = "conservative" | "aggressive";

/**
 * threshold 후보의 현재 적용 가능 상태다.
 *
 * `recommended`도 즉시 config write를 뜻하지 않으며 후속 report/profile PR에서 근거로 사용하는 상태 신호다.
 */
export type CalibrationCandidateStatus = "recommended" | "blocked" | "separate_review";

/**
 * calibration policy가 산출하는 threshold 후보의 안정 식별자다.
 *
 * report와 profile proposal이 같은 key를 공유해 사람이 후보별 근거와 후속 patch를 추적할 수 있게 한다.
 */
export type CalibrationThresholdCandidateKey =
  | "relax_alpha_thresholds"
  | "cost_safety_buffer_bps"
  | "min_volume_spike_ratio"
  | "min_session_liquidity_score"
  | "max_spread_bps"
  | "min_cost_adjusted_margin_bps";

/**
 * threshold 후보가 허용하는 값 변경 방향이다.
 *
 * 보수 방향은 자동 후보로 표시할 수 있지만, threshold 완화 방향은 음수 margin 상태에서 차단되고 그 외에도 승인 경계를
 * 넘지 않는다.
 */
export type CalibrationThresholdDirection = "increase_or_keep" | "decrease_or_keep" | "decrease_requires_approval";

/**
 * threshold 후보 하나의 정책 판단 결과다.
 *
 * 후보는 실제 config patch가 아니라 후속 report/profile PR이 근거를 표시하기 위한 제안 단위다. `status=blocked`는
 * 기본 운영값 변경으로 승격할 수 없다는 fail-closed 신호이며, `metricEvidence`는 사람이 근거를 추적하는 debug 영역이다.
 */
export interface CalibrationThresholdCandidate {
  key: CalibrationThresholdCandidateKey;
  title: string;
  status: CalibrationCandidateStatus;
  aggressiveness: CalibrationCandidateAggressiveness;
  direction: CalibrationThresholdDirection;
  rationale: string;
  metricEvidence: Record<string, string | number | boolean | null>;
}

/**
 * threshold 후보와 분리해 봐야 하는 risk gate 상호작용 분류다.
 *
 * 주문 금액과 예상 손실 한도는 전략 기준값 조정과 호출 경계가 다르므로 별도 action으로 report에 노출한다.
 */
export type CalibrationRiskInteractionKind =
  | "expected_loss_limit_review"
  | "order_notional_limit_review"
  | "risk_reason_review";

/**
 * 전략 threshold와 별도로 검토해야 하는 risk gate 상호작용이다.
 *
 * 주문 금액이나 예상 손실 한도는 alpha threshold를 완화해서 해결할 문제가 아니므로 후보 산정 결과에서 별도 축으로 분리한다.
 */
export interface CalibrationRiskInteraction {
  kind: CalibrationRiskInteractionKind;
  reasonCode: string;
  count: number;
  action: string;
  rationale: string;
}

/**
 * Sub PR 2 정책 계층이 산출하는 calibration 분석 결과다.
 *
 * `status=failed`이면 입력 검증에서 이미 fail-closed 되었으므로 후보와 risk interaction은 비워 둔다. 성공 결과도
 * `config/paper.json`을 직접 바꾸지 않고 후속 report CLI와 profile proposal의 입력으로만 사용한다.
 */
export interface CalibrationPolicyAnalysis {
  status: "ok" | "failed";
  validation: CalibrationInputValidationResult;
  aggregateReasonBreakdown?: CalibrationReasonBreakdown;
  dayReasonBreakdowns: readonly { day: number | null; breakdown: CalibrationReasonBreakdown }[];
  averageMarginBps: string | null;
  thresholdRelaxationBlocked: boolean;
  candidates: readonly CalibrationThresholdCandidate[];
  riskInteractions: readonly CalibrationRiskInteraction[];
  operatorSummary: string;
}
