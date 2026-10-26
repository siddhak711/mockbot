import type { ConnectorAuth, ConnectorRecord } from "../connectors";
import { McpClientError, listMcpTools } from "../mcp/client";
import { isAbortError } from "../tools/http";
import {
  discoverTool,
  hostFromTarget,
  isAuthFailure,
  unreachableMessage,
  type DiscoveredTool,
} from "./policy";

export type ProbeSuccess = {
  ok: true;
  transport: "http" | "stdio";
  transportLabel: "Streamable HTTP" | "SSE" | "stdio";
  auth: ConnectorAuth;
  tools: DiscoveredTool[];
  elapsedMs: number;
};

export type ProbeFailure = {
  ok: false;
  code: "unreachable" | "auth";
  message: string;
  auth?: ConnectorAuth;
  transportLabel?: "Streamable HTTP" | "SSE" | "stdio";
  elapsedMs: number;
};

export async function probeConnector(input: {
  transport: "http" | "stdio";
  target: string;
  name?: string;
  secretRef?: string | null;
  apiKey?: string;
  signal?: AbortSignal;
  env?: Record<string, string | undefined>;
}): Promise<ProbeSuccess | ProbeFailure> {
  const started = Date.now();
  const env = { ...(input.env ?? process.env) };
  const draft: ConnectorRecord = {
    id: crypto.randomUUID(),
    name: input.name?.trim() || "Connector",
    transport: input.transport,
    target: input.target,
    secretRef: input.secretRef ?? null,
    enabled: true,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  };
  if (input.apiKey) {
    draft.secretRef = "MCP_PROBE_KEY";
    env.MCP_PROBE_KEY = input.apiKey;
  }
  try {
    const listed = await listMcpTools(draft, env, input.apiKey ? [input.apiKey] : [], input.signal);
    const peeked =
      input.transport === "http" ? await peekTransport(input.target, input.signal) : null;
    return {
      ok: true,
      transport: input.transport,
      transportLabel: labelFor(input.transport, peeked),
      auth: input.apiKey ? "apikey" : "none",
      tools: listed.map((tool) =>
        discoverTool(tool.name, tool.description, tool.inputSchema, {
          readOnlyHint: tool.readOnlyHint,
          destructiveHint: tool.destructiveHint,
        }),
      ),
      elapsedMs: Date.now() - started,
    };
  } catch (error) {
    if (input.signal?.aborted || isAbortError(error)) throw error;
    const elapsedMs = Date.now() - started;
    const message =
      error instanceof McpClientError || error instanceof Error
        ? error.message
        : "Could not reach the MCP server.";
    if (message.startsWith("Set MCP_") || message.includes("could not be read")) {
      return { ok: false, code: "unreachable", message, elapsedMs };
    }
    const peeked =
      input.transport === "http" ? await peek(input.target, input.signal).catch(() => null) : null;
    const auth = classifyAuth(peeked, message);
    if (input.apiKey && (auth === "apikey" || auth === "oauth" || isAuthFailure(message))) {
      return {
        ok: false,
        code: "auth",
        auth: "apikey",
        message: "That key was rejected.",
        elapsedMs,
      };
    }
    if (!input.apiKey && (auth === "oauth" || auth === "apikey")) {
      return {
        ok: false,
        code: "auth",
        auth,
        message,
        transportLabel: labelFor(input.transport, peeked),
        elapsedMs,
      };
    }
    const timedOut = elapsedMs >= 9_000 || /timeout|timed out|aborted/i.test(message);
    return {
      ok: false,
      code: "unreachable",
      message: unreachableMessage(hostFromTarget(input.target), timedOut),
      transportLabel: labelFor(input.transport, peeked),
      elapsedMs,
    };
  }
}

function labelFor(
  transport: "http" | "stdio",
  peeked: { sse: boolean } | null,
): "Streamable HTTP" | "SSE" | "stdio" {
  if (transport === "stdio") return "stdio";
  if (peeked?.sse) return "SSE";
  return "Streamable HTTP";
}

function classifyAuth(
  peeked: { status: number; www: string } | null,
  message: string,
): ConnectorAuth {
  const www = peeked?.www.toLowerCase() ?? "";
  if (www.includes("oauth") || www.includes("resource_metadata")) return "oauth";
  if (peeked?.status === 401 || isAuthFailure(message)) return "apikey";
  return "none";
}

async function peekTransport(
  url: string,
  signal?: AbortSignal,
): Promise<{ status: number; www: string; sse: boolean } | null> {
  try {
    return await peek(url, signal);
  } catch (error) {
    if (signal?.aborted || isAbortError(error)) throw error;
    return null;
  }
}

async function peek(
  url: string,
  signal?: AbortSignal,
): Promise<{ status: number; www: string; sse: boolean }> {
  const response = await fetch(url, { method: "GET", signal, redirect: "manual" });
  return {
    status: response.status,
    www: response.headers.get("www-authenticate") ?? "",
    sse: (response.headers.get("content-type") ?? "").includes("text/event-stream"),
  };
}
