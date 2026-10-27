import { readFileSync } from "node:fs";
import { afterEach, expect, it } from "vitest";
import { DELETE, PATCH } from "../app/api/memories/[id]/route";
import { GET } from "../app/api/memories/route";
import { DEFAULT_AGENT_ID } from "../src/agent";
import { resetAppContext, setAppContext } from "../src/context";
import { MIGRATIONS } from "../src/db/migrations";
import { MockProvider } from "../src/llm";
import {
  factCount,
  filterMemories,
  forgetCopy,
  forgetDecision,
  inferenceHidden,
  memoriesToJson,
  memoriesToMarkdown,
  nextForgetPhase,
  SEARCH_DEBOUNCE_MS,
  sourceLabel,
  splitHighlight,
  UNDO_MS,
} from "../src/memory/panel-logic";
import { hiddenUntil } from "../src/memory/panel-logic";
import panelTokens from "../src/memory/tokens.memory-panel.json";
import { ConversationStore } from "../src/store";
import type { Memory } from "../src/types";

const stores: ConversationStore[] = [];

afterEach(async () => {
  await resetAppContext();
  await Promise.all(stores.splice(0).map((store) => store.close()));
});

async function openStore(): Promise<ConversationStore> {
  const store = await ConversationStore.open();
  stores.push(store);
  return store;
}

it("keeps migration 014 after 009 and leaves 010-013 and tool status checks alone", () => {
  const ids = MIGRATIONS.map((migration) => migration.id);
  expect(ids.at(-1)).toBe("014_memory_panel");
  expect(ids.filter((id) => /^01[0-3]_/.test(id))).toEqual([]);
  expect(ids.indexOf("009_one_thread_per_agent")).toBeLessThan(ids.indexOf("014_memory_panel"));
  expect(ids.indexOf("003_tool_trace")).toBeGreaterThan(-1);
  const trace = MIGRATIONS.find((migration) => migration.id === "003_tool_trace");
  expect(trace?.sql).toContain(
    "status TEXT NOT NULL CHECK (status IN ('running', 'approval', 'done', 'denied', 'error'))",
  );
  const panel = MIGRATIONS.find((migration) => migration.id === "014_memory_panel");
  expect(panel?.sql).not.toContain("tool_calls");
});

it("forgets a shared fact from every agent and leaves other scopes", async () => {
  const store = await openStore();
  const first = await store.memories.write({
    agentId: "agent-a",
    key: "repo",
    content: "github.com/siddhak711/mockbot",
    kind: "shared",
    createdBy: "user",
    fromAgent: "PM",
    origin: "agent",
  });
  await store.memories.write({
    agentId: "agent-b",
    key: "repo",
    content: "github.com/siddhak711/mockbot",
    kind: "shared",
    createdBy: "user",
    fromAgent: "Builder",
    origin: "agent",
  });
  await store.memories.write({
    agentId: "agent-b",
    key: "name",
    content: "Ada",
    kind: "profile",
    createdBy: "user",
  });
  await store.memories.write({
    agentId: "agent-a",
    key: "note",
    content: "keep",
    kind: "shared",
    createdBy: "user",
  });

  const removed = await store.memories.forgetShared(first.memory.id);
  expect(removed.map((memory) => memory.agentId).sort()).toEqual(["agent-a", "agent-b"]);
  expect(await store.memories.listLive("agent-a")).toEqual([
    expect.objectContaining({ key: "note", kind: "shared" }),
  ]);
  expect(await store.memories.listLive("agent-b")).toEqual([
    expect.objectContaining({ key: "note", kind: "shared" }),
    expect.objectContaining({ key: "name", kind: "profile" }),
  ]);
  expect(forgetCopy(first.memory.content, true)).toContain("every agent");
  expect(forgetCopy("blue", false)).toContain("this agent");
});

it("keeps the journal read-only", async () => {
  const store = await openStore();
  await store.memories.write({
    agentId: DEFAULT_AGENT_ID,
    key: "oct-26",
    content: "Started memory panel design",
    kind: "journal",
    createdBy: "user",
  });
  expect(await store.memories.softDeleteByKey(DEFAULT_AGENT_ID, "oct-26")).toBeNull();
  expect(
    await store.memories.update({
      agentId: DEFAULT_AGENT_ID,
      key: "oct-26",
      content: "changed",
      createdBy: "user",
    }),
  ).toBeNull();
  const live = await store.memories.listLive(DEFAULT_AGENT_ID);
  expect(live.map((memory) => memory.content)).toEqual(["Started memory panel design"]);
  expect(forgetDecision("journal", false)).toBe("blocked");
  expect(forgetDecision("journal", true)).toBe("blocked");
});

