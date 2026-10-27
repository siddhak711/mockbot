import type { Sql } from "../db/sql";
import { hashPassword, PasswordAuthError, validatePassword, verifyPassword } from "./password";

const NAME_MAX = 80;

export type AccountInfo = {
  id: string;
  name: string | null;
  email: string;
  image: string | null;
  hasPassword: boolean;
  providers: string[];
};

export async function readAccount(db: Sql, userId: string): Promise<AccountInfo | null> {
  const users = await db.query<{
    id: string;
    name: string | null;
    email: string;
    image: string | null;
    password_hash: string | null;
  }>(`SELECT id, name, email, image, password_hash FROM users WHERE id = $1`, [userId]);
  const row = users.rows[0];
  if (!row) return null;
  const accounts = await db.query<{ provider: string }>(
    `SELECT DISTINCT provider FROM accounts WHERE user_id = $1 ORDER BY provider ASC`,
    [userId],
  );
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    image: row.image,
    hasPassword: Boolean(row.password_hash),
    providers: accounts.rows.map((account) => account.provider),
  };
}

export async function renameAccount(db: Sql, userId: string, value: string): Promise<string> {
  const name = value.trim();
  if (!name) throw new PasswordAuthError("Enter a name.", 400);
  if (name.length > NAME_MAX) throw new PasswordAuthError("That name is too long.", 400);
  const result = await db.query<{ name: string }>(
    `UPDATE users SET name = $2, updated_at = NOW() WHERE id = $1 RETURNING name`,
    [userId, name],
  );
  if (!result.rows[0]) throw new PasswordAuthError("Account not found.", 404);
  return name;
}

/**
 * Changes a password after checking the current one, then signs out every
 * other session. The session making the change stays signed in.
 */
export async function changePassword(
  db: Sql,
  input: { userId: string; current: string; next: string; keepSessionToken: string | null },
): Promise<void> {
  const result = await db.query<{ password_hash: string | null }>(
    `SELECT password_hash FROM users WHERE id = $1`,
    [input.userId],
  );
  const hash = result.rows[0]?.password_hash;
  if (!hash) {
    throw new PasswordAuthError("This account signs in with Google and has no password.", 400);
  }
  if (!(await verifyPassword(input.current, hash))) {
    throw new PasswordAuthError("Current password is incorrect.", 401);
  }
  const next = validatePassword(input.next);
  const nextHash = await hashPassword(next);
  await db.transaction(async (tx) => {
    await tx.query(`UPDATE users SET password_hash = $2, updated_at = NOW() WHERE id = $1`, [
      input.userId,
      nextHash,
    ]);
    await tx.query(
      `DELETE FROM sessions WHERE user_id = $1 AND session_token IS DISTINCT FROM $2`,
      [input.userId, input.keepSessionToken],
    );
  });
}
