import { expect, it } from "vitest";
import { ApprovalGate, requiresApproval } from "../src/tools/approval";
import { createDefaultTools } from "../src/tools/builtins";
import type { ToolDefinition } from "../src/tools/types";

function tool(partial: Partial<ToolDefinition> & Pick<ToolDefinition, "name">): ToolDefinition {
  return {
    description: partial.name,
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    async invoke() {
      return { content: "ok" };
    },
    ...partial,
  };
}

it("requires approval for send, post, delete, pay, and calendar invites", () => {
  const tools = createDefaultTools({});
  const calendar = tools.get("google_calendar")!;
  const search = tools.get("web_search")!;
  const github = tools.get("github")!;

  expect(requiresApproval(search, { query: "cats" })).toBe(false);
  expect(requiresApproval(github, { action: "list_issues", owner: "acme", repo: "app" })).toBe(
    false,
  );

  const list = calendar.prepare!({ action: "list" });
  expect("args" in list).toBe(true);
  if ("args" in list) expect(requiresApproval(calendar, list.args)).toBe(false);

  const privateEvent = calendar.prepare!({
    action: "create",
    summary: "Focus",
    start: "2026-10-25T15:00:00Z",
    end: "2026-10-25T15:30:00Z",
  });
  expect("args" in privateEvent).toBe(true);
  if ("args" in privateEvent) expect(requiresApproval(calendar, privateEvent.args)).toBe(false);

  const invite = calendar.prepare!({
    action: "create",
    summary: "Planning meeting",
    start: "2026-10-25T15:00:00Z",
    end: "2026-10-25T15:30:00Z",
    attendees: ["team@example.com"],
  });
  expect("args" in invite).toBe(true);
  if ("args" in invite) expect(requiresApproval(calendar, invite.args)).toBe(true);

  expect(requiresApproval(tool({ name: "send_email" }), {})).toBe(true);
  expect(requiresApproval(tool({ name: "notes", approval: "never" }), { action: "delete" })).toBe(
    true,
  );
  expect(requiresApproval(tool({ name: "billing", approval: "never" }), { action: "pay" })).toBe(
    true,
  );
  expect(requiresApproval(tool({ name: "notes", approval: "always" }), { action: "list" })).toBe(
    true,
  );
});

it("resolves an approval once and times out or stops when nobody decides", async () => {
  const gate = new ApprovalGate(30);
  const pending = gate.wait("call_1");
  expect(gate.decide("call_1", "approve")).toBe(true);
  await expect(pending).resolves.toEqual({ decision: "approve", reason: "user" });
  expect(gate.decide("call_1", "deny")).toBe(false);
  expect(gate.decide("missing", "deny")).toBe(false);

  const timedOut = new ApprovalGate(15);
  await expect(timedOut.wait("call_2")).resolves.toEqual({ decision: "deny", reason: "timeout" });

  const controller = new AbortController();
  const stopped = new ApprovalGate(5_000);
  const waiting = stopped.wait("call_3", controller.signal);
  controller.abort();
  await expect(waiting).resolves.toEqual({ decision: "deny", reason: "stopped" });

  const explicit = new ApprovalGate(5_000);
  const pendingStop = explicit.wait("call_4");
  expect(explicit.stop("call_4")).toBe(true);
  await expect(pendingStop).resolves.toEqual({ decision: "deny", reason: "stopped" });
  expect(explicit.stop("call_4")).toBe(false);
});
