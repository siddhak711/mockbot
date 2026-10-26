import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { MIGRATIONS } from "../src/db/migrations";

it("runs the test runner", () => {
  expect(1 + 1).toBe(2);
});

it("keeps the one-thread model in the sidebar and the migration list", () => {
  expect(MIGRATIONS.some((item) => item.id === "007_one_thread_per_agent")).toBe(true);
  const sidebar = readFileSync(new URL("../components/sidebar.tsx", import.meta.url), "utf8");
  const workspace = readFileSync(new URL("../components/workspace.tsx", import.meta.url), "utf8");
  const transcript = readFileSync(new URL("../components/transcript.tsx", import.meta.url), "utf8");
  expect(sidebar).not.toContain("New chat");
  expect(sidebar).not.toContain("Conversations");
  expect(workspace).not.toContain("New chat");
  expect(workspace).not.toContain("Start a conversation");
  expect(transcript).toContain("Hello from");
  expect(transcript).not.toContain("Start a conversation");
});
