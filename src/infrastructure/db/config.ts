import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const localDatabaseConfigUrl = new URL("../../../config/local-db.json", import.meta.url);
const defaultLocalDatabaseUrl =
  "postgres://seemirai:seemirai_local_password@127.0.0.1:55432/seemirai_local";

const PoolConfigSchema = z
  .object({
    max: z.number().int().positive().default(5),
    idleTimeoutMillis: z.number().int().positive().default(30_000),
    connectionTimeoutMillis: z.number().int().positive().default(5_000),
  })
  .strict()
  .default({
    max: 5,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });

const RawDatabaseConfigSchema = z
  .object({
    connectionString: z.string().min(1).optional(),
    applicationName: z.string().min(1).default("seemirai-local"),
    ssl: z.boolean().default(false),
    pool: PoolConfigSchema,
  })
  .strict();

export const DatabaseConfigSchema = RawDatabaseConfigSchema.extend({
  connectionString: z
    .string()
    .min(1)
    .refine(
      isCompletePostgresConnectionString,
      "Complete PostgreSQL connection string with host, user, and database is required",
    ),
});

export type DatabaseConfig = z.infer<typeof DatabaseConfigSchema>;

export async function loadLocalDatabaseConfig(): Promise<DatabaseConfig> {
  return loadDatabaseConfigFile(fileURLToPath(localDatabaseConfigUrl));
}

export async function loadDatabaseConfigFile(filePath: string): Promise<DatabaseConfig> {
  const raw = await readFile(filePath, "utf8");
  const parsed: unknown = JSON.parse(raw);
  return loadDatabaseConfig(parsed);
}

export function loadDatabaseConfig(
  input: unknown,
  env: NodeJS.ProcessEnv = process.env,
): DatabaseConfig {
  const parsed = RawDatabaseConfigSchema.parse(input);
  const connectionString =
    nonEmptyEnvValue(env.SEEMIRAI_DATABASE_URL) ??
    nonEmptyEnvValue(env.DATABASE_URL) ??
    buildConnectionStringFromPostgresEnv(parsed.connectionString, env);

  return DatabaseConfigSchema.parse({
    ...parsed,
    connectionString,
  });
}

function buildConnectionStringFromPostgresEnv(
  baseConnectionString: string | undefined,
  env: NodeJS.ProcessEnv,
): string {
  const componentOverrides = {
    host: parsePostgresHostComponent(nonEmptyEnvValue(env.SEEMIRAI_POSTGRES_HOST)),
    port: parsePostgresPortComponent(nonEmptyEnvValue(env.SEEMIRAI_POSTGRES_PORT)),
    user: nonEmptyEnvValue(env.SEEMIRAI_POSTGRES_USER),
    password: nonEmptyEnvValue(env.SEEMIRAI_POSTGRES_PASSWORD),
    database: nonEmptyEnvValue(env.SEEMIRAI_POSTGRES_DB),
  };

  const hasComponentOverride = Object.values(componentOverrides).some(
    (value) => value !== undefined,
  );

  if (!hasComponentOverride) {
    return baseConnectionString ?? "";
  }

  const url = parsePostgresUrl(baseConnectionString) ?? new URL(defaultLocalDatabaseUrl);
  url.hostname = componentOverrides.host ?? url.hostname;
  url.port = componentOverrides.port ?? url.port;
  url.username = componentOverrides.user ?? url.username;
  url.password = componentOverrides.password ?? url.password;

  if (componentOverrides.database !== undefined) {
    url.pathname = `/${componentOverrides.database}`;
  }

  return url.toString();
}

function nonEmptyEnvValue(value: string | undefined): string | undefined {
  return value !== undefined && value.length > 0 ? value : undefined;
}

function parsePostgresHostComponent(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  try {
    const url = new URL(`postgres://${value}:5432/seemirai`);
    if (url.port !== "5432") {
      throw new Error("host must not include a port");
    }

    return url.hostname;
  } catch {
    throw new Error("SEEMIRAI_POSTGRES_HOST must be a host name without a port");
  }
}

function parsePostgresPortComponent(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!/^\d+$/u.test(value)) {
    throw new Error("SEEMIRAI_POSTGRES_PORT must be an integer between 1 and 65535");
  }

  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("SEEMIRAI_POSTGRES_PORT must be an integer between 1 and 65535");
  }

  return String(port);
}

function parsePostgresUrl(value: string | undefined): URL | undefined {
  if (value === undefined) {
    return undefined;
  }

  try {
    const url = new URL(value);
    return url.protocol === "postgres:" || url.protocol === "postgresql:" ? url : undefined;
  } catch {
    return undefined;
  }
}

function isCompletePostgresConnectionString(value: string): boolean {
  const url = parsePostgresUrl(value);
  if (url === undefined) {
    return false;
  }

  const database = decodeURIComponent(url.pathname).replace(/^\/+/u, "");
  return url.hostname.length > 0 && url.username.length > 0 && database.length > 0;
}
