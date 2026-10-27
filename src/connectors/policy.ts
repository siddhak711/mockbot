import { httpTargetError, joinCommand, splitCommand } from "../connectors";

export type ToolRisk = "read" | "write" | "destructive";
export type ToolApprovalMode = "ask" | "auto";

export type ToolHints = {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
};

export type DiscoveredTool = {
  name: string;
  description: string;
  risk: ToolRisk;
  skipped: boolean;
  skipReason?: string;
};

export type StoredToolSetting = {
  enabled: boolean;
  approval: ToolApprovalMode;
  risk: ToolRisk;
  description: string;
  skipped: boolean;
};

const READ_NAME = /(^|_)(get|list|search|read)(_|$)/i;
const DESTRUCTIVE_NAME = /(^|_)(delete|remove|drop)(_|$)/i;

export const INVALID_TARGET_MESSAGE =
  "That isn't a valid URL or command. Try https://… or npx package-name.";

export const PASTED_OAUTH_UNSUPPORTED_MESSAGE =
  "Sign-in for pasted servers isn't supported yet; use an API key or a catalog connector.";

export function classifyToolRisk(name: string, hints?: ToolHints): ToolRisk {
  if (hints?.destructiveHint) return "destructive";
  if (hints?.readOnlyHint) return "read";
  if (DESTRUCTIVE_NAME.test(name)) return "destructive";
  if (READ_NAME.test(name)) return "read";
  return "write";
}

export function defaultToolSetting(risk: ToolRisk): {
  enabled: boolean;
  approval: ToolApprovalMode;
} {
  if (risk === "read") return { enabled: true, approval: "auto" };
  return { enabled: false, approval: "ask" };
}

export function schemaSkipReason(schema: unknown): string | null {
  if (schema == null) return null;
  if (typeof schema !== "object" || Array.isArray(schema)) return "invalid schema";
  const record = schema as { type?: unknown };
  if (typeof record.type === "string" && record.type !== "object") return "invalid schema";
  return null;
}

export function discoverTool(
  name: string,
  description: string,
  schema: unknown,
  hints?: ToolHints,
): DiscoveredTool {
  const trimmed = name.trim();
  if (!trimmed) {
    return {
      name: trimmed,
      description,
      risk: "write",
      skipped: true,
      skipReason: "invalid schema",
    };
  }
  const skipReason = schemaSkipReason(schema);
  return {
    name: trimmed,
    description,
    risk: classifyToolRisk(trimmed, hints),
    skipped: Boolean(skipReason),
    ...(skipReason ? { skipReason } : {}),
  };
}

export type ProvidedToolSetting = {
  enabled?: boolean;
  approval?: unknown;
};

export function resolveToolSettings(
  discovered: readonly DiscoveredTool[],
  provided: Record<string, ProvidedToolSetting> | undefined,
  mode: "legacy" | "defaults",
): Record<string, StoredToolSetting> {
  const settings: Record<string, StoredToolSetting> = {};
  for (const tool of discovered) {
    if (!tool.name) continue;
    const base =
      mode === "legacy"
        ? { enabled: !tool.skipped, approval: "auto" as const }
        : defaultToolSetting(tool.risk);
    const incoming = provided?.[tool.name];
    let enabled = typeof incoming?.enabled === "boolean" ? incoming.enabled : base.enabled;
    let approval: ToolApprovalMode =
      incoming?.approval === "auto" || incoming?.approval === "ask"
        ? incoming.approval
        : base.approval;
    if (tool.risk === "read") approval = "auto";
    if (tool.risk === "destructive") approval = "ask";
    if (tool.skipped) enabled = false;
    settings[tool.name] = {
      enabled,
      approval,
      risk: tool.risk,
      description: tool.description,
      skipped: tool.skipped,
    };
  }
  return settings;
}

export type ListedTool = {
  name: string;
  description: string;
  risk: ToolRisk;
  enabled: boolean;
  approval: ToolApprovalMode;
  skipped: boolean;
};

