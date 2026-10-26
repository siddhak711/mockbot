import { noteStoredAsk, resumeStoredAsk } from "../../../../src/ask-resume";
import { requireApiUser } from "../../../../src/auth/guard";
import { getAppContext } from "../../../../src/context";
import { STOPPED_TOOL_OUTPUT } from "../../../../src/tools/display";
import {
  acceptedAskAnswer,
  ASK_EXPIRED,
  ASK_USER_TOOL,
  readAskUser,
} from "../../../../src/tools/ask-user";
import type { ConversationStore } from "../../../../src/store";
import type { StoredToolCall } from "../../../../src/types";

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
  if (!body || typeof body !== "object") {
    return Response.json({ error: "Expected JSON body" }, { status: 400 });
  }
  const record = body as { id?: unknown; answer?: unknown; decision?: unknown };
  const id = typeof record.id === "string" ? record.id.trim() : "";
  if (!id) return Response.json({ error: "Question id is required" }, { status: 400 });
  const decision = record.decision;
  const answer = typeof record.answer === "string" ? record.answer : "";
  if (decision !== "stop" && !answer.trim()) {
    return Response.json({ error: "Answer is required" }, { status: 400 });
  }
  if (decision !== undefined && decision !== "stop") {
    return Response.json({ error: 'Decision must be "stop"' }, { status: 400 });
  }

  const context = await getAppContext();
  const { asks, store } = context;
  const userId = actor.scoped ? actor.user.id : undefined;
  const pending = await loadPendingAsk(store, id, userId);
  if (!pending) {
    return Response.json({ error: "That question is no longer waiting" }, { status: 404 });
  }

  if (decision === "stop") {
    if (asks.waiting(id)) {
      asks.stop(id);
      return Response.json({ id, decision: "stop" });
    }
    const claimed = await store.claimToolCall(id, "error", STOPPED_TOOL_OUTPUT);
    if (!claimed) {
      return Response.json({ error: "That question is no longer waiting" }, { status: 404 });
    }
    await noteStoredAsk(store, claimed, STOPPED_TOOL_OUTPUT);
    return Response.json({ id, decision: "stop" });
  }

  const requestArgs = readAskUser(pending.arguments);
  if (!requestArgs) {
    const claimed = await store.claimToolCall(id, "error", ASK_EXPIRED);
    if (claimed) await noteStoredAsk(store, claimed, ASK_EXPIRED);
    return Response.json({ error: "That question expired" }, { status: 404 });
  }
  const accepted = acceptedAskAnswer(requestArgs, answer);
  if (!accepted) {
    return Response.json({ error: "That answer is not one of the options" }, { status: 400 });
  }

  if (asks.waiting(id)) {
    const result = asks.answer(id, accepted);
    if (result === "rejected") {
      return Response.json({ error: "That answer is not one of the options" }, { status: 400 });
    }
    if (result === "ok") return Response.json({ id, answer: accepted });
  }

  const claimed = await store.claimToolCall(id, "done", accepted);
  if (!claimed) {
    return Response.json({ error: "That question is no longer waiting" }, { status: 404 });
  }
  try {
    await resumeStoredAsk({
      store,
      provider: context.provider,
      tools: context.tools.clone(),
      tool: claimed,
      answer: accepted,
    });
  } catch (error) {
    const text = error instanceof Error ? error.message : "The model request failed";
    await noteStoredAsk(store, { ...claimed, output: text }, text);
  }
  return Response.json({ id, answer: accepted, resumed: true });
}

async function loadPendingAsk(
  store: ConversationStore,
  id: string,
  userId: string | undefined,
): Promise<StoredToolCall | null> {
  const tool = await store.getToolCall(id);
  if (!tool || tool.name !== ASK_USER_TOOL || tool.status !== "ask") return null;
  const owned = await store.getConversation(tool.conversationId, undefined, userId);
  if (!owned) return null;
  return tool;
}
