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
