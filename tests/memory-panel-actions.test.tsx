// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { MemoryPanel } from "../components/memory-panel";
import type { Memory } from "../src/types";

const memory: Memory = {
  id: "mem_1",
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
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("re-enables a memory card and shows the error when delete or save throws", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    }),
  );
  const onChanged = vi.fn(async () => {});
  render(
    <MemoryPanel memories={[memory]} error={null} agentId="agent_default" onChanged={onChanged} />,
  );

  const remove = screen.getByRole("button", { name: "Delete memory city" });
  fireEvent.click(remove);
  expect((await screen.findByRole("alert")).textContent).toContain("Could not delete memory");
  expect(remove.hasAttribute("disabled")).toBe(false);

  fireEvent.click(screen.getByRole("button", { name: "Edit" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Edit city" }), {
    target: { value: "Porto" },
  });
  const save = screen.getByRole("button", { name: "Save" });
  fireEvent.click(save);
  expect((await screen.findByRole("alert")).textContent).toContain("Could not update memory");
  expect(save.hasAttribute("disabled")).toBe(false);
  expect(onChanged).not.toHaveBeenCalled();
});
