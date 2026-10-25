export type SandboxProviderKind = "mock" | "daytona";

export type ComputerToolName = "list" | "read" | "write" | "exec";

export type ComputerFile = {
  path: string;
  kind: "file" | "dir";
};

export type ComputerInfo = {
  id: string;
  agentId: string;
  provider: SandboxProviderKind;
  createdAt: string;
};

export type SandboxRun = {
  id: string;
  agentId: string;
  tool: ComputerToolName;
  command: string | null;
  arguments: Record<string, string>;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  changedFiles: string[];
  createdAt: string;
};

export type ComputerSnapshot = {
  provider: SandboxProviderKind;
  computer: ComputerInfo;
  files: ComputerFile[];
  runs: SandboxRun[];
};

export type ComputerToolResult = {
  content: string;
  isError?: boolean;
};
