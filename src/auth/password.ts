import bcrypt from "bcryptjs";
import type { Sql } from "../db/sql";
import { createDatabaseSession } from "./sessions";
import type { SignedInUser } from "./user";

const BCRYPT_COST = 12;
const PASSWORD_MIN = 10;
const PASSWORD_MAX_BYTES = 72;
const EMAIL_MAX = 254;
const NAME_MAX = 80;

/**
 * Cost-12 hash of a string that is not any user's password.
 * Failed lookups compare against it so missing accounts take the same time as real ones.
 */
const DUMMY_PASSWORD_HASH = "$2b$12$cXHn4SWeiDHpwnVl7OpNwOf12f/jMCDR63MQsr2yvvar6cvC1L.IO";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export class PasswordAuthError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "PasswordAuthError";
    this.status = status;
  }
}

export function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

export function validateEmail(value: string): string {
  const email = normalizeEmail(value);
  if (!email || email.length > EMAIL_MAX || !EMAIL_PATTERN.test(email)) {
    throw new PasswordAuthError("Enter a valid email address.", 400);
  }
  return email;
}

export function validatePassword(value: string): string {
  if (value.length < PASSWORD_MIN) {
    throw new PasswordAuthError(`Use at least ${PASSWORD_MIN} characters.`, 400);
  }
  if (Buffer.byteLength(value) > PASSWORD_MAX_BYTES) {
    throw new PasswordAuthError("That password is too long.", 400);
  }
  return value;
}

export function validateName(value: string | undefined, email: string): string {
  const name = value?.trim() || email.split("@")[0] || "User";
  if (name.length > NAME_MAX) throw new PasswordAuthError("That name is too long.", 400);
  return name;
}

export function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, BCRYPT_COST);
}

export function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

type UserRow = {
  id: string;
  name: string | null;
  email: string;
  image: string | null;
  password_hash: string | null;
};

function mapUser(row: UserRow): SignedInUser {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    image: row.image,
  };
}

function isUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  if ("code" in error && String((error as { code: unknown }).code) === "23505") return true;
  const message = error instanceof Error ? error.message : "";
  return message.includes("duplicate key") || message.includes("users_email_lower_idx");
}

async function findByEmail(db: Sql, email: string): Promise<UserRow | null> {
  const result = await db.query<UserRow>(
    `SELECT id, name, email, image, password_hash
     FROM users
     WHERE lower(email) = $1`,
    [email],
  );
  return result.rows[0] ?? null;
}

export async function signUpWithPassword(
  db: Sql,
  input: { email: string; password: string; name?: string },
): Promise<{ user: SignedInUser; sessionToken: string; expires: Date }> {
  const email = validateEmail(input.email);
  const password = validatePassword(input.password);
  const name = validateName(input.name, email);
  const passwordHash = await hashPassword(password);
  const id = crypto.randomUUID();
  try {
    const inserted = await db.query<UserRow>(
      `INSERT INTO users (id, name, email, password_hash)
       VALUES ($1, $2, $3, $4)
       RETURNING id, name, email, image, password_hash`,
      [id, name, email, passwordHash],
    );
    const row = inserted.rows[0];
    if (!row) throw new Error("Failed to create account");
    const session = await createDatabaseSession(db, row.id);
    return { user: mapUser(row), ...session };
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new PasswordAuthError("An account with that email already exists.", 409);
    }
    throw error;
  }
}

export async function signInWithPassword(
  db: Sql,
  input: { email: string; password: string },
): Promise<{ user: SignedInUser; sessionToken: string; expires: Date }> {
  const email = validateEmail(input.email);
  const password = validatePassword(input.password);
  const row = await findByEmail(db, email);
  const hash = row?.password_hash || DUMMY_PASSWORD_HASH;
  const matches = await verifyPassword(password, hash);
  if (!row?.password_hash || !matches) {
    throw new PasswordAuthError("Email or password is incorrect.", 401);
  }
  const session = await createDatabaseSession(db, row.id);
  return { user: mapUser(row), ...session };
}
