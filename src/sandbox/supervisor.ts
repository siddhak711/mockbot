import {
  formatExecResult,
  formatFailure,
  formatListResult,
  formatReadResult,
  formatWriteResult,
  killedMessage,
} from "./format";
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
import type {
  ComputerFile,
  ComputerSnapshot,
  ComputerToolName,
  ComputerToolResult,
  SandboxRun,
} from "./types";

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

  async close(): Promise<void> {
    await this.store.close();
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
    return this.#exec(id, args);
  }

  async #files(agentId: string): Promise<ComputerFile[]> {
    if (this.runtime.kind === "mock") {
      const paths = await this.store.listPaths(agentId);
      return paths.map((path) => ({ path, kind: "file" as const }));
    }
    const computer = await this.store.getComputer(agentId);
    if (!computer?.sandboxId) return [];
    const listed = await this.runtime.list(agentId, "");
    if (!listed.ok) return [];
    return listed.entries.map((entry) => ({
      path: entry.name,
      kind: entry.kind,
    }));
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
    return { result: formatListResult(listed.entries), run };
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
    return { result: formatReadResult(resolved.path, stdout), run };
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
    return { result: formatWriteResult(resolved.path), run };
  }

  async #exec(agentId: string, args: Record<string, unknown>): Promise<ComputerInvocation> {
    const command = typeof args.command === "string" ? args.command.trim() : "";
    if (!command) return this.#fail(agentId, "exec", "", args, "exec requires a command.", []);
    if (command.length > MAX_COMMAND_CHARS) {
      return this.#fail(agentId, "exec", command, args, "Command is too long.", []);
    }
    let outcome: ExecOutcome;
    try {
      await this.runtime.prepare(agentId);
      outcome = await deadline(this.runtime.exec(agentId, command, this.timeoutMs), this.timeoutMs);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Sandbox command failed";
      return this.#fail(agentId, "exec", command, { command }, message, []);
    }
    const finished: ExecOutcome = outcome.timedOut
      ? { stdout: killedMessage(this.timeoutMs), stderr: "", exitCode: null, timedOut: true }
      : {
          stdout: clip(outcome.stdout),
          stderr: clip(outcome.stderr),
          exitCode: outcome.exitCode,
          timedOut: false,
        };
    const run = await this.#record(
      agentId,
      "exec",
      command,
      { command },
      finished.stdout,
      finished.stderr,
      finished.exitCode,
      finished.timedOut,
      [],
    );
    return { result: formatExecResult(command, finished), run };
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
    return { result: formatFailure(message), run };
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

  #agent(agentId: string): string {
    const id = normalizeAgentId(agentId);
    if (!id) throw new Error("Unknown agent");
    return id;
  }

  #throwIfAborted(signal?: AbortSignal): void {
    if (!signal?.aborted) return;
    throw Object.assign(new Error("The operation was aborted"), { name: "AbortError" });
  }
}

function stringArg(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function deadline(work: Promise<ExecOutcome>, timeoutMs: number): Promise<ExecOutcome> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      resolve({ stdout: "", stderr: "", exitCode: null, timedOut: true });
    }, timeoutMs);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error("Sandbox command failed"));
      },
    );
  });
}
