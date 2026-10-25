import type { ConnectorRecord } from "../connectors";
import { connectorSlug } from "../connectors";
import { clip } from "../tools/http";
import type { ToolRegistry } from "../tools/registry";
import type { JsonSchema, JsonSchemaProperty, ToolDefinition } from "../tools/types";
import { callMcpTool, listMcpTools } from "./client";
import { redactSecrets, secretsFor } from "./secrets";

const PROPERTY_TYPES = new Set(["string", "number", "integer", "boolean", "array", "object"]);

type RefreshOptions = {
  registry: ToolRegistry;
  connectors: readonly ConnectorRecord[];
  env: Record<string, string | undefined>;
  signal?: AbortSignal;
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

type RemoteTool = { name: string; description: string; inputSchema: unknown };

type ListedBatch = {
  connector: ConnectorRecord;
  tools: RemoteTool[];
  error?: unknown;
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
  const { registry, connectors, env, signal } = options;
  const secrets = secretsFor(connectors, env);
  const { names, batches } = await assignMcpToolNames({ registry, connectors, env, signal });
  registry.removeSource("mcp");
  for (const batch of batches) {
    const assigned = names.get(batch.connector.id) ?? [];
    for (let index = 0; index < batch.tools.length; index += 1) {
      const tool = batch.tools[index];
      const name = assigned[index]?.name;
      if (!tool || !name) continue;
      registry.register(toToolDefinition(batch.connector, tool, name, env, secrets), "mcp");
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
  const secrets = secretsFor(connectors, env);
  const enabled = connectors.filter((connector) => connector.enabled);
  return Promise.all(
    enabled.map(async (connector) => {
      if (signal?.aborted) {
        return {
          connector,
          tools: [],
          error: Object.assign(new Error("The operation was aborted"), { name: "AbortError" }),
        };
      }
      try {
        const tools = await listMcpTools(connector, env, secrets, signal);
        return { connector, tools: tools.slice(0, 32) };
      } catch (error) {
        return { connector, tools: [], error };
      }
    }),
  );
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
  env: Record<string, string | undefined>,
  secrets: readonly string[],
): ToolDefinition {
  const remoteName = tool.name;
  const description = clip(
    redactSecrets(tool.description || `${connector.name} tool ${remoteName}`, secrets),
    1_024,
  );
  const inputSchema = schemaFrom(tool.inputSchema, secrets);
  return {
    name,
    description,
    inputSchema,
    exposure: "default",
    async invoke(args, context) {
      const result = await callMcpTool(connector, remoteName, args, env, secrets, context.signal);
      return {
        content: redactSecrets(result.content, secrets),
        isError: result.isError,
      };
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
