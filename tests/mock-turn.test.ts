import { expect, it } from "vitest";
import { planMockTurn } from "../src/memory/mock-turn";
import type { LlmMessage } from "../src/types";

const tools = new Set(["memory_write", "memory_update", "memory_delete", "memory_search"]);

function afterTool(user: string, output: string): string {
  const messages: LlmMessage[] = [
    { role: "user", content: user },
    { role: "tool", tool_call_id: "call_1", content: output },
  ];
  const plan = planMockTurn(messages, tools);
  if (plan.type !== "text") throw new Error(`Expected closing text, got ${plan.type}`);
  return plan.text;
}

it("does not say a denied or failed memory delete was forgotten", () => {
  const denied = afterTool(
    "Forget that my favorite color is blue",
    "The user denied this action. Do not retry it unless they ask.",
  );
  expect(denied).not.toMatch(/forgot|forgotten/i);
  expect(denied).toMatch(/not approved/i);

  const failed = afterTool(
    "Delete the memory about favorite color",
    "memory_delete requires a key.",
  );
  expect(failed).not.toMatch(/forgot|forgotten/i);

  const missing = afterTool(
    "Forget that my favorite color is blue",
    "No memory with that key is stored for this agent.",
  );
  expect(missing).not.toMatch(/forgot|forgotten/i);
});

it("does not say a failed write or update was remembered", () => {
  const write = afterTool("Remember that my favorite color is blue", "Text is required.");
  expect(write).not.toMatch(/remember/i);

  const update = afterTool(
    "Update the memory favorite color to green",
    'No memory with that key is stored for this agent. Use memory_write to create "favorite color".',
  );
  expect(update).not.toMatch(/remember/i);
});

it("does not report a saved memory whose key or text contains secret as blocked", () => {
  const saved = afterTool(
    "Remember that the secret project is named aurora and is not stored in the other notebook",
    'Saved memory "secret project" (fact). Stored a new memory. The secret project is named aurora and is not stored in the other notebook.',
  );
  expect(saved).toContain("I'll remember that");
  expect(saved).not.toMatch(/blocked|not stored|looked like a secret/i);
});
