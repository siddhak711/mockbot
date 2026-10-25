import { expect, it } from "vitest";
import {
  releaseDecision,
  settleDecision,
  stopDecision,
  type DecisionLock,
} from "../src/decision-lock";
import { activitiesAfterReconnect, type ToolActivity } from "../src/tools/display";

function activity(id: string, state: ToolActivity["state"]): ToolActivity {
  return {
    id,
    messageId: "message-1",
    name: "google_calendar",
    title: "Create a calendar event",
    detail: "Planning meeting",
    arguments: "{}",
    output: "",
    preview: "",
    summary: "Invite team@example.com",
    state,
    kind: "draft",
  };
}

it("releases the approval lock once the decision is saved", async () => {
  const lock: DecisionLock = { current: null };
  let continueRequest: () => void = () => {};
  const hold = new Promise<void>((resolve) => {
    continueRequest = resolve;
  });
  const pending = settleDecision(lock, "call-1", async () => {
    await hold;
    return true;
  });
  expect(lock.current).toBe("call-1");
  expect(await settleDecision(lock, "call-1", async () => true)).toBe("busy");

  continueRequest();
  expect(await pending).toBe("released");
  expect(lock.current).toBeNull();
  expect(await settleDecision(lock, "call-1", async () => true)).toBe("released");
});

it("clears the approval lock on reconnect and reloads a pending approval", () => {
  const lock: DecisionLock = { current: "call-1" };
  stopDecision(lock);
  expect(lock.current).toBeNull();

  const local = [activity("call-1", "approval")];
  const remote = [activity("call-1", "approval")];
  remote[0] = { ...remote[0], summary: "Invite team@example.com to Planning meeting" };
  expect(activitiesAfterReconnect(local, remote)).toEqual(remote);
  expect(activitiesAfterReconnect(local, remote).some((item) => item.state === "approval")).toBe(
    true,
  );
  expect(activitiesAfterReconnect(local, [])).toEqual(local);
});

it("clears the approval lock when the decision request fails", async () => {
  const lock: DecisionLock = { current: null };
  expect(await settleDecision(lock, "call-1", async () => false)).toBe("released");
  expect(lock.current).toBeNull();
  expect(await settleDecision(lock, "call-2", async () => true)).toBe("released");
});

it("clears the approval lock when the decision request throws", async () => {
  const lock: DecisionLock = { current: null };
  await expect(
    settleDecision(lock, "call-1", async () => {
      throw new Error("network down");
    }),
  ).rejects.toThrow("network down");
  expect(lock.current).toBeNull();
  expect(await settleDecision(lock, "call-2", async () => true)).toBe("released");
});

it("clears a held approval lock on stop", async () => {
  const lock: DecisionLock = { current: "call-1" };
  stopDecision(lock);
  expect(lock.current).toBeNull();
  expect(await settleDecision(lock, "call-2", async () => true)).toBe("released");
  releaseDecision(lock, "call-2");
  expect(lock.current).toBeNull();
});
