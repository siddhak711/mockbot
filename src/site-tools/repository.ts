import { randomUUID } from "node:crypto";
import type { Sql } from "../db/sql";
import type { SiteToolRecord, SiteToolSchema } from "./types";
import { isSiteToolSchema } from "./validate";

type SiteToolRow = {
  id: string;
  user_id: string;
  name: string;
  schema: unknown;
  script: string;
  version: number | string;
  created_at: Date | string;
};

const COLUMNS = `id, user_id, name, "schema", script, version, created_at`;

export class SiteToolRepository {
  constructor(private readonly db: Sql) {}

  async save(input: {
    userId: string;
    name: string;
    schema: SiteToolSchema;
    script: string;
  }): Promise<SiteToolRecord> {
    return this.db.transaction(async (tx) => {
      const current = await tx.query<{ version: number | string | null }>(
        `SELECT COALESCE(MAX(version), 0) AS version
         FROM site_tools
         WHERE user_id = $1 AND lower(name) = lower($2)`,
        [input.userId, input.name],
      );
      const version = Number(current.rows[0]?.version ?? 0) + 1;
      const id = randomUUID();
      const inserted = await tx.query<SiteToolRow>(
        `INSERT INTO site_tools (id, user_id, name, "schema", script, version)
         VALUES ($1, $2, $3, $4::jsonb, $5, $6)
         RETURNING ${COLUMNS}`,
        [id, input.userId, input.name, JSON.stringify(input.schema), input.script, version],
      );
      const row = inserted.rows[0];
      if (!row) throw new Error("The site tool was not stored.");
      return mapRow(row);
    });
  }

  async latest(userId: string, name: string): Promise<SiteToolRecord | null> {
    const result = await this.db.query<SiteToolRow>(
      `SELECT ${COLUMNS}
       FROM site_tools
       WHERE user_id = $1 AND lower(name) = lower($2)
       ORDER BY version DESC
       LIMIT 1`,
      [userId, name],
    );
    const row = result.rows[0];
    return row ? mapRow(row) : null;
  }

  async versions(userId: string, name: string): Promise<number[]> {
    const result = await this.db.query<{ version: number | string }>(
      `SELECT version
       FROM site_tools
       WHERE user_id = $1 AND lower(name) = lower($2)
       ORDER BY version ASC`,
      [userId, name],
    );
    return result.rows.map((row) => Number(row.version));
  }
}

function mapRow(row: SiteToolRow): SiteToolRecord {
  const schema = typeof row.schema === "string" ? JSON.parse(row.schema) : row.schema;
  if (!isSiteToolSchema(schema)) throw new Error("Stored site tool schema is invalid.");
  const created = row.created_at instanceof Date ? row.created_at : new Date(row.created_at);
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    schema,
    script: row.script,
    version: Number(row.version),
    createdAt: created.toISOString(),
  };
}
