import { mkdir } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { LEAD_AGENT_ID } from "./agents/ids";
import { applyAgentSchema } from "./agents/migration";
import type { ConnectorRecord, ConnectorTransport } from "./connectors";
import { applyMigrations } from "./db/migrate";
import { parseTrace } from "./trace";
import type {
  Conversation,
  Message,
  MessageTrace,
  Role,
  StoredToolCall,
  ToolCallStatus,
} from "./types";

type ConversationRow = {
  id: string;
  title: string;
  agent_id: string;
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

type ToolCallRow = {
  id: string;
  conversation_id: string;
  message_id: string;
  name: string;
  arguments: string;
  status: ToolCallStatus;
  output: string | null;
  created_at: Date | string;
};

type ConnectorRow = {
  id: string;
  name: string;
  transport: ConnectorTransport;
  target: string;
  secret_ref: string | null;
  enabled: boolean;
  created_at: Date | string;
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
    agentId: row.agent_id,
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

function mapConnector(row: ConnectorRow): ConnectorRecord {
  return {
    id: row.id,
    name: row.name,
    transport: row.transport,
    target: row.target,
    secretRef: row.secret_ref,
    enabled: row.enabled,
    createdAt: asIso(row.created_at),
    updatedAt: asIso(row.updated_at),
  };
}

function mapToolCall(row: ToolCallRow): StoredToolCall {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    messageId: row.message_id,
    name: row.name,
    arguments: row.arguments,
    status: row.status,
    output: row.output,
    createdAt: asIso(row.created_at),
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

  /** Shared embedded database. The agent directory keeps its tables here. */
  get connection(): PGlite {
    return this.db;
  }

  static async open(dataDir?: string): Promise<ConversationStore> {
    const persistent = dataDir && !dataDir.startsWith("memory:");
    if (persistent) await mkdir(dataDir, { recursive: true });
    const db = new PGlite(persistent ? dataDir : "memory://");
    await db.waitReady;
    await applyMigrations(db);
    await applyAgentSchema(db);
    return new ConversationStore(db);
  }

  async close(): Promise<void> {
    if (!this.db.closed) await this.db.close();
  }

  async createConversation(title: string, agentId = LEAD_AGENT_ID): Promise<Conversation> {
    const id = crypto.randomUUID();
    const result = await this.db.query<ConversationRow>(
      `INSERT INTO conversations (id, title, agent_id) VALUES ($1, $2, $3)
       RETURNING id, title, agent_id, created_at, updated_at`,
      [id, title, agentId],
    );
    const row = result.rows[0];
    if (!row) throw new Error("Failed to create conversation");
    return mapConversation(row);
  }

  async listConversations(): Promise<Conversation[]> {
    const result = await this.db.query<ConversationRow>(
      `SELECT id, title, agent_id, created_at, updated_at
       FROM conversations
       ORDER BY updated_at DESC, id DESC`,
    );
    return result.rows.map(mapConversation);
  }

  async getConversation(
    id: string,
  ): Promise<{ conversation: Conversation; messages: Message[] } | null> {
    const conversations = await this.db.query<ConversationRow>(
      `SELECT id, title, agent_id, created_at, updated_at FROM conversations WHERE id = $1`,
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
    const toolCalls = await this.db.query<ToolCallRow>(
      `SELECT id, conversation_id, message_id, name, arguments, status, output, created_at
       FROM tool_calls
       WHERE conversation_id = $1
       ORDER BY seq ASC`,
      [id],
    );
    const tools = toolCalls.rows.map(mapToolCall);
    return {
      conversation: mapConversation(conversation),
      messages: messages.rows.map((row) => ({
        ...mapMessage(row),
        tools: tools.filter((tool) => tool.messageId === row.id),
      })),
    };
  }

  async renameConversation(id: string, title: string): Promise<Conversation | null> {
    const result = await this.db.query<ConversationRow>(
      `UPDATE conversations
       SET title = $2, updated_at = NOW()
       WHERE id = $1
       RETURNING id, title, agent_id, created_at, updated_at`,
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

  async deleteMessage(id: string): Promise<void> {
    await this.db.query(`DELETE FROM messages WHERE id = $1`, [id]);
  }

  async saveToolCall(input: {
    id: string;
    conversationId: string;
    messageId: string;
    name: string;
    arguments: string;
    status: ToolCallStatus;
    output: string | null;
  }): Promise<void> {
    await this.db.query(
      `INSERT INTO tool_calls (id, conversation_id, message_id, name, arguments, status, output)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (id) DO UPDATE SET
         arguments = EXCLUDED.arguments,
         status = EXCLUDED.status,
         output = EXCLUDED.output,
         updated_at = NOW()`,
      [
        input.id,
        input.conversationId,
        input.messageId,
        input.name,
        input.arguments,
        input.status,
        input.output,
      ],
    );
  }

  async listConnectors(): Promise<ConnectorRecord[]> {
    const result = await this.db.query<ConnectorRow>(
      `SELECT id, name, transport, target, secret_ref, enabled, created_at, updated_at
       FROM connectors
       ORDER BY created_at ASC, id ASC`,
    );
    return result.rows.map(mapConnector);
  }

  async createConnector(input: {
    id?: string;
    name: string;
    transport: ConnectorTransport;
    target: string;
    secretRef: string | null;
  }): Promise<ConnectorRecord> {
    const id = input.id ?? crypto.randomUUID();
    const result = await this.db.query<ConnectorRow>(
      `INSERT INTO connectors (id, name, transport, target, secret_ref)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, name, transport, target, secret_ref, enabled, created_at, updated_at`,
      [id, input.name, input.transport, input.target, input.secretRef],
    );
    const row = result.rows[0];
    if (!row) throw new Error("Failed to create connector");
    return mapConnector(row);
  }

  async setConnectorEnabled(id: string, enabled: boolean): Promise<ConnectorRecord | null> {
    const result = await this.db.query<ConnectorRow>(
      `UPDATE connectors
       SET enabled = $2, updated_at = NOW()
       WHERE id = $1
       RETURNING id, name, transport, target, secret_ref, enabled, created_at, updated_at`,
      [id, enabled],
    );
    const row = result.rows[0];
    return row ? mapConnector(row) : null;
  }

  async deleteConnector(id: string): Promise<boolean> {
    const result = await this.db.query<{ id: string }>(
      `DELETE FROM connectors WHERE id = $1 RETURNING id`,
      [id],
    );
    return result.rows.length > 0;
  }
}
