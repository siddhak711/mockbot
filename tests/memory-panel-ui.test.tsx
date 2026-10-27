// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MemoryPanel } from "../components/memory/memory-panel";
import {
  getMemoryPanelState,
  patchMemoryPanel,
  resetMemoryPanelStore,
} from "../src/memory/panel-store";
import type { Memory, MemoryProposal } from "../src/types";

function memory(
  partial: Partial<Memory> & Pick<Memory, "id" | "key" | "content" | "kind">,
): Memory {
  return {
    agentId: "agent_default",
    sourceMessageId: null,
    sourceSnippet: null,
    supersedes: null,
    validFrom: "2026-10-12T15:00:00.000Z",
    validTo: null,
    deletedAt: null,
    createdBy: "user",
    origin: "you_said",
    history: [],
    ...partial,
  };
}

const profile = memory({
  id: "prefers",
  key: "Prefers",
  content: "Ultra-concise replies",
  kind: "profile",
});
const shared = memory({
  id: "repo",
  key: "Repo",
  content: "github.com/siddhak711/mockbot",
  kind: "shared",
  origin: "agent",
  fromAgent: "PM",
});
const journal = memory({
  id: "journal-1",
  key: "oct-26",
  content: "Started memory panel design",
  kind: "journal",
});
const proposal: MemoryProposal = {
  id: "pending-1",
  agentId: "agent_default",
  kind: "profile",
  key: "city",
  content: "Lives in New York",
  signal: "calendar",
  evidence: "Calendar",
  fingerprint: "fp",
  createdAt: "2026-10-26T15:00:00.000Z",
};

beforeEach(() => {
  resetMemoryPanelStore();
  patchMemoryPanel({
    memories: [profile, shared, journal],
    proposals: [proposal],
    error: null,
    tab: "all",
    query: "",
    selectedId: null,
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  resetMemoryPanelStore();
});

it("syncs tab, query, selection, and the pending queue between the pane and settings", async () => {
  render(
    <>
      <MemoryPanel variant="pane" agentId="agent_default" hotkeys />
      <MemoryPanel variant="page" agentId="agent_default" />
    </>,
  );

  const profileTabs = screen.getAllByRole("tab", { name: "Profile" });
  fireEvent.click(profileTabs[0]!);
  expect(
    screen
      .getAllByRole("tab", { name: "Profile" })
      .every((tab) => tab.getAttribute("aria-selected") === "true"),
  ).toBe(true);
  expect(screen.getAllByText("Ultra-concise replies").length).toBeGreaterThan(0);
  expect(screen.queryByText("github.com/siddhak711/mockbot")).toBeNull();

  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json({
        memory: memory({
          id: "city",
          key: "city",
          content: "Lives in New York",
          kind: "profile",
          origin: "inferred",
          signal: "calendar",
        }),
      }),
    ),
  );
  fireEvent.click(screen.getAllByRole("button", { name: "✓ Approve" })[0]!);
  await act(async () => {
    await Promise.resolve();
  });
  expect(getMemoryPanelState().proposals).toEqual([]);
  expect(screen.queryByText("Pending approval")).toBeNull();
  expect(screen.getAllByText("Lives in New York").length).toBeGreaterThan(0);

  fireEvent.click(screen.getAllByRole("tab", { name: "All" })[1]!);
  fireEvent.change(screen.getAllByLabelText("Search memory")[0]!, { target: { value: "repo" } });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 160));
  });
  expect(getMemoryPanelState().query).toBe("repo");
  expect(screen.getAllByText("github.com/siddhak711/mockbot").length).toBeGreaterThan(0);
  expect(document.querySelectorAll("mark").length).toBeGreaterThan(0);

  fireEvent.click(
    screen.getAllByRole("listitem").find((row) => row.textContent?.includes("Repo"))!,
  );
  expect(getMemoryPanelState().selectedId).toBe("repo");
});