export function applyBulk(
  tools: readonly ListedTool[],
  action: "read-on" | "all-off" | "all-on",
): ListedTool[] {
  return tools.map((tool) => {
    if (tool.skipped) return tool;
    if (action === "all-off") return { ...tool, enabled: false };
    if (action === "read-on") {
      if (tool.risk !== "read") return tool;
      return { ...tool, enabled: true };
    }
    return {
      ...tool,
      enabled: true,
      approval: tool.risk === "destructive" ? "ask" : tool.approval,
    };
  });
}

export function enabledToolCount(
  tools: Record<string, { enabled: boolean; skipped?: boolean }>,
): number {
  return Object.values(tools).filter((tool) => tool.enabled && !tool.skipped).length;
}

export type DetectedInput =
  | { kind: "url"; target: string; valid: boolean; error?: string }
  | { kind: "command"; target: string; valid: boolean; error?: string }
  | {
      kind: "config";
      valid: boolean;
      error?: string;
      name?: string;
      target?: string;
      transport?: "http" | "stdio";
    }
  | { kind: "search"; query: string };

const URL_RE = /^https?:\/\//i;
const COMMAND_RE = /^(npx|uvx|docker|node|python)\s/i;

export function detectInput(raw: string): DetectedInput {
  const input = raw.trim();
  if (!input) return { kind: "search", query: "" };
  if (URL_RE.test(input)) {
    const error = httpTargetError(input);
    return error
      ? { kind: "url", target: input, valid: false, error: INVALID_TARGET_MESSAGE }
      : { kind: "url", target: input, valid: true };
  }
  if (COMMAND_RE.test(input)) {
    const command = splitCommand(input);
    return command
      ? { kind: "command", target: input, valid: true }
      : { kind: "command", target: input, valid: false, error: INVALID_TARGET_MESSAGE };
  }
  if (input.startsWith("{")) return parseConfig(input);
  return { kind: "search", query: input };
}

function parseConfig(input: string): DetectedInput {
  let value: unknown;
  try {
    value = JSON.parse(input) as unknown;
  } catch {
    return { kind: "config", valid: false, error: INVALID_TARGET_MESSAGE };
  }
  const server = firstServer(value);
  if (!server) return { kind: "config", valid: false, error: INVALID_TARGET_MESSAGE };
  if (typeof server.url === "string" && server.url.trim()) {
    const target = server.url.trim();
    const error = httpTargetError(target);
    if (error) return { kind: "config", valid: false, error: INVALID_TARGET_MESSAGE };
    return { kind: "config", valid: true, name: server.name, target, transport: "http" };
  }
  const command = commandFrom(server);
  if (!command || !splitCommand(command)) {
    return { kind: "config", valid: false, error: INVALID_TARGET_MESSAGE };
  }
  return { kind: "config", valid: true, name: server.name, target: command, transport: "stdio" };
}

type ServerShape = { name?: string; url?: unknown; command?: unknown; args?: unknown };

function firstServer(value: unknown): ServerShape | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if ("url" in record || "command" in record) {
    return { name: typeof record.name === "string" ? record.name : undefined, ...record };
  }
  const servers = record.mcpServers;
  if (!servers || typeof servers !== "object" || Array.isArray(servers)) return null;
  const entries = Object.entries(servers as Record<string, unknown>);
  const first = entries[0];
  if (!first) return null;
  const [name, config] = first;
  if (!config || typeof config !== "object" || Array.isArray(config)) return null;
  return { name, ...(config as Record<string, unknown>) };
}

function commandFrom(server: ServerShape): string | null {
  if (typeof server.command !== "string" || !server.command.trim()) return null;
  const args = Array.isArray(server.args)
    ? server.args.filter((item): item is string => typeof item === "string")
    : [];
  return joinCommand([server.command.trim(), ...args]);
}

export function unreachableMessage(host: string, timedOut: boolean): string {
  if (timedOut) {
    return `Couldn't reach ${host} (timed out after 10 s). Check the URL, VPN, or that the server is running.`;
  }
  return `Couldn't reach ${host}. Check the URL, VPN, or that the server is running.`;
}

export function isAuthFailure(message: string): boolean {
  return /\b(?:401|unauthorized|invalid_token|access_denied|token expired|token has expired|revoked)\b/i.test(
    message,
  );
}

export function hostFromTarget(target: string): string {
  try {
    return new URL(target).host || target;
  } catch {
    return target;
  }
}
