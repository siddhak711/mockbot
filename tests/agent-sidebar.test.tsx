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

it("shows a collapsed rail of agent avatars and opens that agent's thread", async () => {
  installFetch();
  render(
    <ThemeProvider>
      <Workspace user={user} />
    </ThemeProvider>,
  );

  expect(await screen.findByText("Remember the grove")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Collapse sidebar" }));

  expect(screen.queryByText("Routines")).toBeNull();
  expect(screen.queryByText("Connectors")).toBeNull();
  expect(screen.queryByRole("button", { name: "New chat" })).toBeNull();
  expect(screen.queryByText("Conversations")).toBeNull();

  const person = screen.getByRole("button", { name: "Expand sidebar, Ada" });
  expect(person.getAttribute("title")).toBe("Ada");
  const divider = screen.getByRole("separator");
  const mockbot = screen.getByRole("button", { name: "Mockbot" });
  const researcher = screen.getByRole("button", { name: "Researcher" });
  expect(person.compareDocumentPosition(divider) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(divider.compareDocumentPosition(mockbot) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(mockbot.className).toContain("rail-agent");
  expect(mockbot.className).toContain("on");
  expect(mockbot.getAttribute("title")).toBe("Mockbot");
  expect(mockbot.getAttribute("aria-current")).toBe("true");
  expect(mockbot.querySelector("[data-sprite-color]")?.getAttribute("data-sprite-color")).toBe(
    "violet",
  );
  expect(researcher.className).toContain("rail-agent");
  expect(researcher.className).not.toContain("on");
  expect(researcher.getAttribute("title")).toBe("Researcher");
  expect(
    researcher.querySelector("[data-sprite-color]")?.getAttribute("data-sprite-color"),
  ).not.toBe("violet");

  fireEvent.click(researcher);
  expect(await screen.findByText("Research notes")).toBeTruthy();
  expect(screen.queryByText("Remember the grove")).toBeNull();
  expect(researcher.getAttribute("aria-current")).toBe("true");
  expect(mockbot.getAttribute("aria-current")).toBeNull();
});

it("sends a message on the newly selected agent before that thread finishes loading", async () => {
  let releaseResearch: (response: Response) => void = () => {};
  const researchHeld = new Promise<Response>((resolve) => {
    releaseResearch = resolve;
  });
  const chatBodies: Array<Record<string, unknown>> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/chat")) {
        chatBodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
        return new Response("event: end\ndata: {}\n\n", {
          headers: { "Content-Type": "text/event-stream" },
        });
      }
      if (url.includes("/api/agents/agent_research/conversation")) return researchHeld;
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

  render(
    <ThemeProvider>
      <Workspace user={user} />
    </ThemeProvider>,
  );
  expect(await screen.findByText("Remember the grove")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: /Researcher/ }));
  fireEvent.change(screen.getByRole("textbox", { name: "Message" }), {
    target: { value: "Follow the ridge" },
  });
  const form = screen.getByRole("textbox", { name: "Message" }).closest("form");
  expect(form).toBeTruthy();
  fireEvent.submit(form!);
  await waitFor(() => expect(chatBodies).toHaveLength(1));
  expect(chatBodies[0]).toMatchObject({
    message: "Follow the ridge",
    agentId: "agent_research",
  });
  expect(chatBodies[0]).not.toHaveProperty("conversationId");
  releaseResearch(Response.json(threads.agent_research));
});

it("opens the agent's thread when the conversation id in the url is gone", async () => {
  installFetch();
  window.history.replaceState(null, "", "/?c=merged-away&agent=agent_research");
  render(
    <ThemeProvider>
      <Workspace user={user} />
    </ThemeProvider>,
  );

  expect(await screen.findByText("Research notes")).toBeTruthy();
  expect(screen.queryByRole("heading", { name: /Hello from/ })).toBeNull();
  expect(screen.queryByText("Remember the grove")).toBeNull();
  expect(screen.queryByText("Start a conversation")).toBeNull();
});
