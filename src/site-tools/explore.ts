import { browseTool } from "../browser/tool";
import type { ToolResult } from "../tools/types";
import type { Binding, PlannedStep, SiteBrowser } from "./types";

export async function exploreSite(options: {
  driver: SiteBrowser;
  site: string;
  steps: PlannedStep[];
  signal?: AbortSignal;
}): Promise<{ ok: true; actions: string[] } | { ok: false; error: string }> {
  const tool = browseTool({
    driver: () => options.driver,
    maxActions: options.steps.length + 2,
  });
  const context = { signal: options.signal, runCounters: new Map<string, number>() };
  const actions: string[] = [];

  const opened = await tool.invoke({ action: "open", url: options.site }, context);
  const openBody = read(opened);
  if (!openBody.ok) return { ok: false, error: `Could not open the site. ${openBody.error}` };
  actions.push("open");

  for (const step of options.steps) {
    const selector = resolve(step.selector);
    if (!selector.ok) return selector;
    if (step.op === "click") {
      const clicked = await tool.invoke({ action: "click", selector: selector.value }, context);
      const body = read(clicked);
      if (!body.ok) return { ok: false, error: `Could not click ${selector.value}. ${body.error}` };
      actions.push("click");
      continue;
    }
    if (step.op === "type") {
      const text = resolve(step.text);
      if (!text.ok) return text;
      const typed = await tool.invoke(
        { action: "type", selector: selector.value, text: text.value },
        context,
      );
      const body = read(typed);
      if (!body.ok)
        return { ok: false, error: `Could not type into ${selector.value}. ${body.error}` };
      actions.push("type");
      continue;
    }
    const extracted = await tool.invoke({ action: "extract", selector: selector.value }, context);
    const body = read(extracted);
    if (!body.ok) return { ok: false, error: `Could not extract ${selector.value}. ${body.error}` };
    actions.push("extract");
  }
  return { ok: true, actions };
}

function resolve(binding: Binding): { ok: true; value: string } | { ok: false; error: string } {
  if (binding.kind === "literal") return { ok: true, value: binding.value };
  if (!binding.example) {
    return {
      ok: false,
      error: `The input {${binding.name}} needs an example, like {${binding.name}: value}.`,
    };
  }
  return { ok: true, value: binding.example };
}

function read(result: ToolResult): { ok: true } | { ok: false; error: string } {
  if (result.isError || result.halt) return { ok: false, error: result.content };
  return { ok: true };
}
