import type { Sql } from "../db/sql";
import type { MemoryKind, MemoryOrigin, MemoryProposal, MemoryVersion } from "../types";
import { hiddenUntil, inferenceFingerprint, proposalKind } from "./panel-logic";
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
  origin?: MemoryOrigin | null;
  signal?: string | null;
  edited?: boolean | null;
  from_agent?: string | null;
  evidence?: string | null;
  user_id?: string | null;
};

type ProposalRow = {
  id: string;
  agent_id: string;
  kind: string;
  key: string;
  content: string;
  signal: string;
  evidence: string | null;
  fingerprint: string;
  created_at: Date | string;
};

const MEMORY_COLUMNS = `id, agent_id, kind, key, content, source_msg, supersedes, valid_from, valid_to, deleted_at, created_by, origin, signal, edited, from_agent, evidence`;

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
    origin: row.origin ?? "you_said",
    signal: row.signal ?? null,
    edited: row.edited === true,
    fromAgent: row.from_agent ?? null,
    evidence: row.evidence ?? null,
  };
}

function mapProposal(row: ProposalRow): MemoryProposal {
  const kind = proposalKind(row.kind) ?? "fact";
  return {
    id: row.id,
    agentId: row.agent_id,
    kind,
    key: row.key,
    content: row.content,
    signal: row.signal,
    evidence: row.evidence,
    fingerprint: row.fingerprint,
    createdAt: asIso(row.created_at) ?? new Date(0).toISOString(),
  };
}

export function isLiveMemory(memory: MemoryVersion): boolean {
  return memory.deletedAt == null && memory.validTo == null;
}

