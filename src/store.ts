import { mkdir } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { parseTrace } from "./trace";
import type { Conversation, Message, MessageTrace, Role } from "./types";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS messages (
  seq BIGSERIAL PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  trace JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE messages ADD COLUMN IF NOT EXISTS trace JSONB;

CREATE INDEX IF NOT EXISTS messages_conversation_idx ON messages (conversation_id, seq);
`;

type ConversationRow = {
  id: string;
  title: string;
  created_at: Date | string;
  updated_at: Date | string;
};

type MessageRow = {
  id: string;
  conversation_id: string;
  role: Role;
  content: string;
  created_at: Date | string;
  trace: unknown;
};

function asIso(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  return date.toISOString();
}

function mapConversation(row: ConversationRow): Conversation {
  return {
    id: row.id,
    title: row.title,
    createdAt: asIso(row.created_at),
    updatedAt: asIso(row.updated_at),
  };
}

function mapMessage(row: MessageRow): Message {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    role: row.role,
    content: row.content,
    createdAt: asIso(row.created_at),
    trace: parseTrace(row.trace),
  };
}

function traceParam(trace: MessageTrace | null): string | null {
  return trace ? JSON.stringify(trace) : null;
}

export function titleFromMessage(message: string): string {
  const oneLine = message.replace(/\s+/g, " ").trim();
  if (!oneLine) return "New chat";
  const max = 48;
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

export class ConversationStore {
  private constructor(private readonly db: PGlite) {}

  static async open(dataDir?: string): Promise<ConversationStore> {
    const persistent = dataDir && !dataDir.startsWith("memory:");
    if (persistent) await mkdir(dataDir, { recursive: true });
    const db = new PGlite(persistent ? dataDir : "memory://");
    await db.waitReady;
    await db.exec(SCHEMA);
    return new ConversationStore(db);
  }

  async close(): Promise<void> {
    if (!this.db.closed) await this.db.close();
  }

  /** Embedded Postgres. Other modules apply their own migrations and queries. */
  get database(): PGlite {
    return this.db;
  }

  async createConversation(title: string): Promise<Conversation> {
    const id = crypto.randomUUID();
    const result = await this.db.query<ConversationRow>(
      `INSERT INTO conversations (id, title) VALUES ($1, $2)
       RETURNING id, title, created_at, updated_at`,
      [id, title],
    );
    const row = result.rows[0];
    if (!row) throw new Error("Failed to create conversation");
    return mapConversation(row);
  }

  async listConversations(): Promise<Conversation[]> {
    const result = await this.db.query<ConversationRow>(
      `SELECT id, title, created_at, updated_at
       FROM conversations
       ORDER BY updated_at DESC, id DESC`,
    );
    return result.rows.map(mapConversation);
  }

  async getConversation(
    id: string,
  ): Promise<{ conversation: Conversation; messages: Message[] } | null> {
    const conversations = await this.db.query<ConversationRow>(
      `SELECT id, title, created_at, updated_at FROM conversations WHERE id = $1`,
      [id],
    );
    const conversation = conversations.rows[0];
    if (!conversation) return null;
    const messages = await this.db.query<MessageRow>(
      `SELECT id, conversation_id, role, content, trace, created_at
       FROM messages
       WHERE conversation_id = $1
       ORDER BY seq ASC`,
      [id],
    );
    return { conversation: mapConversation(conversation), messages: messages.rows.map(mapMessage) };
  }

  async renameConversation(id: string, title: string): Promise<Conversation | null> {
    const result = await this.db.query<ConversationRow>(
      `UPDATE conversations
       SET title = $2, updated_at = NOW()
       WHERE id = $1
       RETURNING id, title, created_at, updated_at`,
      [id, title],
    );
    const row = result.rows[0];
    return row ? mapConversation(row) : null;
  }

  async deleteConversation(id: string): Promise<boolean> {
    const result = await this.db.query<{ id: string }>(
      `DELETE FROM conversations WHERE id = $1 RETURNING id`,
      [id],
    );
    return result.rows.length > 0;
  }

  async addMessage(
    conversationId: string,
    role: Role,
    content: string,
    trace: MessageTrace | null = null,
  ): Promise<Message> {
    const id = crypto.randomUUID();
    const inserted = await this.db.query<MessageRow>(
      `INSERT INTO messages (id, conversation_id, role, content, trace)
       VALUES ($1, $2, $3, $4, $5::jsonb)
       RETURNING id, conversation_id, role, content, trace, created_at`,
      [id, conversationId, role, content, traceParam(trace)],
    );
    await this.db.query(`UPDATE conversations SET updated_at = NOW() WHERE id = $1`, [
      conversationId,
    ]);
    const row = inserted.rows[0];
    if (!row) throw new Error("Failed to store message");
    return mapMessage(row);
  }

  async updateMessage(id: string, content: string, trace: MessageTrace | null): Promise<void> {
    await this.db.query(`UPDATE messages SET content = $2, trace = $3::jsonb WHERE id = $1`, [
      id,
      content,
      traceParam(trace),
    ]);
  }
}
