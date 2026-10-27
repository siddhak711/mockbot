import { requireApiUser } from "../../../src/auth/guard";
import { streamChatTurn } from "../../../src/chat";
import { noteConnectorOutcome } from "../../../src/connectors/runtime";
import { getAgents, getAppContext } from "../../../src/context";
import { refreshMcpTools } from "../../../src/mcp/sync";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const actor = await requireApiUser(request);
  if (!actor.ok) return actor.response;
  const context = await getAppContext();
  const { store, provider, tools, approvals } = context;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Expected JSON body" }, { status: 400 });
  }
  if (!body || typeof body !== "object") {
    return Response.json({ error: "Expected JSON body" }, { status: 400 });
  }
  const record = body as { message?: unknown; conversationId?: unknown; agentId?: unknown };
  const owner = actor.scoped ? actor.user.id : undefined;
  // Connector tools go on this turn's copy. The shared registry never holds
  // them, so one account's tools cannot reach another account's turn.
  const turnTools = tools.clone();
  await refreshMcpTools({
    registry: turnTools,
    connectors: await store.listConnectors(owner),
    env: process.env,
    userId: actor.user.id,
    signal: request.signal,
    onToolResult: (connectorId, result) => {
      void noteConnectorOutcome(store, connectorId, result, actor.user.id, owner);
    },
    onTools: (connectorId, next) => {
      void store.updateConnectorTools(connectorId, next, undefined, owner);
    },
  });
  const directory = await getAgents(context);
  const agents = actor.scoped ? directory.forUser(actor.user.id) : directory;
  return streamChatTurn({
    store,
    provider,
    tools: turnTools,
    approvals,
    message: typeof record.message === "string" ? record.message : "",
    conversationId: typeof record.conversationId === "string" ? record.conversationId : undefined,
    agentId: typeof record.agentId === "string" ? record.agentId : undefined,
    signal: request.signal,
    agents,
    memory: context.memory,
    computer: context.computer,
    connector: context.connector,
    userId: owner,
  });
}
