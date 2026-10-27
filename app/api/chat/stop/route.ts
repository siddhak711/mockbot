import { requireApiUser } from "../../../../src/auth/guard";
import { getAppContext } from "../../../../src/context";
import { stopLiveTurn } from "../../../../src/live-turns";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Stops the running turn in a conversation the caller owns. */
export async function POST(request: Request): Promise<Response> {
  const actor = await requireApiUser(request);
  if (!actor.ok) return actor.response;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Expected JSON body" }, { status: 400 });
  }
  const conversationId = (body as { conversationId?: unknown } | null)?.conversationId;
  if (typeof conversationId !== "string" || !conversationId) {
    return Response.json({ error: "conversationId is required" }, { status: 400 });
  }
  const { store } = await getAppContext();
  const owned = await store.getConversation(
    conversationId,
    undefined,
    actor.scoped ? actor.user.id : undefined,
  );
  if (!owned) return Response.json({ error: "Conversation not found" }, { status: 404 });
  return Response.json({ stopped: stopLiveTurn(conversationId) });
}
