import { expect, it } from "vitest";
import {
  releaseDecision,
  settleDecision,
  stopDecision,
  type DecisionLock,
} from "../src/decision-lock";

it("keeps Approve and Deny locked after a successful decision", async () => {
  const lock: DecisionLock = { current: null };
  expect(await settleDecision(lock, "call-1", async () => true)).toBe("held");
  expect(lock.current).toBe("call-1");
  expect(await settleDecision(lock, "call-1", async () => true)).toBe("busy");
  expect(lock.current).toBe("call-1");

  releaseDecision(lock, "call-1");
  expect(lock.current).toBeNull();
  expect(await settleDecision(lock, "call-2", async () => true)).toBe("held");
});

it("clears the approval lock when the decision request fails", async () => {
  const lock: DecisionLock = { current: null };
  expect(await settleDecision(lock, "call-1", async () => false)).toBe("released");
  expect(lock.current).toBeNull();
  expect(await settleDecision(lock, "call-2", async () => true)).toBe("held");
});

it("clears the approval lock when the decision request throws", async () => {
  const lock: DecisionLock = { current: null };
  await expect(
    settleDecision(lock, "call-1", async () => {
      throw new Error("network down");
    }),
  ).rejects.toThrow("network down");
  expect(lock.current).toBeNull();
  expect(await settleDecision(lock, "call-2", async () => true)).toBe("held");
});

it("clears a held approval lock on stop", async () => {
  const lock: DecisionLock = { current: null };
  expect(await settleDecision(lock, "call-1", async () => true)).toBe("held");
  stopDecision(lock);
  expect(lock.current).toBeNull();
  expect(await settleDecision(lock, "call-2", async () => true)).toBe("held");
  releaseDecision(lock, "call-1");
  expect(lock.current).toBe("call-2");
});
