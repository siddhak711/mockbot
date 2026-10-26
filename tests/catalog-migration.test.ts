import { expect, it } from "vitest";
import { MIGRATIONS } from "../src/db/migrations";
import { openPglite } from "../src/db/pglite";
import { splitSql } from "../src/db/sql";

const dedupe = MIGRATIONS.find((migration) => migration.id === "008_connector_catalog");

it("keeps the dollar-quoted catalog dedupe as one statement", () => {
  expect(dedupe).toBeTruthy();
  const parts = splitSql(dedupe?.sql ?? "");
  expect(parts).toHaveLength(2);
  expect(parts[0]).toContain("DO $dedupe_catalog_connectors$");
  expect(parts[0]).toContain("DELETE FROM connectors");
  expect(parts[1]).toContain("CREATE UNIQUE INDEX");
});

it("merges duplicate catalog connectors before the unique index", async () => {
  expect(dedupe).toBeTruthy();
  const db = await openPglite();
  try {
    for (const migration of MIGRATIONS) {
      if (migration.id === "008_connector_catalog") break;
      await db.exec(migration.sql);
    }
    await db.exec(`
      CREATE TABLE agent_grants (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        resource_kind TEXT NOT NULL,
        resource_id TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (agent_id, resource_kind, resource_id)
      );
    `);
    await db.query(
      `INSERT INTO connectors (
         id, name, transport, target, catalog_id, tools, seen_tools, created_at
       )
       VALUES
         (
           'conn_older', 'Notion', 'http', 'https://example.test/notion', 'notion',
           '{"NOTION_SEARCH":{"enabled":true,"approval":"auto"}}'::jsonb,
           '["NOTION_SEARCH"]'::jsonb,
           '2020-01-01T00:00:00Z'
         ),
         (
           'conn_newer', 'Notion', 'http', 'https://example.test/notion', 'notion',
           '{"NOTION_SEARCH":{"enabled":false,"approval":"ask"},"NOTION_CREATE_PAGE":{"enabled":false,"approval":"ask"}}'::jsonb,
           '["NOTION_CREATE_PAGE"]'::jsonb,
           '2020-06-01T00:00:00Z'
         )`,
    );
    await db.query(
      `INSERT INTO composio_connections (
         id, user_id, catalog_id, toolkit, connected_account_id, account_label, status
       )
       VALUES ('link_1', 'user_a', 'notion', 'notion', 'ca_a', 'Grove', 'connected')`,
    );
    await db.query(
      `INSERT INTO agent_grants (id, agent_id, resource_kind, resource_id)
       VALUES
         ('grant_kept', 'agent_1', 'connector', 'conn_older'),
         ('grant_loser', 'agent_1', 'connector', 'conn_newer'),
         ('grant_move', 'agent_2', 'connector', 'conn_newer')`,
    );

    await db.exec(dedupe?.sql ?? "");

    const connectors = await db.query<{
      id: string;
      tools: Record<string, unknown>;
      seen_tools: string[];
    }>(`SELECT id, tools, seen_tools FROM connectors WHERE catalog_id = 'notion' ORDER BY id`);
    expect(connectors.rows.map((row) => row.id)).toEqual(["conn_older"]);
    expect(connectors.rows[0]?.tools).toMatchObject({
      NOTION_SEARCH: { enabled: true, approval: "auto" },
      NOTION_CREATE_PAGE: { enabled: false, approval: "ask" },
    });
    expect(connectors.rows[0]?.seen_tools).toEqual(
      expect.arrayContaining(["NOTION_SEARCH", "NOTION_CREATE_PAGE"]),
    );
    const links = await db.query<{ connected_account_id: string }>(
      `SELECT connected_account_id FROM composio_connections WHERE catalog_id = 'notion'`,
    );
    expect(links.rows).toEqual([{ connected_account_id: "ca_a" }]);
    const grants = await db.query<{ id: string; resource_id: string }>(
      `SELECT id, resource_id FROM agent_grants ORDER BY id`,
    );
    expect(grants.rows).toEqual([
      { id: "grant_kept", resource_id: "conn_older" },
      { id: "grant_move", resource_id: "conn_older" },
    ]);
    await expect(
      db.query(
        `INSERT INTO connectors (id, name, transport, target, catalog_id)
         VALUES ('conn_again', 'Notion', 'http', 'https://example.test/notion', 'notion')`,
      ),
    ).rejects.toThrow();
  } finally {
    await db.close();
  }
});
