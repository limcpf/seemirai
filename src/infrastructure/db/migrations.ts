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

/**
 * migration 디렉터리의 SQL 파일을 읽어 실행 가능한 migration 목록으로 변환한다.
 *
 * 흐름:
 * 1. 지정된 디렉터리에서 `.sql` 파일만 고른다.
 * 2. 파일명이 `000001_name.sql` 형식인지 검증한다.
 * 3. SQL 본문을 읽고 sha256 checksum을 계산한다.
 * 4. version 오름차순으로 정렬하고 중복 version을 차단한다.
 *
 * @param migrationsDirectory SQL migration 파일이 들어 있는 디렉터리
 * @returns version 순서로 정렬된 migration 파일 목록
 * @throws {InvalidMigrationFilenameError} SQL 파일명이 migration 규칙을 따르지 않을 때
 * @throws {DuplicateMigrationVersionError} 같은 version의 migration 파일이 2개 이상 있을 때
 */
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

/**
 * 디스크에 있는 migration 목록과 DB에 이미 적용된 기록을 비교해 실행 계획을 만든다.
 *
 * 흐름:
 * 1. 디스크 migration을 version 기준 map으로 만든다.
 * 2. DB 적용 기록이 현재 디스크에도 존재하는지 확인한다.
 * 3. filename 또는 checksum이 달라진 기록은 불변 migration 위반으로 중단한다.
 * 4. 아직 적용되지 않은 migration은 `applied`, 이미 같은 checksum으로 적용된 migration은 `skipped`로 분류한다.
 *
 * @param migrations 현재 디스크에서 읽은 migration 목록
 * @param appliedRecords DB의 `schema_migrations`에 기록된 적용 이력
 * @returns 이번 실행에서 적용할 migration과 건너뛸 migration 목록
 * @throws {UnknownAppliedMigrationError} DB에는 적용됐지만 디스크에서 사라진 migration이 있을 때
 * @throws {MigrationChecksumMismatchError} 이미 적용된 migration의 filename 또는 checksum이 바뀌었을 때
 */
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

/**
 * migration runner의 공개 entry point다.
 *
 * 역할:
 * - `pg.Pool` 같은 connection provider가 들어오면 단일 client를 checkout해 전체 migration 실행 동안 같은 PostgreSQL session을 사용한다.
 * - 이미 checkout된 client나 테스트용 executor가 들어오면 그대로 사용한다.
 * - 실행이 끝나면 성공/실패와 무관하게 checkout한 client를 release한다.
 *
 * @param executor SQL을 실행할 client 또는 `connect()`를 제공하는 connection provider
 * @param options migration 디렉터리 override 옵션
 * @returns 적용된 migration과 skip된 migration 목록
 */
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

/**
 * 실제 migration 실행 순서를 조립한다.
 *
 * 흐름:
 * 1. 디스크 migration 파일을 읽는다.
 * 2. `schema_migrations` 테이블이 없으면 만든다.
 * 3. DB 적용 이력을 읽어 실행 계획을 만든다.
 * 4. pending migration을 version 순서대로 하나씩 transaction 안에서 적용한다.
 * 5. 동시 실행으로 이미 적용된 migration은 재확인 후 skip한다.
 *
 * @param executor 단일 PostgreSQL session에 묶인 SQL executor
 * @param options migration 디렉터리 override 옵션
 * @returns 적용된 migration과 skip된 migration 목록
 */
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

/**
 * migration 실행에 사용할 SQL connection을 확보한다.
 *
 * `pg.Pool.query()`는 query마다 다른 client를 사용할 수 있으므로 transaction 경계가 깨질 수 있다.
 * 이 함수는 `connect()`가 있는 provider를 감지하면 client 하나를 checkout하고, 모든 `BEGIN`, DDL,
 * `COMMIT`이 같은 PostgreSQL session에서 실행되도록 고정한다.
 *
 * @param executor SQL executor 또는 connection provider
 * @returns 실제 query 대상 executor와 정리용 release 함수
 */
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

