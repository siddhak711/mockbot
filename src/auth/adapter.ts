import type { Adapter, AdapterAccount, AdapterUser, VerificationToken } from "@auth/core/adapters";
import { randomUUID } from "node:crypto";
import { getAppContext } from "../context";
import type { Sql } from "../db/sql";

type UserRow = {
  id: string;
  name: string | null;
  email: string;
  email_verified: Date | string | null;
  image: string | null;
};

type SessionJoinRow = UserRow & {
  session_token: string;
  user_id: string;
  expires: Date | string;
};

function asDate(value: Date | string | null | undefined): Date | null {
  if (value == null) return null;
  if (value instanceof Date) return value;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function asText(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

function mapUser(row: UserRow): AdapterUser {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    emailVerified: asDate(row.email_verified),
    image: row.image,
  };
}

const USER_COLUMNS = "id, name, email, email_verified, image";

async function database(): Promise<Sql> {
  const { store } = await getAppContext();
  return store.connection;
}

export function createSqlAdapter(getDb: () => Promise<Sql> = database): Adapter {
  return {
    async createUser(user) {
      const db = await getDb();
      const id = user.id || randomUUID();
      const email = user.email.trim().toLowerCase();
      const result = await db.query<UserRow>(
        `INSERT INTO users (id, name, email, email_verified, image)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING ${USER_COLUMNS}`,
        [id, user.name ?? null, email, asDate(user.emailVerified), user.image ?? null],
      );
      const row = result.rows[0];
      if (!row) throw new Error("Failed to create user");
      return mapUser(row);
    },
    async getUser(id) {
      const db = await getDb();
      const result = await db.query<UserRow>(`SELECT ${USER_COLUMNS} FROM users WHERE id = $1`, [
        id,
      ]);
      const row = result.rows[0];
      return row ? mapUser(row) : null;
    },
    async getUserByEmail(email) {
      const db = await getDb();
      const result = await db.query<UserRow>(
        `SELECT ${USER_COLUMNS} FROM users WHERE lower(email) = lower($1)`,
        [email],
      );
      const row = result.rows[0];
      return row ? mapUser(row) : null;
    },
    async getUserByAccount({ provider, providerAccountId }) {
      const db = await getDb();
      const result = await db.query<UserRow>(
        `SELECT u.id, u.name, u.email, u.email_verified, u.image
         FROM users u
         JOIN accounts a ON a.user_id = u.id
         WHERE a.provider = $1 AND a.provider_account_id = $2`,
        [provider, providerAccountId],
      );
      const row = result.rows[0];
      return row ? mapUser(row) : null;
    },
    async updateUser(user) {
      const db = await getDb();
      const current = await db.query<UserRow>(`SELECT ${USER_COLUMNS} FROM users WHERE id = $1`, [
        user.id,
      ]);
      const row = current.rows[0];
      if (!row) throw new Error("User not found");
      const email = (user.email ?? row.email).trim().toLowerCase();
      const name = user.name === undefined ? row.name : user.name;
      const image = user.image === undefined ? row.image : user.image;
      const emailVerified =
        user.emailVerified === undefined ? asDate(row.email_verified) : asDate(user.emailVerified);
      const updated = await db.query<UserRow>(
        `UPDATE users
         SET name = $2, email = $3, email_verified = $4, image = $5, updated_at = NOW()
         WHERE id = $1
         RETURNING ${USER_COLUMNS}`,
        [user.id, name, email, emailVerified, image],
      );
      const next = updated.rows[0];
      if (!next) throw new Error("Failed to update user");
      return mapUser(next);
    },
    async deleteUser(userId) {
      const db = await getDb();
      await db.query(`DELETE FROM users WHERE id = $1`, [userId]);
    },
    async linkAccount(account) {
      const db = await getDb();
      await insertAccount(db, account);
    },
    async unlinkAccount({ provider, providerAccountId }) {
      const db = await getDb();
      await db.query(`DELETE FROM accounts WHERE provider = $1 AND provider_account_id = $2`, [
        provider,
        providerAccountId,
      ]);
    },
    async createSession(session) {
      const db = await getDb();
      await db.query(
        `INSERT INTO sessions (id, session_token, user_id, expires)
         VALUES ($1, $2, $3, $4)`,
        [randomUUID(), session.sessionToken, session.userId, session.expires],
      );
      return session;
    },
    async getSessionAndUser(sessionToken) {
      const db = await getDb();
      const result = await db.query<SessionJoinRow>(
        `SELECT u.id, u.name, u.email, u.email_verified, u.image,
                s.session_token, s.user_id, s.expires
         FROM sessions s
         JOIN users u ON u.id = s.user_id
         WHERE s.session_token = $1`,
        [sessionToken],
      );
      const row = result.rows[0];
      if (!row) return null;
      const expires = asDate(row.expires);
      if (!expires) return null;
      return {
        user: mapUser(row),
        session: {
          sessionToken: row.session_token,
          userId: row.user_id,
          expires,
        },
      };
    },
    async updateSession(session) {
      const db = await getDb();
      const result = await db.query<{
        session_token: string;
        user_id: string;
        expires: Date | string;
      }>(
        `UPDATE sessions
         SET expires = COALESCE($2, expires)
         WHERE session_token = $1
         RETURNING session_token, user_id, expires`,
        [session.sessionToken, session.expires ?? null],
      );
      const row = result.rows[0];
      if (!row) return null;
      const expires = asDate(row.expires);
      if (!expires) return null;
      return {
        sessionToken: row.session_token,
        userId: row.user_id,
        expires,
      };
    },
    async deleteSession(sessionToken) {
      const db = await getDb();
      await db.query(`DELETE FROM sessions WHERE session_token = $1`, [sessionToken]);
    },
    async createVerificationToken(token) {
      const db = await getDb();
      await db.query(
        `INSERT INTO verification_tokens (identifier, token, expires)
         VALUES ($1, $2, $3)`,
        [token.identifier, token.token, token.expires],
      );
      return token;
    },
    async useVerificationToken(params) {
      const db = await getDb();
      const result = await db.query<VerificationToken>(
        `DELETE FROM verification_tokens
         WHERE identifier = $1 AND token = $2
         RETURNING identifier, token, expires`,
        [params.identifier, params.token],
      );
      const row = result.rows[0];
      if (!row) return null;
      const expires = asDate(row.expires);
      if (!expires) return null;
      return { identifier: row.identifier, token: row.token, expires };
    },
  };
}

async function insertAccount(db: Sql, account: AdapterAccount): Promise<void> {
  await db.query(
    `INSERT INTO accounts (
       id, user_id, type, provider, provider_account_id,
       refresh_token, access_token, expires_at, token_type, scope, id_token, session_state
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [
      randomUUID(),
      account.userId,
      account.type,
      account.provider,
      account.providerAccountId,
      asText(account.refresh_token),
      asText(account.access_token),
      asNumber(account.expires_at),
      asText(account.token_type),
      asText(account.scope),
      asText(account.id_token),
      asText(account.session_state),
    ],
  );
}
