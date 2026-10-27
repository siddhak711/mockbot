import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { MemoryPanel } from "../components/memory-panel";
import {
  applyMemoryRefresh,
  MEMORY_LOAD_ERROR,
  memoriesAfterAgentSwitch,
  memoryPanelMode,
  nextMemories,
} from "../src/memory/panel-state";
import type { Memory } from "../src/types";

it("keeps a failed memory load out of the loading state and offers retry", () => {
  const initial = nextMemories(null, false, null);
  expect(initial).toEqual({ memories: null, error: MEMORY_LOAD_ERROR });
  expect(memoryPanelMode(initial.memories, initial.error)).toBe("error");

  const kept = nextMemories(
    [
      {
        id: "live",
        agentId: "agent_default",
        kind: "fact",
        key: "city",
        content: "Lisbon",
        sourceMessageId: null,
        sourceSnippet: null,
        supersedes: null,
        validFrom: "2026-01-01T00:00:00.000Z",
        validTo: null,
        deletedAt: null,
        createdBy: "user",
        history: [],
      },
    ],
    false,
    null,
  );
  expect(kept.memories).toHaveLength(1);
  expect(kept.error).toBe(MEMORY_LOAD_ERROR);
  expect(memoryPanelMode(kept.memories, kept.error)).toBe("list");

  const html = renderToStaticMarkup(
    createElement(MemoryPanel, {
      memories: null,
      error: MEMORY_LOAD_ERROR,
      agentId: "agent_default",
      onChanged: async () => {},
    }),
  );
  expect(html).toContain(MEMORY_LOAD_ERROR);
  expect(html).toContain("Try again");
  expect(html.replace(/&#x27;|&apos;/g, "'")).toContain("Couldn't load memory");
  expect(html).not.toContain("Loading memories");
});

function memory(agentId: string, key: string): Memory {
  return {
    id: key,
    agentId,
    kind: "fact",
    key,
    content: key,
    sourceMessageId: null,
    sourceSnippet: null,
    supersedes: null,
    validFrom: "2026-01-01T00:00:00.000Z",
    validTo: null,
    deletedAt: null,
    createdBy: "user",
    history: [],
  };
}

it("ignores a memory list that finishes loading after the selected agent changes", () => {
  const previous = [memory("agent_default", "city")];
  const other = [memory("agent_research", "topic")];
  const decision = applyMemoryRefresh({
    requestedAgentId: "agent_default",
    currentAgentId: "agent_research",
    ok: true,
    loaded: previous,
    current: other,
  });
  expect(decision).toBeNull();
});

it("keeps the current agent's load error when an old agent's fetch fails", () => {
  const cleared = memoriesAfterAgentSwitch();
  expect(cleared).toEqual({ memories: [], error: null });

  const failed = applyMemoryRefresh({
    requestedAgentId: "agent_research",
    currentAgentId: "agent_research",
    ok: false,
    loaded: null,
    current: cleared.memories,
  });
  expect(failed).toEqual({ memories: [], error: MEMORY_LOAD_ERROR });
  const html = renderToStaticMarkup(
    createElement(MemoryPanel, {
      memories: failed?.memories ?? null,
      error: failed?.error ?? null,
      agentId: "agent_research",
      onChanged: async () => {},
    }),
  );
  expect(html).toContain(MEMORY_LOAD_ERROR);
  expect(html).toContain("Try again");

  const stale = applyMemoryRefresh({
    requestedAgentId: "agent_default",
    currentAgentId: "agent_research",
    ok: false,
    loaded: null,
    current: failed?.memories ?? null,
  });
  expect(stale).toBeNull();
  expect(failed).toEqual({ memories: [], error: MEMORY_LOAD_ERROR });
});
