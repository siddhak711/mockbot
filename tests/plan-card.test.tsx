// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { Composer } from "../components/composer";
import { ToolActivityCards } from "../components/tool-activity";
import type { ToolActivity } from "../src/tools/display";
import type { PlanStep } from "../src/tools/plan";

afterEach(() => {
  cleanup();
});

function planActivity(steps: PlanStep[], state: ToolActivity["state"] = "plan"): ToolActivity {
  return {
    id: "plan-1",
    messageId: "message-1",
    name: "propose_plan",
    title: "Plan",
    detail: `${steps.length} steps`,
    arguments: JSON.stringify({ steps }),
    output: "",
    preview: "",
    summary: steps.map((step) => step.title).join(" · "),
    state,
    kind: "generic",
  };
}

const steps: PlanStep[] = [
  { title: "Search", detail: "Look it up", state: "pending" },
  { title: "Fetch", detail: "Open the page", state: "pending" },
  { title: "Summarize", detail: "Write the recap", state: "pending" },
];

it("approves, edits, and cancels a plan card", () => {
  const onPlan = vi.fn();
  const { rerender } = render(
    <ToolActivityCards activities={[planActivity(steps)]} onPlan={onPlan} />,
  );
  expect(screen.getByText("Search")).toBeTruthy();
  expect(screen.getAllByText("Pending")).toHaveLength(3);
  fireEvent.click(screen.getByRole("button", { name: "Approve" }));
  expect(onPlan).toHaveBeenCalledWith("plan-1", { type: "approve" });

  fireEvent.click(screen.getByRole("button", { name: "Edit" }));
  const editor = screen.getByRole("textbox", { name: "Plan steps" });
  fireEvent.change(editor, {
    target: { value: "Outline — List the points\nDraft — Write the note" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(onPlan).toHaveBeenCalledWith("plan-1", {
    type: "edit",
    steps: [
      { title: "Outline", detail: "List the points", state: "pending" },
      { title: "Draft", detail: "Write the note", state: "pending" },
    ],
  });

  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(onPlan).toHaveBeenCalledWith("plan-1", { type: "cancel" });

  rerender(
    <ToolActivityCards
      activities={[
        planActivity(
          [
            { title: "Search", detail: "Look it up", state: "done" },
            { title: "Fetch", detail: "Open the page", state: "active" },
            { title: "Summarize", detail: "Write the recap", state: "pending" },
          ],
          "running",
        ),
      ]}
      onPlan={onPlan}
    />,
  );
  expect(screen.getByText("Done")).toBeTruthy();
  expect(screen.getByText("In progress")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
});

it("sends the Plan switch with the message", () => {
  const onSend = vi.fn();
  render(<Composer streaming={false} onSend={onSend} onStop={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "Plan" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Message" }), {
    target: { value: "Hello" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  expect(onSend).toHaveBeenCalledWith("Hello", { plan: true });
});
