import type { Daytona, Sandbox } from "@daytonaio/sdk";
import { isAbortError, throwIfAborted, withSignal } from "./abort";
import { toSandboxPath } from "./limits";
import type { ExecOutcome, SandboxEntry, SandboxRuntime } from "./runtime";
import type { SandboxStore } from "./store";
import {
  daytonaCreateOptions,
  provisionSandboxToolchain,
  sandboxImage,
  type SandboxCommandResult,
} from "./toolchain";

export type RemoteRead = { ok: true; content: string } | { ok: false; error: string };

export type RemoteSandbox = {
  readonly id: string;
  /** Refresh remote state and start the sandbox when Daytona has stopped it. */
  ensureRunning(): Promise<void>;
  list(path: string): Promise<{ ok: true; entries: SandboxEntry[] } | { ok: false; error: string }>;
  read(path: string): Promise<RemoteRead>;
  write(path: string, content: string): Promise<void>;
  exec(command: string, cwd: string, timeoutSec: number): Promise<ExecOutcome>;
};

export type RemoteSandboxFleet = {
  create(agentId: string): Promise<RemoteSandbox>;
  reconnect(sandboxId: string): Promise<RemoteSandbox | null>;
  /** Delete a sandbox this process created but lost the race to save. */
  destroy(sandboxId: string): Promise<void>;
};

export type DaytonaSettings = {
  apiKey: string;
  apiUrl?: string;
  target?: string;
};

export function readDaytonaSettings(
  env: Record<string, string | undefined>,
): DaytonaSettings | null {
  const apiKey = env.DAYTONA_API_KEY?.trim() ?? "";
  if (!apiKey) return null;
  const settings: DaytonaSettings = { apiKey };
  const apiUrl = env.DAYTONA_API_URL?.trim();
  const target = env.DAYTONA_TARGET?.trim();
  if (apiUrl) settings.apiUrl = apiUrl;
  if (target) settings.target = target;
  return settings;
}

export function daytonaCreateParams(agentId: string): {
  language: "python";
  image: ReturnType<typeof sandboxImage>;
  labels: { app: "mockbot"; agentId: string };
} {
  return {
    language: "python",
    image: sandboxImage(),
    labels: { app: "mockbot", agentId },
  };
}

export class DaytonaRuntime implements SandboxRuntime {
  readonly kind = "daytona" as const;
  readonly #handles = new Map<string, RemoteSandbox>();
  readonly #opening = new Map<string, Promise<RemoteSandbox | null>>();

  constructor(
    private readonly fleet: RemoteSandboxFleet,
    private readonly store: SandboxStore,
    private readonly secret: string,
  ) {}

  async list(agentId: string, path: string) {
    try {
      const handle = await this.#handle(agentId, false);
      if (!handle) return { ok: true as const, entries: [] };
      const ready = await this.#running(agentId, handle);
      return await ready.list(toSandboxPath(path));
    } catch (error) {
      return { ok: false as const, error: redact(errorText(error), this.secret) };
    }
  }

