import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  orderLifecycleStatuses,
  stateTransitionEventKinds,
} from "../../src/domain/index.js";
import {
  DuplicateMigrationVersionError,
  MigrationChecksumMismatchError,
  applyMigrations,
  createMigrationPlan,
  defaultMigrationsDirectory,
  loadMigrationFiles,
} from "../../src/infrastructure/db/index.js";
import type { AppliedMigrationRecord, SqlExecutor } from "../../src/infrastructure/db/index.js";

const tempDirectories: string[] = [];

describe("migration runner", () => {
  afterEach(async () => {
    await Promise.all(tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true })));
  });

  it("loads migration files in version order with stable checksums", async () => {
    const directory = await createTempMigrationDirectory({
      "000002_second.sql": "SELECT 2;\n",
      "000001_first.sql": "SELECT 1;\n",
    });

    const migrations = await loadMigrationFiles(directory);

    expect(migrations.map((migration) => migration.filename)).toEqual([
      "000001_first.sql",
      "000002_second.sql",
    ]);
    expect(migrations[0]?.checksum).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("rejects duplicate migration versions", async () => {
    const directory = await createTempMigrationDirectory({
      "000001_first.sql": "SELECT 1;\n",
      "000001_duplicate.sql": "SELECT 2;\n",
    });

    await expect(loadMigrationFiles(directory)).rejects.toThrow(DuplicateMigrationVersionError);
  });

  it("keeps database market checks exchange-agnostic", async () => {
    const migrations = await loadMigrationFiles(defaultMigrationsDirectory);
    const migrationSql = migrations.map((migration) => migration.sql).join("\n");

    expect(migrationSql).not.toContain("market ~ '^KRW-");
    expect(migrationSql).toContain("CHECK (btrim(market) <> '')");
    expect(migrationSql).toContain("CHECK (market IS NULL OR btrim(market) <> '')");
  });

  it("keeps database sanity checks for canonical trading metrics", async () => {
    const migrations = await loadMigrationFiles(defaultMigrationsDirectory);
    const migrationSql = migrations.map((migration) => migration.sql).join("\n");

    expect(migrationSql).toContain("CHECK (requested_price IS NULL OR requested_price > 0)");
    expect(migrationSql).toContain("CHECK (websocket_lag_ms IS NULL OR websocket_lag_ms >= 0)");
    expect(migrationSql).toContain("CHECK (quantity >= 0)");
    expect(migrationSql).toContain("CHECK (average_entry_price >= 0)");
    expect(migrationSql).toContain("CHECK (bid_depth_1 >= 0)");
    expect(migrationSql).toContain("CHECK (ask_depth_1 >= 0)");
    expect(migrationSql).toContain("CHECK (bid_depth_5 >= 0)");
    expect(migrationSql).toContain("CHECK (ask_depth_5 >= 0)");
    expect(migrationSql).toContain("CHECK (bid_depth_15 >= 0)");
    expect(migrationSql).toContain("CHECK (ask_depth_15 >= 0)");
    expect(migrationSql).toContain("CHECK (reconnect_count >= 0)");
    expect(migrationSql).toContain("CHECK (high_price >= open_price)");
    expect(migrationSql).toContain("CHECK (high_price >= close_price)");
    expect(migrationSql).toContain("CHECK (low_price <= open_price)");
    expect(migrationSql).toContain("CHECK (low_price <= close_price)");
    expect(migrationSql).toContain("CHECK (trade_count >= 0)");
    expect(migrationSql).toContain("CHECK (equity >= 0)");
    expect(migrationSql).toContain("CHECK (drawdown_bps >= 0)");
  });

  it("keeps jobs queue idempotency and claim guards", async () => {
    const migrations = await loadMigrationFiles(defaultMigrationsDirectory);
    const migrationSql = migrations.map((migration) => migration.sql).join("\n");

    expect(migrationSql).toContain("idempotency_key text NOT NULL UNIQUE");
    expect(migrationSql).toContain("CREATE INDEX IF NOT EXISTS jobs_claim_idx");
    expect(migrationSql).toContain("WHERE status = 'PENDING'");
    expect(migrationSql).toContain("CHECK (attempt_count <= max_attempts)");
  });

  it("keeps order event persistence and state checks aligned with canonical state lists", async () => {
    const migrations = await loadMigrationFiles(defaultMigrationsDirectory);
    const migrationSql = migrations.map((migration) => migration.sql).join("\n");

    expect(migrationSql).toContain("CREATE TABLE IF NOT EXISTS order_events");
    expect(migrationSql).toContain("CREATE INDEX IF NOT EXISTS order_events_order_occurred_at_idx");
    expect(migrationSql).toContain("CREATE INDEX IF NOT EXISTS order_events_rejected_idx");
    expect(migrationSql).toContain("'ORDER_STATE_TRANSITION'");
    expect(stateTransitionEventKinds).toContain("ORDER_STATE_TRANSITION");

    for (const status of orderLifecycleStatuses) {
      expect(migrationSql).toContain(`'${status}'`);
    }
  });

  it("fails when an applied migration checksum changed on disk", async () => {
    const directory = await createTempMigrationDirectory({
      "000001_first.sql": "SELECT 1;\n",
    });
    const [migration] = await loadMigrationFiles(directory);
    expect(migration).toBeDefined();
    if (migration === undefined) {
      throw new Error("expected migration fixture");
    }

    expect(() =>
      createMigrationPlan([migration], [
        {
          version: 1,
          filename: "000001_first.sql",
          checksum: "changed",
          applied_at: new Date(),
        },
      ]),
    ).toThrow(MigrationChecksumMismatchError);
  });

  it("applies pending migrations once and skips them on rerun", async () => {
    const directory = await createTempMigrationDirectory({
      "000001_first.sql": "SELECT 1;\n",
      "000002_second.sql": "SELECT 2;\n",
    });
    const executor = new FakeMigrationExecutor();

    const firstRun = await applyMigrations(executor, { migrationsDirectory: directory });
    const secondRun = await applyMigrations(executor, { migrationsDirectory: directory });

    expect(firstRun.applied.map((migration) => migration.version)).toEqual([1, 2]);
    expect(firstRun.skipped).toEqual([]);
    expect(secondRun.applied).toEqual([]);
    expect(secondRun.skipped.map((migration) => migration.version)).toEqual([1, 2]);
    expect(executor.executedMigrationSql).toEqual(["SELECT 1;\n", "SELECT 2;\n"]);
  });

  it("uses one checked-out client when a connection provider is passed", async () => {
    const directory = await createTempMigrationDirectory({
      "000001_first.sql": "SELECT 1;\n",
    });
    const client = new FakeMigrationExecutor();
    const provider = new FakeMigrationConnectionProvider(client);

    const result = await applyMigrations(provider, { migrationsDirectory: directory });

    expect(result.applied.map((migration) => migration.version)).toEqual([1]);
    expect(provider.connectCount).toBe(1);
    expect(provider.releaseCount).toBe(1);
    expect(client.executedMigrationSql).toEqual(["SELECT 1;\n"]);
  });
});

