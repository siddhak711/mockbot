import type { Sql } from "../db/sql";
import type { MemoryKind, MemoryVersion } from "../types";
import { SEARCH_TOP_K } from "./tokens";

type MemoryRow = {
  id: string;
  agent_id: string;
  kind: MemoryKind;
  key: string;
  content: string;
  source_msg: string | null;
  supersedes: string | null;
  valid_from: Date | string;
  valid_to: Date | string | null;
  deleted_at: Date | string | null;
  created_by: string;
  source_snippet?: string | null;
};

const MEMORY_COLUMNS = `id, agent_id, kind, key, content, source_msg, supersedes, valid_from, valid_to, deleted_at, created_by`;

function asIso(value: Date | string | null): string | null {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return date.toISOString();
}

export function mapMemory(row: MemoryRow): MemoryVersion {
  return {
    id: row.id,
    agentId: row.agent_id,
    kind: row.kind,
    key: row.key,
    content: row.content,
    sourceMessageId: row.source_msg,
    sourceSnippet: row.source_snippet ?? null,
    supersedes: row.supersedes,
    validFrom: asIso(row.valid_from) ?? new Date(0).toISOString(),
    validTo: asIso(row.valid_to),
    deletedAt: asIso(row.deleted_at),
    createdBy: row.created_by,
  };
}

export function isLiveMemory(memory: MemoryVersion): boolean {
  return memory.deletedAt == null && memory.validTo == null;
}

