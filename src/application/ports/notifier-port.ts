import type { JsonRecord, TimestampInput } from "../../domain/index.js";

export type AlertSeverity = "P0" | "P1" | "P2" | "P3";

export interface AlertNotification {
  severity: AlertSeverity;
  title: string;
  body: string;
  fingerprint: string;
  occurredAt: TimestampInput;
  metadata?: JsonRecord;
}

export interface DailyReportNotification {
  reportDate: string;
  summary: string;
  generatedAt: TimestampInput;
  metadata?: JsonRecord;
}

export interface NotificationResult {
  delivered: boolean;
  providerMessageId?: string;
  skippedReason?: string;
}

export interface NotifierPort {
  sendAlert(notification: AlertNotification): Promise<NotificationResult>;
  sendDailyReport(notification: DailyReportNotification): Promise<NotificationResult>;
}

