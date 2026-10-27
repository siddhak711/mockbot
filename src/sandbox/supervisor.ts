import { createHash } from "node:crypto";
import type { BrowserHost } from "../browser/sandbox-browser";
import { isAbortError, throwIfAborted } from "./abort";
import {
  formatExecResult,
  formatFailure,
  formatListResult,
  formatReadResult,
  formatWriteResult,
  killedMessage,
} from "./format";
import { mockToolContent } from "./mock";
import {
  byteLength,
  clip,
  DEFAULT_AGENT_ID,
  MAX_COMMAND_CHARS,
  MAX_FILE_BYTES,
  normalizeAgentId,
  resolveWorkspacePath,
} from "./limits";
import type { ExecOutcome, SandboxRuntime } from "./runtime";
import type { SandboxStore } from "./store";
import type { SandboxEntry } from "./runtime";
import type {
  ComputerFile,
  ComputerSnapshot,
  ComputerToolName,
  ComputerToolResult,
  SandboxRun,
} from "./types";

/** Skip dependency and VCS trees when diffing a command. */
const DIFF_SKIP_DIRS = new Set(["node_modules", ".git"]);

/** Past this many files, record no diff instead of reading the tree. */
export const DIFF_MAX_FILES = 200;

/** Past this many bytes of file content or listed sizes, record no diff. */
export const DIFF_MAX_BYTES = 1_000_000;

const DIFF_READ_CONCURRENCY = 8;

/** A read that failed. Comparison skips the path instead of treating it as new. */
const UNKNOWN_STAMP = "unknown";

type DiffEntry = {
  path: string;
  size?: number;
  modifiedAt?: string;
};

type TreeStamp = Map<string, string> | "over" | null;

export type ComputerInvocation = {
  result: ComputerToolResult;
  run: SandboxRun;
};

export class ComputerSupervisor {
  constructor(
    private readonly store: SandboxStore,
    private readonly runtime: SandboxRuntime,
    private readonly timeoutMs: number,
  ) {}

  get provider() {
    return this.runtime.kind;
  }

  get driver() {
    return this.store.driver;
  }

  async close(): Promise<void> {
    await this.store.close();
  }

  /**
   * Raw write and exec for the browser daemon, or null when the runtime cannot
   * run one. The mock computer has no processes, so only Daytona qualifies.
   */
  browserHost(agentId = DEFAULT_AGENT_ID): BrowserHost | null {
    if (this.runtime.kind !== "daytona") return null;
    const id = this.#agent(agentId);
    const runtime = this.runtime;
    return {
      write: (path, content) => runtime.write(id, path, content),
      async exec(command, timeoutMs, signal) {
        await runtime.prepare(id, signal);
        return runtime.exec(id, command, timeoutMs, signal);
      },
      prepare: (signal) => runtime.prepare(id, signal),
      sandboxId: async () => {
        const computer = await this.store.getComputer(id);
        return computer?.sandboxId ?? null;
      },
    };
  }

  async snapshot(agentId = DEFAULT_AGENT_ID): Promise<ComputerSnapshot> {
    const id = this.#agent(agentId);
    const computer = await this.store.ensureComputer(id, this.runtime.kind);
    const runs = await this.store.listRuns(id);
    const files = await this.#files(id);
    return {
      provider: this.runtime.kind,
      computer: {
        id: computer.id,
        agentId: computer.agentId,
        provider: computer.provider,
        createdAt: computer.createdAt,
      },
      files,
      runs,
    };
  }

  async invoke(
    agentId: string,
    tool: ComputerToolName,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<ComputerInvocation> {
    this.#throwIfAborted(signal);
    const id = this.#agent(agentId);
    await this.store.ensureComputer(id, this.runtime.kind);
    if (tool === "list") return this.#list(id, args);
    if (tool === "read") return this.#read(id, args);
    if (tool === "write") return this.#write(id, args);
    return this.#exec(id, args, signal);
  }

  async #files(agentId: string): Promise<ComputerFile[]> {
    if (this.runtime.kind === "mock") {
      const paths = await this.store.listPaths(agentId);
      return paths.map((path) => ({ path, kind: "file" as const }));
    }
    const computer = await this.store.getComputer(agentId);
    if (!computer?.sandboxId) return [];
    return this.#nestedFiles(agentId, "");
  }