  async read(agentId: string, path: string, signal?: AbortSignal) {
    try {
      throwIfAborted(signal);
      const handle = await withSignal(this.#require(agentId), signal);
      return await withSignal(handle.read(toSandboxPath(path)), signal);
    } catch (error) {
      if (isAbortError(error)) throw error;
      return { ok: false as const, error: redact(errorText(error), this.secret) };
    }
  }

  async write(agentId: string, path: string, content: string) {
    try {
      const handle = await this.#require(agentId);
      await handle.write(toSandboxPath(path), content);
      return { ok: true as const };
    } catch (error) {
      return { ok: false as const, error: redact(errorText(error), this.secret) };
    }
  }

  async prepare(agentId: string, signal?: AbortSignal): Promise<void> {
    try {
      throwIfAborted(signal);
      await withSignal(this.#require(agentId), signal);
    } catch (error) {
      if (isAbortError(error)) throw error;
      throw redactError(error, this.secret);
    }
  }

  async exec(
    agentId: string,
    command: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<ExecOutcome> {
    throwIfAborted(signal);
    const handle = this.#handles.get(agentId);
    if (!handle) throw new Error("Sandbox is unavailable");
    const timeoutSec = Math.max(1, Math.ceil(timeoutMs / 1000));
    try {
      return await withSignal(handle.exec(command, "workspace", timeoutSec), signal);
    } catch (error) {
      if (isAbortError(error)) throw error;
      throw redactError(error, this.secret);
    }
  }

  async #require(agentId: string): Promise<RemoteSandbox> {
    const handle = await this.#handle(agentId, true);
    if (!handle) throw new Error("Sandbox is unavailable");
    return this.#running(agentId, handle);
  }

  async #running(agentId: string, handle: RemoteSandbox): Promise<RemoteSandbox> {
    try {
      await handle.ensureRunning();
      return handle;
    } catch (error) {
      if (this.#handles.get(agentId) === handle) this.#handles.delete(agentId);
      const computer = await this.store.getComputer(agentId);
      if (!computer?.sandboxId) throw error;
      const restored = await this.fleet.reconnect(computer.sandboxId);
      if (!restored) throw error;
      this.#handles.set(agentId, restored);
      return restored;
    }
  }

  async #handle(agentId: string, create: boolean): Promise<RemoteSandbox | null> {
    const cached = this.#handles.get(agentId);
    if (cached) return cached;
    const opening = this.#opening.get(agentId);
    if (opening) {
      const handle = await opening;
      if (handle || !create) return handle;
      return this.#handle(agentId, true);
    }
    const pending = this.#open(agentId, create);
    this.#opening.set(agentId, pending);
    try {
      return await pending;
    } finally {
      if (this.#opening.get(agentId) === pending) this.#opening.delete(agentId);
    }
  }

  async #open(agentId: string, create: boolean): Promise<RemoteSandbox | null> {
    const computer = await this.store.ensureComputer(agentId, "daytona");
    let handle: RemoteSandbox | null = null;
    if (computer.sandboxId) handle = await this.fleet.reconnect(computer.sandboxId);
    if (!handle && !create) return null;
    if (!handle) handle = await this.#createClaimed(agentId, computer.sandboxId);
    this.#handles.set(agentId, handle);
    return handle;
  }

  /**
   * Create a sandbox and save it only if no other process saved one first.
   * The in-process opening map cannot see other serverless instances, so the
   * database decides. The loser deletes its sandbox and uses the winner's.
   */
  async #createClaimed(agentId: string, stale: string | null): Promise<RemoteSandbox> {
    const created = await this.fleet.create(agentId);
    const saved = await this.store.claimSandboxId(agentId, created.id, stale);
    if (saved === created.id) return created;
    await this.fleet.destroy(created.id).catch(() => undefined);
    const winner = saved ? await this.fleet.reconnect(saved) : null;
    if (!winner) throw new Error("Sandbox is unavailable");
    return winner;
  }
}

export async function createSdkFleet(
  env: Record<string, string | undefined>,
): Promise<RemoteSandboxFleet> {
  const settings = readDaytonaSettings(env);
  if (!settings) throw new Error("DAYTONA_API_KEY is required");
  const sdk = await import("@daytonaio/sdk");
  const daytona = new sdk.Daytona({
    apiKey: settings.apiKey,
    ...(settings.apiUrl ? { apiUrl: settings.apiUrl } : {}),
    ...(settings.target ? { target: settings.target } : {}),
  });
  const isTimeout = (error: unknown) =>
    error instanceof sdk.DaytonaTimeoutError || isTimeoutError(error);
  return new SdkFleet(daytona, settings.apiKey, sdk.SandboxState.STARTED, isTimeout);
}

