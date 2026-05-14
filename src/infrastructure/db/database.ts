import { Kysely, PostgresDialect } from "kysely";
import pg from "pg";
import type { Pool, PoolConfig } from "pg";
import type { DatabaseConfig } from "./config.js";
import type { DatabaseSchema } from "./schema.js";

const { Pool: PgPool } = pg;

export type Database = Kysely<DatabaseSchema>;

export function createPostgresPool(config: DatabaseConfig): Pool {
  return new PgPool(toPgPoolConfig(config));
}

export function createDatabase(pool: Pool): Database {
  return new Kysely<DatabaseSchema>({
    dialect: new PostgresDialect({
      pool,
    }),
  });
}

export async function destroyDatabase(database: Database): Promise<void> {
  await database.destroy();
}

function toPgPoolConfig(config: DatabaseConfig): PoolConfig {
  return {
    connectionString: config.connectionString,
    application_name: config.applicationName,
    ssl: config.ssl,
    max: config.pool.max,
    idleTimeoutMillis: config.pool.idleTimeoutMillis,
    connectionTimeoutMillis: config.pool.connectionTimeoutMillis,
  };
}
