import type { Sql } from "../db/sql";
import { SYSTEM_PROMPT } from "../llm";
import type { ConversationStore } from "../store";
import { LEAD_AGENT_ID, LEAD_AGENT_NAME } from "./ids";
import { applyAgentSchema } from "./migration";
import type { Agent, AgentGrant, GrantKind } from "./types";

const NAME_MAX = 48;
const INSTRUCTIONS_MAX = 4_000;
const MEMORY_MAX = 2_000;
const RESOURCE_ID = /^[A-Za-z0-9._:-]{1,64}$/;

export class AgentInputError extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "AgentInputError";
    this.status = status;
  }
}

type AgentRow = {
  id: string;
  name: string;
  instructions: string;
  memory_note: string;
  is_lead: boolean;
  created_at: Date | string;
};

type GrantRow = {
  id: string;
  agent_id: string;
  resource_kind: GrantKind;
  resource_id: string;
};

function asIso(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  return date.toISOString();
}

const AGENT_COLUMNS = "id, name, instructions, memory_note, is_lead, created_at";

function mapAgent(row: AgentRow): Agent {
  return {
    id: row.id,
    name: row.name,
    instructions: row.instructions,
    memoryNote: row.memory_note,
    isLead: row.is_lead === true || row.id === LEAD_AGENT_ID,
    createdAt: asIso(row.created_at),
  };
}

function mapGrant(row: GrantRow): AgentGrant {
  return {
    id: row.id,
    agentId: row.agent_id,
    kind: row.resource_kind,
    resourceId: row.resource_id,
  };
}

function checkedResourceId(kind: GrantKind, resourceId: string): string {
  if (kind !== "connector" && kind !== "computer") {
    throw new AgentInputError("Grant kind must be connector or computer");
  }
  const id = resourceId.trim();
  if (!RESOURCE_ID.test(id)) throw new AgentInputError("Resource id is invalid");
  return id;
}

function validatedAgent(input: { name: string; instructions: string; memoryNote?: string }): {
  name: string;
  instructions: string;
  memoryNote: string;
} {
  const name = input.name.trim();
  const instructions = input.instructions.trim();
  const memoryNote = input.memoryNote?.trim() ?? "";
  if (!name) throw new AgentInputError("Name is required");
  if (name.length > NAME_MAX) throw new AgentInputError("Name is too long");
  if (!instructions) throw new AgentInputError("Instructions are required");
  if (instructions.length > INSTRUCTIONS_MAX) {
    throw new AgentInputError("Instructions are too long");
  }
  if (memoryNote.length > MEMORY_MAX) throw new AgentInputError("Memory is too long");
  return { name, instructions, memoryNote };
}

export class AgentDirectory {
  private constructor(
    private readonly db: Sql,
    private readonly ownerId: string | null = null,
  ) {}

  static async attach(store: ConversationStore): Promise<AgentDirectory> {
    await applyAgentSchema(store.connection);
    const directory = new AgentDirectory(store.connection);
    await directory.seedLead();
    return directory;
  }

  /** Same directory, limited to one account's agents. */
  forUser(userId: string): AgentDirectory {
    return new AgentDirectory(this.db, userId);
  }

