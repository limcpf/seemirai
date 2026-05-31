import type {
  CalibrationEvidenceInput,
  CalibrationInputValidationFailure,
  CalibrationInputValidationResult,
  CalibrationMetricSummary,
  CalibrationRunSummary,
} from "./types.js";

const requiredMetricFields = [
  "costSummary.evaluatedCount",
  "costSummary.allowedCount",
  "costSummary.rejectedCount",
  "costSummary.averageCostBps",
  "costSummary.averageRequiredReturnBps",
  "costSummary.averageMarginBps",
  "slippageSummary.observedFillCount",
  "slippageSummary.averageSlippageBps",
  "slippageSummary.minSlippageBps",
  "slippageSummary.maxSlippageBps",
  "holdReasonCounts",
  "discardReasonCounts",
  "blockingReasonCounts",
  "costRejectedCount",
  "riskRejectedCount",
  "paperOrderSubmittedCount",
  "paperFillCount",
  "fillRate",
  "liveOrderApiCalls",
] as const;

/**
 * M11 calibration 입력이 #68 paper-only evidence로 쓸 수 있는지 검증한다.
 *
 * 이 함수는 파일이나 네트워크를 읽지 않는 순수 validator다. aggregate와 Day 1/2/3 summary가 모두 같은 metric
 * contract를 지키는지 확인하고, live order API 호출이 하나라도 있으면 후속 threshold 후보 산정을 fail-closed로 막는다.
 */
export function validateCalibrationEvidenceInput(input: CalibrationEvidenceInput): CalibrationInputValidationResult {
  const failures: CalibrationInputValidationFailure[] = [];

  if (input.status !== "passed") {
    failures.push(createFailure("status", "내부 evidence 문서의 판정이 통과가 아니어서 calibration 입력으로 사용할 수 없습니다.", {
      status: input.status,
    }));
  }
  if (input.validationCommand === null) {
    failures.push(createFailure("validationCommand", "원천 artifact 재검증 명령이 없어 evidence를 재현할 수 없습니다."));
  }
  if (input.days.length !== 3) {
    failures.push(
      createFailure("days", "Day 1/2/3 summary가 모두 있어야 동일 run shape calibration 입력으로 사용할 수 있습니다.", {
        dayCount: input.days.length,
      }),
    );
  }

  validateRunSummary(input.aggregate, "aggregate", failures);
  input.days.forEach((day, index) => {
    validateRunSummary(day, `days[${index}]`, failures);
  });

  return {
    passed: failures.length === 0,
    failures,
  };
}

