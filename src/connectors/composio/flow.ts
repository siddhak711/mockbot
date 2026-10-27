import type { ConnectorRecord, ConnectorToolSetting } from "../../connectors";
import { getAppContext } from "../../context";
import { discoverTool, resolveToolSettings } from "../policy";
import { catalogById, composioConnectorTarget, type CatalogEntry } from "../catalog";
import { createOAuthState } from "../oauth/flow";
import type { PendingOAuth } from "../oauth/pending";
import { getComposioBroker } from "./broker";
import { catalogUsesComposio } from "./config";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function composioCallbackUrl(origin: string, catalogId: string, state: string): string {
  const url = new URL("/connectors/oauth/callback", origin);
  url.searchParams.set("catalogId", catalogId);
  url.searchParams.set("state", state);
  return url.toString();
}

export async function beginComposioConnect(options: {
  entry: CatalogEntry;
  userId: string;
  origin: string;
  connectorId?: string;
  env: Record<string, string | undefined>;
}): Promise<{ authorizeUrl: string; pending: PendingOAuth }> {
  if (!catalogUsesComposio(options.entry, options.env)) {
    throw new Error(`${options.entry.name} is not available yet.`);
  }
  const toolkit = options.entry.composio?.toolkit;
  if (!toolkit) throw new Error(`${options.entry.name} is not available yet.`);
  if (options.connectorId && !UUID.test(options.connectorId)) {
    throw new Error("Unknown connector.");
  }
  const state = createOAuthState();
  const redirectUri = composioCallbackUrl(options.origin, options.entry.id, state);
  const broker = await getComposioBroker(options.env);
  const started = await broker.authorize({
    userId: options.userId,
    toolkit,
    callbackUrl: redirectUri,
  });
  return {
    authorizeUrl: started.redirectUrl,
    pending: {
      state,
      catalogId: options.entry.id,
      ...(options.connectorId ? { connectorId: options.connectorId } : {}),
      redirectUri,
      issuedAt: Date.now(),
      broker: "composio",
      userId: options.userId,
      connectedAccountId: started.connectedAccountId,
    },
  };
}

export async function completeComposioConnect(options: {
  pending: PendingOAuth;
  userId: string;
  returnedState: string;
  status: string;
  connectedAccountId: string;
  signal?: AbortSignal;
  env?: Record<string, string | undefined>;
}): Promise<{ connector: ConnectorRecord; account: string }> {
  const env = options.env ?? process.env;
  const entry = catalogById(options.pending.catalogId);
  if (!entry || !catalogUsesComposio(entry, env)) {
    throw new Error("That connector is not available.");
  }
  if (!options.returnedState || options.returnedState !== options.pending.state) {
    throw new Error("The sign-in state did not match. Start the connection again.");
  }
  if (options.pending.userId && options.pending.userId !== options.userId) {
    throw new Error("This sign-in belongs to a different account.");
  }
  if (options.status.toLowerCase() !== "success") {
    throw new Error(`${entry.name} did not finish sign-in.`);
  }
  const expected = options.pending.connectedAccountId;
  const connectedAccountId = options.connectedAccountId.trim();
  if (!connectedAccountId) throw new Error(`${entry.name} did not return a connection.`);
  if (expected && expected !== connectedAccountId) {
    throw new Error("The Composio connection did not match this sign-in.");
  }
  const toolkit = entry.composio?.toolkit;
  if (!toolkit) throw new Error(`${entry.name} is not available yet.`);
  const broker = await getComposioBroker(env);
  const account = await broker.getConnectedAccount({
    userId: options.userId,
    toolkit,
    connectedAccountId,
    fallbackLabel: entry.name,
  });
  if (account.status !== "ACTIVE") {
    throw new Error(`${entry.name} sign-in is not active yet.`);
  }
  const listed = await listToolsSafely(broker, toolkit, options.signal);
  const connector = await saveComposioConnector({
    entry,
    toolkit,
    connectorId: options.pending.connectorId,
    tools: listed.tools,
    error: listed.error,
  });
  const { store } = await getAppContext();
  await store.upsertComposioConnection({
    userId: options.userId,
    catalogId: entry.id,
    toolkit,
    connectedAccountId: account.id,
    accountLabel: account.label,
    status: "connected",
  });
  return { connector, account: account.label };
}

async function listToolsSafely(
  broker: Awaited<ReturnType<typeof getComposioBroker>>,
  toolkit: string,
  signal?: AbortSignal,
): Promise<{
  tools: {
    name: string;
    description: string;
    inputSchema: unknown;
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
  }[];
  error: string | null;
}> {
  if (signal?.aborted) return { tools: [], error: "The connection was cancelled." };
  try {
    const tools = await broker.listTools(toolkit);
    return {
      tools: tools.map((tool) => ({
        name: tool.slug,
        description: tool.description,
        inputSchema: tool.inputSchema,
        readOnlyHint: tool.readOnlyHint,
        destructiveHint: tool.destructiveHint,
      })),
      error: null,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message.trim().slice(0, 500) : "";
    return { tools: [], error: message || "Could not list Composio tools." };
  }
}

async function saveComposioConnector(options: {
  entry: CatalogEntry;
  toolkit: string;
  connectorId?: string;
  tools: {
    name: string;
    description: string;
    inputSchema: unknown;
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
  }[];
  error: string | null;
}): Promise<ConnectorRecord> {
  const target = composioConnectorTarget(options.toolkit);
  const { store } = await getAppContext();
  const existing = await store.listConnectors();
  const current = options.connectorId
    ? existing.find((item) => item.id === options.connectorId)
    : existing.find((item) => item.catalogId === options.entry.id);
  if (options.connectorId && !current) throw new Error("That connector no longer exists.");
  if (current && current.catalogId && current.catalogId !== options.entry.id) {
    throw new Error("That connector belongs to a different app.");
  }
  const discovered = options.tools.length
    ? resolveToolSettings(
        options.tools.map((tool) =>
          discoverTool(tool.name, tool.description, tool.inputSchema, {
            readOnlyHint: tool.readOnlyHint,
            destructiveHint: tool.destructiveHint,
          }),
        ),
        current?.tools,
        "defaults",
      )
    : {};
  const settings: Record<string, ConnectorToolSetting> = current
    ? { ...(current.tools ?? {}), ...discovered }
    : discovered;
  const status = options.error ? "error" : "connected";
  if (current) {
    const saved = await store.saveBrokerConnector(current.id, {
      accountLabel: null,
      target,
      tools: settings,
      status,
      statusDetail: options.error,
    });
    if (!saved) throw new Error("That connector no longer exists.");
    return saved;
  }
  return store.insertCatalogConnector({
    name: options.entry.name,
    transport: "http",
    target,
    secretRef: null,
    catalogId: options.entry.id,
    authType: "oauth",
    accountLabel: null,
    status,
    statusDetail: options.error,
    tools: settings,
    seenTools: [],
  });
}
