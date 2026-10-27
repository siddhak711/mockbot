import type { ReviewInput, ReviewVerdict, ScriptReviewer } from "./types";

const FORBIDDEN = [
  /\beval\s*\(/,
  /\bnew\s+Function\s*\(/,
  /\bFunction\s*\(/,
  /child_process/,
  /require\(\s*["']fs["']\s*\)/,
  /require\(\s*["']node:fs["']\s*\)/,
  /process\.env/,
];

const OFFLINE_NOTE = "LLM_API_KEY is unset, so the self-check used the offline reviewer.";

export function heuristicReview(input: ReviewInput): ReviewVerdict {
  const { script, task, site, schema } = input;
  if (
    !script.includes('require("playwright-core")') &&
    !script.includes("require('playwright-core')")
  ) {
    return { ok: false, reviewer: "heuristic", reason: "The script does not use Playwright." };
  }
  if (!script.includes("async function run")) {
    return { ok: false, reviewer: "heuristic", reason: "The script has no run function." };
  }
  if (!script.includes(site)) {
    return { ok: false, reviewer: "heuristic", reason: "The script does not open the site." };
  }
  for (const pattern of FORBIDDEN) {
    if (pattern.test(script)) {
      return {
        ok: false,
        reviewer: "heuristic",
        reason: "The script uses a forbidden capability.",
      };
    }
  }
  const lowered = task.toLowerCase();
  if (/\b(extract|read|text)\b/.test(lowered) && !script.includes("innerText")) {
    return {
      ok: false,
      reviewer: "heuristic",
      reason: "The task reads text, and the script does not.",
    };
  }
  if (/\bclick\b/.test(lowered) && !script.includes('"click"') && !script.includes("click")) {
    return {
      ok: false,
      reviewer: "heuristic",
      reason: "The task clicks, and the script does not.",
    };
  }
  if (/\b(type|enter|fill)\b/.test(lowered) && !script.includes("fill")) {
    return { ok: false, reviewer: "heuristic", reason: "The task types, and the script does not." };
  }
  let origin: string;
  try {
    origin = new URL(site).origin;
  } catch {
    return { ok: false, reviewer: "heuristic", reason: "The site URL is not valid." };
  }
  const urls = script.match(/https?:\/\/[^"'\\\s]+/g) ?? [];
  for (const url of urls) {
    try {
      if (new URL(url).origin !== origin) {
        return { ok: false, reviewer: "heuristic", reason: "The script opens a different site." };
      }
    } catch {
      return {
        ok: false,
        reviewer: "heuristic",
        reason: "The script contains a URL that is not valid.",
      };
    }
  }
  if (schema.type !== "object" || schema.additionalProperties !== false) {
    return {
      ok: false,
      reviewer: "heuristic",
      reason: "The input schema must be a closed object.",
    };
  }
  return { ok: true, reviewer: "heuristic", notes: OFFLINE_NOTE };
}

export async function reviewScript(
  input: ReviewInput,
  options: {
    env: Record<string, string | undefined>;
    fetchImpl?: typeof fetch;
    reviewer?: ScriptReviewer;
    signal?: AbortSignal;
  },
): Promise<ReviewVerdict> {
  if (options.reviewer) return options.reviewer(input);
  const structural = heuristicReview(input);
  if (!reviewApiKey(options.env)) return structural;
  const model = await modelReview(input, options);
  if (!model.ok) return model;
  if (!structural.ok) return { ...structural, reviewer: "model" };
  return model;
}

function reviewApiKey(env: Record<string, string | undefined>): string {
  return env.LLM_API_KEY?.trim() || env.SITE_TOOL_REVIEW_API_KEY?.trim() || "";
}

async function modelReview(
  input: ReviewInput,
  options: {
    env: Record<string, string | undefined>;
    fetchImpl?: typeof fetch;
    signal?: AbortSignal;
  },
): Promise<ReviewVerdict> {
  const apiKey = reviewApiKey(options.env);
  const baseUrl = (options.env.LLM_BASE_URL?.trim() || "https://api.openai.com/v1").replace(
    /\/+$/,
    "",
  );
  const model = options.env.SITE_TOOL_REVIEW_MODEL?.trim() || "gpt-4o-mini";
  const fetchImpl = options.fetchImpl ?? fetch;
  let signal: AbortSignal;
  try {
    signal = options.signal
      ? AbortSignal.any([options.signal, AbortSignal.timeout(20_000)])
      : AbortSignal.timeout(20_000);
  } catch {
    signal = AbortSignal.timeout(20_000);
  }
  let response: Response;
  try {
    response = await fetchImpl(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        max_tokens: 200,
        messages: [
          {
            role: "system",
            content:
              "You review a Playwright site tool before it is saved. Reply with JSON only: " +
              '{"ok":true} or {"ok":false,"reason":"..."}. ' +
              "Reject a script that misses the task, ignores its schema, leaves the site, " +
              "or uses eval, dynamic code, credential theft, or an unrequested form submit.",
          },
          {
            role: "user",
            content: JSON.stringify({
              site: input.site,
              task: input.task,
              schema: input.schema,
              script: input.script.slice(0, 12_000),
            }),
          },
        ],
      }),
      signal,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "The review request failed";
    return {
      ok: false,
      reviewer: "model",
      reason: `The self-check model did not answer. ${message}`,
    };
  }
  if (!response.ok) {
    return {
      ok: false,
      reviewer: "model",
      reason: `The self-check model rejected the request (${response.status}).`,
    };
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return {
      ok: false,
      reviewer: "model",
      reason: "The self-check model returned malformed JSON.",
    };
  }
  const content = readContent(payload);
  const verdict = content ? parseVerdict(content) : null;
  if (!verdict) {
    return {
      ok: false,
      reviewer: "model",
      reason: "The self-check model did not return a usable review.",
    };
  }
  if (!verdict.ok) {
    return {
      ok: false,
      reviewer: "model",
      reason: verdict.reason?.trim() || "The self-check model rejected the script.",
    };
  }
  return { ok: true, reviewer: "model" };
}

function readContent(payload: unknown): string | null {
  if (!payload || typeof payload !== "object" || !("choices" in payload)) return null;
  const choices = (payload as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || !choices[0] || typeof choices[0] !== "object") return null;
  const message = (choices[0] as { message?: unknown }).message;
  if (!message || typeof message !== "object" || !("content" in message)) return null;
  const content = (message as { content?: unknown }).content;
  return typeof content === "string" ? content : null;
}

function parseVerdict(content: string): { ok: boolean; reason?: string } | null {
  const trimmed = content
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  try {
    const parsed = JSON.parse(trimmed) as { ok?: unknown; reason?: unknown };
    if (!parsed || typeof parsed !== "object" || typeof parsed.ok !== "boolean") return null;
    return { ok: parsed.ok, reason: typeof parsed.reason === "string" ? parsed.reason : undefined };
  } catch {
    return null;
  }
}
