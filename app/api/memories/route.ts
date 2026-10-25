import { getAppContext } from "../../../src/context";
import { groupMemories } from "../../../src/memory/group";
import { memoryAgentFromRequest } from "../../../src/memory/request-agent";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request?: Request): Promise<Response> {
  const selected = await memoryAgentFromRequest(request);
  if (!selected.ok) return selected.response;
  const { store } = await getAppContext();
  const rows = await store.memories.listForAgent(selected.agentId);
  return Response.json({ memories: groupMemories(rows) });
}
