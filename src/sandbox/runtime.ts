export type SandboxEntry = {
  name: string;
  kind: "file" | "dir";
};

export type ExecOutcome = {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
};

export type SandboxRuntime = {
  readonly kind: "mock" | "daytona";
  list(
    agentId: string,
    path: string,
  ): Promise<{ ok: true; entries: SandboxEntry[] } | { ok: false; error: string }>;
  read(
    agentId: string,
    path: string,
  ): Promise<{ ok: true; content: string } | { ok: false; error: string }>;
  write(
    agentId: string,
    path: string,
    content: string,
  ): Promise<{ ok: true } | { ok: false; error: string }>;
  prepare(agentId: string, signal?: AbortSignal): Promise<void>;
  exec(
    agentId: string,
    command: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<ExecOutcome>;
};
