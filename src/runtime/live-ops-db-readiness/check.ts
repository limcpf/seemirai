import {
  MigrationChecksumMismatchError,
  UnknownAppliedMigrationError,
  createMigrationPlan,
  defaultMigrationsDirectory,
  loadMigrationFiles,
} from "../../infrastructure/db/index.js";
import type {
  AppliedMigrationRecord,
  MigrationFile,
  SqlExecutor,
} from "../../infrastructure/db/index.js";

/**
 * live ops DB readiness의 최종 상태 코드다.
 *
 * 책임:
 * - 사용자 메시지는 한국어 `message`가 담당하고, 이 값은 자동화와 TUI badge가 안정적으로 분기할 수 있게 한다.
 * - `ready`가 아니면 live worker를 시작하지 않는 invariant를 유지한다.
 */
export type LiveOpsDbReadinessStatus = "ready" | "blocked";

/**
 * DB readiness를 구성하는 개별 probe 이름이다.
 *
 * 책임:
 * - 연결, migration 파일, 적용 이력 테이블, migration 비교를 서로 다른 failure boundary로 분리한다.
 * - 외부 side effect를 유발하지 않는 read-only probe만 포함한다.
 */
export type LiveOpsDbReadinessCheckName =
  | "db_connection"
  | "migration_files"
  | "schema_migrations_table"
  | "migration_state";

/**
 * 개별 DB readiness probe의 결과 코드다.
 *
 * 책임:
 * - `blocked`가 하나라도 있으면 summary 전체를 차단 상태로 만든다.
 * - 사람이 읽는 원인 설명은 `LiveOpsDbReadinessCheck.message`에 보존한다.
 */
export type LiveOpsDbReadinessCheckStatus = "ok" | "blocked";

/**
 * production live ops DB readiness를 계산할 때 필요한 입력 계약이다.
 *
 * 책임:
 * - 호출자가 이미 획득한 read-only SQL executor와 migration 디렉터리 override를 runtime 경계로 전달한다.
 * - 이 타입은 DB URL, credential, env 원문을 받지 않아 사용자 출력에 secret이 섞이지 않는 invariant를 유지한다.
 *
 * 호출 경계:
 * - `live:ops` boot guard, TUI status source, 향후 worker supervisor가 DB를 열기 직전에 호출한다.
 * - 함수 내부는 SQL 조회와 migration 파일 읽기만 수행하며 migration 적용 같은 DB write side effect는 만들지 않는다.
 */
export interface LiveOpsDbReadinessInput {
  readonly executor: SqlExecutor;
  readonly migrationsDirectory?: string;
  readonly clock?: () => Date;
}

/**
 * DB readiness의 개별 guard 결과다.
 *
 * 책임:
 * - 운영자가 바로 이해할 수 있는 한국어 message와, 자동화가 사용할 안정적인 code를 함께 보존한다.
 * - `details`에는 count/version 같은 안전한 evidence만 담고 credential 또는 DB URL은 담지 않는다.
 */
