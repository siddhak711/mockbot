import { streamChatTurn } from "../../../src/chat";
import { getAppContext } from "../../../src/context";
import { refreshMcpTools, withFreshTools } from "../../../src/mcp/sync";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
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
  return withFreshTools(async () => {
    const connectors = await store.listConnectors();
    await refreshMcpTools({
      registry: tools,
      connectors,
      env: process.env,
      signal: request.signal,
    });
    return streamChatTurn({
      store,
      provider,
      tools: tools.clone(),
      approvals,
      message: typeof record.message === "string" ? record.message : "",
      conversationId: typeof record.conversationId === "string" ? record.conversationId : undefined,
      agentId: typeof record.agentId === "string" ? record.agentId : undefined,
      signal: request.signal,
      agents: context.agents,
      memory: context.memory,
      computer: context.computer,
      connector: context.connector,
    });
  });
}
