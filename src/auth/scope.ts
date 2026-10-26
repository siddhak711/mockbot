import { LEAD_AGENT_NAME } from "../agents/ids";
import type { Sql } from "../db/sql";
import { SYSTEM_PROMPT } from "../llm";

function isUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  if ("code" in error && String((error as { code: unknown }).code) === "23505") return true;
  return error instanceof Error && error.message.includes("duplicate key");
}

/**
 * The earliest account adopts rows that predate accounts (user_id is still null).
 * Later accounts do not. Rows created without an owner after that, such as a
 * routine run, are adopted the next time that first account loads the app.
 */
async function claimOrphans(db: Sql, userId: string): Promise<void> {
  const claim = `WITH first_user AS (
       SELECT id FROM users ORDER BY created_at ASC, id ASC LIMIT 1
     )
     UPDATE table_name AS row
     SET user_id = first_user.id
     FROM first_user
     WHERE row.user_id IS NULL
       AND first_user.id = $1`;
  for (const table of ["agents", "conversations", "memories"] as const) {
    if (table === "agents") {
      await db.query(
        `WITH first_user AS (
           SELECT id FROM users ORDER BY created_at ASC, id ASC LIMIT 1
         )
         UPDATE agents AS row
         SET user_id = first_user.id
         FROM first_user
         WHERE row.user_id IS NULL
           AND first_user.id = $1
           AND NOT EXISTS (
             SELECT 1 FROM agents existing
             WHERE existing.user_id = first_user.id
               AND lower(existing.name) = lower(row.name)
           )`,
        [userId],
      );
      continue;
    }
    await db.query(claim.replaceAll("table_name", table), [userId]);
  }
}

async function ensureLead(db: Sql, userId: string): Promise<void> {
  const existing = await db.query<{ id: string }>(
    `SELECT id FROM agents WHERE user_id = $1 AND is_lead = TRUE LIMIT 1`,
    [userId],
  );
  if (existing.rows[0]) return;
  try {
    await db.query(
      `INSERT INTO agents (id, name, instructions, memory_note, user_id, is_lead)
       VALUES ($1, $2, $3, '', $4, TRUE)`,
      [`lead_${userId}`, LEAD_AGENT_NAME, SYSTEM_PROMPT, userId],
    );
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    await db.query(
      `UPDATE agents
       SET is_lead = TRUE
       WHERE user_id = $1
         AND lower(name) = lower($2)
         AND NOT EXISTS (
           SELECT 1 FROM agents lead
           WHERE lead.user_id = $1 AND lead.is_lead = TRUE
         )`,
      [userId, LEAD_AGENT_NAME],
    );
  }
}

export async function prepareUser(db: Sql, userId: string): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.query(`SELECT id FROM users WHERE id = $1 FOR UPDATE`, [userId]);
    await claimOrphans(tx, userId);
    await ensureLead(tx, userId);
  });
}
