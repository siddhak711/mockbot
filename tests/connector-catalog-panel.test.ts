// @vitest-environment happy-dom

import { createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
import { ConnectorsPanel } from "../components/connectors-panel";
import { ThemeProvider } from "../components/theme";
import { CATALOG_CATEGORIES, catalogById, catalogInCategory } from "../src/connectors/catalog";
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
  expect(html).toContain('data-catalog-id="notion"');
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

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function LivePanel({
  initial,
  connectedNext,
}: {
  initial: ConnectorRecord[];
  connectedNext?: ConnectorRecord[];
}) {
  const [items, setItems] = useState(initial);
  return createElement(ConnectorsPanel, {
    open: true,
    intent: "list",
    connectors: items,
    ready: true,
    onClose() {},
    onChanged: async () => {
      if (connectedNext) setItems(connectedNext);
    },
    onInsertPrompt() {},
    onStop() {},
  });
}

function oauthPopup() {
  return {
    closed: false,
    document: { title: "", body: { textContent: "" } },
    location: { href: "" },
    close() {
      this.closed = true;
    },
  };
}

function stubCatalogOauth(connector: ConnectorRecord) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/connectors/oauth/start")) {
        return Response.json({ authorizeUrl: "https://example.com/oauth" });
      }
      return Response.json({ connector });
    }),
  );
  vi.stubGlobal(
    "open",
    vi.fn(() => oauthPopup()),
  );
}

async function connectFromSearch(query: string, catalogId: string, continueName: string) {
  fireEvent.change(screen.getByRole("textbox", { name: "Search connectors" }), {
    target: { value: query },
  });
  const tile = document.querySelector(`[data-catalog-id="${catalogId}"]`);
  expect(tile).not.toBeNull();
  fireEvent.click(tile!.querySelector("button")!);
  fireEvent.click(screen.getByRole("button", { name: `Continue to ${continueName} ↗` }));
  await waitFor(() => {
    expect(vi.mocked(window.open)).toHaveBeenCalled();
  });
  act(() => {
    window.dispatchEvent(
      new MessageEvent("message", {
        origin: window.location.origin,
        data: { type: "mockbot-oauth", ok: true, account: "workspace", connectorId: "c-github" },
      }),
    );
  });
}

it("shows the rest of the catalog after connecting from a search", async () => {
  const github = connected("github", "c-github");
  stubCatalogOauth(github);

  render(
    createElement(
      ThemeProvider,
      null,
      createElement(LivePanel, {
        initial: [connected("notion")],
        connectedNext: [connected("notion"), github],
      }),
    ),
  );

  await connectFromSearch("github", "github", "GitHub");

  await waitFor(() => {
    expect(screen.queryByRole("heading", { name: "Already connected" })).toBeNull();
    expect(document.querySelector('[data-catalog-id="slack"]')).not.toBeNull();
    expect(document.querySelector('[data-catalog-id="linear"]')).not.toBeNull();
  });
  expect(document.querySelector('[data-catalog-id="github"] button')?.textContent).toBe("Manage");
  expect(screen.getByRole("textbox", { name: "Search connectors" })).toHaveProperty("value", "");
  expect(screen.getByRole("heading", { name: "Connectors" })).toBeTruthy();
});

it("filters the success-screen catalog when the search changes", async () => {
  const github = connected("github", "c-github");
  stubCatalogOauth(github);

  render(
    createElement(
      ThemeProvider,
      null,
      createElement(LivePanel, {
        initial: [connected("notion")],
        connectedNext: [connected("notion"), github],
      }),
    ),
  );

  await connectFromSearch("github", "github", "GitHub");

  await waitFor(() => {
    expect(screen.getByRole("textbox", { name: "Search connectors" })).toHaveProperty("value", "");
    expect(document.querySelector('[data-catalog-id="linear"]')).not.toBeNull();
  });

  fireEvent.change(screen.getByRole("textbox", { name: "Search connectors" }), {
    target: { value: "linear" },
  });

  expect(document.querySelector('[data-catalog-id="linear"]')).not.toBeNull();
  expect(document.querySelector('[data-catalog-id="slack"]')).toBeNull();
  expect(document.querySelector('[data-catalog-id="jira"]')).toBeNull();
  expect(screen.queryByRole("heading", { name: "Already connected" })).toBeNull();
  expect(screen.getByRole("heading", { name: "Connectors" })).toBeTruthy();
});

