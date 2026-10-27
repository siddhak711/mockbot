import { expect, it } from "vitest";
import {
  estimatePlan,
  fallbackPlan,
  formatPlanText,
  parsePlan,
  parsePlanText,
  PlanGate,
} from "../src/tools/plan";

it("parses a plan and a free-text edit of its steps", () => {
  expect(parsePlan("{}")).toMatchObject({ ok: false });
  expect(
    parsePlan(
      JSON.stringify({
        steps: [
          { title: " Search ", detail: " Look it up " },
          { title: "Write", detail: "" },
        ],
      }),
    ),
  ).toMatchObject({
    ok: true,
    steps: [
      { title: "Search", detail: "Look it up", state: "pending" },
      { title: "Write", detail: "Write", state: "pending" },
    ],
  });
  expect(parsePlanText("Search — Look it up\nWrite the recap")).toMatchObject({
    ok: true,
    steps: [
      { title: "Search", detail: "Look it up" },
      { title: "Write the recap", detail: "Write the recap" },
    ],
  });
  const parsed = parsePlanText("Search — Look it up\nWrite the recap");
  if (!parsed.ok) throw new Error(parsed.error);
  expect(formatPlanText(parsed.steps)).toBe(
    "Search — Look it up\nWrite the recap — Write the recap",
  );
});

it("estimates a plan only when the task lists three or more steps", () => {
  expect(estimatePlan("Say hello")).toBeNull();
  expect(estimatePlan("1. One\n2. Two")).toBeNull();
  const estimated = estimatePlan(
    "1. Search — Look it up\n2. Fetch — Open it\n3. Summarize — Write it",
  );
  expect(estimated?.map((step) => step.title)).toEqual(["Search", "Fetch", "Summarize"]);
  expect(fallbackPlan("Say hello").map((step) => step.title)).toEqual([
    "Understand the request",
    "Do the work",
    "Report the result",
  ]);
});

it("keeps an edited plan pending until it is approved", async () => {
  const gate = new PlanGate();
  const waiting = gate.wait(
    "plan-1",
    [
      { title: "Search", detail: "Look it up", state: "pending" },
      { title: "Fetch", detail: "Open it", state: "pending" },
      { title: "Summarize", detail: "Write it", state: "pending" },
    ],
    "conversation-1",
    "message-1",
  );
  expect(gate.edit("plan-1", [{ title: "Draft", detail: "Write the note", state: "done" }])).toBe(
    "ok",
  );
  expect(gate.snapshot("plan-1")?.steps).toEqual([
    { title: "Draft", detail: "Write the note", state: "pending" },
  ]);
  expect(gate.approve("plan-1")).toBe("ok");
  await expect(waiting).resolves.toMatchObject({
    reason: "approved",
    steps: [{ title: "Draft", detail: "Write the note", state: "pending" }],
  });
  expect(gate.approve("plan-1")).toBe("missing");
});
