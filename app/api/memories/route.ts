import { DEFAULT_AGENT_ID } from "../../../src/agent";
import { getAppContext } from "../../../src/context";
import { groupMemories } from "../../../src/memory/group";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const { store } = await getAppContext();
  const rows = await store.memories.listForAgent(DEFAULT_AGENT_ID);
  return Response.json({ memories: groupMemories(rows) });
}
