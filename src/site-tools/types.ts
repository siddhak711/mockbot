import type { BrowserSessionSource } from "../browser/browserbase";
import type { BrowserHost } from "../browser/sandbox-browser";
import type { BrowserPaths } from "../browser/install";
import type { BrowserDriver } from "../browser/types";

export const MAX_TASK_CHARS = 2_000;
export const MAX_SITE_TOOL_NAME = 48;
export const SITE_TOOL_RUN_TIMEOUT_MS = 30_000;

export type SiteToolSchema = {
  type: "object";
  properties: Record<string, { type: "string"; description?: string }>;
  required: string[];
  additionalProperties: false;
  examples?: Array<Record<string, string>>;
};

export type SiteToolRecord = {
  id: string;
  userId: string;
  name: string;
  schema: SiteToolSchema;
  script: string;
  version: number;
  createdAt: string;
};

export type Binding =
  { kind: "literal"; value: string } | { kind: "arg"; name: string; example?: string };

export type PlannedStep =
  | { op: "click"; selector: Binding }
  | { op: "type"; selector: Binding; text: Binding }
  | { op: "extract"; selector: Binding };

export type EmittedStep = {
  op: "click" | "type" | "extract";
  selector?: string;
  selectorArg?: string;
  text?: string;
  textArg?: string;
};

export type ReviewerId = "model" | "heuristic" | "injected";

export type ReviewVerdict =
  | { ok: true; reviewer: ReviewerId; notes?: string }
  | { ok: false; reviewer: ReviewerId; reason: string };

export type ReviewInput = {
  site: string;
  task: string;
  name: string;
  schema: SiteToolSchema;
  script: string;
};

export type ScriptReviewer = (input: ReviewInput) => Promise<ReviewVerdict>;

export type ScriptRunRequest = {
  script: string;
  args: Record<string, string>;
  signal?: AbortSignal;
  /** True only after the site-tool call itself passed the submit approval card. */
  allowSubmit?: boolean;
};

export type ScriptRunResult = { ok: true; result: unknown } | { ok: false; error: string };

export type ScriptRunner = (request: ScriptRunRequest) => Promise<ScriptRunResult>;

export type SiteBrowser = BrowserDriver & {
  ensureReady?(signal?: AbortSignal): Promise<{ ok: true } | { ok: false; error: string }>;
};

export type SiteToolDeps = {
  repository: {
    save(input: {
      userId: string;
      name: string;
      schema: SiteToolSchema;
      script: string;
    }): Promise<SiteToolRecord>;
    latest(userId: string, name: string): Promise<SiteToolRecord | null>;
  };
  /** The (user, agent) owner's sandbox browser. Null when there is no real sandbox. */
  driver: (owner?: string) => SiteBrowser | null;
  host: (owner?: string) => BrowserHost | null;
  /**
   * A fresh remote browser session source for one script run. The script
   * connects to it over CDP; the sandbox has no local Chromium.
   */
  scriptSessions?: () => BrowserSessionSource | { error: string };
  paths: BrowserPaths;
  env: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  /** Replaces the self-check. Tests use this to force a pass or a rejection. */
  reviewer?: ScriptReviewer;
  /** Replaces the sandbox Playwright run. Tests use this to fail the live gate. */
  runScript?: ScriptRunner;
  timeoutMs?: number;
};
