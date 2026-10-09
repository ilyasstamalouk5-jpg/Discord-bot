import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import * as schema from "./schema/index.js";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

export const pool = new Pool({ connectionString: process.env.DATABASE_URL });
export const db = drizzle(pool, { schema });

/**
 * Applies any SQL migrations that have not run yet. Safe to call on every
 * startup: already-applied migrations are skipped.
 */
export async function runMigrations(): Promise<void> {
  const migrationsFolder = fileURLToPath(
    new URL("../migrations", import.meta.url),
  );
  await migrate(db, { migrationsFolder });
}

export * from "./schema/index.js";
