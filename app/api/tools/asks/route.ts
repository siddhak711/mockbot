import { requireApiUser } from "../../../../src/auth/guard";
import { CONVERSATION_BUSY, lockConversation, resumeChatTurn } from "../../../../src/chat";
import { getAppContext } from "../../../../src/context";
import { withUserTools } from "../../../../src/mcp/user-tools";
import { SseParser } from "../../../../src/sse";
import { STOPPED_TOOL_OUTPUT } from "../../../../src/tools/display";
import {
  acceptedAskAnswer,
  ASK_EXPIRED,
  ASK_USER_TOOL,
  readAskUser,
} from "../../../../src/tools/ask-user";
import type { ConversationStore } from "../../../../src/store";
import { applyStreamEvent, emptyTrace } from "../../../../src/trace";
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
  const record = body as {
    id?: unknown;
    answer?: unknown;
    decision?: unknown;
    conversationId?: unknown;
  };
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
  const requested =
    typeof record.conversationId === "string" && record.conversationId.trim()
      ? record.conversationId.trim()
      : undefined;
  const found = await loadPendingAsk(store, id, userId, requested);
  if (found === "ambiguous") {
    return Response.json(
      { error: "Several conversations wait on that id. Send conversationId." },
      { status: 409 },
    );
  }
  if (!found) return gone();
  const pending = found;
  const conversationId = pending.conversationId;

  if (decision === "stop") {
    // Claim the row first, so a racing answer cannot also continue the turn.
    const claimed = await store.claimToolCall(pending, "error", STOPPED_TOOL_OUTPUT);
    if (!claimed) return gone();
    if (!asks.stop(id, conversationId)) await noteStoredAsk(store, claimed, STOPPED_TOOL_OUTPUT);
    return Response.json({ id, decision: "stop" });
  }

  const requestArgs = readAskUser(pending.arguments);
  if (!requestArgs) {
    const claimed = await store.claimToolCall(pending, "error", ASK_EXPIRED);
    if (claimed) await noteStoredAsk(store, claimed, ASK_EXPIRED);
    return Response.json({ error: "That question expired" }, { status: 404 });
  }
  const accepted = acceptedAskAnswer(requestArgs, answer);
  if (!accepted) {
    return Response.json({ error: "That answer is not one of the options" }, { status: 400 });
  }

  const actorId = actor.user.id;
  const agents =
    context.agents && actor.scoped ? context.agents.forUser(actor.user.id) : context.agents;

  // A turn still running in this process is waiting on the question: the
  // database claim picks one winner, then the waiter wakes. No lock is needed,
  // since nothing new starts. That turn may be a resume that holds the lock.
  if (asks.waiting(id, conversationId)) {
    const claimed = await store.claimToolCall(pending, "done", accepted);
    if (!claimed) return gone();
    if (asks.answer(id, accepted, conversationId) === "ok")
      return Response.json({ id, answer: accepted });
    return resumeStored(claimed, accepted, null);
  }

  // The live turn is gone. Lock the conversation before claiming, so a new
  // message cannot start between the claim and the resume.
  const release = lockConversation(pending.conversationId);
  if (!release) return Response.json({ error: CONVERSATION_BUSY }, { status: 409 });
  let claimed: StoredToolCall | null;
  try {
    claimed = await store.claimToolCall(pending, "done", accepted);
  } catch (error) {
    release();
    throw error;
  }
  if (!claimed) {
    release();
    return gone();
  }
  return resumeStored(claimed, accepted, release);

  /**
   * Resume through the same turn builder a new message uses, with this user's
   * own connector tools. `release` is the conversation lock, handed to the turn.
   */
  async function resumeStored(
    tool: StoredToolCall,
    output: string,
    held: (() => void) | null,
  ): Promise<Response> {
    const release = held ?? lockConversation(tool.conversationId);
    if (!release) {
      await noteStoredAsk(store, { ...tool, output }, output);
      return Response.json({ error: CONVERSATION_BUSY }, { status: 409 });
    }
    let handedOff = false;
    let response: Response;
    try {
      response = await withUserTools(
        { store, tools: context.tools, userId: actorId, owner: userId },
        (fresh) => {
          handedOff = true;
          return resumeChatTurn({
            store,
            provider: context.provider,
            tools: fresh,
            approvals: context.approvals,
            asks,
            plans: context.plans,
            agents,
            memory: context.memory,
            computer: context.computer,
            connector: context.connector,
            userId,
            tool,
            answer: output,
            release,
          });
        },
      );
    } finally {
      if (!handedOff) release();
    }
    if (!response.body || !response.headers.get("content-type")?.includes("text/event-stream")) {
      const failure = (await response.json().catch(() => null)) as { error?: string } | null;
      const text = failure?.error ?? "The turn could not continue.";
      await noteStoredAsk(store, { ...tool, output }, output);
      return Response.json({ error: text }, { status: response.status || 500 });
    }
    const outcome = await followResume(response.body);
    return Response.json({ id, answer: output, resumed: true, ...outcome });
  }
}

function gone(): Response {
  return Response.json({ error: "That question is no longer waiting" }, { status: 404 });
}

/**
 * Read the resumed turn until it finishes or pauses for the person again. A
 * paused turn keeps running here, waiting on the same approval and question
 * gates a live chat uses, while the client polls the conversation.
 */
async function followResume(
  body: ReadableStream<Uint8Array>,
): Promise<{ state: "done" | "paused" | "error"; error?: string }> {
  const reader = body.getReader();
  const parser = new SseParser();
  const decoder = new TextDecoder();
  while (true) {
    const { done, value } = await reader.read();
    if (done) return { state: "done" };
    for (const message of parser.push(decoder.decode(value, { stream: true }))) {
      if (message.event === "done") return { state: "done" };
      if (message.event === "error") {
        const data = JSON.parse(message.data) as { message?: string };
        return { state: "error", error: data.message ?? "The model request failed" };
      }
      if (message.event === "approval_required" || message.event === "ask_user") {
        void drain(reader);
        return { state: "paused" };
      }
    }
  }
}

async function drain(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
  try {
    while (!(await reader.read()).done) {
      // The turn persists its own progress; nobody reads these events.
    }
  } catch {
    // The turn already stored what it could.
  }
}

/** Write a settled answer onto the assistant message that asked. */
async function noteStoredAsk(
  store: ConversationStore,
  tool: StoredToolCall,
  output: string,
): Promise<void> {
  const loaded = await store.getConversation(tool.conversationId);
  const message = loaded?.messages.find((item) => item.id === tool.messageId);
  if (!message) return;
  const trace = applyStreamEvent(message.trace ?? emptyTrace(), {
    type: "tool_result",
    id: tool.id,
    name: tool.name,
    content: output,
  });
  await store.updateMessage(message.id, trace.text || message.content, trace);
}

/**
 * The open ask_user row this account may answer. Call ids repeat across
 * conversations, so more than one owned match is "ambiguous" unless the
 * caller names the conversation.
 */
async function loadPendingAsk(
  store: ConversationStore,
  id: string,
  userId: string | undefined,
  conversationId: string | undefined,
): Promise<StoredToolCall | "ambiguous" | null> {
  const owned: StoredToolCall[] = [];
  for (const tool of await store.openAsks(id, conversationId)) {
    if (tool.name !== ASK_USER_TOOL || tool.status !== "ask") continue;
    if (!(await store.getConversation(tool.conversationId, undefined, userId))) continue;
    owned.push(tool);
  }
  const conversations = new Set(owned.map((tool) => tool.conversationId));
  if (conversations.size > 1) return "ambiguous";
  return owned[0] ?? null;
}
