// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ToolActivityCards } from "../components/tool-activity";
import type { ToolActivity } from "../src/tools/display";

afterEach(() => {
  cleanup();
});

function askActivity(allowCustom: boolean): ToolActivity {
  return {
    id: "call-1",
    messageId: "message-1",
    name: "ask_user",
    title: "Which color?",
    detail: "Blue · Red",
    arguments: JSON.stringify({
      question: "Which color?",
      options: ["Blue", "Red"],
      allowCustom,
    }),
    output: "",
    preview: "",
    summary: "Which color?",
    state: "ask",
    kind: "generic",
  };
}

it("renders one button per option and a text field when custom answers are allowed", () => {
  const onAnswer = vi.fn();
  render(<ToolActivityCards activities={[askActivity(true)]} onAnswer={onAnswer} />);
  expect(screen.getByText("Which color?")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Blue" }));
  expect(onAnswer).toHaveBeenCalledWith("call-1", "Blue");
  fireEvent.change(screen.getByRole("textbox", { name: "Your answer" }), {
    target: { value: "Teal" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  expect(onAnswer).toHaveBeenCalledWith("call-1", "Teal");
});

it("hides the text field when custom answers are off", () => {
  render(<ToolActivityCards activities={[askActivity(false)]} onAnswer={vi.fn()} />);
  expect(screen.getByRole("button", { name: "Red" })).toBeTruthy();
  expect(screen.queryByRole("textbox", { name: "Your answer" })).toBeNull();
});
