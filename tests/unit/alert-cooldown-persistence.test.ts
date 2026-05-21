import { describe, expect, it } from "vitest";
import { toAlertCooldownRowInput, toAlertCooldownState } from "../../src/infrastructure/db/index.js";

describe("alert cooldown persistence mapping", () => {
  it("maps alert cooldown state to durable DB rows", () => {
    const row = toAlertCooldownRowInput(
      {
        fingerprint: "alert:prod:paper:P0:db:global:global:db_write_failure",
        severity: "P0",
        alertType: "db",
        market: null,
        strategyId: null,
        reasonCode: "db_write_failure",
        occurredAt: "2026-05-21T00:00:00.000Z",
        payloadJson: {
          correlation_id: "corr-alert",
        },
      },
      {
        lastSentAt: "2026-05-21T00:00:00.000Z",
        lastSkippedAt: null,
      },
    );

    expect(row).toMatchObject({
      fingerprint: "alert:prod:paper:P0:db:global:global:db_write_failure",
      severity: "P0",
      alert_type: "db",
      market: null,
      strategy_id: null,
      reason_code: "db_write_failure",
      last_sent_at: "2026-05-21T00:00:00.000Z",
      last_skipped_at: null,
      payload_json: {
        correlation_id: "corr-alert",
      },
    });
  });

  it("maps DB cooldown rows back to application state", () => {
    const sentAt = new Date("2026-05-21T00:00:00.000Z");

    expect(
      toAlertCooldownState({
        fingerprint: "alert:prod:paper:P1:lag:krw-btc:global:public_websocket_lag",
        severity: "P1",
        alert_type: "lag",
        market: "krw-btc",
        strategy_id: null,
        reason_code: "public_websocket_lag",
        last_sent_at: sentAt,
        last_skipped_at: null,
        payload_json: {},
        created_at: sentAt,
        updated_at: sentAt,
      }),
    ).toMatchObject({
      fingerprint: "alert:prod:paper:P1:lag:krw-btc:global:public_websocket_lag",
      severity: "P1",
      alertType: "lag",
      market: "krw-btc",
      strategyId: null,
      reasonCode: "public_websocket_lag",
      lastSentAt: sentAt,
      lastSkippedAt: null,
    });
  });
});
