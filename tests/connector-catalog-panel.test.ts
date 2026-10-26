// @vitest-environment jsdom

import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
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

it("keeps search focus while a URL is typed into the connected catalog", () => {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root: Root = createRoot(host);
  act(() => {
    root.render(
      createElement(ConnectorsPanel, {
        open: true,
        intent: "list",
        connectors: [connected("notion")],
        ready: true,
        onClose() {},
        onChanged: async () => {},
        onInsertPrompt() {},
        onStop() {},
      }),
    );
  });

  const input = document.querySelector<HTMLInputElement>('input[aria-label="Search connectors"]');
  expect(input).not.toBeNull();
  act(() => {
    input!.focus();
  });

  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  if (!setter) throw new Error("missing input value setter");
  let typed = "";
  for (const char of "https://mcp.acme.dev/mcp") {
    typed += char;
    act(() => {
      setter.call(input, typed);
      input!.setSelectionRange(typed.length, typed.length);
      input!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const live = document.querySelector<HTMLInputElement>('input[aria-label="Search connectors"]');
    expect(live, `input remounted at "${typed}"`).toBe(input);
    expect(document.activeElement, `focus lost at "${typed}"`).toBe(input);
    expect(input!.value).toBe(typed);
    expect(input!.selectionStart, `caret lost at "${typed}"`).toBe(typed.length);
    expect(document.body.textContent).toContain("Connected");
    expect(document.body.textContent).toContain("Add a connector");
  }

  act(() => {
    root.unmount();
  });
  host.remove();
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
