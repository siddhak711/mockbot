import { describe, expect, it } from "vitest";
import {
  provisionSandboxToolchain,
  sandboxToolCheckCommand,
  sandboxToolInstallCommand,
  type SandboxCommandResult,
} from "../src/sandbox/toolchain";

function ok(stdout = ""): SandboxCommandResult {
  return { exitCode: 0, stdout, stderr: "" };
}

describe("sandbox toolchain", () => {
  it("leaves a sandbox alone when the CLI tools already resolve", async () => {
    const commands: string[] = [];
    await provisionSandboxToolchain(async (command) => {
      commands.push(command);
      expect(command).toBe(sandboxToolCheckCommand());
      return ok("grep 3.11\nv22.0.0\n10.0.0\nPython 3.12.10\ngit version 2.39.5\n");
    });
    expect(commands).toEqual([sandboxToolCheckCommand()]);
  });

  it("installs the CLI when a tool is missing, then confirms the versions", async () => {
    const commands: string[] = [];
    await provisionSandboxToolchain(async (command) => {
      commands.push(command);
      if (commands.length === 1) return { exitCode: 127, stdout: "", stderr: "node: not found" };
      if (commands.length === 2) {
        expect(command).toBe(sandboxToolInstallCommand());
        return ok("installed");
      }
      return ok("grep (GNU grep) 3.11\nv18.20.4\n9.2.0\nPython 3.12.10\ngit version 2.39.5\n");
    });
    expect(commands).toEqual([
      sandboxToolCheckCommand(),
      sandboxToolInstallCommand(),
      sandboxToolCheckCommand(),
    ]);
  });

  it("reports an apt failure instead of leaving the sandbox without tools", async () => {
    await expect(
      provisionSandboxToolchain(async (command) => {
        if (command === sandboxToolCheckCommand()) {
          return { exitCode: 127, stdout: "", stderr: "grep: not found" };
        }
        return { exitCode: 100, stdout: "", stderr: "E: Unable to locate package nodejs" };
      }),
    ).rejects.toThrow(
      /toolchain install failed \(exit 100\)[\s\S]*Unable to locate package nodejs/,
    );
  });

  it("reports a check that still fails after the packages are installed", async () => {
    let calls = 0;
    await expect(
      provisionSandboxToolchain(async (command) => {
        calls += 1;
        if (command === sandboxToolInstallCommand()) return ok("installed");
        return { exitCode: 127, stdout: "", stderr: "python3: not found" };
      }),
    ).rejects.toThrow(/still missing after install \(exit 127\)[\s\S]*python3: not found/);
    expect(calls).toBe(3);
  });
});