async function createTempMigrationDirectory(files: Record<string, string>): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "seemirai-migrations-"));
  tempDirectories.push(directory);

  await Promise.all(
    Object.entries(files).map(([filename, sql]) => writeFile(path.join(directory, filename), sql)),
  );

  return directory;
}

class FakeMigrationExecutor implements SqlExecutor {
  public readonly executedMigrationSql: string[] = [];

  private readonly records: AppliedMigrationRecord[] = [];

  public async query<T = unknown>(
    text: string,
    values: unknown[] = [],
  ): Promise<{ rows: T[] }> {
    const normalized = text.trim().replace(/\s+/gu, " ");

    if (normalized.startsWith("CREATE TABLE IF NOT EXISTS schema_migrations")) {
      return rows([]);
    }

    if (normalized.startsWith("SELECT pg_advisory_lock")) {
      return rows([]);
    }

    if (normalized.startsWith("SELECT pg_advisory_unlock")) {
      return rows([]);
    }

    if (normalized === "BEGIN" || normalized === "COMMIT" || normalized === "ROLLBACK") {
      return rows([]);
    }

    if (normalized.startsWith("LOCK TABLE schema_migrations")) {
      return rows([]);
    }

    if (normalized.includes("FROM schema_migrations") && normalized.includes("ORDER BY")) {
      return rows(this.records) as { rows: T[] };
    }

    if (normalized.includes("FROM schema_migrations") && normalized.includes("WHERE version = $1")) {
      return rows(this.records.filter((record) => record.version === values[0])) as { rows: T[] };
    }

    if (normalized.startsWith("INSERT INTO schema_migrations")) {
      this.records.push({
        version: Number(values[0]),
        filename: String(values[1]),
        checksum: String(values[2]),
        applied_at: new Date(),
      });
      return rows([]);
    }

    this.executedMigrationSql.push(text);
    return rows([]);
  }
}

class FakeMigrationConnectionProvider implements SqlExecutor {
  public connectCount = 0;
  public releaseCount = 0;

  public constructor(private readonly client: FakeMigrationExecutor) {}

  public async connect(): Promise<SqlExecutor & { release(): void }> {
    this.connectCount += 1;
    return {
      query: this.client.query.bind(this.client),
      release: () => {
        this.releaseCount += 1;
      },
    };
  }

  public async query<T = unknown>(): Promise<{ rows: T[] }> {
    throw new Error("pool-level query must not be used for migrations");
  }
}

function rows<T>(value: T[]): { rows: T[] } {
  return { rows: value };
}
