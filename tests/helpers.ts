import { LEAD_AGENT_ID } from "../src/agents/ids";
import { SseParser } from "../src/sse";
import type { ConversationStore } from "../src/store";
import type { Conversation } from "../src/types";

/** Every conversation row, newest first. The app has no conversation list; tests inspect the table. */
export async function listConversations(
  store: ConversationStore,
  userId?: string,
): Promise<Conversation[]> {
  const result = await store.connection.query<{
    id: string;
    title: string;
    agent_id: string;
    created_at: Date | string;
    updated_at: Date | string;
  }>(
    `SELECT id, title, agent_id, created_at, updated_at
     FROM conversations
     WHERE ($1::text IS NULL OR user_id = $1)
     ORDER BY updated_at DESC, id DESC`,
    [userId ?? null],
  );
  return result.rows.map((row) => ({
    id: row.id,
    title: row.title,
    agentId: row.agent_id,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  }));
}

/** The agent's one thread, titled for the test. */
export async function seedConversation(
  store: ConversationStore,
  title: string,
  agentId = LEAD_AGENT_ID,
  userId?: string | null,
): Promise<Conversation> {
  const conversation = await store.getOrCreateAgentConversation(agentId, userId ?? null);
  await store.connection.query(`UPDATE conversations SET title = $2 WHERE id = $1`, [
    conversation.id,
    title,
  ]);
  return { ...conversation, title };
}

export async function readSse(
  response: Response,
): Promise<Array<{ event: string; data: unknown }>> {
  if (!response.body) throw new Error("Expected a response body");
  const parser = new SseParser();
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const events: Array<{ event: string; data: unknown }> = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    for (const message of parser.push(decoder.decode(value, { stream: true }))) {
      events.push({ event: message.event, data: JSON.parse(message.data) as unknown });
    }
  }
  return events;
}

export function deltas(events: Array<{ event: string; data: unknown }>): string {
  return events
    .filter((event) => event.event === "delta")
    .map((event) => String((event.data as { text?: string }).text ?? ""))
    .join("");
}

/** The newest stored tool call with this id, in any conversation. Tests only. */
export async function toolCallById(
  store: ConversationStore,
  id: string,
): Promise<{ status: string; output: string | null; conversationId: string } | null> {
  const result = await store.connection.query<{
    status: string;
    output: string | null;
    conversation_id: string;
  }>(
    `SELECT status, output, conversation_id FROM tool_calls WHERE id = $1 ORDER BY seq DESC LIMIT 1`,
    [id],
  );
  const row = result.rows[0];
  return row
    ? { status: row.status, output: row.output, conversationId: row.conversation_id }
    : null;
}
