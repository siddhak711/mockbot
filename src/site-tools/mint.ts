import { MAX_URL_CHARS } from "../browser/limits";
import { compileSiteTool } from "./compile";
import { exploreSite } from "./explore";
import { parseSiteToolTask, slugSiteToolName } from "./parse";
import { reviewScript } from "./review";
import { runPlaywrightScript } from "./run-script";
import type { ReviewVerdict, ScriptRunResult, SiteToolDeps, SiteToolRecord } from "./types";
import { validateSiteToolArgs } from "./validate";

export const SITE_TOOL_UNAVAILABLE =
  "Site tools run Playwright inside the Daytona sandbox, and this server has no Daytona sandbox (it is unavailable or the labeled mock computer).";

export type MintResult =
  | {
      saved: true;
      name: string;
      version: number;
      schema: SiteToolRecord["schema"];
      sampleArgs: Record<string, string>;
      explored: string[];
      review: ReviewVerdict & { ok: true };
      run: { ok: true; result: unknown };
    }
  | {
      saved: false;
      error: string;
      stage: "input" | "explore" | "compile" | "review" | "run" | "store";
    };

export async function mintSiteTool(
  input: {
    userId: string;
    site: string;
    task: string;
    name?: string;
    /** The (user, agent) sandbox owner. Defaults to the deps' own choice. */
    owner?: string;
    signal?: AbortSignal;
    /** True only after this mint call passed the submit approval card. */
    allowSubmit?: boolean;
  },
  deps: SiteToolDeps,
): Promise<MintResult> {
  const userId = input.userId.trim();
  if (!userId)
    return { saved: false, stage: "input", error: "Sign in before minting a site tool." };
  const site = normalizeSite(input.site);
  if (!site.ok) return { saved: false, stage: "input", error: site.error };
  const parsed = parseSiteToolTask(input.task);
  if (!parsed.ok) return { saved: false, stage: "input", error: parsed.error };
  const name = slugSiteToolName(input.name?.trim() || input.task);
  const compiled = compileSiteTool({
    site: site.url,
    task: input.task.trim(),
    steps: parsed.steps,
  });
  if (!compiled.ok) return { saved: false, stage: "compile", error: compiled.error };

  const driver = deps.driver(input.owner);
  if (!driver) return { saved: false, stage: "explore", error: SITE_TOOL_UNAVAILABLE };
  const explored = await exploreSite({
    driver,
    site: site.url,
    steps: parsed.steps,
    signal: input.signal,
    allowSubmit: input.allowSubmit === true,
  });
  if (!explored.ok) return { saved: false, stage: "explore", error: explored.error };

  const verdict = await reviewScript(
    {
      site: site.url,
      task: input.task.trim(),
      name,
      schema: compiled.schema,
      script: compiled.script,
    },
    { env: deps.env, fetchImpl: deps.fetchImpl, reviewer: deps.reviewer, signal: input.signal },
  );
  if (!verdict.ok) {
    return {
      saved: false,
      stage: "review",
      error: `The self-check rejected the script. ${verdict.reason}`,
    };
  }

  const ran = await executeScript(
    deps,
    input.owner,
    compiled.script,
    compiled.sampleArgs,
    input.signal,
    input.allowSubmit === true,
  );
  if (!ran.ok) {
    return {
      saved: false,
      stage: "run",
      error: `The script failed its live-site run. ${ran.error}`,
    };
  }

  try {
    const record = await deps.repository.save({
      userId,
      name,
      schema: compiled.schema,
      script: compiled.script,
    });
    return {
      saved: true,
      name: record.name,
      version: record.version,
      schema: record.schema,
      sampleArgs: compiled.sampleArgs,
      explored: explored.actions,
      review: verdict,
      run: { ok: true, result: ran.result },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "The site tool could not be stored.";
    return { saved: false, stage: "store", error: message };
  }
}

export type RunToolResult =
  { ok: true; name: string; version: number; result: unknown } | { ok: false; error: string };

export async function runSiteTool(
  input: {
    userId: string;
    name: string;
    args: unknown;
    /** The (user, agent) sandbox owner. Defaults to the deps' own choice. */
    owner?: string;
    signal?: AbortSignal;
    /** True only after this replay passed the submit approval card. */
    allowSubmit?: boolean;
  },
  deps: SiteToolDeps,
): Promise<RunToolResult> {
  const userId = input.userId.trim();
  if (!userId) return { ok: false, error: "Sign in before running a site tool." };
  const name = slugSiteToolName(input.name);
  const record = await deps.repository.latest(userId, name);
  if (!record) return { ok: false, error: `No site tool named "${name}".` };
  const validated = validateSiteToolArgs(record.schema, input.args);
  if (!validated.ok) return validated;
  const ran = await executeScript(
    deps,
    input.owner,
    record.script,
    validated.args,
    input.signal,
    input.allowSubmit === true,
  );
  if (!ran.ok) return ran;
  return { ok: true, name: record.name, version: record.version, result: ran.result };
}

async function executeScript(
  deps: SiteToolDeps,
  owner: string | undefined,
  script: string,
  args: Record<string, string>,
  signal: AbortSignal | undefined,
  allowSubmit: boolean,
): Promise<ScriptRunResult> {
  if (deps.runScript) return deps.runScript({ script, args, signal, allowSubmit });
  const host = deps.host(owner);
  const driver = deps.driver(owner);
  if (!host || !driver) return { ok: false, error: SITE_TOOL_UNAVAILABLE };
  if (driver.ensureReady) {
    const ready = await driver.ensureReady(signal);
    if (!ready.ok) return ready;
  }
  const sessions = deps.scriptSessions?.() ?? {
    error: "Site tools have no remote browser to run the script in.",
  };
  if ("error" in sessions) return { ok: false, error: sessions.error };
  return runPlaywrightScript({
    host,
    paths: deps.paths,
    sessions,
    script,
    args,
    timeoutMs: deps.timeoutMs,
    signal,
    allowSubmit,
  });
}

function normalizeSite(value: string): { ok: true; url: string } | { ok: false; error: string } {
  const site = value.trim();
  if (!site) return { ok: false, error: "mint_site_tool requires a site." };
  if (site.length > MAX_URL_CHARS) return { ok: false, error: "The site URL is too long." };
  let parsed: URL;
  try {
    parsed = new URL(site);
  } catch {
    return { ok: false, error: "The site URL is not valid." };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, error: "The site must be an http or https URL." };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, error: "The site URL must not include credentials." };
  }
  return { ok: true, url: parsed.toString() };
}