  async #nestedFiles(agentId: string, dir: string, depth = 0): Promise<ComputerFile[]> {
    if (depth > 16) return [];
    const listed = await this.runtime.list(agentId, dir);
    if (!listed.ok) return [];
    const files: ComputerFile[] = [];
    for (const entry of listed.entries) {
      const path = dir ? `${dir}/${entry.name}` : entry.name;
      if (entry.kind === "dir") files.push(...(await this.#nestedFiles(agentId, path, depth + 1)));
      else files.push({ path, kind: "file" });
    }
    return files;
  }

  async #list(agentId: string, args: Record<string, unknown>): Promise<ComputerInvocation> {
    const resolved = resolveWorkspacePath(stringArg(args.path, "."));
    if ("error" in resolved) return this.#fail(agentId, "list", null, args, resolved.error, []);
    const listed = await this.runtime.list(agentId, resolved.path);
    if (!listed.ok) return this.#fail(agentId, "list", null, args, listed.error, []);
    const stdout = listed.entries
      .map((entry) => (entry.kind === "dir" ? `${entry.name}/` : entry.name))
      .join("\n");
    const run = await this.#record(agentId, "list", null, args, stdout, "", 0, false, []);
    return { result: this.#shown(formatListResult(listed.entries)), run };
  }

  async #read(agentId: string, args: Record<string, unknown>): Promise<ComputerInvocation> {
    const requested = stringArg(args.path, "");
    const resolved = resolveWorkspacePath(requested);
    if ("error" in resolved || !resolved.path) {
      const message = "error" in resolved ? resolved.error : "Path is a directory.";
      return this.#fail(agentId, "read", null, args, message, []);
    }
    const file = await this.runtime.read(agentId, resolved.path);
    if (!file.ok) return this.#fail(agentId, "read", null, args, file.error, []);
    const stdout = clip(file.content);
    const run = await this.#record(agentId, "read", null, args, stdout, "", 0, false, []);
    return { result: this.#shown(formatReadResult(resolved.path, stdout)), run };
  }

  async #write(agentId: string, args: Record<string, unknown>): Promise<ComputerInvocation> {
    const requested = stringArg(args.path, "");
    const content = typeof args.content === "string" ? args.content : null;
    if (content == null)
      return this.#fail(agentId, "write", null, args, "write requires content.", []);
    const resolved = resolveWorkspacePath(requested);
    if ("error" in resolved || !resolved.path) {
      const message = "error" in resolved ? resolved.error : "Path is a directory.";
      return this.#fail(agentId, "write", null, args, message, []);
    }
    if (byteLength(content) > MAX_FILE_BYTES) {
      return this.#fail(agentId, "write", null, args, "File is too large.", []);
    }
    const wrote = await this.runtime.write(agentId, resolved.path, content);
    if (!wrote.ok) return this.#fail(agentId, "write", null, args, wrote.error, []);
    const stdout = `Wrote ${resolved.path}`;
    const run = await this.#record(agentId, "write", null, args, stdout, "", 0, false, [
      resolved.path,
    ]);
    return { result: this.#shown(formatWriteResult(resolved.path)), run };
  }

  async #exec(
    agentId: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<ComputerInvocation> {
    const command = typeof args.command === "string" ? args.command.trim() : "";
    if (!command) return this.#fail(agentId, "exec", "", args, "exec requires a command.", []);
    if (command.length > MAX_COMMAND_CHARS) {
      return this.#fail(agentId, "exec", command, args, "Command is too long.", []);
    }
    let before: TreeStamp = null;
    let ran = false;
    let outcome: ExecOutcome;
    try {
      throwIfAborted(signal);
      await this.runtime.prepare(agentId, signal);
      throwIfAborted(signal);
      before = await this.#readTree(agentId, signal);
      ran = true;
      outcome = await deadline(
        this.runtime.exec(agentId, command, this.timeoutMs, signal),
        this.timeoutMs,
        signal,
      );
    } catch (error) {
      if (isAbortError(error) || signal?.aborted)
        throw isAbortError(error) ? error : abortFrom(signal);
      const message = error instanceof Error ? error.message : "Sandbox command failed";
      const changed = ran ? await this.#changedSince(agentId, before, signal) : [];
      return this.#fail(agentId, "exec", command, { command }, message, changed);
    }
    const finished: ExecOutcome = outcome.timedOut
      ? { stdout: killedMessage(this.timeoutMs), stderr: "", exitCode: null, timedOut: true }
      : {
          stdout: clip(outcome.stdout),
          stderr: clip(outcome.stderr),
          exitCode: outcome.exitCode,
          timedOut: false,
        };
    const changed = await this.#changedSince(agentId, before, signal);
    const run = await this.#record(
      agentId,
      "exec",
      command,
      { command },
      finished.stdout,
      finished.stderr,
      finished.exitCode,
      finished.timedOut,
      changed,
    );
    return { result: this.#shown(formatExecResult(command, finished)), run };
  }

  async #readTree(agentId: string, signal?: AbortSignal): Promise<TreeStamp> {
    throwIfAborted(signal);
    const listed = await this.#diffEntries(agentId, signal);
    if (listed === "over" || !listed) return listed;
    if (listed.length > DIFF_MAX_FILES) return "over";
    const knownBytes = listed.reduce(
      (sum, file) => sum + (typeof file.size === "number" ? file.size : 0),
      0,
    );
    if (knownBytes > DIFF_MAX_BYTES) return "over";
    const stamps = new Map<string, string>();
    const unread: DiffEntry[] = [];
    for (const file of listed) {
      if (typeof file.size === "number" && file.modifiedAt) {
        stamps.set(file.path, `${file.size}:${file.modifiedAt}`);
      } else unread.push(file);
    }
    if (unread.length === 0) return stamps;
    const read = await this.#readStamps(agentId, unread, signal);
    if (read === "over") return "over";
    for (const [path, stamp] of read) stamps.set(path, stamp);
    return stamps;
  }

  async #diffEntries(agentId: string, signal?: AbortSignal): Promise<DiffEntry[] | "over" | null> {
    throwIfAborted(signal);
    if (this.runtime.kind === "mock") {
      try {
        const paths = await this.store.listPaths(agentId);
        const files = paths.filter((path) => !ignoredDiffPath(path));
        if (files.length > DIFF_MAX_FILES) return "over";
        return files.map((path) => ({ path }));
      } catch (error) {
        if (isAbortError(error) || signal?.aborted) {
          throw isAbortError(error) ? error : abortFrom(signal);
        }
        return null;
      }
    }
    const computer = await this.store.getComputer(agentId);
    if (!computer?.sandboxId) return [];
    return this.#walkDiff(agentId, "", 0, signal);
  }

  async #walkDiff(
    agentId: string,
    dir: string,
    depth: number,
    signal?: AbortSignal,
  ): Promise<DiffEntry[] | "over" | null> {
    throwIfAborted(signal);
    if (depth > 16) return [];
    let listed: { ok: true; entries: SandboxEntry[] } | { ok: false; error: string };
    try {
      listed = await this.runtime.list(agentId, dir);
    } catch (error) {
      if (isAbortError(error) || signal?.aborted) {
        throw isAbortError(error) ? error : abortFrom(signal);
      }
      return null;
    }
    if (!listed.ok) return null;
    const files: DiffEntry[] = [];
    let bytes = 0;
    for (const entry of listed.entries) {
      throwIfAborted(signal);
      if (DIFF_SKIP_DIRS.has(entry.name)) continue;
      const path = dir ? `${dir}/${entry.name}` : entry.name;
      if (ignoredDiffPath(path)) continue;
      if (entry.kind === "dir") {
        const nested = await this.#walkDiff(agentId, path, depth + 1, signal);
        if (nested === "over" || !nested) return nested;
        files.push(...nested);
        bytes += nested.reduce(
          (sum, file) => sum + (typeof file.size === "number" ? file.size : 0),
          0,
        );
      } else {
        files.push({ path, size: entry.size, modifiedAt: entry.modifiedAt });
        if (typeof entry.size === "number") bytes += entry.size;
      }
      if (files.length > DIFF_MAX_FILES || bytes > DIFF_MAX_BYTES) return "over";
    }
    return files;
  }

  async #readStamps(
    agentId: string,
    files: DiffEntry[],
    signal?: AbortSignal,
  ): Promise<Map<string, string> | "over"> {
    const stamps = new Map<string, string>();
    let bytes = 0;
    let over = false;
    let cursor = 0;
    const worker = async () => {
      while (!over) {
        throwIfAborted(signal);
        const index = cursor;
        cursor += 1;
        if (index >= files.length) return;
        const file = files[index];
        if (!file) return;
        try {
          const read = await this.runtime.read(agentId, file.path, signal);
          if (!read.ok) {
            stamps.set(file.path, UNKNOWN_STAMP);
            continue;
          }
          bytes += byteLength(read.content);
          if (bytes > DIFF_MAX_BYTES) {
            over = true;
            return;
          }
          stamps.set(file.path, contentStamp(read.content));
        } catch (error) {
          if (isAbortError(error) || signal?.aborted) {
            throw isAbortError(error) ? error : abortFrom(signal);
          }
          stamps.set(file.path, UNKNOWN_STAMP);
        }
      }
    };
    const workers = Math.min(DIFF_READ_CONCURRENCY, files.length);
    if (workers > 0) await Promise.all(Array.from({ length: workers }, () => worker()));
    if (over) return "over";
    return stamps;
  }

  async #changedSince(agentId: string, before: TreeStamp, signal?: AbortSignal): Promise<string[]> {
    if (!before || before === "over") return [];
    const after = await this.#readTree(agentId, signal);
    if (!after || after === "over") return [];
    return addedOrModified(before, after);
  }

  async #fail(
    agentId: string,
    tool: ComputerToolName,
    command: string | null,
    args: Record<string, unknown>,
    message: string,
    changedFiles: string[],
  ): Promise<ComputerInvocation> {
    const run = await this.#record(
      agentId,
      tool,
      command,
      args,
      "",
      message,
      1,
      false,
      changedFiles,
    );
    return { result: this.#shown(formatFailure(message)), run };
  }

  async #record(
    agentId: string,
    tool: ComputerToolName,
    command: string | null,
    args: Record<string, unknown>,
    stdout: string,
    stderr: string,
    exitCode: number | null,
    timedOut: boolean,
    changedFiles: string[],
  ): Promise<SandboxRun> {
    const arguments_: Record<string, string> = {};
    for (const [key, value] of Object.entries(args)) {
      if (typeof value === "string") arguments_[key] = value;
    }
    return this.store.insertRun({
      agentId,
      tool,
      command,
      arguments: arguments_,
      stdout,
      stderr,
      exitCode,
      timedOut,
      changedFiles,
    });
  }

  #shown(result: ComputerToolResult): ComputerToolResult {
    if (this.runtime.kind !== "mock") return result;
    return { ...result, content: mockToolContent(result.content) };
  }

  #agent(agentId: string): string {
    const id = normalizeAgentId(agentId);
    if (!id) throw new Error("Unknown agent");
    return id;
  }

  #throwIfAborted(signal?: AbortSignal): void {
    throwIfAborted(signal);
  }
}

