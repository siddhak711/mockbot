import { describe, expect, it } from "vitest";
import { fetchComputerSnapshot } from "../src/sandbox/refresh";
import type { ComputerSnapshot } from "../src/sandbox/types";

function snapshot(path: string): ComputerSnapshot {
  return {
    provider: "mock",
    computer: {
      id: "computer",
      agentId: "agent",
      provider: "mock",
      createdAt: "2026-10-25T00:00:00.000Z",
    },
    files: [{ path, kind: "file" }],
    runs: [],
  };
}

describe("computer refresh", () => {
  it("ignores a computer snapshot that arrives after a newer request", async () => {
    const gate = { current: 0 };
    const first = ++gate.current;
    const second = ++gate.current;
    let releaseFirst: () => void = () => {};
    const firstHeld = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let calls = 0;
    const fetchImpl = async () => {
      const call = calls;
      calls += 1;
      if (call === 0) await firstHeld;
      const body = snapshot(call === 0 ? "stale.txt" : "fresh.txt");
      return Response.json(body);
    };

    const older = fetchComputerSnapshot(fetchImpl, first, () => gate.current);
    const newer = fetchComputerSnapshot(fetchImpl, second, () => gate.current);
    await expect(newer).resolves.toMatchObject({ files: [{ path: "fresh.txt" }] });
    releaseFirst();
    await expect(older).resolves.toBeUndefined();
  });
});
