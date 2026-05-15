import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const migrationFilePattern = /^(\d{6})_[a-z0-9_]+\.sql$/u;

export const defaultMigrationsDirectory = fileURLToPath(
  new URL("../../../migrations", import.meta.url),
);

export interface SqlExecutor {
  query<T = unknown>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: T[] }>;
}

export interface SqlConnectionProvider extends SqlExecutor {
  connect(): Promise<SqlExecutor & { release(): void }>;
}

export interface MigrationFile {
  version: number;
  filename: string;
  checksum: string;
  sql: string;
}

export interface AppliedMigrationRecord {
  version: number;
  filename: string;
  checksum: string;
  applied_at: Date | string;
}

export interface MigrationRunResult {
  applied: MigrationFile[];
  skipped: MigrationFile[];
}

export class InvalidMigrationFilenameError extends Error {
  public constructor(filename: string) {
    super(`Invalid migration filename: ${filename}`);
    this.name = "InvalidMigrationFilenameError";
  }
}

export class DuplicateMigrationVersionError extends Error {
  public constructor(version: number) {
    super(`Duplicate migration version: ${version}`);
    this.name = "DuplicateMigrationVersionError";
  }
}

export class UnknownAppliedMigrationError extends Error {
  public constructor(record: AppliedMigrationRecord) {
    super(`Applied migration is missing from disk: ${record.version} ${record.filename}`);
    this.name = "UnknownAppliedMigrationError";
  }
}

export class MigrationChecksumMismatchError extends Error {
  public constructor(record: AppliedMigrationRecord, migration: MigrationFile) {
    super(
      `Applied migration checksum mismatch for ${migration.filename}: ` +
        `database=${record.checksum} disk=${migration.checksum}`,
    );
    this.name = "MigrationChecksumMismatchError";
  }
}

export async function loadMigrationFiles(
  migrationsDirectory = defaultMigrationsDirectory,
): Promise<MigrationFile[]> {
  const entries = await readdir(migrationsDirectory, { withFileTypes: true });
  const migrations: MigrationFile[] = [];

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".sql")) {
      continue;
    }

    const match = migrationFilePattern.exec(entry.name);
    if (match === null) {
      throw new InvalidMigrationFilenameError(entry.name);
    }

    const sql = await readFile(path.join(migrationsDirectory, entry.name), "utf8");
    migrations.push({
      version: Number(match[1]),
      filename: entry.name,
      checksum: checksumSql(sql),
      sql,
    });
  }

  return sortAndValidateMigrations(migrations);
}

export function createMigrationPlan(
  migrations: readonly MigrationFile[],
  appliedRecords: readonly AppliedMigrationRecord[],
): MigrationRunResult {
  const migrationsByVersion = new Map(migrations.map((migration) => [migration.version, migration]));
  const appliedVersions = new Set<number>();

  for (const record of appliedRecords) {
    const migration = migrationsByVersion.get(record.version);
    if (migration === undefined) {
      throw new UnknownAppliedMigrationError(record);
    }

    if (record.filename !== migration.filename || record.checksum !== migration.checksum) {
      throw new MigrationChecksumMismatchError(record, migration);
    }

    appliedVersions.add(record.version);
  }

  return {
    applied: migrations.filter((migration) => !appliedVersions.has(migration.version)),
    skipped: migrations.filter((migration) => appliedVersions.has(migration.version)),
  };
}

export async function applyMigrations(
  executor: SqlExecutor | SqlConnectionProvider,
  options: { migrationsDirectory?: string } = {},
): Promise<MigrationRunResult> {
  const connection = await acquireMigrationConnection(executor);

  try {
    return await applyMigrationsWithExecutor(connection.executor, options);
  } finally {
    connection.release();
  }
}

async function applyMigrationsWithExecutor(
  executor: SqlExecutor,
  options: { migrationsDirectory?: string },
): Promise<MigrationRunResult> {
  const migrations = await loadMigrationFiles(options.migrationsDirectory);
  await ensureSchemaMigrationsTable(executor);

  const appliedRecords = await listAppliedMigrations(executor);
  const plan = createMigrationPlan(migrations, appliedRecords);
  const applied: MigrationFile[] = [];

  for (const migration of plan.applied) {
    const didApply = await applyMigration(executor, migration);
    if (didApply) {
      applied.push(migration);
    }
  }

  return {
    applied,
    skipped: migrations.filter((migration) => !applied.includes(migration)),
  };
}

async function acquireMigrationConnection(
  executor: SqlExecutor | SqlConnectionProvider,
): Promise<{ executor: SqlExecutor; release(): void }> {
  if (!isSqlConnectionProvider(executor)) {
    return {
      executor,
      release() {},
    };
  }

  const client = await executor.connect();
  return {
    executor: client,
    release() {
      client.release();
    },
  };
}

function isSqlConnectionProvider(
  executor: SqlExecutor | SqlConnectionProvider,
): executor is SqlConnectionProvider {
  return "connect" in executor && typeof executor.connect === "function";
}

async function applyMigration(executor: SqlExecutor, migration: MigrationFile): Promise<boolean> {
  await executor.query("BEGIN");

  try {
    await executor.query("LOCK TABLE schema_migrations IN SHARE ROW EXCLUSIVE MODE");
    const existing = await getAppliedMigration(executor, migration.version);

    if (existing !== undefined) {
      assertAppliedMigrationMatches(existing, migration);
      await executor.query("COMMIT");
      return false;
    }

    await executor.query(migration.sql);
    await executor.query(
      `
        INSERT INTO schema_migrations (version, filename, checksum)
        VALUES ($1, $2, $3)
      `,
      [migration.version, migration.filename, migration.checksum],
    );
    await executor.query("COMMIT");
    return true;
  } catch (error) {
    await executor.query("ROLLBACK");
    throw error;
  }
}

async function ensureSchemaMigrationsTable(executor: SqlExecutor): Promise<void> {
  await executor.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version integer PRIMARY KEY,
      filename text NOT NULL UNIQUE,
      checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
}

async function listAppliedMigrations(executor: SqlExecutor): Promise<AppliedMigrationRecord[]> {
  const result = await executor.query<AppliedMigrationRecord>(`
    SELECT version, filename, checksum, applied_at
    FROM schema_migrations
    ORDER BY version ASC
  `);

  return result.rows;
}

async function getAppliedMigration(
  executor: SqlExecutor,
  version: number,
): Promise<AppliedMigrationRecord | undefined> {
  const result = await executor.query<AppliedMigrationRecord>(
    `
      SELECT version, filename, checksum, applied_at
      FROM schema_migrations
      WHERE version = $1
    `,
    [version],
  );

  return result.rows[0];
}

function assertAppliedMigrationMatches(
  record: AppliedMigrationRecord,
  migration: MigrationFile,
): void {
  if (record.filename !== migration.filename || record.checksum !== migration.checksum) {
    throw new MigrationChecksumMismatchError(record, migration);
  }
}

function sortAndValidateMigrations(migrations: MigrationFile[]): MigrationFile[] {
  const versions = new Set<number>();

  for (const migration of migrations) {
    if (versions.has(migration.version)) {
      throw new DuplicateMigrationVersionError(migration.version);
    }

    versions.add(migration.version);
  }

  return migrations.toSorted((left, right) => left.version - right.version);
}

function checksumSql(sql: string): string {
  return createHash("sha256").update(sql, "utf8").digest("hex");
}
