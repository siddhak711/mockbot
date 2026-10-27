import type { Memory, MemoryKind, MemoryOrigin, MemoryProposal } from "../types";

export const SEARCH_DEBOUNCE_MS = 120;
export const UNDO_MS = 10_000;
export const SKELETON_DELAY_MS = 150;
export const FLASH_MS = 600;
export const DISMISS_HIDE_MS = 30 * 24 * 60 * 60 * 1000;
export const PANE_BREAKPOINT = 1100;

export type ScopeTab = "all" | "profile" | "journal" | "shared" | "chat";

export type MemoryScope = "profile" | "journal" | "shared" | "chat";

export const SCOPE_TABS: readonly { id: ScopeTab; label: string }[] = [
  { id: "all", label: "All" },
  { id: "profile", label: "Profile" },
  { id: "journal", label: "Journal" },
  { id: "shared", label: "Shared" },
  { id: "chat", label: "Chat" },
];

export const ADD_SCOPES: readonly { id: Exclude<MemoryScope, "journal">; label: string }[] = [
  { id: "profile", label: "Profile" },
  { id: "shared", label: "Shared" },
  { id: "chat", label: "Chat" },
];

export function memoryScope(kind: MemoryKind): MemoryScope {
  if (kind === "profile") return "profile";
  if (kind === "journal") return "journal";
  if (kind === "shared") return "shared";
  return "chat";
}

export function isJournal(kind: MemoryKind): boolean {
  return kind === "journal";
}

export function canEditMemory(kind: MemoryKind): boolean {
  return kind !== "journal";
}

export function canForgetMemory(kind: MemoryKind): boolean {
  return kind !== "journal";
}

export type ForgetDecision = "blocked" | "confirm" | "pending";

/** Every forget confirms. Shift+click skips the dialog and still queues the undo toast. */
export function forgetDecision(kind: MemoryKind, shiftKey: boolean): ForgetDecision {
  if (!canForgetMemory(kind)) return "blocked";
  return shiftKey ? "pending" : "confirm";
}

export type ForgetPhase = "idle" | "confirm" | "pending" | "committed" | "undone";

export function nextForgetPhase(
  phase: ForgetPhase,
  action: "request" | "shift" | "confirm" | "cancel" | "undo" | "expire",
): ForgetPhase {
  if (action === "request" && phase === "idle") return "confirm";
  if (action === "shift" && (phase === "idle" || phase === "confirm")) return "pending";
  if (action === "confirm" && phase === "confirm") return "pending";
  if (action === "cancel" && phase === "confirm") return "idle";
  if ((action === "undo" || action === "expire") && phase !== "pending") return phase;
  if (action === "undo" && phase === "pending") return "undone";
  if (action === "expire" && phase === "pending") return "committed";
  return phase;
}

export function forgetCopy(value: string, shared: boolean): string {
  return shared
    ? `"${value}" will be removed from every agent.`
    : `"${value}" will be removed from this agent.`;
}

export function inferenceFingerprint(input: {
  kind: string;
  key: string;
  signal: string;
  content: string;
}): string {
  return [
    input.kind,
    input.key.trim().toLowerCase(),
    input.signal.trim().toLowerCase(),
    input.content.trim().toLowerCase(),
  ].join("\u001f");
}

export function hiddenUntil(from: Date): Date {
  return new Date(from.getTime() + DISMISS_HIDE_MS);
}

export function inferenceHidden(untilIso: string, now: Date): boolean {
  return new Date(untilIso).getTime() > now.getTime();
}

export function sourceLabel(memory: {
  kind: MemoryKind;
  origin?: MemoryOrigin | null;
  signal?: string | null;
  edited?: boolean;
  fromAgent?: string | null;
}): string {
  if (memory.edited) return "You said · edited";
  if (memory.origin === "inferred") {
    return memory.signal ? `Inferred · ${memory.signal}` : "Inferred";
  }
  if (memory.kind === "shared" || memory.origin === "agent") {
    return memory.fromAgent ? `From ${memory.fromAgent}` : "From another agent";
  }
  if (memory.kind === "chat" || memory.origin === "chat") return "This chat";
  return "You said";
}

