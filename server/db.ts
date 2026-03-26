import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "../shared/schema.js";

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
});

export const db = drizzle(pool, { schema });

/** Enable pg_trgm extension for trigram-based text search */
export async function initializeDatabase(): Promise<void> {
  await pool.query("CREATE EXTENSION IF NOT EXISTS pg_trgm");
}

/** Access the raw pool for custom SQL queries */
export { pool };
