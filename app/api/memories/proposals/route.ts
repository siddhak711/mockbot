import { requireApiUser } from "../../../../src/auth/guard";
import { getAppContext } from "../../../../src/context";
import { memoryAgentFromRequest } from "../../../../src/memory/request-agent";
import { proposalKind } from "../../../../src/memory/panel-logic";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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
      ? (body as {
          key?: unknown;
          content?: unknown;
          kind?: unknown;
          signal?: unknown;
          evidence?: unknown;
        })
      : {};
  const kind = proposalKind(typeof record.kind === "string" ? record.kind : "");
  const key = typeof record.key === "string" ? record.key : "";
  const content = typeof record.content === "string" ? record.content : "";
  const signal = typeof record.signal === "string" ? record.signal : "";
  const evidence = typeof record.evidence === "string" ? record.evidence : null;
  if (!kind) return Response.json({ error: "Inference scope is invalid" }, { status: 400 });
  const selected = await memoryAgentFromRequest(request, actor.scoped ? actor.user.id : undefined);
  if (!selected.ok) return selected.response;
  const { store } = await getAppContext();
  const proposed = await store.memories.propose({
    agentId: selected.agentId,
    kind,
    key,
    content,
    signal,
    evidence,
  });
  if (!proposed.ok) {
    const status = proposed.reason === "hidden" ? 200 : 400;
    return Response.json(
      proposed.reason === "hidden"
        ? { suppressed: true }
        : { error: "Inference needs a key, text, and signal" },
      { status },
    );
  }
  return Response.json({ proposal: proposed.proposal }, { status: 201 });
}