it("queues inferred facts until approval and hides a dismissal for 30 days", async () => {
  const store = await openStore();
  const now = new Date("2026-01-01T00:00:00.000Z");
  const proposed = await store.memories.propose({
    agentId: DEFAULT_AGENT_ID,
    kind: "profile",
    key: "city",
    content: "Lives in New York",
    signal: "calendar",
    evidence: "Calendar event in New York",
    now,
  });
  expect(proposed.ok).toBe(true);
  if (!proposed.ok) return;
  expect(await store.memories.listLive(DEFAULT_AGENT_ID)).toEqual([]);
  expect(await store.memories.listProposals(DEFAULT_AGENT_ID)).toHaveLength(1);

  const approved = await store.memories.approveProposal(DEFAULT_AGENT_ID, proposed.proposal.id);
  expect(approved.ok).toBe(true);
  if (!approved.ok) return;
  expect(approved.memory.origin).toBe("inferred");
  expect(approved.memory.signal).toBe("calendar");
  expect(approved.memory.evidence).toBe("Calendar event in New York");
  expect(await store.memories.listProposals(DEFAULT_AGENT_ID)).toEqual([]);
  expect(sourceLabel(approved.memory)).toBe("Inferred · calendar");

  const second = await store.memories.propose({
    agentId: DEFAULT_AGENT_ID,
    kind: "profile",
    key: "hours",
    content: "Works mostly 9pm-1am",
    signal: "chat activity",
    now,
  });
  expect(second.ok).toBe(true);
  if (!second.ok) return;
  const dismissed = await store.memories.dismissProposal(DEFAULT_AGENT_ID, second.proposal.id, now);
  expect(dismissed.ok).toBe(true);
  if (!dismissed.ok) return;
  expect(inferenceHidden(dismissed.hiddenUntil, new Date(now.getTime() + 10 * 86_400_000))).toBe(
    true,
  );
  expect(dismissed.hiddenUntil).toBe(hiddenUntil(now).toISOString());
  const hidden = await store.memories.propose({
    agentId: DEFAULT_AGENT_ID,
    kind: "profile",
    key: "hours",
    content: "Works mostly 9pm-1am",
    signal: "chat activity",
    now: new Date(now.getTime() + 10 * 86_400_000),
  });
  expect(hidden).toEqual({ ok: false, reason: "hidden" });
  const later = await store.memories.propose({
    agentId: DEFAULT_AGENT_ID,
    kind: "profile",
    key: "hours",
    content: "Works mostly 9pm-1am",
    signal: "chat activity",
    now: new Date(now.getTime() + 31 * 86_400_000),
  });
  expect(later.ok).toBe(true);
});

it("edits a fact to You said · edited and searches across scopes", async () => {
  const store = await openStore();
  setAppContext({ store, provider: new MockProvider({ delayMs: 0 }) });
  const written = await store.memories.write({
    agentId: DEFAULT_AGENT_ID,
    key: "prefers",
    content: "Ultra-concise replies",
    kind: "profile",
    createdBy: "user",
  });
  const params = { params: Promise.resolve({ id: written.memory.id }) };
  const edited = await PATCH(
    new Request(`http://localhost/api/memories/${written.memory.id}?agentId=${DEFAULT_AGENT_ID}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "Ultra-concise replies, visuals first" }),
    }),
    params,
  );
  expect(edited.status).toBe(200);
  const body = (await edited.json()) as { memory: Memory };
  expect(sourceLabel(body.memory)).toBe("You said · edited");
  const listed = (await (
    await GET(new Request(`http://localhost/api/memories?agentId=${DEFAULT_AGENT_ID}`))
  ).json()) as {
    memories: Memory[];
  };
  expect(listed.memories.map((memory) => memory.content)).toEqual([
    "Ultra-concise replies, visuals first",
  ]);
  const matches = filterMemories(listed.memories, "profile", "visuals");
  expect(matches).toHaveLength(1);
  expect(splitHighlight("visuals first", "visuals").some((part) => part.match)).toBe(true);
  expect(SEARCH_DEBOUNCE_MS).toBe(120);
});

it("confirms every forget, skips the dialog on shift, and commits when the undo window ends", () => {
  expect(forgetDecision("profile", false)).toBe("confirm");
  expect(forgetDecision("profile", true)).toBe("pending");
  expect(nextForgetPhase("idle", "request")).toBe("confirm");
  expect(nextForgetPhase("confirm", "confirm")).toBe("pending");
  expect(nextForgetPhase("confirm", "cancel")).toBe("idle");
  expect(nextForgetPhase("pending", "undo")).toBe("undone");
  expect(nextForgetPhase("pending", "expire")).toBe("committed");
  expect(nextForgetPhase("committed", "undo")).toBe("committed");
  expect(UNDO_MS).toBe(10_000);
});

