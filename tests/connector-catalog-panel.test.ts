import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { ConnectorsPanel } from "../components/connectors-panel";
import { catalogById, catalogInCategory } from "../src/connectors/catalog";
import type { ConnectorRecord } from "../src/connectors";

function connected(catalogId: string, id = catalogId): ConnectorRecord {
  const entry = catalogById(catalogId);
  if (!entry) throw new Error(`missing catalog entry ${catalogId}`);
  return {
    id,
    name: entry.name,
    transport: "http",
    target: `https://catalog.mockbot.local/${catalogId}`,
    secretRef: null,
    enabled: true,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    catalogId,
    authType: "oauth",
    accountLabel: "workspace",
    status: "connected",
    statusDetail: null,
    tools: {},
    seenTools: [],
    failures: [],
  };
}

function renderPanel(connectors: ConnectorRecord[]): string {
  return renderToStaticMarkup(
    createElement(ConnectorsPanel, {
      open: true,
      intent: "list",
      connectors,
      ready: true,
      onClose() {},
      onChanged: async () => {},
      onInsertPrompt() {},
      onStop() {},
    }),
  );
}

it("keeps the catalog visible when at least one connector is connected", () => {
  const html = renderPanel([connected("notion")]);
  const remaining = catalogInCategory("popular")
    .map((entry) => entry.id)
    .filter((id) => id !== "notion");

  expect(html).toContain('aria-label="Connected"');
  expect(html).toContain('aria-label="Add a connector"');
  expect(html).toContain('aria-label="Available connectors"');
  expect(html).toContain("Notion");
  expect(html).toContain("● Connected");
  expect(html).not.toContain('data-catalog-id="notion"');
  for (const id of remaining) {
    expect(html).toContain(`data-catalog-id="${id}"`);
  }
  expect(html).toContain("Custom URL");
  expect(html).toContain("Connect");
});

it("keeps every unconnected catalog entry when several connectors are connected", () => {
  const html = renderPanel([connected("notion", "c-notion"), connected("github", "c-github")]);

  expect(html).toContain('aria-label="Connected"');
  expect(html).toContain('aria-label="Add a connector"');
  expect(html).not.toContain('data-catalog-id="notion"');
  expect(html).not.toContain('data-catalog-id="github"');
  expect(html).toContain('data-catalog-id="slack"');
  expect(html).toContain('data-catalog-id="linear"');
  expect(html).toContain('data-catalog-id="jira"');
});