export function formatMemoryWhen(iso: string, now = new Date()): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const start = (value: Date) =>
    new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
  const day = start(date);
  const today = start(now);
  if (day === today) return "Today";
  if (day === today - 86_400_000) return "Yesterday";
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function formatMemoryTooltip(iso: string, timeZone?: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString("en-US", {
    timeZone: timeZone || undefined,
    dateStyle: "medium",
    timeStyle: "short",
  });
}

export function journalDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export type HighlightPart = { text: string; match: boolean };

export function splitHighlight(text: string, query: string): HighlightPart[] {
  const needle = query.trim();
  if (!needle) return [{ text, match: false }];
  const lower = text.toLowerCase();
  const target = needle.toLowerCase();
  const parts: HighlightPart[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    const found = lower.indexOf(target, cursor);
    if (found < 0) {
      parts.push({ text: text.slice(cursor), match: false });
      break;
    }
    if (found > cursor) parts.push({ text: text.slice(cursor, found), match: false });
    parts.push({ text: text.slice(found, found + target.length), match: true });
    cursor = found + target.length;
  }
  return parts.filter((part) => part.text.length > 0);
}

export function memoryMatchesQuery(
  memory: { key: string; content: string },
  query: string,
): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return `${memory.key} ${memory.content}`.toLowerCase().includes(needle);
}

export function filterMemories<T extends { key: string; content: string; kind: MemoryKind }>(
  memories: readonly T[],
  tab: ScopeTab,
  query: string,
): T[] {
  const searching = query.trim().length > 0;
  return memories.filter((memory) => {
    if (!memoryMatchesQuery(memory, query)) return false;
    if (searching) return true;
    if (tab === "all") return true;
    return memoryScope(memory.kind) === tab;
  });
}

export function groupLabel(scope: MemoryScope): string {
  if (scope === "chat") return "This chat";
  if (scope === "journal") return "Journal";
  if (scope === "shared") return "Shared";
  return "Profile";
}

export const GROUP_ORDER: readonly MemoryScope[] = ["profile", "shared", "chat", "journal"];

export function factCount(memories: readonly { kind: MemoryKind }[]): number {
  return memories.filter((memory) => memory.kind !== "journal").length;
}

export function factCountLabel(count: number): string {
  return count === 1 ? "1 fact" : `${count} facts`;
}

export type MemoryExportRow = {
  id: string;
  scope: MemoryScope;
  key: string;
  content: string;
  source: string;
  validFrom: string;
};

export function exportRows(memories: readonly Memory[]): MemoryExportRow[] {
  return memories.map((memory) => ({
    id: memory.id,
    scope: memoryScope(memory.kind),
    key: memory.key,
    content: memory.content,
    source: sourceLabel(memory),
    validFrom: memory.validFrom,
  }));
}

export function memoriesToJson(
  memories: readonly Memory[],
  exportedAt = new Date().toISOString(),
): string {
  return JSON.stringify({ exportedAt, memories: exportRows(memories) }, null, 2);
}

export function memoriesToMarkdown(memories: readonly Memory[]): string {
  const lines = ["# Memory", ""];
  for (const scope of GROUP_ORDER) {
    const rows = memories.filter((memory) => memoryScope(memory.kind) === scope);
    if (rows.length === 0) continue;
    lines.push(`## ${groupLabel(scope)}`, "");
    for (const memory of rows) {
      if (scope === "journal") {
        lines.push(`- ${journalDate(memory.validFrom)} — ${memory.content}`);
      } else {
        lines.push(`- **${memory.key}**: ${memory.content}`);
        lines.push(`  - ${sourceLabel(memory)} · ${formatMemoryWhen(memory.validFrom)}`);
      }
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd() + "\n";
}

export function sharedIds(memories: readonly Memory[], key: string): string[] {
  const needle = key.toLowerCase();
  return memories
    .filter((memory) => memory.kind === "shared" && memory.key.toLowerCase() === needle)
    .map((memory) => memory.id);
}

export function proposalKind(kind: string): MemoryProposal["kind"] | null {
  if (kind === "profile" || kind === "fact" || kind === "shared" || kind === "chat") return kind;
  return null;
}

export function addKind(scope: Exclude<MemoryScope, "journal">): MemoryKind {
  return scope;
}

export function originForAdd(scope: Exclude<MemoryScope, "journal">): MemoryOrigin {
  if (scope === "shared") return "agent";
  if (scope === "chat") return "chat";
  return "you_said";
}
