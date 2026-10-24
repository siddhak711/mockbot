import { DEFAULT_AGENT_ID } from "../../../../src/agent";
import { getAppContext } from "../../../../src/context";
import { isLiveMemory } from "../../../../src/memory/repository";
import { saveMemory } from "../../../../src/memory/save";
import type { MemoryKind } from "../../../../src/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, context: RouteContext): Promise<Response> {
  const { id } = await context.params;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Expected JSON body" }, { status: 400 });
  }
  const record =
    body && typeof body === "object" ? (body as { content?: unknown; kind?: unknown }) : {};
  const content = typeof record.content === "string" ? record.content.trim() : "";
  if (!content) return Response.json({ error: "Memory text is required" }, { status: 400 });
  if (content.length > 4_000) {
    return Response.json({ error: "Memory text is too long" }, { status: 400 });
  }
  const kind = record.kind === "profile" || record.kind === "fact" ? record.kind : null;
  const { store } = await getAppContext();
  const existing = await store.memories.getById(DEFAULT_AGENT_ID, id);
  if (!existing) return Response.json({ error: "Memory not found" }, { status: 404 });
  if (!isLiveMemory(existing)) {
    return Response.json({ error: "Only the current memory can be edited" }, { status: 409 });
  }
  const saved = await saveMemory(store.memories, {
    agentId: DEFAULT_AGENT_ID,
    key: existing.key,
    content,
    kind: (kind ?? existing.kind) as MemoryKind,
    sourceMessageId: existing.sourceMessageId,
    createdBy: "user",
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

export async function DELETE(_request: Request, context: RouteContext): Promise<Response> {
  const { id } = await context.params;
  const { store } = await getAppContext();
  const existing = await store.memories.getById(DEFAULT_AGENT_ID, id);
  if (!existing) return Response.json({ error: "Memory not found" }, { status: 404 });
  if (!isLiveMemory(existing)) {
    return Response.json({ error: "Only the current memory can be deleted" }, { status: 409 });
  }
  const deleted = await store.memories.softDeleteById(DEFAULT_AGENT_ID, id);
  if (!deleted) return Response.json({ error: "Memory not found" }, { status: 404 });
  return new Response(null, { status: 204 });
}
