import { dailyReportTimezone } from "./types.js";
import type { DailyReportWindow } from "./types.js";

const reportDatePattern = /^(\d{4})-(\d{2})-(\d{2})$/u;
const millisecondsPerDay = 24 * 60 * 60 * 1000;
const kstOffsetHours = 9;

/**
 * KST 기준일을 UTC 조회 window로 변환한다.
 *
 * 리포트 기준일은 사람이 읽는 한국 날짜지만 DB timestamp는 UTC다. 이 함수는 `YYYY-MM-DDT00:00:00+09:00`부터 다음 날
 * 0시 직전까지를 `utcStartAt <= timestamp < utcEndAt` 쿼리에 사용할 수 있는 half-open window로 고정한다. 외부 side
 * effect는 없으며 잘못된 날짜 문자열은 즉시 예외로 차단한다.
 */
export function createDailyReportWindow(reportDate: string): DailyReportWindow {
  const { year, month, day } = parseReportDate(reportDate);
  const utcStart = new Date(Date.UTC(year, month - 1, day, -kstOffsetHours, 0, 0, 0));
  const utcEnd = new Date(utcStart.getTime() + millisecondsPerDay);
  const nextReportDate = toKstReportDate(utcEnd);

  return {
    reportDate,
    timezone: dailyReportTimezone,
    kstStartAt: `${reportDate}T00:00:00+09:00`,
    kstEndAt: `${nextReportDate}T00:00:00+09:00`,
    utcStartAt: utcStart.toISOString(),
    utcEndAt: utcEnd.toISOString(),
  };
}

/**
 * 기준 시각이 속한 KST 날짜를 `YYYY-MM-DD`로 계산한다.
 *
 * scheduler가 UTC clock으로 실행되더라도 업무 기준일은 KST여야 한다. 이 함수는 현재 시각을 KST로 이동한 뒤 날짜 부분만
 * 사용하므로 DST가 없는 한국 시간대에서 deterministic하게 동작한다.
 */
export function toKstReportDate(input: Date | string): string {
  const date = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(date.getTime())) {
    throw new Error("daily report clock input must be a valid Date or ISO timestamp");
  }

  return new Date(date.getTime() + kstOffsetHours * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function parseReportDate(reportDate: string): { year: number; month: number; day: number } {
  const match = reportDatePattern.exec(reportDate);
  if (match === null) {
    throw new Error("daily report date must use YYYY-MM-DD format");
  }

  const yearText = match[1];
  const monthText = match[2];
  const dayText = match[3];
  if (yearText === undefined || monthText === undefined || dayText === undefined) {
    throw new Error("daily report date must include year, month, and day");
  }

  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const utcMidnight = new Date(Date.UTC(year, month - 1, day, 0, 0, 0, 0));

  if (
    utcMidnight.getUTCFullYear() !== year ||
    utcMidnight.getUTCMonth() !== month - 1 ||
    utcMidnight.getUTCDate() !== day
  ) {
    throw new Error("daily report date must be a valid calendar date");
  }

  return { year, month, day };
}
