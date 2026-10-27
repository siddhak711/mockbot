// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { RunTimeline } from "../components/run-timeline";
import type { RunEvent } from "../src/runs/events";

afterEach(() => {
  cleanup();
});

const events: RunEvent[] = [
  {
    runId: "run_1",
    seq: 1,
    type: "event",
    input: JSON.stringify({ name: "run.started" }),
    output: JSON.stringify({ conversationId: "c1" }),
    tokens: null,
    costUsd: null,
    ms: null,
  },
  {
    runId: "run_1",
    seq: 2,
    type: "model",
    input: JSON.stringify({ model: "gpt-4o-mini", messages: [] }),
    output: JSON.stringify({
      text: "",
      reasoning: "",
      toolCalls: [{ id: "call_1", name: "web_search", arguments: "{}" }],
    }),
    tokens: 20,
    costUsd: 0.000004,
    ms: 40,
  },
  {
    runId: "run_1",
    seq: 3,
    type: "tool",
    input: JSON.stringify({ name: "web_search", arguments: { query: "mockbot" } }),
    output: "Mock results for mockbot",
    tokens: 8,
    costUsd: 0,
    ms: 5,
  },
  {
    runId: "run_1",
    seq: 4,
    type: "model",
    input: JSON.stringify({ model: "gpt-4o-mini", messages: [] }),
    output: JSON.stringify({ text: "Done.", reasoning: "", toolCalls: [] }),
    tokens: 12,
    costUsd: 0.000002,
    ms: 15,
  },
];

it("renders collapsed rows and run totals, then expands the full input and output", () => {
  render(<RunTimeline runId="run_1" events={events} />);

  expect(screen.getByTestId("run-total-tokens").textContent).toBe("40");
  expect(screen.getByTestId("run-total-cost").textContent).toBe("$0.000006");
  expect(screen.getByTestId("run-total-time").textContent).toBe("60 ms");

  const rows = document.querySelectorAll(".run-event");
  expect(Array.from(rows, (row) => row.getAttribute("data-type"))).toEqual([
    "event",
    "model",
    "tool",
    "model",
  ]);
  expect(rows[0]?.hasAttribute("open")).toBe(false);
  expect(screen.getByText("web_search · Mock results for mockbot")).toBeTruthy();
  expect(screen.getByText("20 tok")).toBeTruthy();

  const tool = rows[2] as HTMLDetailsElement;
  fireEvent.click(tool.querySelector("summary")!);
  expect(tool.open).toBe(true);
  expect(tool.textContent).toContain("Mock results for mockbot");
  expect(tool.textContent).toContain('"query":"mockbot"');
});

it("renders an empty timeline when a run has no events", () => {
  render(<RunTimeline runId="run_pending" events={[]} />);
  expect(screen.getByText("No events recorded yet.")).toBeTruthy();
  expect(document.querySelectorAll(".run-event")).toHaveLength(0);
  expect(screen.getByTestId("run-total-tokens").textContent).toBe("0");
});