class SdkFleet implements RemoteSandboxFleet {
  constructor(
    private readonly daytona: Daytona,
    private readonly secret: string,
    private readonly started: string,
    private readonly isTimeout: (error: unknown) => boolean,
  ) {}

  async create(agentId: string): Promise<RemoteSandbox> {
    const sandbox = await this.daytona.create(daytonaCreateParams(agentId), daytonaCreateOptions());
    return this.adapt(sandbox);
  }

  async reconnect(sandboxId: string): Promise<RemoteSandbox | null> {
    try {
      const sandbox = await this.daytona.get(sandboxId);
      await sandbox.refreshData();
      if (sandbox.state !== this.started) await sandbox.start(60);
      return await this.adapt(sandbox);
    } catch (error) {
      redactError(error, this.secret);
      return null;
    }
  }

  async destroy(sandboxId: string): Promise<void> {
    try {
      const sandbox = await this.daytona.get(sandboxId);
      await this.daytona.delete(sandbox);
    } catch (error) {
      throw redactError(error, this.secret);
    }
  }

  private async adapt(sandbox: Sandbox): Promise<RemoteSandbox> {
    const secret = this.secret;
    const isTimeout = this.isTimeout;
    const started = this.started;
    await sandbox.process.executeCommand("mkdir -p workspace", undefined, undefined, 15);
    await provisionSandboxToolchain((command, timeoutSec) =>
      runSandboxCommand(sandbox, command, timeoutSec),
    );
    return {
      id: sandbox.id,
      async ensureRunning() {
        await sandbox.refreshData();
        if (sandbox.state !== started) await sandbox.start(60);
      },
      async list(dir: string) {
        try {
          const entries = await sandbox.fs.listFiles(dir);
          return {
            ok: true as const,
            entries: entries.map((entry) => ({
              name: entry.name,
              kind: entry.isDir ? ("dir" as const) : ("file" as const),
              size: entry.size,
              modifiedAt: entry.modifiedAt,
            })),
          };
        } catch (error) {
          return { ok: false as const, error: redact(errorText(error), secret) };
        }
      },
      async read(remotePath: string) {
        try {
          const bytes = await sandbox.fs.downloadFile(remotePath);
          return { ok: true as const, content: Buffer.from(bytes).toString("utf8") };
        } catch (error) {
          return { ok: false as const, error: redact(errorText(error), secret) };
        }
      },
      async write(remotePath: string, content: string) {
        const parent = remotePath.split("/").slice(0, -1).join("/");
        if (parent) {
          await sandbox.process.executeCommand(
            `mkdir -p ${quotePosix(parent)}`,
            undefined,
            undefined,
            15,
          );
        }
        await sandbox.fs.uploadFile(Buffer.from(content), remotePath);
      },
      async exec(command: string, cwd: string, timeoutSec: number): Promise<ExecOutcome> {
        try {
          const response = await sandbox.process.executeCommand(
            command,
            cwd,
            undefined,
            timeoutSec,
          );
          return {
            stdout: response.result ?? "",
            stderr: "",
            exitCode: response.exitCode,
            timedOut: false,
          };
        } catch (error) {
          if (isTimeout(error)) {
            return { stdout: "", stderr: "", exitCode: null, timedOut: true };
          }
          throw redactError(error, secret);
        }
      },
    };
  }
}

async function runSandboxCommand(
  sandbox: Sandbox,
  command: string,
  timeoutSec: number,
): Promise<SandboxCommandResult> {
  const response = await sandbox.process.executeCommand(command, undefined, undefined, timeoutSec);
  return { exitCode: response.exitCode, stdout: response.result ?? "", stderr: "" };
}

function quotePosix(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : "Sandbox request failed";
}

function redact(value: string, secret: string): string {
  if (!secret) return value;
  return value.split(secret).join("[redacted]");
}

function redactError(error: unknown, secret: string): Error {
  return new Error(redact(errorText(error), secret));
}

function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && /Timeout/i.test(error.name);
}
