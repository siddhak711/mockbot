import { expect, it } from "vitest";
import {
  beginDecision,
  releaseDecision,
  stopDecision,
  type DecisionLock,
} from "../src/decision-lock";

async function decide(lock: DecisionLock, id: string, task: () => Promise<void>): Promise<void> {
  if (!beginDecision(lock, id)) return;
  try {
    await task();
  } finally {
    releaseDecision(lock, id);
  }
}

it("clears the approval lock after a successful decision", async () => {
  const lock: DecisionLock = { current: null };
  await decide(lock, "call-1", async () => {
    expect(lock.current).toBe("call-1");
    expect(beginDecision(lock, "call-2")).toBe(false);
  });
  expect(lock.current).toBeNull();
  expect(beginDecision(lock, "call-2")).toBe(true);
});

it("clears the approval lock when the decision request throws", async () => {
  const lock: DecisionLock = { current: null };
  await expect(
    decide(lock, "call-1", async () => {
      throw new Error("network down");
    }),
  ).rejects.toThrow("network down");
  expect(lock.current).toBeNull();
  expect(beginDecision(lock, "call-2")).toBe(true);
});

it("clears the approval lock on stop so a later decision can start", () => {
  const lock: DecisionLock = { current: null };
  expect(beginDecision(lock, "call-1")).toBe(true);
  stopDecision(lock);
  expect(lock.current).toBeNull();
  expect(beginDecision(lock, "call-2")).toBe(true);
  releaseDecision(lock, "call-1");
  expect(lock.current).toBe("call-2");
  releaseDecision(lock, "call-2");
  expect(lock.current).toBeNull();
});
