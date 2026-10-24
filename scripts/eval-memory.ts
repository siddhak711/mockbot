import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { streamChatTurn } from "../src/chat";
import { MockProvider, selectProvider, type LlmProvider } from "../src/llm";
import { ConversationStore } from "../src/store";
import { deltas, readSse } from "../tests/helpers";

const LONGMEM_URL =
  "https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_oracle.json";
const LONGMEM_SAMPLE = 50;
const CASE_PATH = new URL("../evals/mockbot-recall.json", import.meta.url);
const DATA_DIR = new URL("../evals/data/", import.meta.url);

type TeachTurn = {
  say: string;
  expectContains?: string;
  expectAbsent?: string[];
};

type RecallCase = {
  id: string;
  turns: TeachTurn[];
  ask: string;
  expectContains?: string;
  expectAbsent?: string[];
  savedContains?: string;
  liveAbsent?: string;
  mustNotStore?: string;
};

type LongMemTurn = { role?: string; content?: string; has_answer?: boolean };
type LongMemItem = {
  question_id: string;
  question_type?: string;
  question: string;
  answer: string;
  haystack_sessions?: LongMemTurn[][];
};

type CaseResult = {
  id: string;
  answerMiss: boolean;
  saveMiss: boolean;
  searchMiss: boolean;
  detail: string;
};

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

function flagValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function normalize(text: string): string {
  return text.toLowerCase();
}

function includesText(haystack: string, needle: string): boolean {
  return normalize(haystack).includes(normalize(needle));
}

function answerMatches(reply: string, expected: string): boolean {
  const haystack = normalize(reply).replace(/[^a-z0-9]+/g, " ");
  const needle = normalize(expected)
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  if (!needle) return false;
  if (haystack.includes(needle)) return true;
  const words = needle.split(/\s+/).filter((word) => word.length > 2);
  if (words.length === 0) return haystack.includes(needle);
  const hits = words.filter((word) => haystack.includes(word)).length;
  return hits / words.length >= 0.6;
}

async function ask(
  store: ConversationStore,
  provider: LlmProvider,
  message: string,
  conversationId?: string,
): Promise<{ text: string; conversationId: string }> {
  const response = await streamChatTurn({
    store,
    provider,
    message,
    conversationId,
  });
  const events = await readSse(response);
  const error = events.find((event) => event.event === "error");
  if (error) {
    const messageText = (error.data as { message?: string }).message ?? "request failed";
    throw new Error(messageText);
  }
  const meta = events.find((event) => event.event === "meta");
  const id = (meta?.data as { conversationId?: string } | undefined)?.conversationId;
  if (!id) throw new Error("Chat turn did not return a conversation id");
  return { text: deltas(events), conversationId: id };
}

async function runRecallCase(item: RecallCase, provider: LlmProvider): Promise<CaseResult> {
  const dir = join(tmpdir(), `mockbot-eval-${item.id}-${crypto.randomUUID()}`);
  const store = await ConversationStore.open(dir);
  const problems: string[] = [];
  try {
    let conversationId: string | undefined;
    for (const turn of item.turns) {
      const result = await ask(store, provider, turn.say, conversationId);
      conversationId = result.conversationId;
      if (turn.expectContains && !includesText(result.text, turn.expectContains)) {
        problems.push(`teach missed "${turn.expectContains}"`);
      }
      for (const absent of turn.expectAbsent ?? []) {
        if (includesText(result.text, absent)) problems.push(`teach leaked "${absent}"`);
      }
    }
    const answer = await ask(store, provider, item.ask);
    if (item.expectContains && !includesText(answer.text, item.expectContains)) {
      problems.push(`answer missed "${item.expectContains}"`);
    }
    for (const absent of item.expectAbsent ?? []) {
      if (includesText(answer.text, absent)) problems.push(`answer contained "${absent}"`);
    }
    const live = await store.memories.listLive("agent_default");
    const liveText = live.map((memory) => `${memory.key}\n${memory.content}`).join("\n");
    const stored = await store.memories.listForAgent("agent_default");
    const storedText = stored.map((memory) => memory.content).join("\n");
    let saveMiss = false;
    if (item.mustNotStore && includesText(storedText, item.mustNotStore)) {
      saveMiss = true;
      problems.push("secret was stored");
    }
    if (item.savedContains && !includesText(liveText, item.savedContains)) {
      saveMiss = true;
      problems.push(`live memory missed "${item.savedContains}"`);
    }
    if (item.liveAbsent && includesText(liveText, item.liveAbsent)) {
      saveMiss = true;
      problems.push(`live memory still has "${item.liveAbsent}"`);
    }
    const searchMiss = Boolean(
      item.savedContains &&
      item.expectContains &&
      includesText(liveText, item.savedContains) &&
      !includesText(answer.text, item.expectContains),
    );
    if (searchMiss) problems.push("saved fact was not recalled");
    return {
      id: item.id,
      answerMiss: problems.some((problem) => problem.startsWith("answer")),
      saveMiss,
      searchMiss,
      detail: problems.join("; "),
    };
  } finally {
    await store.close();
  }
}

function sampleItems<T>(items: T[], count: number, seed = 3): T[] {
  const copy = items.slice();
  let state = seed >>> 0;
  const next = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(next() * (index + 1));
    const current = copy[index];
    copy[index] = copy[swap] as T;
    copy[swap] = current as T;
  }
  return copy.slice(0, Math.min(count, copy.length));
}

function userTurns(item: LongMemItem): string[] {
  const sessions = item.haystack_sessions ?? [];
  const preferred: string[] = [];
  const rest: string[] = [];
  for (const session of sessions) {
    for (const turn of session) {
      if (turn.role !== "user" || !turn.content?.trim()) continue;
      if (turn.has_answer) preferred.push(turn.content.trim());
      else rest.push(turn.content.trim());
    }
  }
  return [...preferred, ...rest].slice(0, 8);
}

