import { MAX_SITE_TOOL_NAME, MAX_TASK_CHARS, type Binding, type PlannedStep } from "./types";

const SELECTOR_TOKEN =
  /^(?:(?:button|input|label|a)?(?:#[\w-]+|\.[\w-]+|\[[^\]]+\])(?:\[[^\]]+\])?)$/;
const SELECTOR = String.raw`(?:\{[^}]+\}|(?:button|input|label|a)?(?:#[\w-]+|\.[\w-]+|\[[^\]]+\])(?:\[[^\]]+\])?)`;
const VALUE = String.raw`(?:"[^"]*"|\{[^}]+\}|\S+)`;

type Found = { index: number; step: PlannedStep };

export function slugSiteToolName(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, MAX_SITE_TOOL_NAME)
    .replace(/_+$/g, "");
  return slug || "site_tool";
}

export function parseSiteToolTask(
  task: string,
): { ok: true; steps: PlannedStep[] } | { ok: false; error: string } {
  const text = task.trim();
  if (!text) return { ok: false, error: "mint_site_tool requires a task." };
  if (text.length > MAX_TASK_CHARS) return { ok: false, error: "The task is too long." };

  const found: Found[] = [];
  collect(
    text,
    new RegExp(String.raw`\b(?:type|enter)\s+(${VALUE})\s+(?:into|in)\s+(${SELECTOR})`, "gi"),
    (match) => {
      const textBinding = parseBinding(match[1] ?? "");
      const selector = parseSelector(match[2] ?? "");
      if (!textBinding || !selector) return null;
      return { op: "type", selector, text: textBinding };
    },
    found,
  );
  collect(
    text,
    new RegExp(String.raw`\bfill\s+(${SELECTOR})\s+with\s+(${VALUE})`, "gi"),
    (match) => {
      const selector = parseSelector(match[1] ?? "");
      const textBinding = parseBinding(match[2] ?? "");
      if (!selector || !textBinding) return null;
      return { op: "type", selector, text: textBinding };
    },
    found,
  );
  collect(
    text,
    new RegExp(String.raw`\bclick\s+(${SELECTOR})`, "gi"),
    (match) => {
      const selector = parseSelector(match[1] ?? "");
      if (!selector) return null;
      return { op: "click", selector };
    },
    found,
  );
  collect(
    text,
    new RegExp(
      String.raw`\b(?:(?:extract|get)(?:\s+the)?(?:\s+text)?(?:\s+of)?|read)\s+(${SELECTOR})`,
      "gi",
    ),
    (match) => {
      const selector = parseSelector(match[1] ?? "");
      if (!selector) return null;
      return { op: "extract", selector };
    },
    found,
  );

  found.sort((a, b) => a.index - b.index);
  const steps = found.map((item) => item.step);
  if (steps.length === 0) {
    return {
      ok: false,
      error:
        "The task needs a step this tool can replay, such as extract the text of #price, click #reveal, or type {query: widgets} into #search.",
    };
  }
  if (steps.length > 8) return { ok: false, error: "The task has too many steps." };

  for (const step of steps) {
    if ((step.op === "click" || step.op === "type") && step.selector.kind === "arg") {
      return {
        ok: false,
        error:
          "Click and type targets stay fixed. Put the typed input in the text, like {query: widgets}.",
      };
    }
  }
  return { ok: true, steps: promoteExtractSelector(steps) };
}

function collect(
  text: string,
  pattern: RegExp,
  build: (match: RegExpMatchArray) => PlannedStep | null,
  found: Found[],
): void {
  for (const match of text.matchAll(pattern)) {
    const step = build(match);
    if (!step || match.index === undefined) continue;
    const overlaps = found.some(
      (item) => match.index! < item.index + 1 && item.index < match.index! + match[0].length,
    );
    if (overlaps) continue;
    found.push({ index: match.index, step });
  }
}

function parseSelector(token: string): Binding | null {
  const binding = parseBinding(token);
  if (!binding) return null;
  if (binding.kind === "literal" && !SELECTOR_TOKEN.test(binding.value)) return null;
  if (binding.kind === "arg" && binding.example && !SELECTOR_TOKEN.test(binding.example)) {
    return null;
  }
  return binding;
}

function parseBinding(token: string): Binding | null {
  const trimmed = token.trim();
  const placeholder = trimmed.match(/^\{([A-Za-z][A-Za-z0-9_]{0,31})(?::\s*([^}]*))?\}$/);
  if (placeholder) {
    const name = placeholder[1]?.toLowerCase();
    if (!name) return null;
    const example = placeholder[2]?.trim();
    return example ? { kind: "arg", name, example } : { kind: "arg", name };
  }
  if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
    return { kind: "literal", value: trimmed.slice(1, -1) };
  }
  if (!trimmed) return null;
  return { kind: "literal", value: trimmed };
}

/** One fixed extract target becomes a required string arg so the saved tool is reusable. */
function promoteExtractSelector(steps: PlannedStep[]): PlannedStep[] {
  if (steps.some((step) => bindingsOf(step).some((binding) => binding.kind === "arg")))
    return steps;
  let index = -1;
  for (let i = 0; i < steps.length; i += 1) {
    const step = steps[i];
    if (step?.op === "extract" && step.selector.kind === "literal") index = i;
  }
  if (index < 0) return steps;
  const step = steps[index];
  if (!step || step.op !== "extract" || step.selector.kind !== "literal") return steps;
  const next: PlannedStep = {
    op: "extract",
    selector: { kind: "arg", name: "selector", example: step.selector.value },
  };
  return steps.map((item, i) => (i === index ? next : item));
}

function bindingsOf(step: PlannedStep): Binding[] {
  if (step.op === "type") return [step.selector, step.text];
  return [step.selector];
}