export interface LiveOpsDbReadinessCheck {
  readonly name: LiveOpsDbReadinessCheckName;
  readonly status: LiveOpsDbReadinessCheckStatus;
  readonly message: string;
  readonly code: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

/**
 * migration 파일과 `schema_migrations` 기록의 비교 요약이다.
 *
 * 책임:
 * - live ops가 기대하는 최신 schema version과 현재 DB version 차이를 안전하게 노출한다.
 * - pending version 목록은 적용 순서 판단용 evidence이며, 함수는 이 목록을 직접 적용하지 않는 invariant를 유지한다.
 */
export interface LiveOpsDbReadinessMigrationSummary {
  readonly expectedLatestVersion: number | null;
  readonly appliedLatestVersion: number | null;
  readonly pendingVersions: readonly number[];
  readonly appliedVersions: readonly number[];
  readonly tableExists: boolean;
}

/**
 * production live ops DB boot guard의 최종 사용자 안전 요약이다.
 *
 * 책임:
 * - boot를 계속해도 되는지(`ready`)와 차단 원인(`checks`)을 한 객체로 제공한다.
 * - 외부 side effect는 read-only query와 migration 파일 읽기에 제한되며, summary는 secret-free여야 한다.
 */
export interface LiveOpsDbReadinessSummary {
  readonly status: LiveOpsDbReadinessStatus;
  readonly ready: boolean;
  readonly checkedAt: string;
  readonly message: string;
  readonly migration: LiveOpsDbReadinessMigrationSummary;
  readonly checks: readonly LiveOpsDbReadinessCheck[];
}

/**
 * production live ops DB readiness를 read-only로 계산한다.
 *
 * 역할:
 * - DB 연결 가능 여부를 확인한다.
 * - 디스크 migration 파일과 DB `schema_migrations` 적용 기록을 비교한다.
 * - pending/unknown/checksum mismatch를 실운영 boot 차단 사유로 분류한다.
 *
 * @param input SQL executor, migration 디렉터리, 테스트용 clock
 * @returns secret-free DB readiness summary
 */
export async function evaluateLiveOpsDbReadiness(
  input: LiveOpsDbReadinessInput,
): Promise<LiveOpsDbReadinessSummary> {
  const checkedAt = (input.clock?.() ?? new Date()).toISOString();
  const migrationsDirectory = input.migrationsDirectory ?? defaultMigrationsDirectory;
  const checks: LiveOpsDbReadinessCheck[] = [];

  const connectionCheck = await checkDatabaseConnection(input.executor);
  checks.push(connectionCheck);

  const migrationFiles = await loadMigrationFilesForReadiness(migrationsDirectory, checks);
  if (migrationFiles === undefined) {
    // migration 파일 자체가 불확실하면 DB schema 기준도 신뢰할 수 없어 boot를 보수적으로 차단한다.
    return buildSummary(checkedAt, checks, emptyMigrationSummary(false));
  }

  if (connectionCheck.status === "blocked") {
    // DB에 붙지 못해도 디스크 기준 최신 version은 남겨 운영자가 어떤 schema 기준에서 막혔는지 확인하게 한다.
    return buildSummary(checkedAt, checks, buildMigrationSummary(migrationFiles, [], false));
  }

  const migrationSummary = await evaluateMigrationState(input.executor, migrationFiles, checks);

  return buildSummary(checkedAt, checks, migrationSummary);
}

/**
 * DB readiness 차단 결과를 CLI/Telegram/TUI에서 같은 사용자 언어로 재사용할 수 있게 포맷한다.
 *
 * @param summary readiness evaluator의 secret-free 결과
 * @returns 원인과 다음 조치가 포함된 한국어 메시지
 */
export function formatLiveOpsDbReadinessFailureMessage(
  summary: LiveOpsDbReadinessSummary,
): string {
  if (summary.ready) {
    return "DB readiness를 통과했습니다.";
  }

  const failures = summary.checks
    .filter((check) => check.status === "blocked")
    .map((check) => check.message);
  return `DB readiness를 통과하지 못해 live ops boot를 중단합니다. ${failures.join(" ")}`;
}

async function checkDatabaseConnection(executor: SqlExecutor): Promise<LiveOpsDbReadinessCheck> {
  try {
    await executor.query("SELECT 1::int AS ok");
    return okCheck("db_connection", "DB 연결 probe를 통과했습니다.", "db_connection_ok");
  } catch (error) {
    return blockedCheck(
      "db_connection",
      "DB에 연결할 수 없습니다. env file의 SEEMIRAI_DATABASE_URL과 네트워크 접근성을 확인하세요.",
      "db_connection_failed",
      { reason: safeErrorName(error) },
    );
  }
}

async function loadMigrationFilesForReadiness(
  migrationsDirectory: string,
  checks: LiveOpsDbReadinessCheck[],
): Promise<MigrationFile[] | undefined> {
  try {
    const migrations = await loadMigrationFiles(migrationsDirectory);
    if (migrations.length === 0) {
      // 적용 기준 파일이 없으면 DB가 최신인지 판단할 수 없으므로 live boot를 멈춘다.
      checks.push(
        blockedCheck(
          "migration_files",
          "migration 파일을 찾지 못했습니다. 운영 스키마 기준을 확인하세요.",
          "migration_files_missing",
        ),
      );
      return undefined;
    }

    checks.push(
      okCheck("migration_files", "migration 파일 기준을 읽었습니다.", "migration_files_ok", {
        expectedLatestVersion: latestVersionOf(migrations),
        migrationCount: migrations.length,
      }),
    );
    return migrations;
  } catch (error) {
    checks.push(
      blockedCheck(
        "migration_files",
        "migration 파일을 읽거나 검증할 수 없습니다. 파일명/version/checksum 기준을 확인하세요.",
        "migration_files_invalid",
        { reason: safeErrorName(error) },
      ),
    );
    return undefined;
  }
}

async function evaluateMigrationState(
  executor: SqlExecutor,
  migrations: readonly MigrationFile[],
  checks: LiveOpsDbReadinessCheck[],
): Promise<LiveOpsDbReadinessMigrationSummary> {
  const tableState = await readSchemaMigrationTableState(executor).catch((error) => {
    // 연결은 됐지만 migration state 조회가 실패하면 권한/테이블 손상 가능성이 있어 live boot를 차단한다.
    checks.push(
      blockedCheck(
        "migration_state",
        "DB migration 상태를 읽을 수 없습니다. schema_migrations 조회 권한과 테이블 상태를 확인하세요.",
        "migration_state_query_failed",
        { reason: safeErrorName(error) },
      ),
    );
    return undefined;
  });

  if (tableState === undefined) {
    return buildMigrationSummary(migrations, [], false);
  }

  checks.push(tableState.check);

  if (!tableState.tableExists) {
    const pendingVersions = migrations.map((migration) => migration.version);
    // schema_migrations가 없으면 적용 이력을 증명할 수 없어 모든 migration을 pending으로 보고 차단한다.
    checks.push(
      blockedCheck(
        "migration_state",
        "DB migration 이력이 없습니다. migration을 먼저 적용한 뒤 live ops를 시작하세요.",
        "schema_migrations_missing",
        {
          expectedLatestVersion: latestVersionOf(migrations),
          pendingCount: pendingVersions.length,
        },
      ),
    );
    return {
      expectedLatestVersion: latestVersionOf(migrations),
      appliedLatestVersion: null,
      pendingVersions,
      appliedVersions: [],
      tableExists: false,
    };
  }

  const appliedRecords = tableState.appliedRecords;
  const migrationSummary = buildMigrationSummary(migrations, appliedRecords, true);

  try {
    const plan = createMigrationPlan(migrations, appliedRecords);
    if (plan.applied.length > 0) {
      // pending migration은 live worker가 시작된 뒤 DB 계약이 바뀌는 것을 막기 위해 boot 전에 차단한다.
      checks.push(
        blockedCheck(
          "migration_state",
          "적용되지 않은 migration이 있습니다. migration apply를 먼저 완료하세요.",
          "pending_migrations",
          {
            expectedLatestVersion: migrationSummary.expectedLatestVersion,
            appliedLatestVersion: migrationSummary.appliedLatestVersion,
            pendingCount: plan.applied.length,
          },
        ),
      );
      return migrationSummary;
    }

    checks.push(
      okCheck("migration_state", "DB migration 상태가 디스크 기준과 일치합니다.", "migration_state_ok", {
        expectedLatestVersion: migrationSummary.expectedLatestVersion,
        appliedLatestVersion: migrationSummary.appliedLatestVersion,
      }),
    );
    return migrationSummary;
  } catch (error) {
    const code = error instanceof UnknownAppliedMigrationError
      ? "unknown_applied_migration"
      : error instanceof MigrationChecksumMismatchError
        ? "migration_checksum_mismatch"
        : "migration_state_invalid";
    // 적용 이력과 디스크 파일이 어긋나면 자동 복구가 위험하므로 사람이 schema drift를 확인해야 한다.
    checks.push(
      blockedCheck(
        "migration_state",
        "DB migration 이력이 현재 코드의 migration 파일과 일치하지 않습니다. schema drift를 확인하세요.",
        code,
        { reason: safeErrorName(error) },
      ),
    );
    return migrationSummary;
  }
}

async function readSchemaMigrationTableState(
  executor: SqlExecutor,
): Promise<{
  tableExists: boolean;
  appliedRecords: AppliedMigrationRecord[];
  check: LiveOpsDbReadinessCheck;
}> {
  const tableResult = await executor.query<{ table_name: string | null }>(
    "SELECT to_regclass('public.schema_migrations')::text AS table_name",
  );
  const tableExists = tableResult.rows[0]?.table_name !== null && tableResult.rows[0]?.table_name !== undefined;

  if (!tableExists) {
    return {
      tableExists: false,
      appliedRecords: [],
      check: blockedCheck(
        "schema_migrations_table",
        "schema_migrations 테이블이 없습니다. 운영 DB migration bootstrap을 먼저 실행하세요.",
        "schema_migrations_table_missing",
      ),
    };
  }

  const recordsResult = await executor.query<AppliedMigrationRecord>(`
    SELECT version, filename, checksum, applied_at
    FROM schema_migrations
    ORDER BY version ASC
  `);

  return {
    tableExists: true,
    appliedRecords: recordsResult.rows,
    check: okCheck("schema_migrations_table", "schema_migrations 적용 이력을 읽었습니다.", "schema_migrations_table_ok", {
      appliedCount: recordsResult.rows.length,
    }),
  };
}

function buildSummary(
  checkedAt: string,
  checks: readonly LiveOpsDbReadinessCheck[],
  migration: LiveOpsDbReadinessMigrationSummary,
): LiveOpsDbReadinessSummary {
  const ready = checks.every((check) => check.status === "ok");
  return {
    status: ready ? "ready" : "blocked",
    ready,
    checkedAt,
    message: ready
      ? "DB readiness를 통과했습니다."
      : "DB readiness를 통과하지 못해 live ops boot를 중단합니다.",
    migration,
    checks,
  };
}

function buildMigrationSummary(
  migrations: readonly MigrationFile[],
  appliedRecords: readonly AppliedMigrationRecord[],
  tableExists: boolean,
): LiveOpsDbReadinessMigrationSummary {
  const appliedVersions = appliedRecords.map((record) => record.version).toSorted((left, right) => left - right);
  const appliedVersionSet = new Set(appliedVersions);
  return {
    expectedLatestVersion: latestVersionOf(migrations),
    appliedLatestVersion: appliedVersions.at(-1) ?? null,
    pendingVersions: migrations
      .map((migration) => migration.version)
      .filter((version) => !appliedVersionSet.has(version)),
    appliedVersions,
    tableExists,
  };
}

function emptyMigrationSummary(tableExists: boolean): LiveOpsDbReadinessMigrationSummary {
  return {
    expectedLatestVersion: null,
    appliedLatestVersion: null,
    pendingVersions: [],
    appliedVersions: [],
    tableExists,
  };
}

function latestVersionOf(migrations: readonly MigrationFile[]): number | null {
  return migrations.at(-1)?.version ?? null;
}

function okCheck(
  name: LiveOpsDbReadinessCheckName,
  message: string,
  code: string,
  details?: Readonly<Record<string, unknown>>,
): LiveOpsDbReadinessCheck {
  const check: LiveOpsDbReadinessCheck = {
    name,
    status: "ok",
    message,
    code,
  };
  return details === undefined ? check : { ...check, details };
}

function blockedCheck(
  name: LiveOpsDbReadinessCheckName,
  message: string,
  code: string,
  details?: Readonly<Record<string, unknown>>,
): LiveOpsDbReadinessCheck {
  const check: LiveOpsDbReadinessCheck = {
    name,
    status: "blocked",
    message,
    code,
  };
  return details === undefined ? check : { ...check, details };
}

function safeErrorName(error: unknown): string {
  return error instanceof Error ? error.name : "UnknownError";
}
