import { DEFAULT_AGENT_ID } from "./agent";
import { migrate } from "./db/migrate";
import { openDatabase, type ProcessEnv } from "./db/open";
import { openPglite } from "./db/pglite";
import type { Sql, SqlDriver } from "./db/sql";
import { MemoryRepository } from "./memory/repository";
import type { Conversation, ConversationSummary, Message, Role } from "./types";

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
};

type SummaryRow = {
  conversation_id: string;
  summary: string;
  upto_msg: string;
  updated_at: Date | string;
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
  };
}

export function titleFromMessage(message: string): string {
  const oneLine = message.replace(/\s+/g, " ").trim();
  if (!oneLine) return "New chat";
  const max = 48;
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

export class ConversationStore {
  readonly memories: MemoryRepository;
  readonly driver: SqlDriver;

  private constructor(private readonly db: Sql) {
    this.driver = db.driver;
    this.memories = new MemoryRepository(db);
  }

  static async open(dataDir?: string): Promise<ConversationStore> {
    return ConversationStore.fromSql(await openPglite(dataDir));
  }

  static async connect(env: ProcessEnv): Promise<ConversationStore> {
    return ConversationStore.fromSql(await openDatabase(env));
  }

  private static async fromSql(db: Sql): Promise<ConversationStore> {
    try {
      await migrate(db);
    } catch (error) {
      await db.close();
      throw error;
    }
    return new ConversationStore(db);
  }

  async close(): Promise<void> {
    await this.db.close();
  }

  async migrationIds(): Promise<string[]> {
    const result = await this.db.query<{ id: string }>(
      "SELECT id FROM schema_migrations ORDER BY id",
    );
    return result.rows.map((row) => row.id);
  }

  async createConversation(title: string, agentId = DEFAULT_AGENT_ID): Promise<Conversation> {
    const id = crypto.randomUUID();
    const result = await this.db.query<ConversationRow>(
      `INSERT INTO conversations (id, title, agent_id) VALUES ($1, $2, $3)
       RETURNING id, title, created_at, updated_at`,
      [id, title, agentId],
    );
    const row = result.rows[0];
    if (!row) throw new Error("Failed to create conversation");
    return mapConversation(row);
  }

  async listConversations(agentId = DEFAULT_AGENT_ID): Promise<Conversation[]> {
    const result = await this.db.query<ConversationRow>(
      `SELECT id, title, created_at, updated_at
       FROM conversations
       WHERE agent_id = $1
       ORDER BY updated_at DESC, id DESC`,
      [agentId],
    );
    return result.rows.map(mapConversation);
  }

  async getConversation(
    id: string,
    agentId = DEFAULT_AGENT_ID,
  ): Promise<{ conversation: Conversation; messages: Message[] } | null> {
    const conversations = await this.db.query<ConversationRow>(
      `SELECT id, title, created_at, updated_at
       FROM conversations
       WHERE id = $1 AND agent_id = $2`,
      [id, agentId],
    );
    const conversation = conversations.rows[0];
    if (!conversation) return null;
    const messages = await this.db.query<MessageRow>(
      `SELECT id, conversation_id, role, content, created_at
       FROM messages
       WHERE conversation_id = $1
       ORDER BY seq ASC`,
      [id],
    );
    return { conversation: mapConversation(conversation), messages: messages.rows.map(mapMessage) };
  }

  async renameConversation(
    id: string,
    title: string,
    agentId = DEFAULT_AGENT_ID,
  ): Promise<Conversation | null> {
    const result = await this.db.query<ConversationRow>(
      `UPDATE conversations
       SET title = $2, updated_at = NOW()
       WHERE id = $1 AND agent_id = $3
       RETURNING id, title, created_at, updated_at`,
      [id, title, agentId],
    );
    const row = result.rows[0];
    return row ? mapConversation(row) : null;
  }

  async deleteConversation(id: string, agentId = DEFAULT_AGENT_ID): Promise<boolean> {
    const result = await this.db.query<{ id: string }>(
      `DELETE FROM conversations WHERE id = $1 AND agent_id = $2 RETURNING id`,
      [id, agentId],
    );
    return result.rows.length > 0;
  }

  async addMessage(
    conversationId: string,
    role: Role,
    content: string,
    agentId = DEFAULT_AGENT_ID,
  ): Promise<Message> {
    const owned = await this.db.query<{ id: string }>(
      `SELECT id FROM conversations WHERE id = $1 AND agent_id = $2`,
      [conversationId, agentId],
    );
    if (!owned.rows[0]) throw new Error("Conversation not found");
    const id = crypto.randomUUID();
    const inserted = await this.db.query<MessageRow>(
      `INSERT INTO messages (id, conversation_id, role, content)
       VALUES ($1, $2, $3, $4)
       RETURNING id, conversation_id, role, content, created_at`,
      [id, conversationId, role, content],
    );
    await this.db.query(
      `UPDATE conversations SET updated_at = NOW() WHERE id = $1 AND agent_id = $2`,
      [conversationId, agentId],
    );
    const row = inserted.rows[0];
    if (!row) throw new Error("Failed to store message");
    return mapMessage(row);
  }

  async updateMessageContent(
    id: string,
    content: string,
    agentId = DEFAULT_AGENT_ID,
  ): Promise<void> {
    await this.db.query(
      `UPDATE messages
       SET content = $2
       WHERE id = $1
         AND conversation_id IN (SELECT id FROM conversations WHERE agent_id = $3)`,
      [id, content, agentId],
    );
  }

  async getSummary(
    conversationId: string,
    agentId = DEFAULT_AGENT_ID,
  ): Promise<ConversationSummary | null> {
    const result = await this.db.query<SummaryRow>(
      `SELECT s.conversation_id, s.summary, s.upto_msg, s.updated_at
       FROM conversation_summaries s
       JOIN conversations c ON c.id = s.conversation_id
       WHERE s.conversation_id = $1 AND c.agent_id = $2`,
      [conversationId, agentId],
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      conversationId: row.conversation_id,
      summary: row.summary,
      uptoMessageId: row.upto_msg,
      updatedAt: asIso(row.updated_at),
    };
  }

  async saveSummary(
    conversationId: string,
    agentId: string,
    summary: string,
    uptoMessageId: string,
  ): Promise<void> {
    await this.db.query(
      `INSERT INTO conversation_summaries (conversation_id, summary, upto_msg)
       SELECT $1, $2, $3
       FROM conversations
       WHERE id = $1 AND agent_id = $4
       ON CONFLICT (conversation_id) DO UPDATE SET
         summary = EXCLUDED.summary,
         upto_msg = EXCLUDED.upto_msg,
         updated_at = NOW()`,
      [conversationId, summary, uptoMessageId, agentId],
    );
  }
}
