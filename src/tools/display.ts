import type { StoredToolCall } from "../types";

export type ToolActivityState = StoredToolCall["status"];

export type ToolActivityKind = "search" | "read" | "draft" | "generic";

export type ToolActivity = {
  id: string;
  messageId: string;
  name: string;
  title: string;
  detail: string;
  arguments: string;
  output: string;
  preview: string;
  summary: string;
  state: ToolActivityState;
  kind: ToolActivityKind;
};

export function parseToolArgs(raw: string): Record<string, unknown> | null {
  if (!raw.trim()) return null;
  try {
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    return value as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function previewText(output: string, max = 160): string {
  const one = output.replace(/\s+/g, " ").trim();
  if (one.length <= max) return one;
  return `${one.slice(0, max - 1)}…`;
}

export function formatToolPayload(raw: string): string {
  if (!raw.trim()) return "";
  try {
    return JSON.stringify(JSON.parse(raw) as unknown, null, 2);
  } catch {
    return raw;
  }
}

export const BLOCKED_MEMORY_OUTPUT = "Blocked. A secret was not stored.";

export function toolKind(name: string, args: Record<string, unknown> | null): ToolActivityKind {
  if (name === "web_search" || name === "tool_search" || name === "memory_search") return "search";
  if (name === "web_fetch" || name === "github") return "read";
  if (name === "memory_write" || name === "memory_update" || name === "memory_delete")
    return "draft";
  if (name === "google_calendar") return args?.action === "list" ? "read" : "draft";
  return "generic";
}

export function toolTitle(name: string, args: Record<string, unknown> | null): string {
  if (name === "tool_search") return "Searched tools";
  if (name === "web_search") return "Searched the web";
  if (name === "web_fetch") return "Fetched a page";
  if (name === "github") {
    const action = typeof args?.action === "string" ? args.action : "";
    if (action === "get_file") return "Read a GitHub file";
    if (action.includes("pull")) return "Read GitHub pull requests";
    return "Read GitHub";
  }
  if (name === "google_calendar") {
    return args?.action === "create" ? "Create a calendar event" : "Checked the calendar";
  }
  if (name === "memory_search") return "Searching memory";
  if (name === "memory_write") return "Saving a memory";
  if (name === "memory_update") return "Updating a memory";
  if (name === "memory_delete") return "Forgetting a memory";
  if (name === "write")
    return typeof args?.path === "string" ? `Write ${args.path}` : "Write a file";
  if (name === "read") return typeof args?.path === "string" ? `Read ${args.path}` : "Read a file";
  if (name === "list") return "List sandbox files";
  if (name === "exec") return typeof args?.command === "string" ? args.command : "Run a command";
  return name.replaceAll("_", " ");
}

export function toolDetail(name: string, args: Record<string, unknown> | null): string {
  if (!args) return "";
  if (name === "tool_search" || name === "web_search") {
    return typeof args.query === "string" ? args.query : "";
  }
  if (name === "web_fetch") return typeof args.url === "string" ? args.url : "";
  if (name === "github") {
    const repo = [args.owner, args.repo].filter((part) => typeof part === "string").join("/");
    if (typeof args.path === "string" && args.path) return `${repo}/${args.path}`;
    if (typeof args.number === "number") return `${repo}#${args.number}`;
    return repo;
  }
  if (name === "exec") return typeof args.command === "string" ? args.command : "";
  if (name === "write" || name === "read" || name === "list") {
    return typeof args.path === "string" ? args.path : "";
  }
  if (name === "google_calendar") {
    if (args.action === "create") {
      const summary = typeof args.summary === "string" ? args.summary : "New event";
      const attendees = Array.isArray(args.attendees) ? args.attendees.map(String).join(", ") : "";
      return attendees ? `${summary} · invite ${attendees}` : summary;
    }
    return "Primary calendar";
  }
  if (name.startsWith("memory_")) {
    if (typeof args.query === "string") return args.query;
    if (typeof args.key === "string") return args.key;
  }
  if (typeof args.message === "string" && args.message) return args.message;
  const first = Object.values(args).find((value) => typeof value === "string");
  return typeof first === "string" ? first : "";
}

export function approvalSummary(name: string, args: Record<string, unknown> | null): string {
  if (name === "memory_delete") {
    const key = typeof args?.key === "string" && args.key.trim() ? args.key.trim() : "this memory";
    return `Forget “${key}”? This removes it from later chats.`;
  }
  if (name === "google_calendar" && args?.action === "create") {
    const attendees = Array.isArray(args.attendees) ? args.attendees.map(String) : [];
    const summary =
      typeof args.summary === "string" && args.summary.trim() ? args.summary.trim() : "an event";
    if (attendees.length > 0) return `Invite ${attendees.join(", ")} to “${summary}”?`;
  }
  const action = typeof args?.action === "string" ? args.action : "run";
  return `Allow ${name} to ${action}? This can send, post, delete, or pay.`;
}

export function activityTitle(
  name: string,
  phase: "running" | "done",
  isError: boolean,
  blockedWrite: boolean,
): string {
  if (blockedWrite) return "Memory write blocked";
  const label =
    name === "memory_search"
      ? "Searching memory"
      : name === "memory_delete"
        ? "Forgetting a memory"
        : name === "memory_update"
          ? "Updating a memory"
          : name === "memory_write"
            ? "Saving a memory"
            : name;
  if (phase === "running" || !isError) return label;
  if (name === "memory_delete") return "Could not forget that memory";
  if (name === "memory_search") return "Memory search failed";
  if (name === "memory_update") return "Could not update that memory";
  if (name === "memory_write") return "Could not save that memory";
  return `${name} failed`;
}

export function describeTool(
  name: string,
  raw: string,
): Pick<ToolActivity, "title" | "detail" | "summary" | "kind"> {
  const args = parseToolArgs(raw);
  return {
    title: toolTitle(name, args),
    detail: toolDetail(name, args),
    summary: approvalSummary(name, args),
    kind: toolKind(name, args),
  };
}

export function toToolActivity(tool: StoredToolCall): ToolActivity {
  const described = describeTool(tool.name, tool.arguments);
  const output = tool.output ?? "";
  const blocked = tool.name === "memory_write" && output === BLOCKED_MEMORY_OUTPUT;
  const title = tool.name.startsWith("memory_")
    ? activityTitle(tool.name, "done", tool.status === "error", blocked)
    : described.title;
  return {
    id: tool.id,
    messageId: tool.messageId,
    name: tool.name,
    arguments: tool.arguments,
    output,
    preview: output ? previewText(output) : "",
    state: tool.status,
    ...described,
    title,
  };
}

export function activitiesFromMessages(
  messages: Array<{ tools?: StoredToolCall[] }>,
): ToolActivity[] {
  return messages.flatMap((message) => (message.tools ?? []).map((tool) => toToolActivity(tool)));
}

export const STOPPED_TOOL_OUTPUT = "Stopped before the tool ran.";

export function activitiesAfterStop(activities: ToolActivity[]): ToolActivity[] {
  return activities.map((activity) =>
    activity.state === "approval"
      ? {
          ...activity,
          state: "error",
          output: STOPPED_TOOL_OUTPUT,
          preview: previewText(STOPPED_TOOL_OUTPUT),
        }
      : activity,
  );
}

export function activitiesAfterReconnect(
  local: ToolActivity[],
  remote: ToolActivity[],
): ToolActivity[] {
  if (remote.length === 0) return local;
  return remote.map((item) => {
    const previous = local.find((entry) => entry.id === item.id);
    if (
      previous &&
      item.state === "approval" &&
      previous.state !== "approval" &&
      previous.output === STOPPED_TOOL_OUTPUT
    ) {
      return previous;
    }
    return item;
  });
}
