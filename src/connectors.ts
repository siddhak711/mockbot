export type ConnectorTransport = "http" | "stdio";

export type ConnectorAuth = "oauth" | "apikey" | "none";

export type ConnectorStatus = "connected" | "error" | "reconnect" | "not connected";

export type ToolApprovalMode = "ask" | "auto";

export type ToolRisk = "read" | "write" | "destructive";

export type ConnectorToolSetting = {
  enabled: boolean;
  approval: ToolApprovalMode;
  risk?: ToolRisk;
  description?: string;
  skipped?: boolean;
};

export type ConnectorRecord = {
  id: string;
  name: string;
  transport: ConnectorTransport;
  target: string;
  secretRef: string | null;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  catalogId?: string | null;
  authType?: ConnectorAuth;
  accountLabel?: string | null;
  status?: ConnectorStatus;
  statusDetail?: string | null;
  tools?: Record<string, ConnectorToolSetting>;
  seenTools?: string[];
  failures?: number[];
  /** Server-only ciphertext. Never include this in an API response. */
  secretCipher?: string | null;
};

export type PublicConnector = Omit<ConnectorRecord, "secretCipher">;

export function toPublicConnector(record: ConnectorRecord): PublicConnector {
  const { secretCipher: _secret, ...visible } = record;
  return visible;
}

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

export function parseConnectorPatch(
  body: unknown,
):
  | { ok: true; enabled?: boolean; reconnected?: boolean; apiKey?: string }
  | { ok: false; error: string } {
  if (!body || typeof body !== "object") return { ok: false, error: "Expected a JSON object." };
  const record = body as { enabled?: unknown; reconnected?: unknown; apiKey?: unknown };
  const hasEnabled = "enabled" in record;
  const hasReconnected = record.reconnected === true;
  if (!hasEnabled && !hasReconnected) {
    return { ok: false, error: "enabled must be true or false." };
  }
  if (hasEnabled && typeof record.enabled !== "boolean") {
    return { ok: false, error: "enabled must be true or false." };
  }
  if ("apiKey" in record && record.apiKey != null && typeof record.apiKey !== "string") {
    return { ok: false, error: "API key is invalid." };
  }
  if (typeof record.apiKey === "string" && record.apiKey.length > 2_000) {
    return { ok: false, error: "API key is too long." };
  }
  return {
    ok: true,
    ...(hasEnabled ? { enabled: record.enabled as boolean } : {}),
    ...(hasReconnected ? { reconnected: true } : {}),
    ...(typeof record.apiKey === "string" && record.apiKey ? { apiKey: record.apiKey } : {}),
  };
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

// Tokens split on whitespace; a double-quoted token may hold spaces, so paths
// like "/Users/me/Claude Code/server.mjs" survive.
const QUOTED_TOKEN = /^[A-Za-z0-9._+/:@ -]+$/;

export function splitCommand(target: string): { command: string; args: string[] } | null {
  const parts: string[] = [];
  for (const match of target.trim().matchAll(/"([^"]*)"|(\S+)/g)) {
    const [, quoted, bare] = match;
    if (quoted !== undefined) {
      if (!quoted.trim() || !QUOTED_TOKEN.test(quoted)) return null;
      parts.push(quoted);
    } else if (bare !== undefined) {
      if (!COMMAND_TOKEN.test(bare)) return null;
      parts.push(bare);
    }
  }
  const [command, ...args] = parts;
  if (!command) return null;
  return { command, args };
}

export function joinCommand(parts: string[]): string {
  return parts.map((part) => (/\s/.test(part) ? `"${part}"` : part)).join(" ");
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

export function parseToolSettingsBody(body: unknown):
  | {
      ok: true;
      tools: Record<string, { enabled: boolean; approval?: ToolApprovalMode }>;
      markSeen: boolean;
    }
  | { ok: false; error: string } {
  if (!body || typeof body !== "object") return { ok: false, error: "Expected a JSON object." };
  const record = body as { tools?: unknown; markSeen?: unknown };
  const markSeen = record.markSeen === true;
  if (record.tools == null && !markSeen) {
    return { ok: false, error: "tools must be an object." };
  }
  if (record.tools == null) return { ok: true, tools: {}, markSeen };
  if (typeof record.tools !== "object" || Array.isArray(record.tools)) {
    return { ok: false, error: "tools must be an object." };
  }
  const tools: Record<string, { enabled: boolean; approval?: ToolApprovalMode }> = {};
  for (const [name, value] of Object.entries(record.tools as Record<string, unknown>)) {
    if (!/^[A-Za-z0-9_-]+$/.test(name)) return { ok: false, error: "Tool name is invalid." };
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return { ok: false, error: "Each tool needs enabled true or false." };
    }
    const setting = value as { enabled?: unknown; approval?: unknown };
    if (typeof setting.enabled !== "boolean") {
      return { ok: false, error: "Each tool needs enabled true or false." };
    }
    if (setting.approval != null && setting.approval !== "ask" && setting.approval !== "auto") {
      return { ok: false, error: "approval must be ask or auto." };
    }
    tools[name] = {
      enabled: setting.enabled,
      ...(setting.approval === "ask" || setting.approval === "auto"
        ? { approval: setting.approval }
        : {}),
    };
  }
  return { ok: true, tools, markSeen };
}

function parseSecretRef(value: unknown): string | null | "invalid" {
  if (value == null) return null;
  if (typeof value !== "string") return "invalid";
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > 128 || !SECRET_REF.test(trimmed)) return "invalid";
  return trimmed;
}
