import type {
  CalibrationEvidenceInput,
  CalibrationInputValidationFailure,
  CalibrationInputValidationResult,
  CalibrationMetricSummary,
  CalibrationRunSummary,
} from "./types.js";

const fillRatePrecision = 6;
const fillRateTolerance = 10 ** -fillRatePrecision;

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
  const rawDays = (input as { days?: unknown }).days;
  if (!Array.isArray(rawDays)) {
    failures.push(createFailure("days", "Day summary 목록은 배열이어야 합니다.", { value: rawDays }));
  } else if (input.days.length !== 3) {
    failures.push(
      createFailure("days", "Day 1/2/3 summary가 모두 있어야 동일 run shape calibration 입력으로 사용할 수 있습니다.", {
        dayCount: input.days.length,
      }),
    );
  }

  validateRunSummary(input.aggregate, "aggregate", failures);
  if (Array.isArray(rawDays)) {
    const days = readDaySummaries(rawDays, failures);
    validateDaySet(days, failures);
    days.forEach((day, index) => {
      validateRunSummary(day, `days[${index}]`, failures);
    });
    if (days.length === rawDays.length) {
      validateAggregateMatchesDays({ ...input, days }, failures);
    }
  }

  return {
    passed: failures.length === 0,
    failures,
  };
}

function readDaySummaries(rawDays: readonly unknown[], failures: CalibrationInputValidationFailure[]): CalibrationRunSummary[] {
  const days: CalibrationRunSummary[] = [];
  rawDays.forEach((day, index) => {
    if (!isRecord(day)) {
      failures.push(createFailure(`days[${index}]`, "Day summary는 객체여야 합니다.", { value: day }));
      return;
    }
    days.push(day as unknown as CalibrationRunSummary);
  });
  return days;
}

function validateDaySet(
  days: readonly CalibrationRunSummary[],
  failures: CalibrationInputValidationFailure[],
): void {
  const observedDays = days.map((day) => day.day);
  const sortedUniqueDays = [...new Set(observedDays)].sort();
  if (sortedUniqueDays.length !== 3 || sortedUniqueDays[0] !== 1 || sortedUniqueDays[1] !== 2 || sortedUniqueDays[2] !== 3) {
    failures.push(
      createFailure("days", "Day summary 번호는 정확히 Day 1/2/3을 한 번씩 포함해야 합니다.", {
        observedDays,
      }),
    );
  }
}

/**
 * aggregate summary가 Day 1/2/3 summary의 합계와 같은 run shape를 설명하는지 검증한다.
 *
 * 각 summary가 개별 contract를 만족해도 다른 run의 Day artifact가 섞이면 aggregate 근거가 손상된다.
 * paper 주문/체결, 비용/리스크 count, live API, reason count map의 합계 invariant를 비교하며 외부 side effect는 없다.
 */
function validateAggregateMatchesDays(
  input: CalibrationEvidenceInput,
  failures: CalibrationInputValidationFailure[],
): void {
  const aggregate = (input as { aggregate?: unknown }).aggregate;
  if (!isRecord(aggregate) || !isRecord((aggregate as { metrics?: unknown }).metrics) || !input.days.every((day) => isRecord(day.metrics))) {
    return;
  }
  const aggregateMetrics = (aggregate as unknown as CalibrationRunSummary).metrics;
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
    const aggregateValue = readPath(aggregateMetrics, field);
    const dayValues = input.days.map((day) => readPath(day.metrics, field));
    if (typeof aggregateValue === "number" && dayValues.every((value): value is number => typeof value === "number")) {
      const dayTotal = dayValues.reduce((total, value) => total + value, 0);
      if (aggregateValue !== dayTotal) {
        failures.push(
          createFailure(`aggregate.metrics.${field}`, "aggregate metric은 Day 1/2/3 합계와 일치해야 합니다.", {
            aggregateValue,
            dayTotal,
          }),
        );
      }
    }
  }

  validateAggregateReasonMap(input, "blockingReasonCounts", failures);
}

