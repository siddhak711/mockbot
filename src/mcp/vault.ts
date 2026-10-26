import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const PREFIX = "v1";

export function connectorDataDir(env: Record<string, string | undefined> = process.env): string {
  return env.DATA_DIR?.trim() || ".data/pglite";
}

function hostedRuntime(env: Record<string, string | undefined>): boolean {
  return env.NODE_ENV === "production" || Boolean(env.VERCEL);
}

function keyFromEnv(env: Record<string, string | undefined>): Buffer | null {
  const raw = env.CONNECTOR_SECRET_KEY?.trim();
  if (!raw) return null;
  const decoded =
    raw.length === 64 && /^[0-9a-f]+$/i.test(raw)
      ? Buffer.from(raw, "hex")
      : Buffer.from(raw, "base64");
  if (decoded.length !== 32) {
    throw new Error("CONNECTOR_SECRET_KEY must decode to 32 bytes (base64 or hex).");
  }
  return decoded;
}

async function loadKey(
  dataDir: string,
  env: Record<string, string | undefined> = process.env,
): Promise<Buffer> {
  const fromEnv = keyFromEnv(env);
  if (fromEnv) return fromEnv;
  if (hostedRuntime(env)) {
    throw new Error("Set CONNECTOR_SECRET_KEY to encrypt connector secrets.");
  }
  await mkdir(dataDir, { recursive: true });
  const path = join(dataDir, "connector.key");
  try {
    const existing = await readFile(path);
    if (existing.length === 32) return existing;
  } catch {
    // A missing key file means this is the first secret stored on this machine.
  }
  const key = randomBytes(32);
  await writeFile(path, key, { mode: 0o600 });
  return key;
}

export async function encryptSecret(
  plaintext: string,
  dataDir = connectorDataDir(),
): Promise<string> {
  const key = await loadKey(dataDir);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    PREFIX,
    iv.toString("base64url"),
    tag.toString("base64url"),
    encrypted.toString("base64url"),
  ].join(".");
}

export async function decryptSecret(
  payload: string,
  dataDir = connectorDataDir(),
): Promise<string> {
  const [prefix, ivText, tagText, dataText] = payload.split(".");
  if (prefix !== PREFIX || !ivText || !tagText || !dataText) {
    throw new Error("The stored connector secret could not be read.");
  }
  const key = await loadKey(dataDir);
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivText, "base64url"));
  decipher.setAuthTag(Buffer.from(tagText, "base64url"));
  const plain = Buffer.concat([
    decipher.update(Buffer.from(dataText, "base64url")),
    decipher.final(),
  ]);
  return plain.toString("utf8");
}