function validateRunSummary(
  summary: CalibrationRunSummary,
  fieldPrefix: string,
  failures: CalibrationInputValidationFailure[],
): void {
  if (summary.status !== "passed") {
    failures.push(
      createFailure(`${fieldPrefix}.status`, "summary 판정이 통과가 아니어서 calibration 입력을 중단합니다.", {
        status: summary.status,
        sourcePath: summary.sourcePath,
      }),
    );
  }

  for (const field of requiredMetricFields) {
    const value = readPath(summary.metrics, field);
    if (value === undefined) {
      failures.push(
        createFailure(`${fieldPrefix}.metrics.${field}`, "calibration에 필요한 summary metric이 누락되어 입력을 중단합니다.", {
          sourcePath: summary.sourcePath,
        }),
      );
    }
  }

  for (const field of [
    "costSummary.evaluatedCount",
    "costSummary.allowedCount",
    "costSummary.rejectedCount",
    "slippageSummary.observedFillCount",
    "costRejectedCount",
    "riskRejectedCount",
    "paperOrderSubmittedCount",
    "paperFillCount",
    "liveOrderApiCalls",
  ]) {
    const value = readPath(summary.metrics, field);
    if (typeof value === "number" && (!Number.isSafeInteger(value) || value < 0)) {
      failures.push(
        createFailure(`${fieldPrefix}.metrics.${field}`, "count metric은 0 이상의 안전한 정수여야 합니다.", {
          value,
          sourcePath: summary.sourcePath,
        }),
      );
    }
  }

  validateCounts(summary.metrics.holdReasonCounts, `${fieldPrefix}.metrics.holdReasonCounts`, failures, summary.sourcePath);
  validateCounts(summary.metrics.discardReasonCounts, `${fieldPrefix}.metrics.discardReasonCounts`, failures, summary.sourcePath);
  validateCounts(summary.metrics.blockingReasonCounts, `${fieldPrefix}.metrics.blockingReasonCounts`, failures, summary.sourcePath);

  if (summary.metrics.costSummary.evaluatedCount > 0) {
    validatePresentDecimal(
      summary.metrics.costSummary.averageCostBps,
      `${fieldPrefix}.metrics.costSummary.averageCostBps`,
      "비용 평가가 있는 summary에는 평균 비용 bps가 있어야 합니다.",
      failures,
      summary.sourcePath,
    );
    validatePresentDecimal(
      summary.metrics.costSummary.averageRequiredReturnBps,
      `${fieldPrefix}.metrics.costSummary.averageRequiredReturnBps`,
      "비용 평가가 있는 summary에는 평균 요구수익률 bps가 있어야 합니다.",
      failures,
      summary.sourcePath,
    );
  }

  if (summary.metrics.slippageSummary.observedFillCount > 0) {
    validatePresentDecimal(
      summary.metrics.slippageSummary.averageSlippageBps,
      `${fieldPrefix}.metrics.slippageSummary.averageSlippageBps`,
      "체결이 있는 summary에는 평균 슬리피지 bps가 있어야 합니다.",
      failures,
      summary.sourcePath,
    );
    validatePresentDecimal(
      summary.metrics.slippageSummary.minSlippageBps,
      `${fieldPrefix}.metrics.slippageSummary.minSlippageBps`,
      "체결이 있는 summary에는 최소 슬리피지 bps가 있어야 합니다.",
      failures,
      summary.sourcePath,
    );
    validatePresentDecimal(
      summary.metrics.slippageSummary.maxSlippageBps,
      `${fieldPrefix}.metrics.slippageSummary.maxSlippageBps`,
      "체결이 있는 summary에는 최대 슬리피지 bps가 있어야 합니다.",
      failures,
      summary.sourcePath,
    );
  }

  if (summary.metrics.liveOrderApiCalls > 0) {
    failures.push(
      createFailure(
        `${fieldPrefix}.metrics.liveOrderApiCalls`,
        "실거래 주문 API 호출이 감지되어 paper-only calibration 입력으로 사용할 수 없습니다.",
        { count: summary.metrics.liveOrderApiCalls, sourcePath: summary.sourcePath },
      ),
    );
  }
}

function validatePresentDecimal(
  value: string | null,
  fieldPath: string,
  message: string,
  failures: CalibrationInputValidationFailure[],
  sourcePath: string,
): void {
  if (value === null) {
    failures.push(createFailure(fieldPath, message, { sourcePath }));
  }
}

function validateCounts(
  counts: Record<string, number>,
  fieldPath: string,
  failures: CalibrationInputValidationFailure[],
  sourcePath: string,
): void {
  for (const [key, value] of Object.entries(counts)) {
    if (!Number.isSafeInteger(value) || value < 0) {
      failures.push(
        createFailure(`${fieldPath}.${key}`, "reason count는 0 이상의 안전한 정수여야 합니다.", {
          value,
          sourcePath,
        }),
      );
    }
  }
}

function readPath(metrics: CalibrationMetricSummary, path: string): unknown {
  return path.split(".").reduce<unknown>((current, key) => {
    if (typeof current !== "object" || current === null || !(key in current)) {
      return undefined;
    }
    return (current as Record<string, unknown>)[key];
  }, metrics);
}

function createFailure(
  fieldPath: string,
  message: string,
  trace?: Record<string, unknown>,
): CalibrationInputValidationFailure {
  return {
    severity: "error",
    fieldPath,
    message,
    ...(trace === undefined ? {} : { trace }),
  };
}
