import { randomBytes, randomUUID } from "node:crypto";
import type { Sql } from "../db/sql";
import { sessionExpiry } from "./cookies";
import type { SignedInUser } from "./user";

type SessionUserRow = {
  id: string;
  name: string | null;
  email: string;
  image: string | null;
  session_token: string;
  expires: Date | string;
};

function asDate(value: Date | string | null | undefined): Date | null {
  if (value == null) return null;
  if (value instanceof Date) return value;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export async function createDatabaseSession(
  db: Sql,
  userId: string,
  expires = sessionExpiry(),
): Promise<{ sessionToken: string; expires: Date }> {
  const sessionToken = randomBytes(32).toString("base64url");
  await db.query(
    `INSERT INTO sessions (id, session_token, user_id, expires)
     VALUES ($1, $2, $3, $4)`,
    [randomUUID(), sessionToken, userId, expires],
  );
  return { sessionToken, expires };
}

export async function readSessionUser(db: Sql, sessionToken: string): Promise<SignedInUser | null> {
  const result = await db.query<SessionUserRow>(
    `SELECT u.id, u.name, u.email, u.image, s.session_token, s.expires
     FROM sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.session_token = $1`,
    [sessionToken],
  );
  const row = result.rows[0];
  if (!row) return null;
  const expires = asDate(row.expires);
  if (!expires || expires.getTime() <= Date.now()) {
    await db.query(`DELETE FROM sessions WHERE session_token = $1`, [sessionToken]);
    return null;
  }
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    image: row.image,
  };
}
