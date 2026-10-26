// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ThemeProvider } from "../components/theme";
import { Workspace } from "../components/workspace";
import type { SignedInUser } from "../src/auth/user";

const user: SignedInUser = {
  id: "user_1",
  name: "Ada",
  email: "ada@example.com",
  image: null,
};

const agents = [
  {
    id: "agent_default",
    name: "Mockbot",
    instructions: "Lead",
    memoryNote: "",
    isLead: true,
    createdAt: "2020-01-01T00:00:00.000Z",
  },
  {
    id: "agent_research",
    name: "Researcher",
    instructions: "Notes",
    memoryNote: "",
    isLead: false,
    createdAt: "2020-01-02T00:00:00.000Z",
  },
  {
    id: "agent_scribe",
    name: "Scribe",
    instructions: "Empty",
    memoryNote: "",
    isLead: false,
    createdAt: "2020-01-03T00:00:00.000Z",
  },
];

const threads: Record<string, { conversation: object; messages: object[] }> = {
  agent_default: {
    conversation: {
      id: "c-lead",
      title: "Mockbot",
      agentId: "agent_default",
      createdAt: "2020-01-01T00:00:00.000Z",
      updatedAt: "2020-01-01T00:00:00.000Z",
    },
    messages: [
      {
        id: "m1",
        conversationId: "c-lead",
        role: "user",
        content: "Remember the grove",
        createdAt: "2020-01-01T00:00:00.000Z",
        trace: null,
      },
      {
        id: "m2",
        conversationId: "c-lead",
        role: "assistant",
        content: "Stored the grove",
        createdAt: "2020-01-01T00:01:00.000Z",
        trace: null,
      },
    ],
  },
  agent_research: {
    conversation: {
      id: "c-research",
      title: "Researcher",
      agentId: "agent_research",
      createdAt: "2020-01-02T00:00:00.000Z",
      updatedAt: "2020-01-02T00:00:00.000Z",
    },
    messages: [
      {
        id: "m3",
        conversationId: "c-research",
        role: "user",
        content: "Research notes",
        createdAt: "2020-01-02T00:00:00.000Z",
        trace: null,
      },
    ],
  },
  agent_scribe: {
    conversation: {
      id: "c-scribe",
      title: "Scribe",
      agentId: "agent_scribe",
      createdAt: "2020-01-03T00:00:00.000Z",
      updatedAt: "2020-01-03T00:00:00.000Z",
    },
    messages: [],
  },
};

function installFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/conversations")) {
        return new Response("threads are not listed", { status: 404 });
      }
      if (url.endsWith("/api/agents") || url.endsWith("/api/agents/")) {
        return Response.json({ agents });
      }
      const agentMatch = url.match(/\/api\/agents\/([^/]+)\/conversation/);
      if (agentMatch?.[1]) {
        const thread = threads[decodeURIComponent(agentMatch[1])];
        if (!thread) return new Response("missing", { status: 404 });
        return Response.json(thread);
      }
      if (url.includes("/api/status")) {
        return Response.json({ provider: "mock", model: null, database: "local" });
      }
      if (url.includes("/api/connectors")) return Response.json({ connectors: [] });
      if (url.includes("/api/computer")) return new Response("no", { status: 404 });
      if (url.includes("/api/memories")) return Response.json({ memories: [] });
      return new Response(`unmocked ${url}`, { status: 404 });
    }),
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

it("shows agents instead of chats, and keeps history after a reload", async () => {
  installFetch();
  const { unmount } = render(
    <ThemeProvider>
      <Workspace user={user} />
    </ThemeProvider>,
  );

  expect(await screen.findByText("Remember the grove")).toBeTruthy();
  expect(screen.getByText("Stored the grove")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "New chat" })).toBeNull();
  expect(screen.queryByText("Conversations")).toBeNull();
  expect(screen.queryByText("Today")).toBeNull();
  expect(screen.queryByText("Start a conversation")).toBeNull();
  expect(screen.queryByRole("button", { name: "Rename" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
  expect(screen.getByRole("button", { name: /Mockbot/ })).toBeTruthy();
  expect(screen.getByRole("button", { name: /Researcher/ })).toBeTruthy();

  unmount();
  render(
    <ThemeProvider>
      <Workspace user={user} />
    </ThemeProvider>,
  );
  expect(await screen.findByText("Remember the grove")).toBeTruthy();

  fireEvent.click(screen.getByRole("button", { name: /Researcher/ }));
  expect(await screen.findByText("Research notes")).toBeTruthy();
  expect(screen.queryByText("Remember the grove")).toBeNull();

  cleanup();
  render(
    <ThemeProvider>
      <Workspace user={user} />
    </ThemeProvider>,
  );
  expect(await screen.findByText("Research notes")).toBeTruthy();

  fireEvent.click(screen.getByRole("button", { name: /Scribe/ }));
  expect(await screen.findByRole("heading", { name: "Hello from Scribe" })).toBeTruthy();
  expect(screen.queryByText("Start a conversation")).toBeNull();
  await waitFor(() => {
    expect(window.location.search).toContain("agent=agent_scribe");
  });
});