/**
 * aggregate reason count map이 Day별 reason count map의 key별 합계와 일치하는지 검증한다.
 *
 * reason key가 일부 Day에서만 나타나는 경우도 전체 key set으로 비교해 누락과 과집계를 모두 잡는다.
 * 입력 객체를 변경하지 않고 failure만 누적한다.
 */
function validateAggregateReasonMap(
  input: CalibrationEvidenceInput,
  field: "holdReasonCounts" | "discardReasonCounts" | "blockingReasonCounts",
  failures: CalibrationInputValidationFailure[],
): void {
  const aggregate = (input as { aggregate?: unknown }).aggregate;
  if (!isRecord(aggregate) || !isRecord((aggregate as { metrics?: unknown }).metrics)) {
    return;
  }
  const aggregateCounts = (aggregate as unknown as CalibrationRunSummary).metrics[field];
  const dayCounts = input.days.map((day) => day.metrics[field]);
  if (!isRecord(aggregateCounts) || !dayCounts.every(isRecord)) {
    return;
  }
  const keys = new Set(
    [...Object.keys(aggregateCounts), ...dayCounts.flatMap((counts) => Object.keys(counts))].filter(
      (key) => key.startsWith("cost:") || key.startsWith("risk:"),
    ),
  );
  for (const key of keys) {
    const aggregateValue = aggregateCounts[key] ?? 0;
    const dayTotal = dayCounts.reduce((total, counts) => total + ((counts[key] as number | undefined) ?? 0), 0);
    if (aggregateValue !== dayTotal) {
      failures.push(
        createFailure(`aggregate.metrics.${field}.${key}`, "aggregate reason count는 Day 1/2/3 합계와 일치해야 합니다.", {
          aggregateValue,
          dayTotal,
        }),
      );
    }
  }
}