/**
 * 입력 executor가 `connect()`를 제공하는 connection provider인지 판별한다.
 *
 * @param executor SQL executor 또는 connection provider 후보
 * @returns provider이면 `true`, 이미 단일 executor이면 `false`
 */
function isSqlConnectionProvider(
  executor: SqlExecutor | SqlConnectionProvider,
): executor is SqlConnectionProvider {
  return "connect" in executor && typeof executor.connect === "function";
}

/**
 * migration 하나를 transaction 안에서 적용한다.
 *
 * 흐름:
 * 1. `BEGIN`으로 transaction을 시작한다.
 * 2. `schema_migrations`를 lock해 동시에 실행되는 runner와 version 기록 경쟁을 막는다.
 * 3. lock 이후 같은 version이 이미 적용됐는지 다시 확인한다.
 * 4. 미적용이면 SQL 본문을 실행하고 `schema_migrations`에 checksum을 기록한다.
 * 5. 성공하면 `COMMIT`, 실패하면 `ROLLBACK` 후 원래 error를 다시 던진다.
 *
 * @param executor 단일 PostgreSQL session에 묶인 SQL executor
 * @param migration 적용할 migration
 * @returns 이번 호출에서 실제 적용했으면 `true`, 이미 적용돼 skip했으면 `false`
 * @throws {MigrationChecksumMismatchError} 같은 version이 다른 filename/checksum으로 이미 적용됐을 때
 */
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

/**
 * migration 기록 테이블을 보장한다.
 *
 * 첫 migration 파일도 같은 테이블을 만들지만, runner가 적용 이력을 조회하기 전에
 * 항상 안전하게 존재하도록 한 번 더 `CREATE TABLE IF NOT EXISTS`를 실행한다.
 *
 * @param executor SQL executor
 */
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

/**
 * DB에 기록된 migration 적용 이력을 version 오름차순으로 조회한다.
 *
 * @param executor SQL executor
 * @returns `schema_migrations`에 기록된 적용 이력
 */
async function listAppliedMigrations(executor: SqlExecutor): Promise<AppliedMigrationRecord[]> {
  const result = await executor.query<AppliedMigrationRecord>(`
    SELECT version, filename, checksum, applied_at
    FROM schema_migrations
    ORDER BY version ASC
  `);

  return result.rows;
}

/**
 * 특정 version의 migration 적용 기록을 조회한다.
 *
 * 동시 runner가 같은 migration을 먼저 적용했는지 transaction lock 이후 재확인할 때 사용한다.
 *
 * @param executor SQL executor
 * @param version 조회할 migration version
 * @returns 적용 기록이 있으면 record, 없으면 `undefined`
 */
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

/**
 * DB에 기록된 migration과 디스크 migration이 같은 파일/본문인지 검증한다.
 *
 * migration은 한 번 적용되면 수정하지 않는다는 규칙을 지키기 위한 guard다.
 *
 * @param record DB에 이미 적용된 migration 기록
 * @param migration 현재 디스크에서 읽은 migration
 * @throws {MigrationChecksumMismatchError} filename 또는 checksum이 다를 때
 */
function assertAppliedMigrationMatches(
  record: AppliedMigrationRecord,
  migration: MigrationFile,
): void {
  if (record.filename !== migration.filename || record.checksum !== migration.checksum) {
    throw new MigrationChecksumMismatchError(record, migration);
  }
}

/**
 * migration version 중복을 검사하고 실행 순서를 고정한다.
 *
 * @param migrations 디스크에서 읽은 migration 목록
 * @returns version 오름차순으로 정렬된 migration 목록
 * @throws {DuplicateMigrationVersionError} 같은 version이 중복될 때
 */
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

/**
 * SQL 본문 checksum을 계산한다.
 *
 * DB에 저장된 checksum과 다음 실행 시 디스크 checksum을 비교해 이미 적용한 migration의 수정을 감지한다.
 *
 * @param sql migration SQL 본문
 * @returns sha256 hex checksum
 */
function checksumSql(sql: string): string {
  return createHash("sha256").update(sql, "utf8").digest("hex");
}
