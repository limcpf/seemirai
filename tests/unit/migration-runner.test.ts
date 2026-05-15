import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DuplicateMigrationVersionError,
  MigrationChecksumMismatchError,
  applyMigrations,
  createMigrationPlan,
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

function rows<T>(value: T[]): { rows: T[] } {
  return { rows: value };
}
