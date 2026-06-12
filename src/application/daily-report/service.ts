import type { DailyReportNotification, NotificationResult, NotifierPort } from "../ports/index.js";
import { aggregateDailyReport } from "./aggregator.js";
import { formatDailyReportSummary } from "./formatter.js";
import { createDailyReportWindow } from "./window.js";
import type { DailyReportAggregate, DailyReportSourceData, DailyReportWindow } from "./types.js";
import type { LiveAutonomousExitStatusSummary } from "../live-autonomous-exit-status.js";
import type { LiveOpsStatusSummary } from "../live-ops-status.js";

/**
 * 일간 리포트가 읽을 데이터 공급자 port다.
 *
 * DB repository, fixture, 향후 worker는 이 port를 구현해 application service에 facts를 제공한다. service는 공급자가 어떤
 * 저장소를 쓰는지 모르며, 입력 window의 half-open UTC 범위를 그대로 지켜야 한다는 invariant만 요구한다.
 */
export interface DailyReportDataProvider {
  loadDailyReportSourceData(window: DailyReportWindow): Promise<DailyReportSourceData>;
}

/**
 * daily report notification 생성 결과다.
 *
 * `report`는 테스트와 HTTP status 확장에 쓰는 구조화 결과이고, `notification`은 NotifierPort에 전달하는 전송 payload다.
 * 이 함수 단계에서는 외부 provider를 호출하지 않으므로 전송 실패 side effect가 발생하지 않는다.
 */
export interface BuildDailyReportNotificationResult {
  report: DailyReportAggregate;
  notification: DailyReportNotification;
}

/**
 * daily report service에 전달하는 입력이다.
 *
 * `generatedAt`은 테스트 재현성과 job retry idempotency를 위해 주입 가능하다. 생략하면 현재 시각을 사용하지만, reportDate의
 * KST/UTC window는 항상 명시된 `reportDate`에서만 계산한다.
 */
export interface BuildDailyReportNotificationOptions {
  reportDate: string;
  dataProvider: DailyReportDataProvider;
  generatedAt?: Date | string;
  /**
   * M22 live autonomous exit safe summary다.
   *
   * runtime/status 경계가 이미 secret-safe로 낮춘 summary만 전달해야 한다. 값이 있으면 실제 daily report notification 본문에
   * M22 자동 청산 상태를 포함하며, 이 옵션 자체는 추가 DB 조회나 broker side effect를 만들지 않는다.
   */
  liveAutonomousExit?: LiveAutonomousExitStatusSummary | null;
  /**
   * daily report notification 본문에 포함할 M23 live ops safe summary다.
   *
   * caller가 `/status`와 같은 secret-safe contract로 생성한 값만 전달한다. service는 이 값을 formatter에만 넘기며 추가 DB 조회,
   * broker 호출, Telegram 전송 side effect를 발생시키지 않는다.
   */
  liveOps?: LiveOpsStatusSummary | null;
}

/**
 * DB facts를 읽어 NotifierPort가 보낼 daily report payload를 만든다.
 *
 * 이 함수는 데이터 조회와 순수 집계/formatting까지만 수행한다. Telegram 전송은 호출자가 명시적으로 `sendDailyReport`를
 * 호출할 때만 발생해야 하며, 그래야 리포트 생성 실패와 알림 전송 실패를 audit에서 분리할 수 있다.
 */
export async function buildDailyReportNotification(
  options: BuildDailyReportNotificationOptions,
): Promise<BuildDailyReportNotificationResult> {
  const window = createDailyReportWindow(options.reportDate);
  const sourceData = await options.dataProvider.loadDailyReportSourceData(window);
  const report = aggregateDailyReport(window, sourceData);
  const generatedAt = options.generatedAt ?? new Date();

  return {
    report,
    notification: {
      reportDate: options.reportDate,
      summary: formatDailyReportSummary(report, {
        liveAutonomousExit: options.liveAutonomousExit ?? null,
        liveOps: options.liveOps ?? null,
      }),
      generatedAt,
      metadata: {
        source: "daily_report_aggregator",
        timezone: window.timezone,
        kst_start_at: window.kstStartAt,
        kst_end_at: window.kstEndAt,
        utc_start_at: window.utcStartAt,
        utc_end_at: window.utcEndAt,
        order_count: report.orderCount,
        fill_count: report.fillCount,
        discarded_candidate_count: report.discardedCandidates.total,
        pilot_evidence_count: report.pilotEvidence.total,
        risk_event_count: report.riskEvents.total,
      },
    },
  };
}

/**
 * daily report를 생성한 뒤 NotifierPort로 전송한다.
 *
 * NotifierPort 호출은 Telegram 같은 외부 side effect가 발생하는 경계다. 호출자는 반환된 `notification`과 provider 결과를
 * 함께 audit/job 상태에 남겨 리포트 생성 실패와 provider 실패를 구분해야 한다.
 */
export async function sendDailyReport(options: BuildDailyReportNotificationOptions & {
  notifier: NotifierPort;
}): Promise<BuildDailyReportNotificationResult & { result: NotificationResult }> {
  const built = await buildDailyReportNotification(options);
  // 리포트 전송은 외부 알림 provider side effect이므로 집계가 성공한 뒤 마지막 단계에서만 실행한다.
  const result = await options.notifier.sendDailyReport(built.notification);

  return {
    ...built,
    result,
  };
}
