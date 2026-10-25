import type { ExecOutcome, SandboxEntry } from "./runtime";
import type { ComputerToolResult } from "./types";

export function formatFailure(message: string): ComputerToolResult {
  return { content: `${message}\nexit_code: 1`, isError: true };
}

export function formatWriteResult(path: string): ComputerToolResult {
  return { content: `Wrote ${path}\nchanged: ${path}\nexit_code: 0` };
}

export function formatReadResult(path: string, content: string): ComputerToolResult {
  return { content: `${path}\nexit_code: 0\n${content}` };
}

export function formatListResult(entries: SandboxEntry[]): ComputerToolResult {
  const lines = entries.map((entry) => (entry.kind === "dir" ? `${entry.name}/` : entry.name));
  return { content: ["exit_code: 0", ...lines].join("\n") };
}

export function formatExecResult(command: string, outcome: ExecOutcome): ComputerToolResult {
  const exit = outcome.timedOut || outcome.exitCode == null ? "null" : String(outcome.exitCode);
  const parts = [`$ ${command}`];
  if (outcome.timedOut) parts.push("The command exceeded the time limit and was killed.");
  parts.push(`exit_code: ${exit}`);
  if (outcome.stdout.trim()) parts.push(outcome.stdout.replace(/\s+$/, ""));
  if (outcome.stderr.trim()) parts.push(outcome.stderr.replace(/\s+$/, ""));
  const failed = outcome.timedOut || outcome.exitCode !== 0;
  return failed ? { content: parts.join("\n"), isError: true } : { content: parts.join("\n") };
}

export function killedMessage(timeoutMs: number): string {
  return `The command exceeded ${timeoutMs}ms and was killed.`;
}
