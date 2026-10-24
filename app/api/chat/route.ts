import { streamChatTurn } from "../../../src/chat";
import { getAppContext } from "../../../src/context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const { store, provider } = await getAppContext();
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Expected JSON body" }, { status: 400 });
  }
  if (!body || typeof body !== "object") {
    return Response.json({ error: "Expected JSON body" }, { status: 400 });
  }
  const record = body as { message?: unknown; conversationId?: unknown };
  return streamChatTurn({
    store,
    provider,
    message: typeof record.message === "string" ? record.message : "",
    conversationId: typeof record.conversationId === "string" ? record.conversationId : undefined,
    signal: request.signal,
  });
}
