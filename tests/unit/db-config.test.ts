import { describe, expect, it } from "vitest";
import {
  createDatabase,
  createPostgresPool,
  destroyDatabase,
  loadDatabaseConfig,
  loadLocalDatabaseConfig,
} from "../../src/infrastructure/db/index.js";

describe("database config", () => {
  it("loads the local development database config separately from the paper profile", async () => {
    const config = await loadLocalDatabaseConfig();

    expect(config.connectionString).toBe(
      "postgres://seemirai:seemirai_local_password@127.0.0.1:55432/seemirai_local",
    );
    expect(config.applicationName).toBe("seemirai-local");
    expect(config.ssl).toBe(false);
    expect(config.pool.max).toBe(5);
  });

  it("allows explicit environment override for local database URLs", () => {
    const config = loadDatabaseConfig(
      {
        connectionString: "postgres://seemirai:local@127.0.0.1:55432/seemirai_local",
      },
      {
        SEEMIRAI_DATABASE_URL: "postgresql://override:local@127.0.0.1:55432/override",
      } as NodeJS.ProcessEnv,
    );

    expect(config.connectionString).toBe("postgresql://override:local@127.0.0.1:55432/override");
  });

  it("rejects non-postgres connection strings", () => {
    expect(() =>
      loadDatabaseConfig({
        connectionString: "mysql://seemirai:local@127.0.0.1:3306/seemirai_local",
      }),
    ).toThrow();
  });

  it("creates a Kysely database boundary without connecting eagerly", async () => {
    const config = loadDatabaseConfig({
      connectionString: "postgres://seemirai:local@127.0.0.1:55432/seemirai_local",
    });

    const pool = createPostgresPool(config);
    const database = createDatabase(pool);

    expect(database).toBeDefined();
    await destroyDatabase(database);
  });
});
