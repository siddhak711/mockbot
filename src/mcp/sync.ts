import type { ConnectorRecord, ConnectorToolSetting } from "../connectors";
import { connectorSlug } from "../connectors";
import { catalogById } from "../connectors/catalog";
import { discoverTool, type ToolRisk } from "../connectors/policy";
import { clip } from "../tools/http";
import type { ToolRegistry } from "../tools/registry";
import type { JsonSchema, JsonSchemaProperty, ToolDefinition } from "../tools/types";
import { callMcpTool, listMcpTools, type McpToolInfo } from "./client";
import { redactSecrets, secretsFor } from "./secrets";

const PROPERTY_TYPES = new Set(["string", "number", "integer", "boolean", "array", "object"]);

type RefreshOptions = {
  registry: ToolRegistry;
  connectors: readonly ConnectorRecord[];
  env: Record<string, string | undefined>;
  signal?: AbortSignal;
  onToolResult?: (connectorId: string, result: { isError: boolean; content: string }) => void;
  onTools?: (
    connectorId: string,
    tools: Record<string, ConnectorToolSetting>,
  ) => Promise<void> | void;
};

let queue: Promise<void> = Promise.resolve();

export async function withFreshTools<T>(run: () => Promise<T>): Promise<T> {
  let released = false;
  let resolveHold: () => void = () => undefined;
  const hold = new Promise<void>((resolve) => {
    resolveHold = () => {
      if (released) return;
      released = true;
      resolve();
    };
  });
  const previous = queue;
  // A failed refresh must not reject the queue, or every later turn waits forever.
  queue = previous.then(
    () => hold,
    () => hold,
  );
  await previous.catch(() => undefined);
  try {
    return await run();
  } finally {
    resolveHold();
  }
}

type RemoteTool = McpToolInfo;

type ListedBatch = {
  connector: ConnectorRecord;
  tools: RemoteTool[];
  error?: unknown;
  paused?: boolean;
};

export type AssignedToolName = { name: string; remoteName: string };

export async function assignMcpToolNames(options: {
  registry: ToolRegistry;
  connectors: readonly ConnectorRecord[];
  env: Record<string, string | undefined>;
  signal?: AbortSignal;
}): Promise<{ names: Map<string, AssignedToolName[]>; batches: ListedBatch[] }> {
  const { registry, connectors, env, signal } = options;
  const batches = await listEnabledTools(connectors, env, signal);
  return {
    names: assignConnectorToolNames(registry.namesExcept("mcp"), batches),
    batches,
  };
}

export async function refreshMcpTools(options: RefreshOptions): Promise<void> {
  const { registry, connectors, env, signal, onToolResult, onTools } = options;
  const secrets = await secretsFor(connectors, env);
  const { names, batches } = await assignMcpToolNames({ registry, connectors, env, signal });
  registry.removeSource("mcp");
  for (const batch of batches) {
    if (batch.paused || batch.error) continue;
    const assigned = names.get(batch.connector.id) ?? [];
    const merged = mergeSettings(batch.connector, batch.tools, secrets);
    if (onTools && settingsChanged(batch.connector.tools, merged)) {
      await onTools(batch.connector.id, merged);
    }
    for (let index = 0; index < batch.tools.length; index += 1) {
      const tool = batch.tools[index];
      const name = assigned[index]?.name;
      if (!tool || !name) continue;
      const setting = merged[tool.name];
      if (!setting || !setting.enabled || setting.skipped) continue;
      registry.register(
        toToolDefinition(batch.connector, tool, name, setting, env, secrets, onToolResult),
        "mcp",
      );
    }
  }
}

export async function previewMcpTools(
  connector: ConnectorRecord,
  connectors: readonly ConnectorRecord[],
  env: Record<string, string | undefined>,
  registry: ToolRegistry,
  signal?: AbortSignal,
): Promise<AssignedToolName[]> {
  const { names, batches } = await assignMcpToolNames({
    registry,
    connectors,
    env,
    signal,
  });
  const listed = batches.find((batch) => batch.connector.id === connector.id);
  if (listed?.error) throw listed.error;
  return names.get(connector.id) ?? [];
}

