// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Sidebar } from "../components/sidebar";
import { ThemeProvider } from "../components/theme";
import type { Agent } from "../src/agents/types";

const base = { instructions: "", memoryNote: "", createdAt: "2020-01-01T00:00:00.000Z" };

const agents: Agent[] = [
  { ...base, id: "agent_default", name: "Mockbot", isLead: true, preview: "Lead line" },
  {
    ...base,
    id: "agent_old",
    name: "Builder",
    isLead: false,
    preview: "Older reply",
    lastMessageAt: "2020-01-02T00:00:00.000Z",
    lastMessageRole: "assistant",
  },
  {
    ...base,
    id: "agent_new",
    name: "Reviewer",
    isLead: false,
    preview: "Newest reply",
    lastMessageAt: "2020-01-03T00:00:00.000Z",
    lastMessageRole: "assistant",
  },
  { ...base, id: "agent_empty", name: "Life", isLead: false },
];

function renderSidebar(list: Agent[] = agents, onSelectAgent = () => {}) {
  return render(
    <ThemeProvider>
      <Sidebar
        agents={list}
        activeAgentId="agent_default"
        spriteState="idle"
        runtimeStatus={{ provider: "mock", model: null, database: "local" }}
        busy={false}
        open
        onSelectAgent={onSelectAgent}
        onCreateAgent={async () => null}
        onOpenConnectors={() => {}}
        user={{ id: "user_1", name: "Ada", email: "ada@example.com", image: null }}
      />
    </ThemeProvider>,
  );
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
});

it("pins the lead as a tile and lists the rest newest first with a preview", () => {
  renderSidebar();
  const pin = document.querySelector(".roster-pin");
  expect(pin?.textContent).toBe("Mockbot");
  const rows = [...document.querySelectorAll(".roster-row")].map((row) => row.textContent);
  expect(rows).toEqual(["ReviewerNewest reply", "BuilderOlder reply", "LifeMessage"]);
});

it("marks a reply that arrived after the agent was last seen", () => {
  const view = renderSidebar();
  expect(document.querySelectorAll(".roster-dot")).toHaveLength(0);

  const later = agents.map((agent) =>
    agent.id === "agent_old"
      ? { ...agent, preview: "Fresh reply", lastMessageAt: "2020-02-01T00:00:00.000Z" }
      : agent,
  );
  view.rerender(
    <ThemeProvider>
      <Sidebar
        agents={later}
        activeAgentId="agent_default"
        spriteState="idle"
        runtimeStatus={{ provider: "mock", model: null, database: "local" }}
        busy={false}
        open
        onSelectAgent={() => {}}
        onCreateAgent={async () => null}
        user={{ id: "user_1", name: "Ada", email: "ada@example.com", image: null }}
      />
    </ThemeProvider>,
  );
  expect(screen.getByRole("button", { name: "Builder, new reply" })).toBeTruthy();
  expect(document.querySelectorAll(".roster-dot")).toHaveLength(1);
});

it("filters agents by name or preview from the search button", () => {
  const onSelect = vi.fn();
  renderSidebar(agents, onSelect);
  fireEvent.click(screen.getByRole("button", { name: "Search agents" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Search agents" }), {
    target: { value: "older" },
  });
  const rows = [...document.querySelectorAll(".roster-row")].map((row) => row.textContent);
  expect(rows).toEqual(["BuilderOlder reply"]);
  expect(document.querySelector(".roster-pin")).toBeNull();
  fireEvent.click(screen.getByText("Builder"));
  expect(onSelect).toHaveBeenCalledWith("agent_old");
});

it("moves routines and connectors into the footer menu", () => {
  renderSidebar();
  expect(screen.queryByRole("link", { name: "Routines" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Routines and connectors" }));
  expect(screen.getByRole("menuitem", { name: "Routines" }).getAttribute("href")).toBe("/routines");
  expect(screen.getByRole("menuitem", { name: "Connectors" })).toBeTruthy();
});
