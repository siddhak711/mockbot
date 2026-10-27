import { requireApiUser } from "../../../src/auth/guard";
import { streamChatTurn } from "../../../src/chat";
import { noteConnectorOutcome } from "../../../src/connectors/runtime";
import { getAppContext } from "../../../src/context";
import { refreshMcpTools, withFreshTools } from "../../../src/mcp/sync";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const actor = await requireApiUser(request);
  if (!actor.ok) return actor.response;
  const context = await getAppContext();
  const { store, provider, tools, approvals, asks, plans } = context;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Expected JSON body" }, { status: 400 });
  }
  if (!body || typeof body !== "object") {
    return Response.json({ error: "Expected JSON body" }, { status: 400 });
  }
  const record = body as {
    message?: unknown;
    conversationId?: unknown;
    agentId?: unknown;
    plan?: unknown;
  };
  return withFreshTools(async () => {
    const connectors = await store.listConnectors();
    await refreshMcpTools({
      registry: tools,
      connectors,
      env: process.env,
      userId: actor.user.id,
      signal: request.signal,
      onToolResult: (connectorId, result) => {
        void noteConnectorOutcome(store, connectorId, result, actor.user.id);
      },
      onTools: (connectorId, next) => {
        void store.updateConnectorTools(connectorId, next);
      },
    });
    const agents =
      context.agents && actor.scoped ? context.agents.forUser(actor.user.id) : context.agents;
    return streamChatTurn({
      store,
      provider,
      tools: tools.clone(),
      approvals,
      asks,
      plans,
      plan: record.plan === true,
      message: typeof record.message === "string" ? record.message : "",
      conversationId: typeof record.conversationId === "string" ? record.conversationId : undefined,
      agentId: typeof record.agentId === "string" ? record.agentId : undefined,
      signal: request.signal,
      agents,
      memory: context.memory,
      computer: context.computer,
      connector: context.connector,
      userId: actor.scoped ? actor.user.id : undefined,
    });
  });
}
