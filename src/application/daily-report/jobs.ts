import { createDailyReportWindow } from "./window.js";
import type { DailyReportWindow } from "./types.js";

export const dailyReportJobType = "report.daily";

/**
 * daily report job payload에 저장하는 기준 window다.
 *
 * jobs table에는 composite unique key가 없으므로 `idempotencyKey`에 `job_type + report_date`를 반영하고, payload에는
 * 사람이 복구할 수 있는 KST/UTC window를 함께 저장한다. worker는 이 payload로 같은 리포트를 재생할 수 있어야 한다.
 */
export interface DailyReportJobPayload {
  report_date: string;
  timezone: DailyReportWindow["timezone"];
  kst_start_at: string;
  kst_end_at: string;
  utc_start_at: string;
  utc_end_at: string;
}

/**
 * DB jobs queue에 등록할 daily report 작업 계획이다.
 *
 * application layer는 job_type, idempotency key, payload invariant만 만든다. 실제 insert와 unique conflict 처리는
 * infrastructure repository가 담당하므로 이 함수 자체는 외부 side effect가 없다.
 */
export interface DailyReportJobPlan {
  jobType: typeof dailyReportJobType;
  idempotencyKey: string;
  payloadJson: DailyReportJobPayload;
  runAfter?: Date | string;
  maxAttempts?: number;
}

/**
 * 기준일별 daily report job idempotency 계획을 만든다.
 *
 * 같은 `reportDate`는 반드시 같은 `report.daily:<YYYY-MM-DD>` key를 가져야 한다. 이 규칙이 깨지면 재시도나 scheduler 중복
 * 실행 시 같은 일간 리포트가 여러 번 전송될 수 있으므로 key format은 application contract로 고정한다.
 */
export function createDailyReportJobPlan(input: {
  reportDate: string;
  runAfter?: Date | string;
  maxAttempts?: number;
}): DailyReportJobPlan {
  const window = createDailyReportWindow(input.reportDate);
  const plan: DailyReportJobPlan = {
    jobType: dailyReportJobType,
    idempotencyKey: `${dailyReportJobType}:${input.reportDate}`,
    payloadJson: {
      report_date: window.reportDate,
      timezone: window.timezone,
      kst_start_at: window.kstStartAt,
      kst_end_at: window.kstEndAt,
      utc_start_at: window.utcStartAt,
      utc_end_at: window.utcEndAt,
    },
  };

  if (input.runAfter !== undefined) {
    plan.runAfter = input.runAfter;
  }

  if (input.maxAttempts !== undefined) {
    plan.maxAttempts = input.maxAttempts;
  }

  return plan;
}
