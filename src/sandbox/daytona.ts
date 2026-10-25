import type { Daytona, Sandbox } from "@daytonaio/sdk";
import { toSandboxPath } from "./limits";
import type { ExecOutcome, SandboxEntry, SandboxRuntime } from "./runtime";
import type { SandboxStore } from "./store";

export type RemoteRead = { ok: true; content: string } | { ok: false; error: string };

export type RemoteSandbox = {
  readonly id: string;
  list(path: string): Promise<{ ok: true; entries: SandboxEntry[] } | { ok: false; error: string }>;
  read(path: string): Promise<RemoteRead>;
  write(path: string, content: string): Promise<void>;
  exec(command: string, cwd: string, timeoutSec: number): Promise<ExecOutcome>;
};

export type RemoteSandboxFleet = {
  create(agentId: string): Promise<RemoteSandbox>;
  reconnect(sandboxId: string): Promise<RemoteSandbox | null>;
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
  labels: { app: "mockbot"; agentId: string };
} {
  return { language: "python", labels: { app: "mockbot", agentId } };
}

export class DaytonaRuntime implements SandboxRuntime {
  readonly kind = "daytona" as const;
  readonly #handles = new Map<string, RemoteSandbox>();

  constructor(
    private readonly fleet: RemoteSandboxFleet,
    private readonly store: SandboxStore,
    private readonly secret: string,
  ) {}

  async list(agentId: string, path: string) {
    try {
      const handle = await this.#handle(agentId, false);
      if (!handle) return { ok: true as const, entries: [] };
      return await handle.list(toSandboxPath(path));
    } catch (error) {
      return { ok: false as const, error: redact(errorText(error), this.secret) };
    }
  }

  async read(agentId: string, path: string) {
    try {
      const handle = await this.#require(agentId);
      return await handle.read(toSandboxPath(path));
    } catch (error) {
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

  async exec(agentId: string, command: string, timeoutMs: number): Promise<ExecOutcome> {
    try {
      const handle = await this.#require(agentId);
      const timeoutSec = Math.max(1, Math.ceil(timeoutMs / 1000));
      return await handle.exec(command, "workspace", timeoutSec);
    } catch (error) {
      throw redactError(error, this.secret);
    }
  }

  async #require(agentId: string): Promise<RemoteSandbox> {
    const handle = await this.#handle(agentId, true);
    if (!handle) throw new Error("Sandbox is unavailable");
    return handle;
  }

  async #handle(agentId: string, create: boolean): Promise<RemoteSandbox | null> {
    const cached = this.#handles.get(agentId);
    if (cached) return cached;
    const computer = await this.store.ensureComputer(agentId, "daytona");
    let handle: RemoteSandbox | null = null;
    if (computer.sandboxId) handle = await this.fleet.reconnect(computer.sandboxId);
    if (!handle && !create) return null;
    if (!handle) {
      handle = await this.fleet.create(agentId);
      await this.store.setSandboxId(agentId, handle.id);
    }
    this.#handles.set(agentId, handle);
    return handle;
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
    const sandbox = await this.daytona.create(daytonaCreateParams(agentId));
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

  private async adapt(sandbox: Sandbox): Promise<RemoteSandbox> {
    const secret = this.secret;
    const isTimeout = this.isTimeout;
    await sandbox.process.executeCommand("mkdir -p workspace", undefined, undefined, 15);
    return {
      id: sandbox.id,
      async list(dir: string) {
        try {
          const entries = await sandbox.fs.listFiles(dir);
          return {
            ok: true as const,
            entries: entries.map((entry) => ({
              name: entry.name,
              kind: entry.isDir ? ("dir" as const) : ("file" as const),
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
