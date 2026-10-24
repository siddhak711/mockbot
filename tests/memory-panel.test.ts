import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { MemoryPanel } from "../components/memory-panel";
import { MEMORY_LOAD_ERROR, memoryPanelMode, nextMemories } from "../src/memory/panel-state";

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
      onChanged: async () => {},
    }),
  );
  expect(html).toContain(MEMORY_LOAD_ERROR);
  expect(html).toContain("Retry");
  expect(html).not.toContain("Loading memories");
});