  private async rows<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    const result = await this.db.query<T>(sql, params);
    return result.rows;
  }

  private async seedLead(): Promise<void> {
    await this.db.query(
      `INSERT INTO agents (id, name, instructions, is_lead)
       VALUES ($1, $2, $3, TRUE)
       ON CONFLICT (id) DO NOTHING`,
      [LEAD_AGENT_ID, LEAD_AGENT_NAME, SYSTEM_PROMPT],
    );
    await this.db.query(`UPDATE agents SET is_lead = TRUE WHERE id = $1 AND is_lead = FALSE`, [
      LEAD_AGENT_ID,
    ]);
  }

  async list(): Promise<Agent[]> {
    const rows = await this.rows<AgentRow>(
      `SELECT ${AGENT_COLUMNS}
       FROM agents
       WHERE ($1::text IS NULL OR user_id = $1)
       ORDER BY created_at ASC, id ASC`,
      [this.ownerId],
    );
    return rows.map(mapAgent);
  }

  async get(id: string): Promise<Agent | null> {
    const rows = await this.rows<AgentRow>(
      `SELECT ${AGENT_COLUMNS}
       FROM agents
       WHERE id = $1 AND ($2::text IS NULL OR user_id = $2)`,
      [id, this.ownerId],
    );
    const row = rows[0];
    return row ? mapAgent(row) : null;
  }

  async findByName(name: string): Promise<Agent | null> {
    const rows = await this.rows<AgentRow>(
      `SELECT ${AGENT_COLUMNS}
       FROM agents
       WHERE lower(name) = lower($1)
         AND ($2::text IS NULL OR user_id = $2)`,
      [name.trim(), this.ownerId],
    );
    const row = rows[0];
    return row ? mapAgent(row) : null;
  }

  async create(input: { name: string; instructions: string; memoryNote?: string }): Promise<Agent> {
    const created = await this.createWithGrants(input);
    return created.agent;
  }

  async createWithGrants(input: {
    name: string;
    instructions: string;
    memoryNote?: string;
    computerId?: string;
    connectorId?: string;
  }): Promise<{ agent: Agent; grants: AgentGrant[] }> {
    const agentInput = validatedAgent(input);
    const grants: Array<{ kind: GrantKind; resourceId: string }> = [];
    const computerId = input.computerId?.trim() ?? "";
    const connectorId = input.connectorId?.trim() ?? "";
    if (computerId)
      grants.push({ kind: "computer", resourceId: checkedResourceId("computer", computerId) });
    if (connectorId) {
      grants.push({ kind: "connector", resourceId: checkedResourceId("connector", connectorId) });
    }
    if (await this.findByName(agentInput.name)) {
      throw new AgentInputError("An agent with that name already exists", 409);
    }

    return this.db.transaction(async (tx) => {
      const id = crypto.randomUUID();
      const inserted = await tx.query<AgentRow>(
        `INSERT INTO agents (id, name, instructions, memory_note, user_id, is_lead)
         VALUES ($1, $2, $3, $4, $5, FALSE)
         RETURNING ${AGENT_COLUMNS}`,
        [id, agentInput.name, agentInput.instructions, agentInput.memoryNote, this.ownerId],
      );
      const row = inserted.rows[0];
      if (!row) throw new Error("Failed to create agent");
      const stored: AgentGrant[] = [];
      for (const grant of grants) {
        const saved = await tx.query<GrantRow>(
          `INSERT INTO agent_grants (id, agent_id, resource_kind, resource_id)
           VALUES ($1, $2, $3, $4)
           RETURNING id, agent_id, resource_kind, resource_id`,
          [crypto.randomUUID(), id, grant.kind, grant.resourceId],
        );
        const grantRow = saved.rows[0];
        if (!grantRow) throw new Error("Failed to store grant");
        stored.push(mapGrant(grantRow));
      }
      return { agent: mapAgent(row), grants: stored };
    });
  }

  async listGrants(agentId: string): Promise<AgentGrant[]> {
    const rows = await this.rows<GrantRow>(
      `SELECT id, agent_id, resource_kind, resource_id
       FROM agent_grants
       WHERE agent_id = $1
       ORDER BY resource_kind ASC, resource_id ASC`,
      [agentId],
    );
    return rows.map(mapGrant);
  }

  async listAllGrants(): Promise<AgentGrant[]> {
    const rows = await this.rows<GrantRow>(
      `SELECT g.id, g.agent_id, g.resource_kind, g.resource_id
       FROM agent_grants g
       JOIN agents a ON a.id = g.agent_id
       WHERE ($1::text IS NULL OR a.user_id = $1)
       ORDER BY g.agent_id ASC, g.resource_kind ASC, g.resource_id ASC`,
      [this.ownerId],
    );
    return rows.map(mapGrant);
  }

  async hasGrant(agentId: string, kind: GrantKind, resourceId: string): Promise<boolean> {
    const rows = await this.rows<{ id: string }>(
      `SELECT id FROM agent_grants
       WHERE agent_id = $1 AND resource_kind = $2 AND resource_id = $3`,
      [agentId, kind, resourceId],
    );
    return rows.length > 0;
  }

  async grant(agentId: string, kind: GrantKind, resourceId: string): Promise<AgentGrant> {
    const id = checkedResourceId(kind, resourceId);
    const agent = await this.get(agentId);
    if (!agent) throw new AgentInputError("Agent not found", 404);
    const grantId = crypto.randomUUID();
    await this.db.query(
      `INSERT INTO agent_grants (id, agent_id, resource_kind, resource_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (agent_id, resource_kind, resource_id) DO NOTHING`,
      [grantId, agentId, kind, id],
    );
    const rows = await this.rows<GrantRow>(
      `SELECT id, agent_id, resource_kind, resource_id
       FROM agent_grants
       WHERE agent_id = $1 AND resource_kind = $2 AND resource_id = $3`,
      [agentId, kind, id],
    );
    const row = rows[0];
    if (!row) throw new Error("Failed to store grant");
    return mapGrant(row);
  }
}
