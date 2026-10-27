export type BrowseAction = "open" | "click" | "type" | "extract" | "screenshot";

export const BROWSE_ACTIONS: readonly BrowseAction[] = [
  "open",
  "click",
  "type",
  "extract",
  "screenshot",
];

/** One action as the sandbox daemon receives it. */
export type BrowseStep = {
  action: BrowseAction;
  url?: string;
  selector?: string;
  text?: string;
  timeoutMs: number;
  /** True only after the approval layer let a form submit or login through. */
  allowSubmit: boolean;
};

export type BrowseScreenshot = {
  /** Path inside the sandbox workspace. */
  path: string;
  mimeType: "image/png";
  bytes: number;
  sha256: string;
  width: number;
  height: number;
  base64: string;
};

export type BrowseOutcome =
  | {
      ok: true;
      url?: string;
      title?: string;
      status?: number | null;
      text?: string;
      screenshot?: BrowseScreenshot;
    }
  | {
      ok: false;
      error: string;
      /** The daemon refused because the action submits a form or logs in. */
      needsApproval?: boolean;
      timedOut?: boolean;
      /** The remote browser session ended, such as at its time limit. */
      sessionEnded?: boolean;
    };

export type BrowserDriver = {
  perform(step: BrowseStep, signal?: AbortSignal): Promise<BrowseOutcome>;
};