function abortFrom(signal?: AbortSignal): Error {
  const reason = signal?.reason;
  if (reason instanceof Error && reason.name === "AbortError") return reason;
  return Object.assign(new Error("The operation was aborted"), { name: "AbortError" });
}

function ignoredDiffPath(path: string): boolean {
  return path.split("/").some((part) => DIFF_SKIP_DIRS.has(part));
}

function contentStamp(content: string): string {
  const size = byteLength(content);
  const hash = createHash("sha256").update(content).digest("hex");
  return `${size}:${hash}`;
}

function addedOrModified(before: Map<string, string>, after: Map<string, string>): string[] {
  const changed: string[] = [];
  for (const [path, content] of after) {
    if (content === UNKNOWN_STAMP) continue;
    const previous = before.get(path);
    if (previous === UNKNOWN_STAMP) continue;
    if (previous === undefined || previous !== content) changed.push(path);
  }
  changed.sort((left, right) => left.localeCompare(right));
  return changed;
}

function stringArg(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function deadline(
  work: Promise<ExecOutcome>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<ExecOutcome> {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      finish(() => resolve({ stdout: "", stderr: "", exitCode: null, timedOut: true }));
    }, timeoutMs);
    const onAbort = () => finish(() => reject(abortFrom(signal)));
    const finish = (settle: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      settle();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => {
        finish(() => reject(error instanceof Error ? error : new Error("Sandbox command failed")));
      },
    );
  });
}