it("returns to the list when a failed sign-in is retried and then cancelled", async () => {
  stubCatalogOauth(connected("github", "c-github"));
  render(
    createElement(
      ThemeProvider,
      null,
      createElement(LivePanel, { initial: [connected("notion")] }),
    ),
  );

  const githubTile = document.querySelector('[data-catalog-id="github"]');
  expect(githubTile).not.toBeNull();
  fireEvent.click(githubTile!.querySelector("button")!);
  fireEvent.click(screen.getByRole("button", { name: "Continue to GitHub ↗" }));
  await waitFor(() => {
    expect(vi.mocked(window.open)).toHaveBeenCalled();
  });
  act(() => {
    window.dispatchEvent(
      new MessageEvent("message", {
        origin: window.location.origin,
        data: { type: "mockbot-oauth", ok: false },
      }),
    );
  });

  fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

  expect(document.querySelector('section[aria-label="Connected"]')).not.toBeNull();
  expect(screen.getByRole("heading", { name: "Connectors" })).toBeTruthy();
  expect(screen.queryByRole("heading", { name: "Add a connector", level: 2 })).toBeNull();
});

it("returns to the connected list when a connect started there is cancelled", () => {
  render(
    createElement(
      ThemeProvider,
      null,
      createElement(LivePanel, { initial: [connected("notion")] }),
    ),
  );

  const githubTile = document.querySelector('[data-catalog-id="github"]');
  expect(githubTile).not.toBeNull();
  fireEvent.click(githubTile!.querySelector("button")!);
  expect(screen.getByRole("heading", { name: "Connect GitHub" })).toBeTruthy();

  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

  expect(document.querySelector('section[aria-label="Connected"]')).not.toBeNull();
  expect(screen.getByRole("heading", { name: "Connectors" })).toBeTruthy();
  expect(screen.queryByRole("heading", { name: "Add a connector", level: 2 })).toBeNull();
  const githubAgain = document.querySelector('[data-catalog-id="github"]');
  expect(githubAgain?.querySelector("button")?.textContent).toBe("Connect");
});

function searchBox(): HTMLInputElement {
  const node = screen.getByRole("textbox", { name: "Search connectors" });
  if (!(node instanceof HTMLInputElement)) throw new Error("search field is not an input");
  return node;
}

function pasteInto(input: HTMLInputElement, clip: string, next: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  if (!setter) throw new Error("missing input value setter");
  act(() => {
    const event = new Event("paste", { bubbles: true });
    Object.defineProperty(event, "clipboardData", { value: { getData: () => clip } });
    input.dispatchEvent(event);
    setter.call(input, next);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

it("classifies the field after a paste, not only the clipboard text", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => new Promise(() => {})),
  );
  render(
    createElement(
      ThemeProvider,
      null,
      createElement(LivePanel, { initial: [connected("notion")] }),
    ),
  );

  const input = searchBox();
  fireEvent.change(input, { target: { value: "https://" } });
  input.setSelectionRange("https://".length, "https://".length);
  pasteInto(input, "mcp.acme.dev/mcp", "https://mcp.acme.dev/mcp");

  await waitFor(() => {
    expect(screen.getByText("Reaching server…")).toBeTruthy();
  });
  expect(screen.queryByRole("heading", { name: "Connectors" })).toBeNull();

  cleanup();
  render(
    createElement(
      ThemeProvider,
      null,
      createElement(LivePanel, { initial: [connected("notion")] }),
    ),
  );
  const search = searchBox();
  fireEvent.change(search, { target: { value: "slack " } });
  search.setSelectionRange("slack ".length, "slack ".length);
  pasteInto(search, "https://example.com", "slack https://example.com");

  expect(screen.getByRole("heading", { name: "Connectors" })).toBeTruthy();
  expect(document.querySelector('section[aria-label="Connected"]')).not.toBeNull();
  expect(screen.queryByText("Reaching server…")).toBeNull();
});

