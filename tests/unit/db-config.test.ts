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

  it("allows env-only database URL loading without a config file secret", () => {
    const config = loadDatabaseConfig(
      {},
      {
        SEEMIRAI_DATABASE_URL: "postgres://env:local@127.0.0.1:55432/env_only",
      } as NodeJS.ProcessEnv,
    );

    expect(config.connectionString).toBe("postgres://env:local@127.0.0.1:55432/env_only");
  });

  it("applies SEEMIRAI_POSTGRES component overrides consistently with Docker Compose", () => {
    const config = loadDatabaseConfig(
      {
        connectionString: "postgres://seemirai:local@127.0.0.1:55432/seemirai_local",
      },
      {
        SEEMIRAI_POSTGRES_HOST: "127.0.0.1",
        SEEMIRAI_POSTGRES_PORT: "55433",
        SEEMIRAI_POSTGRES_USER: "custom_user",
        SEEMIRAI_POSTGRES_PASSWORD: "custom_password",
        SEEMIRAI_POSTGRES_DB: "custom_db",
      } as NodeJS.ProcessEnv,
    );

    expect(config.connectionString).toBe(
      "postgres://custom_user:custom_password@127.0.0.1:55433/custom_db",
    );
  });

  it("treats blank component env values like missing Docker Compose defaults", () => {
    const config = loadDatabaseConfig(
      {
        connectionString: "postgres://seemirai:local@127.0.0.1:55432/seemirai_local",
      },
      {
        SEEMIRAI_DATABASE_URL: "",
        SEEMIRAI_POSTGRES_PORT: "",
        SEEMIRAI_POSTGRES_PASSWORD: "custom_password",
      } as NodeJS.ProcessEnv,
    );

    expect(config.connectionString).toBe(
      "postgres://seemirai:custom_password@127.0.0.1:55432/seemirai_local",
    );
  });

  it("rejects invalid component port overrides", () => {
    expect(() =>
      loadDatabaseConfig(
        {
          connectionString: "postgres://seemirai:local@127.0.0.1:55432/seemirai_local",
        },
        {
          SEEMIRAI_POSTGRES_PORT: "5543x",
        } as NodeJS.ProcessEnv,
      ),
    ).toThrow("SEEMIRAI_POSTGRES_PORT");

    expect(() =>
      loadDatabaseConfig(
        {
          connectionString: "postgres://seemirai:local@127.0.0.1:55432/seemirai_local",
        },
        {
          SEEMIRAI_POSTGRES_PORT: "99999",
        } as NodeJS.ProcessEnv,
      ),
    ).toThrow("SEEMIRAI_POSTGRES_PORT");
  });

  it("rejects host component overrides that include a port", () => {
    expect(() =>
      loadDatabaseConfig(
        {
          connectionString: "postgres://seemirai:local@127.0.0.1:55432/seemirai_local",
        },
        {
          SEEMIRAI_POSTGRES_HOST: "localhost:55433",
        } as NodeJS.ProcessEnv,
      ),
    ).toThrow("SEEMIRAI_POSTGRES_HOST");
  });

  it("rejects incomplete postgres URLs", () => {
    expect(() =>
      loadDatabaseConfig({
        connectionString: "postgres://localhost",
      }),
    ).toThrow();

    expect(() =>
      loadDatabaseConfig(
        {},
        {
          SEEMIRAI_DATABASE_URL: "postgres://seemirai@localhost",
        } as NodeJS.ProcessEnv,
      ),
    ).toThrow();
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
