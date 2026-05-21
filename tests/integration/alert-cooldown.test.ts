import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import {
  PostgresAlertCooldownRepository,
  applyMigrations,
  createDatabase,
  createPostgresPool,
  destroyDatabase,
  loadLocalDatabaseConfig,
} from "../../src/infrastructure/db/index.js";
import type { Database } from "../../src/infrastructure/db/index.js";

const runDbIntegration = process.env.SEEMIRAI_RUN_DB_INTEGRATION === "1";
const describeDb = runDbIntegration ? describe : describe.skip;

describeDb("alert cooldown integration", () => {
  let pool: Pool | undefined;
  let database: Database | undefined;

  beforeEach(async () => {
    const db = await getDatabase();
    await db.deleteFrom("alert_cooldowns").execute();
  });

  afterAll(async () => {
    if (database !== undefined) {
      await destroyDatabase(database);
      database = undefined;
      pool = undefined;
      return;
    }

    await pool?.end();
    pool = undefined;
  });

  it("persists P0/P1 alert cooldown state by fingerprint", async () => {
    const db = await getDatabase();
    const repository = new PostgresAlertCooldownRepository(db);
    const input = {
      fingerprint: "alert:prod:paper:P0:db:global:global:db_write_failure",
      severity: "P0" as const,
      alertType: "db",
      market: null,
      strategyId: null,
      reasonCode: "db_write_failure",
      occurredAt: "2026-05-21T00:00:00.000Z",
      payloadJson: {
        correlation_id: "corr-alert",
      },
    };

    const sent = await repository.recordSent(input);
    const skipped = await repository.recordSkipped({
      ...input,
      occurredAt: "2026-05-21T00:00:30.000Z",
    });
    const loaded = await repository.findByFingerprint(input.fingerprint);

    expect(sent.lastSentAt).toEqual(new Date("2026-05-21T00:00:00.000Z"));
    expect(skipped.lastSkippedAt).toEqual(new Date("2026-05-21T00:00:30.000Z"));
    expect(loaded).toMatchObject({
      fingerprint: input.fingerprint,
      severity: "P0",
      reasonCode: "db_write_failure",
    });
  });

  it("atomically reserves delivery and preserves last sent timestamp on skips", async () => {
    const db = await getDatabase();
    const repository = new PostgresAlertCooldownRepository(db);
    const input = {
      fingerprint: "alert:prod:paper:P0:db:global:global:db_write_failure",
      severity: "P0" as const,
      alertType: "db",
      market: null,
      strategyId: null,
      reasonCode: "db_write_failure",
      occurredAt: "2026-05-21T00:00:00.000Z",
      payloadJson: {
        correlation_id: "corr-alert",
      },
    };

    const reserved = await repository.reserveDelivery({
      ...input,
      cooldownMs: 60_000,
      reserveUntil: "2026-05-21T00:01:00.000Z",
    });
    const duplicate = await repository.reserveDelivery({
      ...input,
      occurredAt: "2026-05-21T00:00:10.000Z",
      cooldownMs: 60_000,
      reserveUntil: "2026-05-21T00:01:10.000Z",
    });
    const released = await repository.releaseDeliveryReservation({
      ...input,
      occurredAt: "2026-05-21T00:00:15.000Z",
    });
    const retryReservation = await repository.reserveDelivery({
      ...input,
      occurredAt: "2026-05-21T00:00:16.000Z",
      cooldownMs: 60_000,
      reserveUntil: "2026-05-21T00:01:16.000Z",
    });
    await repository.recordSent({
      ...input,
      occurredAt: "2026-05-21T00:00:20.000Z",
    });
    const skipped = await repository.recordSkipped({
      ...input,
      occurredAt: "2026-05-21T00:00:30.000Z",
    });

    expect(reserved).toMatchObject({
      reserved: true,
      state: {
        deliveryReservedUntil: new Date("2026-05-21T00:01:00.000Z"),
      },
    });
    expect(duplicate).toMatchObject({
      reserved: false,
      state: {
        deliveryReservedUntil: new Date("2026-05-21T00:01:00.000Z"),
      },
    });
    expect(released.deliveryReservedUntil).toBeNull();
    expect(retryReservation).toMatchObject({
      reserved: true,
      state: {
        deliveryReservedUntil: new Date("2026-05-21T00:01:16.000Z"),
      },
    });
    expect(skipped).toMatchObject({
      lastSentAt: new Date("2026-05-21T00:00:20.000Z"),
      lastSkippedAt: new Date("2026-05-21T00:00:30.000Z"),
    });
  });

  it("does not roll back last skipped timestamp when an older skip arrives late", async () => {
    const db = await getDatabase();
    const repository = new PostgresAlertCooldownRepository(db);
    const input = {
      fingerprint: "alert:prod:paper:P1:lag:krw-btc:global:public_websocket_lag",
      severity: "P1" as const,
      alertType: "lag",
      market: "krw-btc",
      strategyId: null,
      reasonCode: "public_websocket_lag",
      occurredAt: "2026-05-21T00:00:00.000Z",
    };

    await repository.recordSent(input);
    await repository.recordSkipped({
      ...input,
      occurredAt: "2026-05-21T00:02:00.000Z",
    });
    const staleSkip = await repository.recordSkipped({
      ...input,
      occurredAt: "2026-05-21T00:01:00.000Z",
    });

    expect(staleSkip.lastSkippedAt).toEqual(new Date("2026-05-21T00:02:00.000Z"));
  });

  it("keeps sent and skipped timestamps monotonic across out-of-order updates", async () => {
    const db = await getDatabase();
    const repository = new PostgresAlertCooldownRepository(db);
    const input = {
      fingerprint: "alert:prod:paper:P1:lag:krw-eth:global:public_websocket_lag",
      severity: "P1" as const,
      alertType: "lag",
      market: "krw-eth",
      strategyId: null,
      reasonCode: "public_websocket_lag",
      occurredAt: "2026-05-21T00:03:00.000Z",
    };

    await repository.recordSent(input);
    await repository.recordSkipped({
      ...input,
      occurredAt: "2026-05-21T00:04:00.000Z",
    });
    const staleSent = await repository.recordSent({
      ...input,
      occurredAt: "2026-05-21T00:02:00.000Z",
    });

    expect(staleSent.lastSentAt).toEqual(new Date("2026-05-21T00:03:00.000Z"));
    expect(staleSent.lastSkippedAt).toEqual(new Date("2026-05-21T00:04:00.000Z"));
  });

  async function getDatabase(): Promise<Database> {
    if (database !== undefined) {
      return database;
    }

    const config = await loadLocalDatabaseConfig();
    pool = createPostgresPool(config);
    await applyMigrations(pool);
    database = createDatabase(pool);
    return database;
  }
});
