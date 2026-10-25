import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { splitCommand, type ConnectorRecord } from "../connectors";
import { isAbortError } from "../tools/http";
import { redactSecrets, resolveSecret } from "./secrets";

const LIST_TIMEOUT_MS = 10_000;
const CALL_TIMEOUT_MS = 20_000;

export type McpToolInfo = {
  name: string;
  description: string;
  inputSchema: unknown;
};

export class McpClientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpClientError";
  }
}

function abortError(): Error {
  return Object.assign(new Error("The operation was aborted"), { name: "AbortError" });
}

function rethrowAbort(error: unknown, signal?: AbortSignal): never {
  if (signal?.aborted || isAbortError(error)) throw abortError();
  throw error;
}

async function withClient<T>(
  connector: ConnectorRecord,
  env: Record<string, string | undefined>,
  secrets: readonly string[],
  signal: AbortSignal | undefined,
  run: (client: Client) => Promise<T>,
): Promise<T> {
  if (signal?.aborted) throw abortError();
  const resolved = resolveSecret(connector.secretRef, env);
  if (!resolved.ok) throw new McpClientError(resolved.error);
  const client = new Client({ name: "mockbot", version: "0.1.0" });
  const transport = createTransport(connector, resolved.secret);
  if (transport instanceof StdioClientTransport && transport.stderr) {
    transport.stderr.on("data", () => undefined);
  }
  try {
    await client.connect(transport, { timeout: LIST_TIMEOUT_MS, signal });
    const result = await run(client);
    await closeClient(transport, client);
    return result;
  } catch (error) {
    await closeClient(transport, client);
    rethrowAbort(error, signal);
  }
}

async function closeClient(
  transport: StreamableHTTPClientTransport | StdioClientTransport,
  client: Client,
): Promise<void> {
  if (transport instanceof StreamableHTTPClientTransport) {
    await transport.terminateSession().catch(() => undefined);
  }
  await client.close().catch(() => undefined);
}

function createTransport(connector: ConnectorRecord, secret: string | undefined) {
  if (connector.transport === "http") {
    const headers: Record<string, string> = {};
    if (secret) headers.Authorization = `Bearer ${secret}`;
    return new StreamableHTTPClientTransport(new URL(connector.target), {
      requestInit: secret ? { headers } : undefined,
    });
  }
  const command = splitCommand(connector.target);
  if (!command) throw new McpClientError("The connector command is not valid.");
  const childEnv = getDefaultEnvironment();
  if (connector.secretRef && secret) childEnv[connector.secretRef] = secret;
  return new StdioClientTransport({
    command: command.command,
    args: command.args,
    env: childEnv,
    stderr: "pipe",
  });
}

function failureMessage(error: unknown, secrets: readonly string[]): string {
  const message = error instanceof Error ? error.message : "The MCP request failed.";
  return redactSecrets(message, secrets);
}

export async function listMcpTools(
  connector: ConnectorRecord,
  env: Record<string, string | undefined>,
  secrets: readonly string[],
  signal?: AbortSignal,
): Promise<McpToolInfo[]> {
  try {
    return await withClient(connector, env, secrets, signal, async (client) => {
      const listed = await client.listTools(undefined, { timeout: LIST_TIMEOUT_MS, signal });
      return listed.tools.map((tool) => ({
        name: tool.name,
        description: typeof tool.description === "string" ? tool.description : "",
        inputSchema: tool.inputSchema,
      }));
    });
  } catch (error) {
    if (isAbortError(error)) throw error;
    throw new McpClientError(failureMessage(error, secrets));
  }
}

export async function callMcpTool(
  connector: ConnectorRecord,
  name: string,
  args: Record<string, unknown>,
  env: Record<string, string | undefined>,
  secrets: readonly string[],
  signal?: AbortSignal,
): Promise<{ content: string; isError: boolean }> {
  try {
    return await withClient(connector, env, secrets, signal, async (client) => {
      const result = await client.callTool(
        { name, arguments: args },
        { timeout: CALL_TIMEOUT_MS, signal },
      );
      return {
        content: redactSecrets(readContent(result), secrets),
        isError: result.isError === true,
      };
    });
  } catch (error) {
    if (isAbortError(error)) throw error;
    return { content: failureMessage(error, secrets), isError: true };
  }
}

function readContent(result: { content?: unknown; structuredContent?: unknown }): string {
  const blocks = Array.isArray(result.content) ? result.content : [];
  const text = blocks
    .map((block) => {
      if (!block || typeof block !== "object" || !("text" in block)) return "";
      return typeof block.text === "string" ? block.text : "";
    })
    .filter(Boolean)
    .join("\n");
  if (text.trim()) return text;
  if (result.structuredContent !== undefined) return JSON.stringify(result.structuredContent);
  return "The tool returned no content.";
}
