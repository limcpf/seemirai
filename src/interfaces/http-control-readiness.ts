import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import type { RuntimeConfig } from "../runtime/index.js";
import type { Database } from "../infrastructure/db/index.js";
import { toErrorMessage } from "./http-control-errors.js";
import type {
  ControlReadinessCheckResult,
  ControlReadinessProvider,
  ControlReadinessSummary,
  CreateDatabaseReadinessProviderOptions,
  ReadinessCheck,
} from "./http-control-types.js";

class ReadinessWriteRollback extends Error {
  public constructor() {
    super("readyz write check rollback");
    this.name = "ReadinessWriteRollback";
  }
}

/**
 * readiness check 묶음을 하나의 provider로 합친다.
 *
 * 각 check는 독립적으로 실행되며, 최종 ready 여부는 critical check의 성공 여부로만 계산한다.
 */
export function createControlReadinessProvider(checks: readonly ReadinessCheck[]): ControlReadinessProvider {
  return {
    async check(): Promise<ControlReadinessSummary> {
      const results = await Promise.all(checks.map((check) => check()));
      return toReadinessSummary(results, new Date().toISOString());
    },
  };
}

/**
 * PostgreSQL/TimescaleDB와 runtime config loaded 상태를 확인하는 기본 readiness provider다.
 *
 * HTTP control layer의 기본 readiness는 process 생존이 아니라 worker가 안전하게 실행될 수 있는지에 맞춘다.
 */
export function createDatabaseControlReadinessProvider(
  options: CreateDatabaseReadinessProviderOptions,
): ControlReadinessProvider {
  const clock = options.clock ?? (() => new Date());
  const checks: ReadinessCheck[] = [
    createRuntimeConfigLoadedCheck(options.runtimeConfig, clock),
    createDatabaseConnectionCheck(options.database, clock),
    createDatabaseWriteCheck(options.database, clock),
  ];

  if (options.expectedMigrationVersion !== undefined) {
    // 배포된 코드와 DB schema가 어긋난 상태에서는 worker를 ready로 올리지 않는다.
    checks.push(createMigrationVersionCheck(options.database, options.expectedMigrationVersion, clock));
  }

  return createControlReadinessProvider(checks);
}

/**
 * runtime config loader가 성공했는지 확인한다.
 *
 * config가 없으면 거래소, mode, universe 기준을 알 수 없으므로 critical readiness 실패로 처리한다.
 */
function createRuntimeConfigLoadedCheck(
  runtimeConfig: RuntimeConfig | undefined,
  clock: () => Date,
): ReadinessCheck {
  return async () => ({
    name: "runtime_config_loaded",
    status: runtimeConfig === undefined ? "fail" : "ok",
    critical: true,
    checkedAt: clock().toISOString(),
    message: runtimeConfig === undefined ? "runtime config is not loaded" : "runtime config is loaded",
    observedValue: runtimeConfig === undefined ? null : runtimeConfig.mode,
  });
}

/**
 * DB 접속 가능 여부를 가장 작은 read query로 확인한다.
 */
function createDatabaseConnectionCheck(database: Database | undefined, clock: () => Date): ReadinessCheck {
  return async () => {
    if (database === undefined) {
      return failedCheck("db_connection", "database is not configured", null, clock);
    }

    try {
      const result = await sql<{ ok: number }>`SELECT 1::int AS ok`.execute(database);
      return passedCheck("db_connection", "database connection is available", result.rows[0]?.ok ?? null, clock);
    } catch (error) {
      return failedCheck("db_connection", toErrorMessage(error), null, clock);
    }
  };
}

/**
 * 실제 애플리케이션 table에 쓰기 권한이 있는지 확인한다.
 *
 * TEMP table은 운영 schema 권한 문제를 놓칠 수 있으므로 `jobs`에 rollback insert를 수행한다.
 */
function createDatabaseWriteCheck(database: Database | undefined, clock: () => Date): ReadinessCheck {
  return async () => {
    if (database === undefined) {
      return failedCheck("db_write", "database is not configured", null, clock);
    }

    try {
      await database.transaction().execute(async (transaction) => {
        // 실제 앱 table 쓰기 권한을 확인한 뒤 의도적 rollback으로 데이터 흔적을 남기지 않는다.
        await transaction
          .insertInto("jobs")
          .values({
            job_type: "readyz.write_check",
            idempotency_key: `readyz.write_check:${randomUUID()}`,
            payload_json: {
              source: "http_control.readyz",
            },
            status: "PENDING",
          })
          .execute();
        throw new ReadinessWriteRollback();
      });
      return passedCheck("db_write", "database write check succeeded", true, clock);
    } catch (error) {
      if (error instanceof ReadinessWriteRollback) {
        // 의도한 rollback은 쓰기 권한 확인 성공 신호로 해석한다.
        return passedCheck("db_write", "database write check succeeded", true, clock);
      }

      return failedCheck("db_write", toErrorMessage(error), false, clock);
    }
  };
}

/**
 * 코드가 기대하는 migration version과 DB가 실제 적용한 version을 비교한다.
 */
function createMigrationVersionCheck(
  database: Database | undefined,
  expectedMigrationVersion: number,
  clock: () => Date,
): ReadinessCheck {
  return async () => {
    if (database === undefined) {
      return failedCheck("migration_version", "database is not configured", null, clock);
    }

    try {
      const result = await sql<{ version: number | null }>`
        SELECT max(version)::int AS version
        FROM schema_migrations
      `.execute(database);
      const version = result.rows[0]?.version ?? null;
      if (version !== expectedMigrationVersion) {
        // schema mismatch는 런타임 쿼리 실패로 이어질 수 있으므로 readiness에서 선제 차단한다.
        return failedCheck(
          "migration_version",
          `migration version mismatch: expected ${expectedMigrationVersion}, got ${String(version)}`,
          version,
          clock,
        );
      }

      return passedCheck("migration_version", "migration version matches", version, clock);
    } catch (error) {
      return failedCheck("migration_version", toErrorMessage(error), null, clock);
    }
  };
}

/**
 * critical check 결과를 `/readyz` 최종 판단으로 접는다.
 */
function toReadinessSummary(
  checks: readonly ControlReadinessCheckResult[],
  checkedAt: string,
): ControlReadinessSummary {
  const ready = checks.every((check) => !check.critical || check.status === "ok");
  return {
    status: ready ? "ok" : "error",
    ready,
    checkedAt,
    checks,
  };
}

function passedCheck(
  name: string,
  message: string,
  observedValue: string | number | boolean | null,
  clock: () => Date,
): ControlReadinessCheckResult {
  return {
    name,
    status: "ok",
    critical: true,
    checkedAt: clock().toISOString(),
    message,
    observedValue,
  };
}

function failedCheck(
  name: string,
  message: string,
  observedValue: string | number | boolean | null,
  clock: () => Date,
): ControlReadinessCheckResult {
  return {
    name,
    status: "fail",
    critical: true,
    checkedAt: clock().toISOString(),
    message,
    observedValue,
  };
}