function likeContains(value: string): string {
  return `%${value.toLowerCase().replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

function visibleClause(alias: string, agentParam: string): string {
  return `(
    ${alias}.agent_id = ${agentParam}
    OR (
      ${alias}.kind = 'shared'
      AND ${alias}.user_id IS NOT DISTINCT FROM (SELECT user_id FROM agents WHERE id = ${agentParam})
    )
  )`;
}

type MemoryWriteFields = {
  origin?: MemoryOrigin | null;
  signal?: string | null;
  edited?: boolean;
  fromAgent?: string | null;
  evidence?: string | null;
};

export class MemoryRepository {
  constructor(private readonly db: Sql) {}

  async write(
    input: {
      agentId: string;
      key: string;
      content: string;
      kind?: MemoryKind | null;
      sourceMessageId?: string | null;
      createdBy: string;
    } & MemoryWriteFields,
  ): Promise<{ memory: MemoryVersion; previousId: string | null }> {
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
           id, agent_id, kind, key, content, source_msg, supersedes, created_by, user_id,
           origin, signal, edited, from_agent, evidence
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
           (SELECT user_id FROM agents WHERE id = $1),
           COALESCE($8::text, 'you_said'),
           $9,
           COALESCE($10::boolean, FALSE),
           $11,
           $12
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
        input.origin ?? null,
        input.signal ?? null,
        input.edited ?? false,
        input.fromAgent ?? null,
        input.evidence ?? null,
      ],
    );
    const row = result.rows[0];
    if (!row) throw new Error("Failed to write memory");
    const memory = mapMemory(row);
    return { memory, previousId: memory.supersedes };
  }

  async update(
    input: {
      agentId: string;
      key: string;
      content: string;
      kind?: MemoryKind | null;
      sourceMessageId?: string | null;
      createdBy: string;
    } & MemoryWriteFields,
  ): Promise<{ memory: MemoryVersion; previousId: string } | null> {
    const live = await this.getLiveByKey(input.agentId, input.key);
    if (!live || live.kind === "journal") return null;
    const id = crypto.randomUUID();
    const result = await this.db.query<MemoryRow>(
      `WITH closed AS (
         UPDATE memories
         SET valid_to = NOW()
         WHERE agent_id = $1
           AND lower(key) = lower($2)
           AND deleted_at IS NULL
           AND valid_to IS NULL
           AND kind <> 'journal'
         RETURNING id, kind, source_msg, origin, signal, from_agent, evidence
       ),
       inserted AS (
         INSERT INTO memories (
           id, agent_id, kind, key, content, source_msg, supersedes, created_by, user_id,
           origin, signal, edited, from_agent, evidence
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
           (SELECT user_id FROM agents WHERE id = $1),
           COALESCE($8::text, closed.origin, 'you_said'),
           COALESCE($9, closed.signal),
           COALESCE($10::boolean, FALSE),
           COALESCE($11, closed.from_agent),
           COALESCE($12, closed.evidence)
         FROM closed
         RETURNING ${MEMORY_COLUMNS}
       )
       SELECT ${MEMORY_COLUMNS} FROM inserted`,
      [
        live.agentId,
        input.key,
        id,
        input.kind ?? null,
        input.content,
        input.sourceMessageId ?? null,
        input.createdBy,
        input.origin ?? null,
        input.signal ?? null,
        input.edited ?? false,
        input.fromAgent ?? null,
        input.evidence ?? null,
      ],
    );
    const row = result.rows[0];
    if (!row) return null;
    const memory = mapMemory(row);
    if (!memory.supersedes) return null;
    return { memory, previousId: memory.supersedes };
  }

  async softDeleteByKey(agentId: string, key: string): Promise<MemoryVersion | null> {
    const existing = await this.getLiveByKey(agentId, key);
    if (!existing || existing.kind === "journal") return null;
    if (existing.kind === "shared") {
      const removed = await this.forgetShared(existing.id);
      return removed.find((memory) => memory.id === existing.id) ?? removed[0] ?? null;
    }
    return this.softDeleteById(existing.agentId, existing.id);
  }

  async softDeleteById(agentId: string, id: string): Promise<MemoryVersion | null> {
    const result = await this.db.query<MemoryRow>(
      `UPDATE memories
       SET deleted_at = NOW()
       WHERE id = $1
         AND agent_id = $2
         AND deleted_at IS NULL
         AND valid_to IS NULL
         AND kind <> 'journal'
       RETURNING ${MEMORY_COLUMNS}`,
      [id, agentId],
    );
    const row = result.rows[0];
    return row ? mapMemory(row) : null;
  }

  async forgetVisible(viewerAgentId: string, id: string): Promise<MemoryVersion[]> {
    const existing = await this.getVisibleById(viewerAgentId, id);
    if (!existing || !isLiveMemory(existing) || existing.kind === "journal") return [];
    if (existing.kind === "shared") return this.forgetShared(existing.id);
    const deleted = await this.softDeleteById(existing.agentId, existing.id);
    return deleted ? [deleted] : [];
  }

  async forgetShared(id: string): Promise<MemoryVersion[]> {
    const result = await this.db.query<MemoryRow>(
      `WITH victim AS (
         SELECT id, user_id, key
         FROM memories
         WHERE id = $1
           AND kind = 'shared'
           AND deleted_at IS NULL
           AND valid_to IS NULL
       )
       UPDATE memories
       SET deleted_at = NOW()
       WHERE kind = 'shared'
         AND lower(key) = lower((SELECT key FROM victim))
         AND user_id IS NOT DISTINCT FROM (SELECT user_id FROM victim)
         AND (SELECT id FROM victim) IS NOT NULL
         AND deleted_at IS NULL
         AND valid_to IS NULL
       RETURNING ${MEMORY_COLUMNS}`,
      [id],
    );
    return result.rows.map(mapMemory);
  }

  async getById(agentId: string, id: string): Promise<MemoryVersion | null> {
    return this.getVisibleById(agentId, id);
  }

  async getVisibleById(agentId: string, id: string): Promise<MemoryVersion | null> {
    const result = await this.db.query<MemoryRow>(
      `SELECT ${MEMORY_COLUMNS}
       FROM memories
       WHERE id = $2 AND ${visibleClause("memories", "$1")}`,
      [agentId, id],
    );
    const row = result.rows[0];
    return row ? mapMemory(row) : null;
  }

  async getLiveByKey(agentId: string, key: string): Promise<MemoryVersion | null> {
    const result = await this.db.query<MemoryRow>(
      `SELECT ${MEMORY_COLUMNS}
       FROM memories
       WHERE lower(key) = lower($2)
         AND deleted_at IS NULL
         AND valid_to IS NULL
         AND ${visibleClause("memories", "$1")}
       ORDER BY CASE WHEN agent_id = $1 THEN 0 ELSE 1 END, valid_from DESC, id DESC
       LIMIT 1`,
      [agentId, key],
    );
    const row = result.rows[0];
    return row ? mapMemory(row) : null;
  }

  async listForAgent(agentId: string): Promise<MemoryVersion[]> {
    const result = await this.db.query<MemoryRow>(
      `SELECT
         m.id, m.agent_id, m.kind, m.key, m.content, m.source_msg, m.supersedes,
         m.valid_from, m.valid_to, m.deleted_at, m.created_by, m.origin, m.signal,
         m.edited, m.from_agent, m.evidence,
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
       WHERE ${visibleClause("m", "$1")}
       ORDER BY m.valid_from DESC, m.id DESC`,
      [agentId],
    );
    return result.rows.map(mapMemory);
  }

  async listLive(agentId: string, kind?: MemoryKind): Promise<MemoryVersion[]> {
    const result = await this.db.query<MemoryRow>(
      `SELECT ${MEMORY_COLUMNS}
       FROM memories
       WHERE ${visibleClause("memories", "$1")}
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
       WHERE ${visibleClause("memories", "$1")}
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
    await this.db.query("DELETE FROM memory_proposals WHERE agent_id = $1", [agentId]);
  }

  async propose(input: {
    agentId: string;
    kind: MemoryProposal["kind"];
    key: string;
    content: string;
    signal: string;
    evidence?: string | null;
    now?: Date;
  }): Promise<
    { ok: true; proposal: MemoryProposal } | { ok: false; reason: "hidden" | "invalid" }
  > {
    const key = input.key.trim();
    const content = input.content.trim();
    const signal = input.signal.trim();
    if (!key || !content || !signal) return { ok: false, reason: "invalid" };
    const now = input.now ?? new Date();
    const fingerprint = inferenceFingerprint({
      kind: input.kind,
      key,
      signal,
      content,
    });
    const hidden = await this.db.query<{ id: string }>(
      `SELECT id
       FROM memory_dismissals
       WHERE fingerprint = $1
         AND user_id IS NOT DISTINCT FROM (SELECT user_id FROM agents WHERE id = $2)
         AND hidden_until > $3
       LIMIT 1`,
      [fingerprint, input.agentId, now.toISOString()],
    );
    if (hidden.rows[0]) return { ok: false, reason: "hidden" };
    const existing = await this.db.query<ProposalRow>(
      `SELECT id, agent_id, kind, key, content, signal, evidence, fingerprint, created_at
       FROM memory_proposals
       WHERE fingerprint = $1
         AND user_id IS NOT DISTINCT FROM (SELECT user_id FROM agents WHERE id = $2)
       LIMIT 1`,
      [fingerprint, input.agentId],
    );
    if (existing.rows[0]) return { ok: true, proposal: mapProposal(existing.rows[0]) };
    const id = crypto.randomUUID();
    const inserted = await this.db.query<ProposalRow>(
      `INSERT INTO memory_proposals (
         id, user_id, agent_id, kind, key, content, signal, evidence, fingerprint
       )
       VALUES (
         $1,
         (SELECT user_id FROM agents WHERE id = $2),
         $2, $3, $4, $5, $6, $7, $8
       )
       RETURNING id, agent_id, kind, key, content, signal, evidence, fingerprint, created_at`,
      [id, input.agentId, input.kind, key, content, signal, input.evidence ?? null, fingerprint],
    );
    const row = inserted.rows[0];
    if (!row) return { ok: false, reason: "invalid" };
    return { ok: true, proposal: mapProposal(row) };
  }

  async listProposals(agentId: string): Promise<MemoryProposal[]> {
    const result = await this.db.query<ProposalRow>(
      `SELECT id, agent_id, kind, key, content, signal, evidence, fingerprint, created_at
       FROM memory_proposals
       WHERE agent_id = $1
          OR (
            kind = 'shared'
            AND user_id IS NOT DISTINCT FROM (SELECT user_id FROM agents WHERE id = $1)
          )
       ORDER BY created_at DESC, id DESC`,
      [agentId],
    );
    return result.rows.map(mapProposal);
  }

  async approveProposal(
    agentId: string,
    id: string,
  ): Promise<{ ok: true; memory: MemoryVersion; proposal: MemoryProposal } | { ok: false }> {
    const found = await this.db.query<ProposalRow>(
      `SELECT id, agent_id, kind, key, content, signal, evidence, fingerprint, created_at
       FROM memory_proposals
       WHERE id = $1
         AND (
           agent_id = $2
           OR (
             kind = 'shared'
             AND user_id IS NOT DISTINCT FROM (SELECT user_id FROM agents WHERE id = $2)
           )
         )`,
      [id, agentId],
    );
    const proposal = found.rows[0] ? mapProposal(found.rows[0]) : null;
    if (!proposal) return { ok: false };
    const written = await this.write({
      agentId: proposal.agentId,
      key: proposal.key,
      content: proposal.content,
      kind: proposal.kind,
      createdBy: "model",
      origin: "inferred",
      signal: proposal.signal,
      evidence: proposal.evidence,
      edited: false,
    });
    await this.db.query("DELETE FROM memory_proposals WHERE id = $1", [proposal.id]);
    return { ok: true, memory: written.memory, proposal };
  }

  async dismissProposal(
    agentId: string,
    id: string,
    now = new Date(),
  ): Promise<{ ok: true; hiddenUntil: string } | { ok: false }> {
    const found = await this.db.query<ProposalRow & { user_id: string | null }>(
      `SELECT id, user_id, agent_id, kind, key, content, signal, evidence, fingerprint, created_at
       FROM memory_proposals
       WHERE id = $1
         AND (
           agent_id = $2
           OR (
             kind = 'shared'
             AND user_id IS NOT DISTINCT FROM (SELECT user_id FROM agents WHERE id = $2)
           )
         )`,
      [id, agentId],
    );
    const row = found.rows[0];
    if (!row) return { ok: false };
    const until = hiddenUntil(now);
    await this.db.query(
      `DELETE FROM memory_dismissals
       WHERE fingerprint = $1
         AND user_id IS NOT DISTINCT FROM $2`,
      [row.fingerprint, row.user_id],
    );
    await this.db.query(
      `INSERT INTO memory_dismissals (id, user_id, fingerprint, dismissed_at, hidden_until)
       VALUES ($1, $2, $3, $4, $5)`,
      [crypto.randomUUID(), row.user_id, row.fingerprint, now.toISOString(), until.toISOString()],
    );
    await this.db.query("DELETE FROM memory_proposals WHERE id = $1", [row.id]);
    return { ok: true, hiddenUntil: until.toISOString() };
  }
}