function likeContains(value: string): string {
  return `%${value.toLowerCase().replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

export class MemoryRepository {
  constructor(private readonly db: Sql) {}

  async write(input: {
    agentId: string;
    key: string;
    content: string;
    kind?: MemoryKind | null;
    sourceMessageId?: string | null;
    createdBy: string;
  }): Promise<{ memory: MemoryVersion; previousId: string | null }> {
    const id = crypto.randomUUID();
    const result = await this.db.query<MemoryRow>(
      `WITH closed AS (
         UPDATE memories
         SET valid_to = NOW()
         WHERE agent_id = $1
           AND lower(key) = lower($2)
           AND deleted_at IS NULL
           AND valid_to IS NULL
         RETURNING id, kind
       ),
       inserted AS (
         INSERT INTO memories (
           id, agent_id, kind, key, content, source_msg, supersedes, created_by, user_id
         )
         VALUES (
           $3,
           $1,
           CASE
             WHEN $4::text IS NOT NULL THEN $4
             ELSE COALESCE((SELECT kind FROM closed), 'fact')
           END,
           $2,
           $5,
           $6,
           (SELECT id FROM closed),
           $7,
           (SELECT user_id FROM agents WHERE id = $1)
         )
         RETURNING ${MEMORY_COLUMNS}
       )
       SELECT ${MEMORY_COLUMNS} FROM inserted`,
      [
        input.agentId,
        input.key,
        id,
        input.kind ?? null,
        input.content,
        input.sourceMessageId ?? null,
        input.createdBy,
      ],
    );
    const row = result.rows[0];
    if (!row) throw new Error("Failed to write memory");
    const memory = mapMemory(row);
    return { memory, previousId: memory.supersedes };
  }

  async update(input: {
    agentId: string;
    key: string;
    content: string;
    kind?: MemoryKind | null;
    sourceMessageId?: string | null;
    createdBy: string;
  }): Promise<{ memory: MemoryVersion; previousId: string } | null> {
    const id = crypto.randomUUID();
    const result = await this.db.query<MemoryRow>(
      `WITH closed AS (
         UPDATE memories
         SET valid_to = NOW()
         WHERE agent_id = $1
           AND lower(key) = lower($2)
           AND deleted_at IS NULL
           AND valid_to IS NULL
         RETURNING id, kind, source_msg
       ),
       inserted AS (
         INSERT INTO memories (
           id, agent_id, kind, key, content, source_msg, supersedes, created_by, user_id
         )
         SELECT
           $3,
           $1,
           COALESCE($4::text, closed.kind),
           $2,
           $5,
           COALESCE($6, closed.source_msg),
           closed.id,
           $7,
           (SELECT user_id FROM agents WHERE id = $1)
         FROM closed
         RETURNING ${MEMORY_COLUMNS}
       )
       SELECT ${MEMORY_COLUMNS} FROM inserted`,
      [
        input.agentId,
        input.key,
        id,
        input.kind ?? null,
        input.content,
        input.sourceMessageId ?? null,
        input.createdBy,
      ],
    );
    const row = result.rows[0];
    if (!row) return null;
    const memory = mapMemory(row);
    if (!memory.supersedes) return null;
    return { memory, previousId: memory.supersedes };
  }

  async softDeleteByKey(agentId: string, key: string): Promise<MemoryVersion | null> {
    const result = await this.db.query<MemoryRow>(
      `UPDATE memories
       SET deleted_at = NOW()
       WHERE agent_id = $1
         AND lower(key) = lower($2)
         AND deleted_at IS NULL
         AND valid_to IS NULL
       RETURNING ${MEMORY_COLUMNS}`,
      [agentId, key],
    );
    const row = result.rows[0];
    return row ? mapMemory(row) : null;
  }

  async softDeleteById(agentId: string, id: string): Promise<MemoryVersion | null> {
    const result = await this.db.query<MemoryRow>(
      `UPDATE memories
       SET deleted_at = NOW()
       WHERE id = $1
         AND agent_id = $2
         AND deleted_at IS NULL
         AND valid_to IS NULL
       RETURNING ${MEMORY_COLUMNS}`,
      [id, agentId],
    );
    const row = result.rows[0];
    return row ? mapMemory(row) : null;
  }

  async getById(agentId: string, id: string): Promise<MemoryVersion | null> {
    const result = await this.db.query<MemoryRow>(
      `SELECT ${MEMORY_COLUMNS}
       FROM memories
       WHERE id = $1 AND agent_id = $2`,
      [id, agentId],
    );
    const row = result.rows[0];
    return row ? mapMemory(row) : null;
  }

  async listForAgent(agentId: string): Promise<MemoryVersion[]> {
    const result = await this.db.query<MemoryRow>(
      `SELECT
         m.id, m.agent_id, m.kind, m.key, m.content, m.source_msg, m.supersedes,
         m.valid_from, m.valid_to, m.deleted_at, m.created_by,
         CASE
           WHEN msg.id IS NULL THEN NULL
           ELSE LEFT(msg.content, 180)
         END AS source_snippet
       FROM memories m
       LEFT JOIN messages msg
         ON msg.id = m.source_msg
        AND EXISTS (
          SELECT 1 FROM conversations c
          WHERE c.id = msg.conversation_id AND c.agent_id = m.agent_id
        )
       WHERE m.agent_id = $1
       ORDER BY m.valid_from DESC, m.id DESC`,
      [agentId],
    );
    return result.rows.map(mapMemory);
  }

  async listLive(agentId: string, kind?: MemoryKind): Promise<MemoryVersion[]> {
    const result = await this.db.query<MemoryRow>(
      `SELECT ${MEMORY_COLUMNS}
       FROM memories
       WHERE agent_id = $1
         AND deleted_at IS NULL
         AND valid_to IS NULL
         AND ($2::text IS NULL OR kind = $2)
       ORDER BY valid_from DESC, id DESC`,
      [agentId, kind ?? null],
    );
    return result.rows.map(mapMemory);
  }

  async search(input: {
    agentId: string;
    query: string;
    limit?: number;
    kind?: MemoryKind | null;
  }): Promise<MemoryVersion[]> {
    const query = input.query.trim().slice(0, 500);
    if (!query || !/[a-z0-9]/i.test(query)) return [];
    const limit = Math.max(1, Math.min(input.limit ?? SEARCH_TOP_K, 8));
    const pattern = likeContains(query);
    const result = await this.db.query<MemoryRow>(
      `SELECT ${MEMORY_COLUMNS}
       FROM memories
       WHERE agent_id = $1
         AND deleted_at IS NULL
         AND valid_to IS NULL
         AND ($3::text IS NULL OR kind = $3)
         AND (
           to_tsvector('english', content) @@ plainto_tsquery('english', $2)
           OR lower(key) LIKE $4 ESCAPE '\\'
         )
       ORDER BY ts_rank(to_tsvector('english', content), plainto_tsquery('english', $2)) DESC,
                valid_from DESC
       LIMIT $5`,
      [input.agentId, query, input.kind ?? null, pattern, limit],
    );
    return result.rows.map(mapMemory);
  }

  async purgeAgent(agentId: string): Promise<void> {
    await this.db.query("DELETE FROM memories WHERE agent_id = $1", [agentId]);
  }
}
