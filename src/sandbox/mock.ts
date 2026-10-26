import { throwIfAborted } from "./abort";
import { resolveWorkspacePath } from "./limits";
import type { ExecOutcome, SandboxEntry, SandboxRuntime } from "./runtime";
import type { SandboxStore } from "./store";

const SANDBOX_ENV = {
  HOME: "/workspace",
  PWD: "/workspace",
};

/** Marks a sandbox tool result so the UI can badge a mock fallback. */
export function mockToolContent(content: string): string {
  const marker = '{"provider":"mock"}';
  if (content === marker || content.startsWith(`${marker}\n`)) return content;
  return `${marker}\n${content}`;
}

export class MockSandboxRuntime implements SandboxRuntime {
  readonly kind = "mock" as const;

  constructor(private readonly store: SandboxStore) {}

  async list(agentId: string, path: string) {
    const paths = await this.store.listPaths(agentId);
    if (path && paths.includes(path))
      return { ok: false as const, error: `Not a directory: ${path}` };
    if (path && !paths.some((item) => item.startsWith(`${path}/`))) {
      return { ok: false as const, error: `No such directory: ${path}` };
    }
    return { ok: true as const, entries: directChildren(paths, path) };
  }

  async read(agentId: string, path: string) {
    const paths = await this.store.listPaths(agentId);
    if (paths.some((item) => item.startsWith(`${path}/`))) {
      return { ok: false as const, error: `Is a directory: ${path}` };
    }
    const content = await this.store.readFile(agentId, path);
    if (content == null) return { ok: false as const, error: `No such file: ${path}` };
    return { ok: true as const, content };
  }

  async write(agentId: string, path: string, content: string) {
    await this.store.writeFile(agentId, path, content);
    return { ok: true as const };
  }

  async prepare(_agentId: string, signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal);
  }

  async exec(
    agentId: string,
    command: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<ExecOutcome> {
    throwIfAborted(signal);
    const tokens = tokenize(command);
    if ("error" in tokens) {
      return { stdout: "", stderr: tokens.error, exitCode: 126, timedOut: false };
    }
    const [name, ...args] = tokens;
    if (!name) return { stdout: "", stderr: "Command is empty.", exitCode: 126, timedOut: false };
    if (name === "echo") {
      return { stdout: `${args.join(" ")}\n`, stderr: "", exitCode: 0, timedOut: false };
    }
    if (name === "pwd") {
      return { stdout: "/workspace\n", stderr: "", exitCode: 0, timedOut: false };
    }
    if (name === "printenv" || name === "env") return printEnv(args);
    if (name === "sleep") return sleepCommand(args, timeoutMs);
    if (name === "ls") return this.listCommand(agentId, args);
    if (name === "cat") return this.catCommand(agentId, args);
    return { stdout: "", stderr: `${name}: command not found`, exitCode: 127, timedOut: false };
  }

  private async listCommand(agentId: string, args: string[]): Promise<ExecOutcome> {
    if (args.length > 1) {
      return { stdout: "", stderr: "ls: too many arguments", exitCode: 1, timedOut: false };
    }
    const resolved = resolveWorkspacePath(args[0] ?? ".");
    if ("error" in resolved) {
      return { stdout: "", stderr: resolved.error, exitCode: 1, timedOut: false };
    }
    const listed = await this.list(agentId, resolved.path);
    if (!listed.ok) return { stdout: "", stderr: listed.error, exitCode: 1, timedOut: false };
    const text = listed.entries
      .map((entry) => (entry.kind === "dir" ? `${entry.name}/` : entry.name))
      .join("\n");
    return { stdout: text ? `${text}\n` : "", stderr: "", exitCode: 0, timedOut: false };
  }

  private async catCommand(agentId: string, args: string[]): Promise<ExecOutcome> {
    if (args.length !== 1) {
      return { stdout: "", stderr: "cat: expected one file", exitCode: 1, timedOut: false };
    }
    const target = args[0] ?? "";
    const resolved = resolveWorkspacePath(target);
    if ("error" in resolved || !resolved.path) {
      return {
        stdout: "",
        stderr: "error" in resolved ? resolved.error : "cat: expected one file",
        exitCode: 1,
        timedOut: false,
      };
    }
    const file = await this.read(agentId, resolved.path);
    if (!file.ok)
      return {
        stdout: "",
        stderr: `cat: ${resolved.path}: No such file`,
        exitCode: 1,
        timedOut: false,
      };
    return { stdout: file.content, stderr: "", exitCode: 0, timedOut: false };
  }
}

function printEnv(args: string[]): ExecOutcome {
  if (args.length === 0) {
    const stdout = Object.entries(SANDBOX_ENV)
      .map(([key, value]) => `${key}=${value}`)
      .join("\n");
    return { stdout: `${stdout}\n`, stderr: "", exitCode: 0, timedOut: false };
  }
  const name = args[0] ?? "";
  const value = SANDBOX_ENV[name as keyof typeof SANDBOX_ENV];
  if (value === undefined) return { stdout: "", stderr: "", exitCode: 1, timedOut: false };
  return { stdout: `${value}\n`, stderr: "", exitCode: 0, timedOut: false };
}

function sleepCommand(args: string[], timeoutMs: number): ExecOutcome {
  const seconds = Number(args[0]);
  if (!Number.isFinite(seconds) || seconds < 0) {
    return { stdout: "", stderr: "sleep: invalid time", exitCode: 1, timedOut: false };
  }
  if (seconds * 1000 > timeoutMs) {
    return { stdout: "", stderr: "", exitCode: null, timedOut: true };
  }
  return { stdout: "", stderr: "", exitCode: 0, timedOut: false };
}

function tokenize(command: string): string[] | { error: string } {
  if (/[|&;<>$`\\\n\r]/.test(command)) {
    return { error: "The sandbox shell only runs one command." };
  }
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  for (const char of command) {
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) tokens.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  if (quote) return { error: "The command has an unclosed quote." };
  if (current) tokens.push(current);
  if (tokens.length === 0) return { error: "Command is empty." };
  return tokens;
}

function directChildren(paths: string[], dir: string): SandboxEntry[] {
  const prefix = dir ? `${dir}/` : "";
  const dirs = new Set<string>();
  const files: string[] = [];
  for (const file of paths) {
    if (dir && file !== dir && !file.startsWith(prefix)) continue;
    const rest = dir ? file.slice(prefix.length) : file;
    if (!rest) continue;
    const slash = rest.indexOf("/");
    if (slash === -1) files.push(rest);
    else dirs.add(rest.slice(0, slash));
  }
  const entries: SandboxEntry[] = [...dirs]
    .sort((left, right) => left.localeCompare(right))
    .map((name) => ({ name, kind: "dir" }));
  for (const name of files.sort((left, right) => left.localeCompare(right))) {
    entries.push({ name, kind: "file" });
  }
  return entries;
}