async function loadLongMemEval(limit: number): Promise<LongMemItem[]> {
  await mkdir(DATA_DIR, { recursive: true });
  const file = new URL("longmemeval_oracle.json", DATA_DIR);
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    process.stdout.write(`Downloading LongMemEval oracle to ${file.pathname}\n`);
    const response = await fetch(LONGMEM_URL);
    if (!response.ok) {
      throw new Error(`LongMemEval download failed (${response.status})`);
    }
    raw = await response.text();
    await writeFile(file, raw);
  }
  const parsed = JSON.parse(raw) as LongMemItem[];
  if (!Array.isArray(parsed)) throw new Error("LongMemEval file is not a JSON array");
  return sampleItems(parsed, limit);
}

async function runLongMemItem(
  item: LongMemItem,
  provider: LlmProvider,
): Promise<{ hit: boolean; baselineHit: boolean; saveMiss: boolean; searchMiss: boolean }> {
  const dir = join(tmpdir(), `mockbot-lme-${item.question_id}-${crypto.randomUUID()}`);
  const store = await ConversationStore.open(dir);
  const baselineDir = join(tmpdir(), `mockbot-lme-base-${item.question_id}-${crypto.randomUUID()}`);
  const baseline = await ConversationStore.open(baselineDir);
  try {
    let conversationId: string | undefined;
    for (const message of userTurns(item)) {
      const result = await ask(store, provider, message, conversationId);
      conversationId = result.conversationId;
    }
    const answer = await ask(store, provider, item.question);
    const baselineAnswer = await ask(baseline, provider, item.question);
    const live = await store.memories.listLive("agent_default");
    const liveText = live.map((memory) => memory.content).join("\n");
    const saved = answerMatches(liveText, item.answer);
    const hit = answerMatches(answer.text, item.answer);
    return {
      hit,
      baselineHit: answerMatches(baselineAnswer.text, item.answer),
      saveMiss: !saved,
      searchMiss: saved && !hit,
    };
  } finally {
    await store.close();
    await baseline.close();
  }
}

function rate(count: number, total: number): string {
  if (total === 0) return "n/a";
  return `${count}/${total} (${((count / total) * 100).toFixed(1)}%)`;
}

async function main(): Promise<void> {
  const cases = JSON.parse(await readFile(CASE_PATH, "utf8")) as RecallCase[];
  const provider = new MockProvider({ delayMs: 0, chunkSize: 200 });
  const results: CaseResult[] = [];
  for (const item of cases) {
    const result = await runRecallCase(item, provider);
    results.push(result);
    const mark = result.detail ? "miss" : "ok";
    process.stdout.write(`${mark}\t${result.id}${result.detail ? `\t${result.detail}` : ""}\n`);
  }
  const answerMisses = results.filter((result) => result.answerMiss).length;
  const saveMisses = results.filter((result) => result.saveMiss).length;
  const searchMisses = results.filter((result) => result.searchMiss).length;
  process.stdout.write("\nMockbot recall (mock provider)\n");
  process.stdout.write(`  cases: ${results.length}\n`);
  process.stdout.write(`  answer misses: ${rate(answerMisses, results.length)}\n`);
  process.stdout.write(`  save misses: ${rate(saveMisses, results.length)}\n`);
  process.stdout.write(`  search misses: ${rate(searchMisses, results.length)}\n`);

  const wantLongMem = hasFlag("--longmemeval");
  const modelReady =
    process.env.LLM_PROVIDER === "openai" && Boolean(process.env.LLM_API_KEY?.trim());
  if (!wantLongMem || !modelReady) {
    process.stdout.write("\nLongMemEval sample\n");
    process.stdout.write(
      "  skipped. This harness does not call a model unless you opt in.\n" +
        "  Set LLM_PROVIDER=openai and LLM_API_KEY, then run:\n" +
        "  npm run eval:memory -- --longmemeval\n" +
        "  The official LongMemEval score uses a GPT judge. This script uses a contains-match\n" +
        "  on a seeded 50-question slice of longmemeval_oracle.json and reports a no-memory\n" +
        "  baseline plus save and search miss rates. It is not part of npm test.\n",
    );
    if (results.some((result) => result.detail)) process.exitCode = 1;
    return;
  }

  const limit = Number(flagValue("--limit") ?? LONGMEM_SAMPLE);
  const items = await loadLongMemEval(Number.isFinite(limit) && limit > 0 ? limit : LONGMEM_SAMPLE);
  const model = selectProvider(process.env);
  let hits = 0;
  let baselineHits = 0;
  let longSave = 0;
  let longSearch = 0;
  for (const item of items) {
    const result = await runLongMemItem(item, model);
    if (result.hit) hits += 1;
    if (result.baselineHit) baselineHits += 1;
    if (result.saveMiss) longSave += 1;
    if (result.searchMiss) longSearch += 1;
    process.stdout.write(
      `${result.hit ? "hit" : "miss"}\t${item.question_id}\t${item.question_type ?? ""}\n`,
    );
  }
  process.stdout.write("\nLongMemEval contains-match (not the official GPT judge)\n");
  process.stdout.write(`  questions: ${items.length}\n`);
  process.stdout.write(
    `  baseline (no haystack, no memory): ${rate(baselineHits, items.length)}\n`,
  );
  process.stdout.write(`  with memory: ${rate(hits, items.length)}\n`);
  process.stdout.write(`  save misses: ${rate(longSave, items.length)}\n`);
  process.stdout.write(`  search misses: ${rate(longSearch, items.length)}\n`);
  if (results.some((result) => result.detail)) process.exitCode = 1;
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
