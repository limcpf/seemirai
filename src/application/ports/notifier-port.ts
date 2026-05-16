import type { JsonRecord, TimestampInput } from "../../domain/index.js";

export type AlertSeverity = "P0" | "P1" | "P2" | "P3";

/**
 * 운영 알림으로 보낼 단건 alert payload다.
 *
 * Telegram adapter 같은 outbound notifier가 이 구조를 받아 전송한다. fingerprint는 중복 억제와 cooldown
 * 판단에 사용한다.
 */
export interface AlertNotification {
  severity: AlertSeverity;
  title: string;
  body: string;
  fingerprint: string;
  occurredAt: TimestampInput;
  metadata?: JsonRecord;
}

/**
 * 일간 운영 요약 리포트 payload다.
 *
 * 전략별 성과, 비용 비중, 장애 이벤트 같은 요약은 metadata로 확장하고, command 수신 경로는 이 contract에
 * 포함하지 않는다.
 */
export interface DailyReportNotification {
  reportDate: string;
  summary: string;
  generatedAt: TimestampInput;
  metadata?: JsonRecord;
}

/**
 * 알림 provider 호출 결과다.
 *
 * cooldown, 중복 억제, provider 장애처럼 전송되지 않은 이유도 audit 가능하게 표현한다.
 */
export interface NotificationResult {
  delivered: boolean;
  providerMessageId?: string;
  skippedReason?: string;
}

/**
 * 외부 알림 adapter가 구현해야 하는 application port다.
 *
 * MVP는 Telegram outbound alert만 대상으로 하며, Telegram command 수신은 이 port의 책임이 아니다.
 */
export interface NotifierPort {
  /** P0~P3 운영 alert를 전송한다. */
  sendAlert(notification: AlertNotification): Promise<NotificationResult>;
  /** 일간 운영 리포트를 전송한다. */
  sendDailyReport(notification: DailyReportNotification): Promise<NotificationResult>;
}