function validateRunSummary(
  summary: CalibrationRunSummary,
  fieldPrefix: string,
  failures: CalibrationInputValidationFailure[],
): void {
  if (!isRecord(summary)) {
    failures.push(
      createFailure(`${fieldPrefix}`, "summary는 객체여야 합니다.", {
        value: summary,
      }),
    );
    return;
  }
  if (summary.status !== "passed") {
    failures.push(
      createFailure(`${fieldPrefix}.status`, "summary 판정이 통과가 아니어서 calibration 입력을 중단합니다.", {
        status: summary.status,
        sourcePath: summary.sourcePath,
      }),
    );
  }

  const rawMetrics = (summary as { metrics?: unknown }).metrics;
  if (!isRecord(rawMetrics)) {
    failures.push(
      createFailure(`${fieldPrefix}.metrics`, "summary metrics는 객체여야 합니다.", {
        value: rawMetrics,
        sourcePath: summary.sourcePath,
      }),
    );
    return;
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

  if (!isRecord(summary.metrics.costSummary) || !isRecord(summary.metrics.slippageSummary)) {
    if (!isRecord(summary.metrics.costSummary)) {
      failures.push(
        createFailure(`${fieldPrefix}.metrics.costSummary`, "cost summary는 객체여야 합니다.", {
          value: summary.metrics.costSummary,
          sourcePath: summary.sourcePath,
        }),
      );
    }
    if (!isRecord(summary.metrics.slippageSummary)) {
      failures.push(
        createFailure(`${fieldPrefix}.metrics.slippageSummary`, "slippage summary는 객체여야 합니다.", {
          value: summary.metrics.slippageSummary,
          sourcePath: summary.sourcePath,
        }),
      );
    }
    return;
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
    if (value !== undefined && (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)) {
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
  validateFillRate(summary, fieldPrefix, failures);
  validateCostSummaryCounts(summary, fieldPrefix, failures);
  validateRejectReasonCounts(summary, fieldPrefix, failures);
  validateOptionalDecimalMetrics(summary, fieldPrefix, failures);

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
    validatePresentDecimal(
      summary.metrics.costSummary.averageMarginBps,
      `${fieldPrefix}.metrics.costSummary.averageMarginBps`,
      "비용 평가가 있는 summary에는 평균 margin bps가 있어야 합니다.",
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

/**
 * paper 주문/체결 count와 fillRate가 동일한 run summary를 설명하는지 검증한다.
 *
 * 이 helper는 source artifact reader를 거치지 않고 이미 구성된 입력 객체가 들어오는 validator 경계에서 호출된다.
 * runner가 fillRate를 6자리 소수로 저장하는 invariant를 기준으로 비교하며, 외부 side effect 없이 failure만 누적한다.
 */
function validateFillRate(
  summary: CalibrationRunSummary,
  fieldPrefix: string,
  failures: CalibrationInputValidationFailure[],
): void {
  const { fillRate, paperFillCount, paperOrderSubmittedCount } = summary.metrics;
  if (typeof fillRate !== "number" || !Number.isFinite(fillRate) || fillRate < 0 || fillRate > 1) {
    failures.push(
      createFailure(`${fieldPrefix}.metrics.fillRate`, "fillRate는 0 이상 1 이하의 유한한 숫자여야 합니다.", {
        value: fillRate,
        sourcePath: summary.sourcePath,
      }),
    );
    return;
  }
  if (
    Number.isSafeInteger(paperOrderSubmittedCount) &&
    Number.isSafeInteger(paperFillCount) &&
    paperOrderSubmittedCount >= 0 &&
    paperFillCount >= 0
  ) {
    const expectedFillRate = paperOrderSubmittedCount === 0 ? 0 : paperFillCount / paperOrderSubmittedCount;
    const roundedExpectedFillRate = Number(expectedFillRate.toFixed(fillRatePrecision));
    if (Math.abs(fillRate - roundedExpectedFillRate) > fillRateTolerance) {
      failures.push(
        createFailure(`${fieldPrefix}.metrics.fillRate`, "fillRate는 paper 주문/체결 count와 일치해야 합니다.", {
          value: fillRate,
          expectedFillRate: roundedExpectedFillRate,
          paperOrderSubmittedCount,
          paperFillCount,
          sourcePath: summary.sourcePath,
        }),
      );
    }
  }
}

/**
 * 비용 평가 count의 합계 invariant를 검증한다.
 *
 * 이 validator 경계는 이미 구성된 evidence 입력도 받으므로, 각 count의 타입 검증을 통과한 뒤
 * allowed/rejected 합이 evaluated와 다른 손상 입력을 report 후보 산정 전에 차단한다. 외부 side effect는 없다.
 */
function validateCostSummaryCounts(
  summary: CalibrationRunSummary,
  fieldPrefix: string,
  failures: CalibrationInputValidationFailure[],
): void {
  const { evaluatedCount, allowedCount, rejectedCount } = summary.metrics.costSummary;
  if (
    Number.isSafeInteger(evaluatedCount) &&
    Number.isSafeInteger(allowedCount) &&
    Number.isSafeInteger(rejectedCount) &&
    allowedCount + rejectedCount !== evaluatedCount
  ) {
    failures.push(
      createFailure(`${fieldPrefix}.metrics.costSummary`, "비용 허용/차단 count 합계는 평가 count와 일치해야 합니다.", {
        evaluatedCount,
        allowedCount,
        rejectedCount,
        sourcePath: summary.sourcePath,
      }),
    );
  }
}

/**
 * reject count와 blocking reason count가 같은 evidence 방향을 가리키는지 검증한다.
 *
 * 비용 차단은 runner에서 단일 cost reason과 함께 증가하므로 exact 합계를 요구한다. risk reason은 한 주문에
 * 여러 risk reason이 함께 남을 수 있어 reason 합계가 reject count보다 작아지는 손실만 차단한다. 외부 side effect는 없다.
 */
function validateRejectReasonCounts(
  summary: CalibrationRunSummary,
  fieldPrefix: string,
  failures: CalibrationInputValidationFailure[],
): void {
  const costReasonTotal = sumReasonCounts(summary.metrics.blockingReasonCounts, "cost");
  const riskReasonTotal = sumReasonCounts(summary.metrics.blockingReasonCounts, "risk");
  if (Number.isSafeInteger(summary.metrics.costRejectedCount) && costReasonTotal !== summary.metrics.costRejectedCount) {
    failures.push(
      createFailure(`${fieldPrefix}.metrics.costRejectedCount`, "비용 reject count는 cost reason 합계와 일치해야 합니다.", {
        costRejectedCount: summary.metrics.costRejectedCount,
        costReasonTotal,
        sourcePath: summary.sourcePath,
      }),
    );
  }
  if (Number.isSafeInteger(summary.metrics.riskRejectedCount) && riskReasonTotal < summary.metrics.riskRejectedCount) {
    failures.push(
      createFailure(`${fieldPrefix}.metrics.riskRejectedCount`, "risk reason 합계는 risk reject count 이상이어야 합니다.", {
        riskRejectedCount: summary.metrics.riskRejectedCount,
        riskReasonTotal,
        sourcePath: summary.sourcePath,
      }),
    );
  }
}

/**
 * null이 아닌 decimal metric 값이 후속 Decimal parser에 넘겨도 안전한 문자열인지 검증한다.
 *
 * 비용/슬리피지 평가 건수가 0이면 null은 허용하지만, 값이 존재한다면 report 근거로 보존되므로
 * 항상 유한한 숫자 문자열 invariant를 유지해야 한다. 외부 입력을 읽거나 변경하지 않고 failure만 누적한다.
 */
function validateOptionalDecimalMetrics(
  summary: CalibrationRunSummary,
  fieldPrefix: string,
  failures: CalibrationInputValidationFailure[],
): void {
  for (const [field, value] of [
    ["costSummary.averageCostBps", summary.metrics.costSummary.averageCostBps],
    ["costSummary.averageRequiredReturnBps", summary.metrics.costSummary.averageRequiredReturnBps],
    ["costSummary.averageMarginBps", summary.metrics.costSummary.averageMarginBps],
    ["slippageSummary.averageSlippageBps", summary.metrics.slippageSummary.averageSlippageBps],
    ["slippageSummary.minSlippageBps", summary.metrics.slippageSummary.minSlippageBps],
    ["slippageSummary.maxSlippageBps", summary.metrics.slippageSummary.maxSlippageBps],
  ] as const) {
    if (value !== null && (typeof value !== "string" || !/^-?\d+(?:\.\d+)?$/u.test(value))) {
      failures.push(
        createFailure(`${fieldPrefix}.metrics.${field}`, "decimal metric은 유한한 숫자 문자열이어야 합니다.", {
          value,
          sourcePath: summary.sourcePath,
        }),
      );
    }
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
  if (counts === null || typeof counts !== "object" || Array.isArray(counts)) {
    failures.push(createFailure(fieldPath, "reason count map은 객체여야 합니다.", { value: counts, sourcePath }));
    return;
  }
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

/**
 * validator가 신뢰해도 되는 plain record인지 확인한다.
 *
 * 이미 구성된 JSON 객체가 type assertion을 우회해 들어올 수 있으므로, nested summary 역참조 전에 객체 invariant를 확인한다.
 * 입력을 변경하지 않는 순수 guard다.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * blocking reason map에서 지정 축의 count 합계를 계산한다.
 *
 * validator 내부 cross-field 검증용 순수 함수이며, 비정상 map은 앞선 failure에서 다루므로 여기서는 0으로 낮춰
 * 추가 예외 없이 남은 failure 수집을 계속한다.
 */
function sumReasonCounts(counts: Record<string, number>, prefix: string): number {
  if (!isRecord(counts)) {
    return 0;
  }
  return Object.entries(counts)
    .filter(([key]) => key.startsWith(`${prefix}:`))
    .reduce((total, [, count]) => total + (typeof count === "number" ? count : 0), 0);
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