it("confirms a forget, skips it on shift-click, undoes with the toast and ⌘Z, and commits on expiry", async () => {
  const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
  vi.stubGlobal("fetch", fetchMock);
  vi.useFakeTimers();
  render(<MemoryPanel variant="pane" agentId="agent_default" hotkeys onClose={() => undefined} />);

  fireEvent.click(screen.getByRole("button", { name: "Forget Prefers" }));
  expect(screen.getByRole("dialog", { name: "Forget this fact?" })).toBeTruthy();
  expect(screen.getByText(/removed from this agent/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(screen.queryByRole("dialog")).toBeNull();

  fireEvent.click(screen.getByRole("button", { name: "Forget Repo" }), { shiftKey: true });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.getByRole("status").textContent).toContain('Forgot "Repo"');
  expect(screen.queryByText("github.com/siddhak711/mockbot")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Undo" }));
  expect(screen.getByText("github.com/siddhak711/mockbot")).toBeTruthy();

  fireEvent.click(screen.getByRole("button", { name: "Forget Prefers" }));
  fireEvent.click(screen.getByRole("button", { name: "Forget" }));
  expect(screen.queryByText("Ultra-concise replies")).toBeNull();
  fireEvent.keyDown(window, { key: "z", metaKey: true });
  expect(screen.getByText("Ultra-concise replies")).toBeTruthy();

  fireEvent.click(screen.getByRole("button", { name: "Forget Prefers" }));
  fireEvent.click(screen.getByRole("button", { name: "Forget" }));
  await act(async () => {
    vi.advanceTimersByTime(10_000);
  });
  expect(fetchMock).toHaveBeenCalledWith(
    expect.stringContaining("/api/memories/prefers"),
    expect.objectContaining({ method: "DELETE" }),
  );
  expect(getMemoryPanelState().memories?.some((item) => item.id === "prefers")).toBe(false);
});

it("adds and edits a fact, keeps journal read-only, and dismisses an inference", async () => {
  const calls: Array<{ url: string; body: string; method: string }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      calls.push({ url, body: String(init?.body ?? ""), method });
      if (method === "POST" && url.includes("/api/memories/proposals")) {
        return Response.json({ hiddenUntil: "2026-11-25T00:00:00.000Z" });
      }
      if (method === "POST") {
        return Response.json({
          memory: memory({
            id: "added",
            key: "diet",
            content: "I'm vegetarian",
            kind: "profile",
          }),
        });
      }
      if (method === "PATCH") {
        return Response.json({
          memory: memory({
            id: "prefers",
            key: "Prefers",
            content: "Ultra-concise replies, visuals first",
            kind: "profile",
            edited: true,
            origin: "you_said",
          }),
        });
      }
      return new Response(null, { status: 204 });
    }),
  );
  render(<MemoryPanel variant="page" agentId="agent_default" agentName="Mockbot" />);

  expect(screen.getByText("read-only")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Forget oct-26" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Edit oct-26" })).toBeNull();
  expect(screen.getByRole("button", { name: "Export" })).toBeTruthy();
  expect(screen.getByRole("checkbox", { name: "Select Prefers" })).toBeTruthy();
  expect(screen.queryByRole("link", { name: /Open in Settings/ })).toBeNull();

  fireEvent.click(screen.getByRole("button", { name: "+ Add fact" }));
  fireEvent.change(screen.getByLabelText("Fact"), { target: { value: "I'm vegetarian" } });
  fireEvent.click(screen.getByRole("button", { name: "Add" }));
  await act(async () => {
    await Promise.resolve();
  });
  expect(calls.some((call) => call.method === "POST" && call.body.includes("vegetarian"))).toBe(
    true,
  );
  expect(screen.getByText("I'm vegetarian")).toBeTruthy();

  fireEvent.click(screen.getByRole("button", { name: "Edit Prefers" }));
  fireEvent.change(screen.getByLabelText("Edit Prefers value"), {
    target: { value: "Ultra-concise replies, visuals first" },
  });
  fireEvent.keyDown(screen.getByLabelText("Edit Prefers value"), { key: "Enter" });
  await act(async () => {
    await Promise.resolve();
  });
  expect(screen.getByText("You said · edited")).toBeTruthy();

  fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
  await act(async () => {
    await Promise.resolve();
  });
  expect(screen.queryByText("Lives in New York")).toBeNull();
  expect(calls.some((call) => call.url.includes("action=dismiss"))).toBe(true);
});

it("offers to add a search that matches nothing", async () => {
  render(<MemoryPanel variant="pane" agentId="agent_default" />);
  fireEvent.change(screen.getByLabelText("Search memory"), { target: { value: "quinoa" } });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 160));
  });
  expect(screen.getByRole("button", { name: "Add 'quinoa' as a fact" })).toBeTruthy();
});

it("labels the pane and closes it from the control", () => {
  const onClose = vi.fn();
  render(<MemoryPanel variant="pane" agentId="agent_default" hotkeys onClose={onClose} />);
  expect(screen.getByRole("complementary", { name: "Memory" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  expect(onClose).toHaveBeenCalledOnce();
  fireEvent.keyDown(window, { key: "Escape" });
  expect(onClose).toHaveBeenCalledTimes(2);
});
