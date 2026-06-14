import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  evaluateLiveOpsDbReadiness,
  formatLiveOpsDbReadinessFailureMessage,
} from "../../src/runtime/index.js";
import { loadMigrationFiles } from "../../src/infrastructure/db/index.js";
import type { AppliedMigrationRecord, SqlExecutor } from "../../src/infrastructure/db/index.js";

const tempDirectories: string[] = [];

describe("production live ops DB readiness", () => {
  afterEach(async () => {
    await Promise.all(tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true })));
  });

  it("통과한 DB는 migration 파일과 schema_migrations checksum이 일치해야 한다", async () => {
    const directory = await createTempMigrationDirectory({
      "000001_first.sql": "SELECT 1;\n",
      "000002_second.sql": "SELECT 2;\n",
    });
    const migrations = await loadMigrationFiles(directory);
    const executor = new FakeReadinessExecutor({
      tableExists: true,
      appliedRecords: migrations.map(toAppliedMigrationRecord),
    });

    const summary = await evaluateLiveOpsDbReadiness({
      executor,
      migrationsDirectory: directory,
      clock: () => new Date("2026-06-14T00:00:00.000Z"),
    });

    expect(summary.ready).toBe(true);
    expect(summary.status).toBe("ready");
    expect(summary.checkedAt).toBe("2026-06-14T00:00:00.000Z");
    expect(summary.migration).toMatchObject({
      expectedLatestVersion: 2,
      appliedLatestVersion: 2,
      pendingVersions: [],
      appliedVersions: [1, 2],
      tableExists: true,
    });
    expect(executor.queryTexts.join("\n")).not.toContain("CREATE TABLE");
    expect(executor.queryTexts.join("\n")).not.toContain("INSERT INTO schema_migrations");
  });

  it("pending migration이 있으면 live ops boot를 차단한다", async () => {
    const directory = await createTempMigrationDirectory({
      "000001_first.sql": "SELECT 1;\n",
      "000002_second.sql": "SELECT 2;\n",
    });
    const migrations = await loadMigrationFiles(directory);
    const executor = new FakeReadinessExecutor({
      tableExists: true,
      appliedRecords: [toAppliedMigrationRecord(migrations[0]!)],
    });

    const summary = await evaluateLiveOpsDbReadiness({
      executor,
      migrationsDirectory: directory,
    });

    expect(summary.ready).toBe(false);
    expect(summary.migration.pendingVersions).toEqual([2]);
    expect(summary.checks.map((check) => check.code)).toContain("pending_migrations");
    expect(formatLiveOpsDbReadinessFailureMessage(summary)).toContain("migration apply를 먼저 완료하세요");
  });

  it("schema_migrations 테이블이 없으면 모든 migration을 pending으로 보고 차단한다", async () => {
    const directory = await createTempMigrationDirectory({
      "000001_first.sql": "SELECT 1;\n",
      "000002_second.sql": "SELECT 2;\n",
    });
    const executor = new FakeReadinessExecutor({
      tableExists: false,
      appliedRecords: [],
    });

    const summary = await evaluateLiveOpsDbReadiness({
      executor,
      migrationsDirectory: directory,
    });

    expect(summary.ready).toBe(false);
    expect(summary.migration).toMatchObject({
      expectedLatestVersion: 2,
      appliedLatestVersion: null,
      pendingVersions: [1, 2],
      tableExists: false,
    });
    expect(summary.checks.map((check) => check.code)).toContain("schema_migrations_missing");
  });

  it("적용된 migration checksum이 바뀌면 schema drift로 차단한다", async () => {
    const directory = await createTempMigrationDirectory({
      "000001_first.sql": "SELECT 1;\n",
    });
    const [migration] = await loadMigrationFiles(directory);
    if (migration === undefined) {
      throw new Error("expected migration fixture");
    }
    const executor = new FakeReadinessExecutor({
      tableExists: true,
      appliedRecords: [
        {
          ...toAppliedMigrationRecord(migration),
          checksum: "changed",
        },
      ],
    });

    const summary = await evaluateLiveOpsDbReadiness({
      executor,
      migrationsDirectory: directory,
    });

    expect(summary.ready).toBe(false);
    expect(summary.checks.map((check) => check.code)).toContain("migration_checksum_mismatch");
    expect(formatLiveOpsDbReadinessFailureMessage(summary)).toContain("schema drift");
  });

  it("DB connection probe 실패는 credential 없이 차단 요약으로 반환한다", async () => {
    const directory = await createTempMigrationDirectory({
      "000001_first.sql": "SELECT 1;\n",
    });
    const executor = new FakeReadinessExecutor({
      tableExists: true,
      appliedRecords: [],
      failConnection: true,
    });

    const summary = await evaluateLiveOpsDbReadiness({
      executor,
      migrationsDirectory: directory,
    });

    expect(summary.ready).toBe(false);
    expect(summary.checks.map((check) => check.code)).toContain("db_connection_failed");
    expect(JSON.stringify(summary)).not.toContain("postgres://");
  });
});

async function createTempMigrationDirectory(files: Record<string, string>): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "seemirai-live-ops-readiness-"));
  tempDirectories.push(directory);

  await Promise.all(
    Object.entries(files).map(([filename, sql]) => writeFile(path.join(directory, filename), sql)),
  );

  return directory;
}

function toAppliedMigrationRecord(migration: {
  version: number;
  filename: string;
  checksum: string;
}): AppliedMigrationRecord {
  return {
    version: migration.version,
    filename: migration.filename,
    checksum: migration.checksum,
    applied_at: new Date("2026-06-14T00:00:00.000Z"),
  };
}

/**
 * live ops DB readiness unit test에서 PostgreSQL을 대신하는 read-only executor다.
 *
 * 책임:
 * - readiness evaluator가 수행하는 연결 probe와 `schema_migrations` 조회만 응답한다.
 * - DDL/DML을 구현하지 않아 evaluator가 migration 적용 side effect를 만들면 테스트가 실패한다.
 */
class FakeReadinessExecutor implements SqlExecutor {
  public readonly queryTexts: string[] = [];

  public constructor(
    private readonly options: {
      readonly tableExists: boolean;
      readonly appliedRecords: readonly AppliedMigrationRecord[];
      readonly failConnection?: boolean;
    },
  ) {}

  public async query<T = unknown>(text: string): Promise<{ rows: T[] }> {
    this.queryTexts.push(text);
    const normalized = text.trim().replace(/\s+/gu, " ");

    if (normalized === "SELECT 1::int AS ok") {
      if (this.options.failConnection === true) {
        throw Object.assign(new Error("connection failed"), { name: "ConnectionError" });
      }
      return rows([{ ok: 1 }] as T[]);
    }

    if (normalized === "SELECT to_regclass('public.schema_migrations')::text AS table_name") {
      return rows([{ table_name: this.options.tableExists ? "schema_migrations" : null }] as T[]);
    }

    if (normalized.includes("FROM schema_migrations") && normalized.includes("ORDER BY version ASC")) {
      return rows(this.options.appliedRecords as T[]);
    }

    throw new Error(`unexpected query: ${normalized}`);
  }
}

function rows<T>(value: T[]): { rows: T[] } {
  return { rows: value };
}
