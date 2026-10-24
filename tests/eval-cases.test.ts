import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";

type RecallCase = {
  id: string;
  turns: Array<{ say: string }>;
  ask: string;
  expectContains?: string;
  expectAbsent?: string[];
  savedContains?: string;
  liveAbsent?: string;
  mustNotStore?: string;
};

it("keeps a runnable mockbot recall set of about twenty cases", async () => {
  const cases = JSON.parse(
    await readFile(new URL("../evals/mockbot-recall.json", import.meta.url), "utf8"),
  ) as RecallCase[];
  expect(cases.length).toBeGreaterThanOrEqual(20);
  expect(cases.length).toBeLessThanOrEqual(30);
  const ids = new Set(cases.map((item) => item.id));
  expect(ids.size).toBe(cases.length);
  for (const item of cases) {
    expect(item.id).toMatch(/^[a-z0-9-]+$/);
    expect(item.ask.trim().length).toBeGreaterThan(0);
    expect(Array.isArray(item.turns)).toBe(true);
  }
  expect(cases.some((item) => item.mustNotStore)).toBe(true);
  expect(cases.some((item) => item.id.startsWith("update"))).toBe(true);
  expect(cases.some((item) => item.id.startsWith("forget"))).toBe(true);
  expect(cases.some((item) => item.turns.length === 0)).toBe(true);
  expect(cases.filter((item) => item.savedContains).length).toBeGreaterThanOrEqual(10);
});
