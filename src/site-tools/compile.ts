import type { Binding, EmittedStep, PlannedStep, SiteToolSchema } from "./types";

export function compileSiteTool(input: {
  site: string;
  task: string;
  steps: PlannedStep[];
}):
  | { ok: true; script: string; schema: SiteToolSchema; sampleArgs: Record<string, string> }
  | { ok: false; error: string } {
  const bound = bindSchema(input.steps);
  if (!bound.ok) return bound;
  const script = renderScript(input.site, input.task, bound.steps);
  return { ok: true, script, schema: bound.schema, sampleArgs: bound.sampleArgs };
}

function bindSchema(
  steps: PlannedStep[],
):
  | { ok: true; steps: EmittedStep[]; schema: SiteToolSchema; sampleArgs: Record<string, string> }
  | { ok: false; error: string } {
  const properties: SiteToolSchema["properties"] = {};
  const required: string[] = [];
  const sampleArgs: Record<string, string> = {};
  const emitted: EmittedStep[] = [];

  for (const step of steps) {
    if (step.op === "click") {
      if (step.selector.kind !== "literal") {
        return { ok: false, error: "Click targets stay fixed." };
      }
      emitted.push({ op: "click", selector: step.selector.value });
      continue;
    }
    if (step.op === "type") {
      if (step.selector.kind !== "literal") return { ok: false, error: "Type targets stay fixed." };
      const text = takeBinding(step.text, "text", properties, required, sampleArgs);
      if (!text.ok) return text;
      emitted.push({
        op: "type",
        selector: step.selector.value,
        ...(text.arg ? { textArg: text.arg } : { text: text.value }),
      });
      continue;
    }
    const selector = takeBinding(step.selector, "selector", properties, required, sampleArgs);
    if (!selector.ok) return selector;
    emitted.push({
      op: "extract",
      ...(selector.arg ? { selectorArg: selector.arg } : { selector: selector.value }),
    });
  }

  return {
    ok: true,
    steps: emitted,
    sampleArgs,
    schema: {
      type: "object",
      properties,
      required,
      additionalProperties: false,
      examples: [sampleArgs],
    },
  };
}

function takeBinding(
  binding: Binding,
  fallbackName: string,
  properties: SiteToolSchema["properties"],
  required: string[],
  sampleArgs: Record<string, string>,
): { ok: true; arg?: string; value?: string } | { ok: false; error: string } {
  if (binding.kind === "literal") return { ok: true, value: binding.value };
  const name = binding.name || fallbackName;
  if (!binding.example) {
    return {
      ok: false,
      error: `The input {${name}} needs an example, like {${name}: value}.`,
    };
  }
  const existing = sampleArgs[name];
  if (existing !== undefined && existing !== binding.example) {
    return { ok: false, error: `The input {${name}} is used with two different examples.` };
  }
  if (existing === undefined) {
    properties[name] = {
      type: "string",
      description: `Typed input. Explored with ${binding.example}.`,
    };
    required.push(name);
    sampleArgs[name] = binding.example;
  }
  return { ok: true, arg: name };
}

function renderScript(site: string, task: string, steps: EmittedStep[]): string {
  return `"use strict";
// ${JSON.stringify(task)}
const { chromium } = require("playwright-core");

const SITE = ${JSON.stringify(site)};
const STEPS = ${JSON.stringify(steps)};

const ALLOW_SUBMIT = process.argv[3] === "1";

function selectorRisk(op, selector) {
  const value = String(selector || "");
  const submit = /submit|log-?in|sign-?in|password|passwd/i;
  const label = /(?:^|[\\s>+~,])label\\b|\\[for\\s*=/i;
  if ((op === "click" || op === "type") && submit.test(value)) return "This step submits a form.";
  if (op === "click" && label.test(value)) return "This click submits a form.";
  return null;
}

async function controlRisk(page, op, selector) {
  try {
    return await page.locator(selector).evaluate(function (el, op) {
      var LOGIN = /\\b(log ?in|sign ?in)\\b/i;
      var label = null;
      if (el && el.tagName && String(el.tagName).toLowerCase() === "label") label = el;
      else if (el && el.closest) label = el.closest("label");
      var labeled = null;
      if (label) {
        labeled =
          label.control ||
          (label.querySelector && label.querySelector("button, input, select, textarea"));
      }
      var inside = el && el.closest ? el.closest("button, input, select, textarea") : null;
      var resolved = inside || labeled || el;
      var target = (resolved.closest && resolved.closest("button, input")) || resolved;
      var tag = String(target.tagName || "").toLowerCase();
      var type = String((target.getAttribute && target.getAttribute("type")) || "").toLowerCase();
      if (op === "type") {
        var hint = [
          target.getAttribute && target.getAttribute("name"),
          target.id,
          target.getAttribute && target.getAttribute("autocomplete"),
        ]
          .filter(Boolean)
          .join(" ");
        if (type === "password" || /password|passcode|one-time-code/i.test(hint)) {
          return "Typing here enters a password.";
        }
        return null;
      }
      var form = target.form || (target.closest && target.closest("form"));
      var submits =
        (tag === "button" && (type === "" || type === "submit")) ||
        (tag === "input" && (type === "submit" || type === "image"));
      if (submits && form) return "This click submits a form.";
      var words = [
        target.innerText,
        target.value,
        target.getAttribute && target.getAttribute("aria-label"),
        target.id,
        target.getAttribute && target.getAttribute("name"),
      ];
      if (label && label !== target) {
        words.push(label.innerText, label.id, label.getAttribute && label.getAttribute("for"));
      }
      if (LOGIN.test(words.filter(Boolean).join(" "))) return "This click looks like a login.";
      return null;
    }, op);
  } catch (error) {
    return null;
  }
}

async function refuseSubmit(page, op, selector) {
  const risk = selectorRisk(op, selector) || (await controlRisk(page, op, selector));
  if (risk && !ALLOW_SUBMIT) {
    throw new Error(risk + " Nothing was submitted. Call again with confirm: true.");
  }
}

async function run(page, args) {
  page.setDefaultTimeout(15000);
  page.setDefaultNavigationTimeout(15000);
  await page.goto(SITE, { waitUntil: "domcontentloaded" });
  let text = "";
  for (const step of STEPS) {
    const selector = step.selectorArg ? String(args[step.selectorArg] ?? "") : step.selector;
    if (!selector) throw new Error("The step is missing a selector.");
    if (step.op === "click") {
      await refuseSubmit(page, "click", selector);
      await page.locator(selector).click();
    } else if (step.op === "type") {
      await refuseSubmit(page, "type", selector);
      const value = step.textArg ? String(args[step.textArg] ?? "") : String(step.text ?? "");
      await page.locator(selector).fill(value);
    } else if (step.op === "extract") {
      text = (await page.locator(selector).innerText()).trim();
    }
  }
  return { text };
}

async function main() {
  const encoded = process.argv[2] || "";
  const args = encoded ? JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) : {};
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1024, height: 640 } });
    const result = await run(page, args);
    process.stdout.write(JSON.stringify({ ok: true, result }));
  } catch (error) {
    const message = error && error.message ? String(error.message).split("\\n")[0] : String(error);
    process.stdout.write(JSON.stringify({ ok: false, error: message }));
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

main();
`;
}
