import { requireApiUser } from "../../../../src/auth/guard";
import { getAppContext } from "../../../../src/context";
import { memoryAgentFromRequest } from "../../../../src/memory/request-agent";
import { isLiveMemory } from "../../../../src/memory/repository";
import { saveMemory } from "../../../../src/memory/save";
import type { MemoryKind } from "../../../../src/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, context: RouteContext): Promise<Response> {
  const actor = await requireApiUser(request);
  if (!actor.ok) return actor.response;
  const { id } = await context.params;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Expected JSON body" }, { status: 400 });
  }
  const record =
    body && typeof body === "object"
      ? (body as { content?: unknown; kind?: unknown; edited?: unknown })
      : {};
  const content = typeof record.content === "string" ? record.content.trim() : "";
  if (!content) return Response.json({ error: "Memory text is required" }, { status: 400 });
  if (content.length > 4_000) {
    return Response.json({ error: "Memory text is too long" }, { status: 400 });
  }
  const kind =
    record.kind === "profile" ||
    record.kind === "fact" ||
    record.kind === "shared" ||
    record.kind === "chat" ||
    record.kind === "journal"
      ? record.kind
      : null;
  const selected = await memoryAgentFromRequest(request, actor.scoped ? actor.user.id : undefined);
  if (!selected.ok) return selected.response;
  const { store } = await getAppContext();
  const existing = await store.memories.getById(selected.agentId, id);
  if (!existing) return Response.json({ error: "Memory not found" }, { status: 404 });
  if (existing.kind === "journal" || kind === "journal") {
    return Response.json({ error: "Journal is read-only" }, { status: 409 });
  }
  if (!isLiveMemory(existing)) {
    return Response.json({ error: "Only the current memory can be edited" }, { status: 409 });
  }
  const saved = await saveMemory(store.memories, {
    agentId: existing.agentId,
    key: existing.key,
    content,
    kind: (kind ?? existing.kind) as MemoryKind,
    sourceMessageId: existing.sourceMessageId,
    createdBy: "user",
    origin: "you_said",
    edited: true,
    mode: "update",
    ground: false,
  });
  if (!saved.ok) {
    const message =
      saved.blocked === "secret" ? "That looks like a secret and was not stored." : saved.error;
    return Response.json({ error: message }, { status: 400 });
  }
  return Response.json({ memory: saved.memory });
}

export async function DELETE(request: Request, context: RouteContext): Promise<Response> {
  const actor = await requireApiUser(request);
  if (!actor.ok) return actor.response;
  const { id } = await context.params;
  const selected = await memoryAgentFromRequest(request, actor.scoped ? actor.user.id : undefined);
  if (!selected.ok) return selected.response;
  const { store } = await getAppContext();
  const existing = await store.memories.getById(selected.agentId, id);
  if (!existing) return Response.json({ error: "Memory not found" }, { status: 404 });
  if (existing.kind === "journal") {
    return Response.json({ error: "Journal is read-only" }, { status: 409 });
  }
  if (!isLiveMemory(existing)) {
    return Response.json({ error: "Only the current memory can be deleted" }, { status: 409 });
  }
  const deleted = await store.memories.forgetVisible(selected.agentId, id);
  if (deleted.length === 0) return Response.json({ error: "Memory not found" }, { status: 404 });
  return new Response(null, { status: 204 });
}