async function listEnabledTools(
  connectors: readonly ConnectorRecord[],
  env: Record<string, string | undefined>,
  signal?: AbortSignal,
): Promise<ListedBatch[]> {
  const secrets = await secretsFor(connectors, env);
  const enabled = connectors.filter((connector) => connector.enabled);
  return Promise.all(
    enabled.map(async (connector) => {
      if (connector.status === "reconnect") return { connector, tools: [], paused: true };
      if (signal?.aborted) {
        return {
          connector,
          tools: [],
          error: Object.assign(new Error("The operation was aborted"), { name: "AbortError" }),
        };
      }
      if (connector.catalogId) return { connector, tools: catalogTools(connector) };
      try {
        const tools = await listMcpTools(connector, env, secrets, signal);
        return { connector, tools: tools.slice(0, 32) };
      } catch (error) {
        return { connector, tools: [], error };
      }
    }),
  );
}

function catalogTools(connector: ConnectorRecord): RemoteTool[] {
  const entry = connector.catalogId ? catalogById(connector.catalogId) : undefined;
  if (entry) {
    return entry.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      ...(tool.risk === "read" ? { readOnlyHint: true } : {}),
      ...(tool.risk === "destructive" ? { destructiveHint: true } : {}),
    }));
  }
  return Object.entries(connector.tools ?? {}).map(([name, setting]) => ({
    name,
    description: setting.description ?? name,
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    ...(setting.risk === "read" ? { readOnlyHint: true } : {}),
    ...(setting.risk === "destructive" ? { destructiveHint: true } : {}),
  }));
}

function mergeSettings(
  connector: ConnectorRecord,
  tools: readonly RemoteTool[],
  secrets: readonly string[],
): Record<string, ConnectorToolSetting> {
  const hasPolicy = Boolean(connector.tools && Object.keys(connector.tools).length > 0);
  const merged: Record<string, ConnectorToolSetting> = {};
  for (const [name, setting] of Object.entries(connector.tools ?? {})) {
    merged[name] = { ...setting };
  }
  for (const tool of tools) {
    const discovered = discoverTool(tool.name, tool.description, tool.inputSchema, {
      readOnlyHint: tool.readOnlyHint,
      destructiveHint: tool.destructiveHint,
    });
    if (!discovered.name) continue;
    const saved = connector.tools?.[discovered.name];
    const risk = saved?.risk ?? discovered.risk;
    const base = hasPolicy
      ? defaultFor(risk)
      : { enabled: !discovered.skipped, approval: defaultFor(risk).approval };
    let approval =
      saved?.approval === "auto" || saved?.approval === "ask" ? saved.approval : base.approval;
    let enabled = saved ? saved.enabled : base.enabled;
    if (risk === "read") approval = "auto";
    if (risk === "destructive") approval = "ask";
    if (discovered.skipped) enabled = false;
    merged[discovered.name] = {
      enabled,
      approval,
      risk,
      description: redactSecrets(discovered.description || saved?.description || "", secrets),
      skipped: discovered.skipped,
    };
  }
  return merged;
}

function defaultFor(risk: ToolRisk): { enabled: boolean; approval: "ask" | "auto" } {
  if (risk === "read") return { enabled: true, approval: "auto" };
  return { enabled: false, approval: "ask" };
}

function settingsChanged(
  previous: Record<string, ConnectorToolSetting> | undefined,
  next: Record<string, ConnectorToolSetting>,
): boolean {
  const before = previous ?? {};
  const beforeKeys = Object.keys(before);
  const nextKeys = Object.keys(next);
  if (!beforeKeys.length) return false;
  if (nextKeys.length < beforeKeys.length) return false;
  if (beforeKeys.some((name) => !next[name])) return false;
  if (beforeKeys.length !== nextKeys.length) return true;
  return nextKeys.some((name) => {
    const left = before[name];
    const right = next[name];
    if (!left || !right) return true;
    return (
      left.enabled !== right.enabled ||
      left.approval !== right.approval ||
      left.risk !== right.risk ||
      left.skipped !== right.skipped ||
      left.description !== right.description
    );
  });
}

