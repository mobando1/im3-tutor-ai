import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "../shared/schema.js";

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
});

export const db = drizzle(pool, { schema });

/** Enable pg_trgm extension and create tables if they don't exist */
export async function initializeDatabase(): Promise<void> {
  await pool.query("CREATE EXTENSION IF NOT EXISTS pg_trgm");

  // Auto-create tables if they don't exist
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tutors (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      project_name TEXT NOT NULL,
      client_name TEXT NOT NULL,
      welcome_message TEXT NOT NULL DEFAULT 'Hola, soy tu tutor virtual. ¿En qué puedo ayudarte?',
      system_prompt TEXT NOT NULL DEFAULT '',
      theme TEXT NOT NULL DEFAULT 'light',
      accent_color TEXT NOT NULL DEFAULT '#2FA4A9',
      language TEXT NOT NULL DEFAULT 'es',
      api_key TEXT NOT NULL,
      is_active BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS tutor_documents (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tutor_id UUID NOT NULL REFERENCES tutors(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      content TEXT NOT NULL,
      chunks JSON NOT NULL,
      original_url TEXT,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS tutor_conversations (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tutor_id UUID NOT NULL REFERENCES tutors(id) ON DELETE CASCADE,
      session_id TEXT NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS tutor_messages (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      conversation_id UUID NOT NULL REFERENCES tutor_conversations(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      docs_used JSON,
      rating TEXT,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    );
  `);
}

/** Access the raw pool for custom SQL queries */
export { pool };
