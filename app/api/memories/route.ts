import { requireApiUser } from "../../../src/auth/guard";
import { getAppContext } from "../../../src/context";
import { groupMemories } from "../../../src/memory/group";
import { addKind, originForAdd } from "../../../src/memory/panel-logic";
import { memoryAgentFromRequest } from "../../../src/memory/request-agent";
import { saveMemory } from "../../../src/memory/save";
import { keyFromFact } from "../../../src/memory/prompt";
import type { MemoryKind } from "../../../src/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request?: Request): Promise<Response> {
  const actor = await requireApiUser(request);
  if (!actor.ok) return actor.response;
  const selected = await memoryAgentFromRequest(request, actor.scoped ? actor.user.id : undefined);
  if (!selected.ok) return selected.response;
  const { store } = await getAppContext();
  const [rows, proposals] = await Promise.all([
    store.memories.listForAgent(selected.agentId),
    store.memories.listProposals(selected.agentId),
  ]);
  return Response.json({ memories: groupMemories(rows), proposals });
}

export async function POST(request: Request): Promise<Response> {
  const actor = await requireApiUser(request);
  if (!actor.ok) return actor.response;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Expected JSON body" }, { status: 400 });
  }
  const record =
    body && typeof body === "object"
      ? (body as { content?: unknown; key?: unknown; kind?: unknown; fromAgent?: unknown })
      : {};
  const content = typeof record.content === "string" ? record.content.trim() : "";
  if (!content) return Response.json({ error: "Memory text is required" }, { status: 400 });
  const kind =
    record.kind === "profile" || record.kind === "shared" || record.kind === "chat"
      ? record.kind
      : null;
  if (!kind)
    return Response.json({ error: "Choose a profile, shared, or chat fact" }, { status: 400 });
  const key =
    typeof record.key === "string" && record.key.trim() ? record.key : keyFromFact(content);
  const selected = await memoryAgentFromRequest(request, actor.scoped ? actor.user.id : undefined);
  if (!selected.ok) return selected.response;
  const { store } = await getAppContext();
  const fromAgent =
    typeof record.fromAgent === "string" && record.fromAgent.trim()
      ? record.fromAgent.trim()
      : null;
  const saved = await saveMemory(store.memories, {
    agentId: selected.agentId,
    key,
    content,
    kind: addKind(kind) as MemoryKind,
    createdBy: "user",
    origin: originForAdd(kind),
    fromAgent: kind === "shared" ? fromAgent : null,
    mode: "write",
    ground: false,
  });
  if (!saved.ok) {
    const message =
      saved.blocked === "secret" ? "That looks like a secret and was not stored." : saved.error;
    return Response.json({ error: message }, { status: 400 });
  }
  return Response.json({ memory: saved.memory }, { status: 201 });
}