it("exports memory without touching the global token file", () => {
  const memory = {
    id: "1",
    agentId: DEFAULT_AGENT_ID,
    kind: "profile" as const,
    key: "Name",
    content: "Siddha Kanthi",
    sourceMessageId: null,
    sourceSnippet: null,
    supersedes: null,
    validFrom: "2026-10-12T15:00:00.000Z",
    validTo: null,
    deletedAt: null,
    createdBy: "user",
    origin: "you_said" as const,
    history: [],
  };
  expect(memoriesToJson([memory])).toContain("Siddha Kanthi");
  expect(memoriesToMarkdown([memory])).toContain("**Name**: Siddha Kanthi");
  expect(factCount([memory, { kind: "journal" }])).toBe(1);

  const globalTokens = JSON.parse(readFileSync("docs/design/tokens.json", "utf8")) as {
    color: { light: Record<string, string>; dark: Record<string, string> };
  };
  expect(globalTokens.color.light["ink-2"]).toBe("#676767");
  expect(globalTokens.color.light.muted).toBe("#878787");
  expect(globalTokens.color.light["accent-text"]).toBeUndefined();
  expect(globalTokens.color.dark["accent-on-ink"]).toBeUndefined();
  expect(panelTokens.color.light["ink-2"]).toBe("#505050");
  expect(panelTokens.color.light["accent-text"]).toBe("#B63900");
  expect(panelTokens.color.dark["accent-text"]).toBe("#FF5405");
  expect(panelTokens.color.dark.danger).toBe("#E56588");

  for (const theme of ["light", "dark"] as const) {
    const colors = panelTokens.color[theme];
    const texts = [
      "ink",
      "ink-2",
      "muted",
      "link",
      "accent-text",
      "success",
      "danger",
      "warn",
    ] as const;
    const backgrounds = ["window", "sidebar", "surface", "selected", "hover"] as const;
    for (const text of texts) {
      for (const background of backgrounds) {
        expect(contrast(colors[text], colors[background])).toBeGreaterThanOrEqual(4.5);
      }
    }
    expect(contrast(colors["on-danger"], colors.danger)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(colors.window, colors.ink)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(colors["accent-on-ink"], colors.ink)).toBeGreaterThanOrEqual(4.5);
  }
});

it("refuses journal changes and shared deletes over HTTP", async () => {
  const store = await openStore();
  setAppContext({ store, provider: new MockProvider({ delayMs: 0 }) });
  const journal = await store.memories.write({
    agentId: DEFAULT_AGENT_ID,
    key: "day",
    content: "Crown made floating",
    kind: "journal",
    createdBy: "user",
  });
  const params = { params: Promise.resolve({ id: journal.memory.id }) };
  const patched = await PATCH(
    new Request("http://localhost/api/memories/" + journal.memory.id, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "nope" }),
    }),
    params,
  );
  expect(patched.status).toBe(409);
  const removed = await DELETE(
    new Request("http://localhost/api/memories/" + journal.memory.id),
    params,
  );
  expect(removed.status).toBe(409);
  expect(await store.memories.listLive(DEFAULT_AGENT_ID)).toHaveLength(1);
});

type RGB = [number, number, number];

function parseColor(input: string): { rgb: RGB; alpha: number } {
  if (input.startsWith("#")) {
    const hex = input.slice(1);
    return {
      rgb: [
        Number.parseInt(hex.slice(0, 2), 16),
        Number.parseInt(hex.slice(2, 4), 16),
        Number.parseInt(hex.slice(4, 6), 16),
      ],
      alpha: 1,
    };
  }
  const match = input.match(/rgba?\(([^)]+)\)/i);
  if (!match?.[1]) throw new Error(`Unparsed color ${input}`);
  const parts = match[1].split(",").map((part) => part.trim());
  return {
    rgb: [Number(parts[0]), Number(parts[1]), Number(parts[2])],
    alpha: parts[3] === undefined ? 1 : Number(parts[3]),
  };
}

function composite(foreground: string, background: string): RGB {
  const fg = parseColor(foreground);
  const bg = parseColor(background);
  const alpha = fg.alpha;
  return [
    fg.rgb[0] * alpha + bg.rgb[0] * (1 - alpha),
    fg.rgb[1] * alpha + bg.rgb[1] * (1 - alpha),
    fg.rgb[2] * alpha + bg.rgb[2] * (1 - alpha),
  ];
}

function channel(value: number): number {
  const unit = value / 255;
  return unit <= 0.04045 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
}

function luminance(rgb: RGB): number {
  return 0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2]);
}

function contrast(foreground: string, background: string): number {
  const fg = luminance(composite(foreground, background));
  const bg = luminance(composite(background, background));
  const lighter = Math.max(fg, bg);
  const darker = Math.min(fg, bg);
  return (lighter + 0.05) / (darker + 0.05);
}