function assignConnectorToolNames(
  reserved: Iterable<string>,
  batches: readonly ListedBatch[],
): Map<string, AssignedToolName[]> {
  const used = new Set(reserved);
  const names = new Map<string, AssignedToolName[]>();
  for (const batch of batches) {
    const assigned: AssignedToolName[] = [];
    for (const tool of batch.tools) {
      const name = localName(batch.connector, tool.name, used);
      used.add(name);
      assigned.push({ name, remoteName: tool.name });
    }
    names.set(batch.connector.id, assigned);
  }
  return names;
}

function toToolDefinition(
  connector: ConnectorRecord,
  tool: RemoteTool,
  name: string,
  setting: ConnectorToolSetting,
  env: Record<string, string | undefined>,
  secrets: readonly string[],
  onToolResult?: (connectorId: string, result: { isError: boolean; content: string }) => void,
): ToolDefinition {
  const remoteName = tool.name;
  const description = clip(
    redactSecrets(tool.description || `${connector.name} tool ${remoteName}`, secrets),
    1_024,
  );
  const inputSchema = schemaFrom(tool.inputSchema, secrets);
  const asks = setting.risk !== "read" && setting.approval !== "auto";
  return {
    name,
    description,
    inputSchema,
    exposure: "default",
    approval: asks ? "always" : "never",
    skipHeuristicApproval: setting.approval === "auto",
    async invoke(args, context) {
      if (connector.catalogId) {
        return {
          content: JSON.stringify({
            connector: connector.name,
            tool: remoteName,
            arguments: args,
          }),
        };
      }
      const result = await callMcpTool(connector, remoteName, args, env, secrets, context.signal);
      const content = redactSecrets(result.content, secrets);
      onToolResult?.(connector.id, { content, isError: result.isError });
      return { content, isError: result.isError };
    },
  };
}

function localName(connector: ConnectorRecord, remoteName: string, used: Set<string>): string {
  const base = `${connectorSlug(connector.name)}_${sanitize(remoteName)}`.slice(0, 52);
  if (!used.has(base)) return base;
  const suffix = connector.id.replace(/-/g, "").slice(0, 8);
  const qualified = `${base}_${suffix}`.slice(0, 64);
  if (!used.has(qualified)) return qualified;
  return `${qualified.slice(0, 50)}_${suffix}`;
}

function sanitize(name: string): string {
  const cleaned = name
    .replace(/[^A-Za-z0-9_-]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  return cleaned.slice(0, 32) || "tool";
}

function schemaFrom(schema: unknown, secrets: readonly string[]): JsonSchema {
  const redacted = redactSecrets(JSON.stringify(schema ?? {}), secrets);
  let parsed: unknown;
  try {
    parsed = JSON.parse(redacted) as unknown;
  } catch {
    parsed = {};
  }
  const record =
    parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  const properties: Record<string, JsonSchemaProperty> = {};
  const rawProperties = record.properties;
  if (rawProperties && typeof rawProperties === "object" && !Array.isArray(rawProperties)) {
    for (const [key, value] of Object.entries(rawProperties as Record<string, unknown>)) {
      if (!/^[A-Za-z0-9_-]+$/.test(key)) continue;
      properties[key] = propertyFrom(value);
    }
  }
  const required = Array.isArray(record.required)
    ? record.required.filter(
        (item): item is string => typeof item === "string" && item in properties,
      )
    : undefined;
  return {
    type: "object",
    properties,
    ...(required && required.length > 0 ? { required } : {}),
    additionalProperties: false,
  };
}

function propertyFrom(value: unknown): JsonSchemaProperty {
  const record =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const type =
    typeof record.type === "string" && PROPERTY_TYPES.has(record.type) ? record.type : "string";
  const property: JsonSchemaProperty = {
    type: type as JsonSchemaProperty["type"],
  };
  if (typeof record.description === "string" && record.description) {
    property.description = clip(record.description, 200);
  }
  if (Array.isArray(record.enum) && record.enum.every((item) => typeof item === "string")) {
    property.enum = record.enum;
  }
  return property;
}
