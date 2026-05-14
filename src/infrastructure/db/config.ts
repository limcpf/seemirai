import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const localDatabaseConfigUrl = new URL("../../../config/local-db.json", import.meta.url);

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

export const DatabaseConfigSchema = z
  .object({
    connectionString: z
      .string()
      .min(1)
      .refine(isPostgresConnectionString, "PostgreSQL connection string is required"),
    applicationName: z.string().min(1).default("seemirai-local"),
    ssl: z.boolean().default(false),
    pool: PoolConfigSchema,
  })
  .strict();

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
  const parsed = DatabaseConfigSchema.parse(input);
  const connectionString = env.SEEMIRAI_DATABASE_URL ?? env.DATABASE_URL ?? parsed.connectionString;

  return DatabaseConfigSchema.parse({
    ...parsed,
    connectionString,
  });
}

function isPostgresConnectionString(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "postgres:" || url.protocol === "postgresql:";
  } catch {
    return false;
  }
}