it("keeps the caret in place when detection changes mode mid-edit", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => new Promise(() => {})),
  );
  render(
    createElement(
      ThemeProvider,
      null,
      createElement(LivePanel, { initial: [connected("notion")] }),
    ),
  );

  const input = searchBox();
  const url = "https://mcp.acme.dev/mcp";
  fireEvent.change(input, { target: { value: url } });
  fireEvent.keyDown(input, { key: "Enter" });

  await waitFor(() => {
    expect(screen.getByText("Reaching server…")).toBeTruthy();
  });

  const at = url.indexOf("mcp");
  const next = `${url.slice(0, at)}x${url.slice(at)}`;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  if (!setter) throw new Error("missing input value setter");
  const field = searchBox();
  act(() => {
    field.focus();
    setter.call(field, next);
    field.setSelectionRange(at + 1, at + 1);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
  });

  const live = searchBox();
  expect(live).toBe(field);
  expect(document.activeElement).toBe(live);
  expect(live.selectionStart).toBe(at + 1);
  expect(live.value).toBe(next);
});

it("keeps every unconnected catalog entry when several connectors are connected", () => {
  const html = renderPanel([connected("notion", "c-notion"), connected("github", "c-github")]);

  expect(html).toContain('aria-label="Connected"');
  expect(html).toContain('aria-label="Add a connector"');
  expect(html).toContain('data-catalog-id="notion"');
  expect(html).toContain('data-catalog-id="github"');
  expect(html).toContain('data-catalog-id="slack"');
  expect(html).toContain('data-catalog-id="linear"');
  expect(html).toContain('data-catalog-id="jira"');
});

function sharedCatalogRow(catalogId: string, status: ConnectorRecord["status"]): ConnectorRecord {
  return {
    ...connected(catalogId, `c-${catalogId}`),
    status,
    accountLabel: status === "connected" ? "workspace" : null,
  };
}

function openCatalog(connectors: ConnectorRecord[], intent: "list" | "add" = "list") {
  render(
    createElement(
      ThemeProvider,
      null,
      createElement(ConnectorsPanel, {
        open: true,
        intent,
        connectors,
        ready: true,
        onClose() {},
        onChanged: async () => {},
        onInsertPrompt() {},
        onStop() {},
      }),
    ),
  );
}

function gridTile(catalogId: string): HTMLElement {
  const tile = document.querySelector(
    `[aria-label="Available connectors"] [data-catalog-id="${catalogId}"]`,
  );
  if (!(tile instanceof HTMLElement)) throw new Error(`missing catalog tile ${catalogId}`);
  return tile;
}

function expectCallerCard(catalogId: string, linked: boolean) {
  const tile = gridTile(catalogId);
  if (linked) {
    expect(tile.textContent).toContain("● Connected");
    expect(tile.querySelector("button")?.textContent).toBe("Manage");
    return;
  }
  expect(tile.textContent).toContain("Not connected");
  expect(tile.textContent).not.toContain("● Connected");
  expect(tile.querySelector("button")?.textContent).not.toBe("Manage");
}

function expectEveryCatalogCard(linkedId: string | null) {
  for (const category of CATALOG_CATEGORIES) {
    fireEvent.click(screen.getByRole("button", { name: category.label }));
    for (const entry of catalogInCategory(category.id)) {
      expectCallerCard(entry.id, entry.id === linkedId);
    }
  }
}

it("shows every add-connector card from the caller's own link", () => {
  const catalogIds = CATALOG_CATEGORIES.flatMap((category) =>
    catalogInCategory(category.id).map((entry) => entry.id),
  );
  const ids = [...new Set(catalogIds)];

  openCatalog([], "add");
  expectEveryCatalogCard(null);

  cleanup();
  openCatalog(ids.map((id) => sharedCatalogRow(id, "not connected")));
  expect(document.querySelector('section[aria-label="Connected"]')?.textContent).toContain(
    "Notion",
  );
  expect(document.querySelector('section[aria-label="Connected"]')?.textContent).toContain(
    "Not connected",
  );
  expectEveryCatalogCard(null);

  cleanup();
  openCatalog(
    ids.map((id) => sharedCatalogRow(id, id === "notion" ? "connected" : "not connected")),
  );
  expectEveryCatalogCard("notion");
});
