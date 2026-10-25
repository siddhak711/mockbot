export type ConnectorTransport = "http" | "stdio";

export type ConnectorRecord = {
  id: string;
  name: string;
  transport: ConnectorTransport;
  target: string;
  secretRef: string | null;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
};

export type ConnectorInput = {
  name: string;
  transport: ConnectorTransport;
  target: string;
  secretRef: string | null;
};

const SECRET_REF = /^MCP_[A-Za-z0-9_]+$/;

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) <= 31) return true;
  }
  return false;
}
const COMMAND_TOKEN = /^[A-Za-z0-9._+/:@-]+$/;

export function connectorSlug(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 20);
  return slug || "mcp";
}

export function parseConnectorInput(
  body: unknown,
): { ok: true; value: ConnectorInput } | { ok: false; error: string } {
  if (!body || typeof body !== "object") return { ok: false, error: "Expected a JSON object." };
  const record = body as {
    name?: unknown;
    transport?: unknown;
    target?: unknown;
    secretRef?: unknown;
  };
  const name = typeof record.name === "string" ? record.name.trim() : "";
  if (!name) return { ok: false, error: "Name is required." };
  if (name.length > 80) return { ok: false, error: "Name is too long." };
  if (hasControlCharacter(name)) return { ok: false, error: "Name has invalid characters." };

  const transport = record.transport;
  if (transport !== "http" && transport !== "stdio") {
    return { ok: false, error: "Transport must be http or stdio." };
  }

  const target = typeof record.target === "string" ? record.target.trim() : "";
  if (!target) return { ok: false, error: "Target is required." };
  if (target.length > 500) return { ok: false, error: "Target is too long." };
  if (transport === "http") {
    const urlError = httpTargetError(target);
    if (urlError) return { ok: false, error: urlError };
  } else if (!splitCommand(target)) {
    return {
      ok: false,
      error: "The command must be a program and arguments separated by spaces, without a shell.",
    };
  }

  const secretRef = parseSecretRef(record.secretRef);
  if (secretRef === "invalid") {
    return {
      ok: false,
      error: "Secret reference must be an environment variable name that starts with MCP_.",
    };
  }

  return { ok: true, value: { name, transport, target, secretRef } };
}

export function parseEnabled(
  body: unknown,
): { ok: true; enabled: boolean } | { ok: false; error: string } {
  if (
    !body ||
    typeof body !== "object" ||
    typeof (body as { enabled?: unknown }).enabled !== "boolean"
  ) {
    return { ok: false, error: "enabled must be true or false." };
  }
  return { ok: true, enabled: (body as { enabled: boolean }).enabled };
}

export function splitCommand(target: string): { command: string; args: string[] } | null {
  const parts = target.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0 || parts.some((part) => !COMMAND_TOKEN.test(part))) return null;
  const [command, ...args] = parts;
  if (!command) return null;
  return { command, args };
}

export function httpTargetError(target: string): string | null {
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return "Target must be an http or https URL.";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return "Target must be an http or https URL.";
  }
  if (url.username || url.password) {
    return "Put the secret in a secret reference, not in the URL.";
  }
  return null;
}

function parseSecretRef(value: unknown): string | null | "invalid" {
  if (value == null) return null;
  if (typeof value !== "string") return "invalid";
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > 128 || !SECRET_REF.test(trimmed)) return "invalid";
  return trimmed;
}
