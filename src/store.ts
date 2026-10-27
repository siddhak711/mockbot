import { LEAD_AGENT_ID } from "./agents/ids";
import { applyAgentSchema } from "./agents/migration";
import type {
  ConnectorAuth,
  ConnectorRecord,
  ConnectorStatus,
  ConnectorToolSetting,
  ConnectorTransport,
} from "./connectors";
import { migrate } from "./db/migrate";
import { openDatabase, type ProcessEnv } from "./db/open";
import { openPglite } from "./db/pglite";
import type { Sql, SqlDriver } from "./db/sql";
import { MemoryRepository } from "./memory/repository";
import { parseTrace } from "./trace";
import type {
  Conversation,
  ConversationSummary,
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

type SummaryRow = {
  conversation_id: string;
  summary: string;
  upto_msg: string;
  updated_at: Date | string;
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
  catalog_id?: string | null;
  auth_type?: ConnectorAuth | null;
  account_label?: string | null;
  status?: ConnectorStatus | null;
  status_detail?: string | null;
  tools?: unknown;
  seen_tools?: unknown;
  failures?: unknown;
  secret_cipher?: string | null;
  user_id?: string | null;
};

const CONNECTOR_COLUMNS = `id, name, transport, target, secret_ref, enabled, created_at, updated_at,
  catalog_id, auth_type, account_label, status, status_detail, tools, seen_tools, failures, secret_cipher,
  user_id`;

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

function jsonRecord(value: unknown): Record<string, ConnectorToolSetting> {
  const parsed = jsonValue(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  return parsed as Record<string, ConnectorToolSetting>;
}

function jsonStringList(value: unknown): string[] {
  const parsed = jsonValue(value);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((item): item is string => typeof item === "string");
}

function jsonNumberList(value: unknown): number[] {
  const parsed = jsonValue(value);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((item): item is number => typeof item === "number" && Number.isFinite(item));
}

function jsonValue(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

export type ComposioConnection = {
  id: string;
  userId: string;
  catalogId: string;
  toolkit: string;
  connectedAccountId: string;
  accountLabel: string | null;
  status: string;
};

type ComposioConnectionRow = {
  id: string;
  user_id: string;
  catalog_id: string;
  toolkit: string;
  connected_account_id: string;
  account_label: string | null;
  status: string;
};

function mapComposioConnection(row: ComposioConnectionRow): ComposioConnection {
  return {
    id: row.id,
    userId: row.user_id,
    catalogId: row.catalog_id,
    toolkit: row.toolkit,
    connectedAccountId: row.connected_account_id,
    accountLabel: row.account_label,
    status: row.status,
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
    catalogId: row.catalog_id ?? null,
    authType: row.auth_type ?? "none",
    accountLabel: row.account_label ?? null,
    status: row.status ?? "connected",
    statusDetail: row.status_detail ?? null,
    tools: jsonRecord(row.tools),
    seenTools: jsonStringList(row.seen_tools),
    failures: jsonNumberList(row.failures),
    secretCipher: row.secret_cipher ?? null,
    userId: row.user_id ?? null,
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

function isUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  if ("code" in error && String((error as { code: unknown }).code) === "23505") return true;
  const message = error instanceof Error ? error.message : "";
  return message.toLowerCase().includes("duplicate") || message.toLowerCase().includes("unique");
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

  /** Shared database connection. The agent directory keeps its tables here. */
  get connection(): Sql {
    return this.db;
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
      await applyAgentSchema(db);
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

  async createConversation(
    title: string,
    agentId = LEAD_AGENT_ID,
    userId?: string | null,
  ): Promise<Conversation> {
    const id = crypto.randomUUID();
    const result = await this.db.query<ConversationRow>(
      `INSERT INTO conversations (id, title, agent_id, user_id) VALUES ($1, $2, $3, $4)
       RETURNING id, title, agent_id, created_at, updated_at`,
      [id, title, agentId, userId ?? null],
    );
    const row = result.rows[0];
    if (!row) throw new Error("Failed to create conversation");
    return mapConversation(row);
  }

  /**
   * The one thread for this user and agent. A second caller, including a race,
   * gets the same row.
   */
  async getOrCreateAgentConversation(
    agentId: string,
    userId?: string | null,
  ): Promise<Conversation> {
    const existing = await this.findAgentConversation(agentId, userId ?? null);
    if (existing) return existing;
    try {
      return await this.createConversation("Chat", agentId, userId ?? null);
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const raced = await this.findAgentConversation(agentId, userId ?? null);
      if (raced) return raced;
      throw error;
    }
  }

  /** Names a thread that has no messages yet. A later turn leaves the title alone. */
  async nameIfEmpty(
    id: string,
    title: string,
    userId?: string | null,
  ): Promise<Conversation | null> {
    const result = await this.db.query<ConversationRow>(
      `UPDATE conversations
       SET title = $2, updated_at = NOW()
       WHERE id = $1
         AND ($3::text IS NULL OR user_id IS NOT DISTINCT FROM $3)
         AND NOT EXISTS (SELECT 1 FROM messages WHERE conversation_id = conversations.id)
       RETURNING id, title, agent_id, created_at, updated_at`,
      [id, title, userId ?? null],
    );
    const row = result.rows[0];
    if (row) return mapConversation(row);
    const loaded = await this.getConversation(id, undefined, userId ?? undefined);
    return loaded?.conversation ?? null;
  }

  private async findAgentConversation(
    agentId: string,
    userId: string | null,
  ): Promise<Conversation | null> {
    const result = await this.db.query<ConversationRow>(
      `SELECT id, title, agent_id, created_at, updated_at
       FROM conversations
       WHERE agent_id = $1
         AND user_id IS NOT DISTINCT FROM $2
       ORDER BY created_at ASC, id ASC
       LIMIT 1`,
      [agentId, userId],
    );
    const row = result.rows[0];
    return row ? mapConversation(row) : null;
  }

  async listConversations(userId?: string): Promise<Conversation[]> {
    const result = await this.db.query<ConversationRow>(
      `SELECT id, title, agent_id, created_at, updated_at
       FROM conversations
       WHERE ($1::text IS NULL OR user_id = $1)
       ORDER BY updated_at DESC, id DESC`,
      [userId ?? null],
    );
    return result.rows.map(mapConversation);
  }

  async getConversation(
    id: string,
    agentId?: string,
    userId?: string,
  ): Promise<{ conversation: Conversation; messages: Message[] } | null> {
    const conversations = await this.db.query<ConversationRow>(
      `SELECT id, title, agent_id, created_at, updated_at
       FROM conversations
       WHERE id = $1
         AND ($2::text IS NULL OR agent_id = $2)
         AND ($3::text IS NULL OR user_id = $3)`,
      [id, agentId ?? null, userId ?? null],
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

  async addMessage(
    conversationId: string,
    role: Role,
    content: string,
    trace: MessageTrace | null = null,
  ): Promise<Message> {
    const owned = await this.db.query<{ id: string }>(
      `SELECT id FROM conversations WHERE id = $1`,
      [conversationId],
    );
    if (!owned.rows[0]) throw new Error("Conversation not found");
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

  async getSummary(
    conversationId: string,
    agentId = LEAD_AGENT_ID,
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

  /**
   * Connectors one account owns. `ownerId` limits every connector query below;
   * leaving it out is the unscoped path (tests and the pre-account app).
   */
  async listConnectors(ownerId?: string | null): Promise<ConnectorRecord[]> {
    const result = await this.db.query<ConnectorRow>(
      `SELECT ${CONNECTOR_COLUMNS}
       FROM connectors
       WHERE ($1::text IS NULL OR user_id = $1)
       ORDER BY created_at ASC, id ASC`,
      [ownerId ?? null],
    );
    return result.rows.map(mapConnector);
  }

  async getConnector(id: string, ownerId?: string | null): Promise<ConnectorRecord | null> {
    const result = await this.db.query<ConnectorRow>(
      `SELECT ${CONNECTOR_COLUMNS}
       FROM connectors
       WHERE id = $1 AND ($2::text IS NULL OR user_id = $2)`,
      [id, ownerId ?? null],
    );
    const row = result.rows[0];
    return row ? mapConnector(row) : null;
  }

  async createConnector(input: {
    id?: string;
    name: string;
    transport: ConnectorTransport;
    target: string;
    secretRef: string | null;
    catalogId?: string | null;
    authType?: ConnectorAuth;
    accountLabel?: string | null;
    status?: ConnectorStatus;
    statusDetail?: string | null;
    tools?: Record<string, ConnectorToolSetting>;
    seenTools?: string[];
    secretCipher?: string | null;
    userId?: string | null;
  }): Promise<ConnectorRecord> {
    const id = input.id ?? crypto.randomUUID();
    const result = await this.db.query<ConnectorRow>(
      `INSERT INTO connectors (
         id, name, transport, target, secret_ref, catalog_id, auth_type, account_label,
         status, status_detail, tools, seen_tools, secret_cipher, user_id
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12::jsonb, $13, $14)
       RETURNING ${CONNECTOR_COLUMNS}`,
      [
        id,
        input.name,
        input.transport,
        input.target,
        input.secretRef,
        input.catalogId ?? null,
        input.authType ?? "none",
        input.accountLabel ?? null,
        input.status ?? "connected",
        input.statusDetail ?? null,
        JSON.stringify(input.tools ?? {}),
        JSON.stringify(input.seenTools ?? []),
        input.secretCipher ?? null,
        input.userId ?? null,
      ],
    );
    const row = result.rows[0];
    if (!row) throw new Error("Failed to create connector");
    return mapConnector(row);
  }

  /**
   * One row per account and catalog app. A concurrent insert loses and returns the row that won.
   */
  async insertCatalogConnector(input: {
    name: string;
    transport: ConnectorTransport;
    target: string;
    secretRef: string | null;
    catalogId: string;
    authType?: ConnectorAuth;
    accountLabel?: string | null;
    status?: ConnectorStatus;
    statusDetail?: string | null;
    tools?: Record<string, ConnectorToolSetting>;
    seenTools?: string[];
    secretCipher?: string | null;
    userId?: string | null;
  }): Promise<ConnectorRecord> {
    const id = crypto.randomUUID();
    const inserted = await this.db.query<ConnectorRow>(
      `INSERT INTO connectors (
         id, name, transport, target, secret_ref, catalog_id, auth_type, account_label,
         status, status_detail, tools, seen_tools, secret_cipher, user_id
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12::jsonb, $13, $14)
       ON CONFLICT (user_id, catalog_id) WHERE catalog_id IS NOT NULL DO NOTHING
       RETURNING ${CONNECTOR_COLUMNS}`,
      [
        id,
        input.name,
        input.transport,
        input.target,
        input.secretRef,
        input.catalogId,
        input.authType ?? "none",
        input.accountLabel ?? null,
        input.status ?? "connected",
        input.statusDetail ?? null,
        JSON.stringify(input.tools ?? {}),
        JSON.stringify(input.seenTools ?? []),
        input.secretCipher ?? null,
        input.userId ?? null,
      ],
    );
    const created = inserted.rows[0];
    if (created) return mapConnector(created);
    const existing = await this.db.query<ConnectorRow>(
      `SELECT ${CONNECTOR_COLUMNS}
       FROM connectors
       WHERE catalog_id = $1 AND user_id IS NOT DISTINCT FROM $2
       ORDER BY created_at ASC, id ASC
       LIMIT 1`,
      [input.catalogId, input.userId ?? null],
    );
    const row = existing.rows[0];
    if (!row) throw new Error("Failed to create connector");
    return mapConnector(row);
  }

  async saveOAuthConnector(
    id: string,
    input: {
      secretCipher: string;
      accountLabel: string | null;
      target: string;
      tools: Record<string, ConnectorToolSetting>;
      status: ConnectorStatus;
      statusDetail: string | null;
    },
    ownerId?: string | null,
  ): Promise<ConnectorRecord | null> {
    const result = await this.db.query<ConnectorRow>(
      `UPDATE connectors
       SET secret_cipher = $2,
           secret_ref = NULL,
           account_label = $3,
           target = $4,
           tools = $5::jsonb,
           status = $6,
           status_detail = $7,
           failures = '[]'::jsonb,
           auth_type = 'oauth',
           updated_at = NOW()
       WHERE id = $1 AND ($8::text IS NULL OR user_id = $8)
       RETURNING ${CONNECTOR_COLUMNS}`,
      [
        id,
        input.secretCipher,
        input.accountLabel,
        input.target,
        JSON.stringify(input.tools),
        input.status,
        input.statusDetail,
        ownerId ?? null,
      ],
    );
    const row = result.rows[0];
    return row ? mapConnector(row) : null;
  }

  async setConnectorSecret(
    id: string,
    secretCipher: string,
    ownerId?: string | null,
  ): Promise<ConnectorRecord | null> {
    const result = await this.db.query<ConnectorRow>(
      `UPDATE connectors
       SET secret_cipher = $2, secret_ref = NULL, updated_at = NOW()
       WHERE id = $1 AND ($3::text IS NULL OR user_id = $3)
       RETURNING ${CONNECTOR_COLUMNS}`,
      [id, secretCipher, ownerId ?? null],
    );
    const row = result.rows[0];
    return row ? mapConnector(row) : null;
  }

  async setConnectorEnabled(
    id: string,
    enabled: boolean,
    ownerId?: string | null,
  ): Promise<ConnectorRecord | null> {
    const result = await this.db.query<ConnectorRow>(
      `UPDATE connectors
       SET enabled = $2, updated_at = NOW()
       WHERE id = $1 AND ($3::text IS NULL OR user_id = $3)
       RETURNING ${CONNECTOR_COLUMNS}`,
      [id, enabled, ownerId ?? null],
    );
    const row = result.rows[0];
    return row ? mapConnector(row) : null;
  }

  async setConnectorStatus(
    id: string,
    status: ConnectorStatus,
    statusDetail: string | null,
    failures?: number[],
    ownerId?: string | null,
  ): Promise<ConnectorRecord | null> {
    const result = await this.db.query<ConnectorRow>(
      `UPDATE connectors
       SET status = $2,
           status_detail = $3,
           failures = COALESCE($4::jsonb, failures),
           updated_at = NOW()
       WHERE id = $1 AND ($5::text IS NULL OR user_id = $5)
       RETURNING ${CONNECTOR_COLUMNS}`,
      [id, status, statusDetail, failures ? JSON.stringify(failures) : null, ownerId ?? null],
    );
    const row = result.rows[0];
    return row ? mapConnector(row) : null;
  }

  async updateConnectorTools(
    id: string,
    tools: Record<string, ConnectorToolSetting>,
    seenTools?: string[],
    ownerId?: string | null,
  ): Promise<ConnectorRecord | null> {
    const result = await this.db.query<ConnectorRow>(
      `UPDATE connectors
       SET tools = $2::jsonb,
           seen_tools = COALESCE($3::jsonb, seen_tools),
           updated_at = NOW()
       WHERE id = $1 AND ($4::text IS NULL OR user_id = $4)
       RETURNING ${CONNECTOR_COLUMNS}`,
      [id, JSON.stringify(tools), seenTools ? JSON.stringify(seenTools) : null, ownerId ?? null],
    );
    const row = result.rows[0];
    return row ? mapConnector(row) : null;
  }

  async deleteConnector(id: string, ownerId?: string | null): Promise<boolean> {
    const result = await this.db.query<{ id: string }>(
      `DELETE FROM connectors
       WHERE id = $1 AND ($2::text IS NULL OR user_id = $2)
       RETURNING id`,
      [id, ownerId ?? null],
    );
    return result.rows.length > 0;
  }

  async upsertComposioConnection(input: {
    userId: string;
    catalogId: string;
    toolkit: string;
    connectedAccountId: string;
    accountLabel: string | null;
    status: string;
  }): Promise<ComposioConnection> {
    const result = await this.db.query<ComposioConnectionRow>(
      `INSERT INTO composio_connections (
         id, user_id, catalog_id, toolkit, connected_account_id, account_label, status
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (user_id, catalog_id) DO UPDATE SET
         toolkit = EXCLUDED.toolkit,
         connected_account_id = EXCLUDED.connected_account_id,
         account_label = EXCLUDED.account_label,
         status = EXCLUDED.status,
         updated_at = NOW()
       RETURNING id, user_id, catalog_id, toolkit, connected_account_id, account_label, status`,
      [
        crypto.randomUUID(),
        input.userId,
        input.catalogId,
        input.toolkit,
        input.connectedAccountId,
        input.accountLabel,
        input.status,
      ],
    );
    const row = result.rows[0];
    if (!row) throw new Error("Failed to store the Composio connection.");
    return mapComposioConnection(row);
  }

  async getComposioConnection(
    userId: string,
    catalogId: string,
  ): Promise<ComposioConnection | null> {
    const result = await this.db.query<ComposioConnectionRow>(
      `SELECT id, user_id, catalog_id, toolkit, connected_account_id, account_label, status
       FROM composio_connections
       WHERE user_id = $1 AND catalog_id = $2`,
      [userId, catalogId],
    );
    const row = result.rows[0];
    return row ? mapComposioConnection(row) : null;
  }

  async listComposioConnections(userId: string): Promise<ComposioConnection[]> {
    const result = await this.db.query<ComposioConnectionRow>(
      `SELECT id, user_id, catalog_id, toolkit, connected_account_id, account_label, status
       FROM composio_connections
       WHERE user_id = $1
       ORDER BY created_at ASC, id ASC`,
      [userId],
    );
    return result.rows.map(mapComposioConnection);
  }

  async deleteComposioConnection(userId: string, catalogId: string): Promise<void> {
    await this.db.query(`DELETE FROM composio_connections WHERE user_id = $1 AND catalog_id = $2`, [
      userId,
      catalogId,
    ]);
  }

  async countComposioConnections(catalogId: string): Promise<number> {
    const result = await this.db.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM composio_connections WHERE catalog_id = $1`,
      [catalogId],
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  async saveBrokerConnector(
    id: string,
    input: {
      accountLabel: string | null;
      target: string;
      tools: Record<string, ConnectorToolSetting>;
      status: ConnectorStatus;
      statusDetail: string | null;
    },
    ownerId?: string | null,
  ): Promise<ConnectorRecord | null> {
    const result = await this.db.query<ConnectorRow>(
      `UPDATE connectors
       SET secret_cipher = NULL,
           secret_ref = NULL,
           account_label = $2,
           target = $3,
           tools = $4::jsonb,
           status = $5,
           status_detail = $6,
           failures = '[]'::jsonb,
           auth_type = 'oauth',
           updated_at = NOW()
       WHERE id = $1 AND ($7::text IS NULL OR user_id = $7)
       RETURNING ${CONNECTOR_COLUMNS}`,
      [
        id,
        input.accountLabel,
        input.target,
        JSON.stringify(input.tools),
        input.status,
        input.statusDetail,
        ownerId ?? null,
      ],
    );
    const row = result.rows[0];
    return row ? mapConnector(row) : null;
  }
}
