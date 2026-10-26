import { Image } from "@daytonaio/sdk";

/** Official Python slim image. Daytona's default snapshot does not include these CLIs. */
export const SANDBOX_BASE_IMAGE = "python:3.12-slim-bookworm";

/** Apt packages that provide the sandbox CLI. `sed` is its own package, not coreutils. */
export const SANDBOX_APT_PACKAGES = [
  "ca-certificates",
  "coreutils",
  "grep",
  "sed",
  "git",
  "python3",
  "nodejs",
  "npm",
] as const;

/** Binaries that must resolve on PATH inside every sandbox. */
export const SANDBOX_CLI_TOOLS = [
  "ls",
  "cat",
  "wc",
  "head",
  "tail",
  "sed",
  "grep",
  "node",
  "npm",
  "python3",
  "git",
] as const;

export const SANDBOX_TOOL_CHECK_TIMEOUT_SEC = 30;
export const SANDBOX_TOOL_INSTALL_TIMEOUT_SEC = 600;

/** Image builds can outlive the SDK's 60s default. 0 waits until Daytona finishes. */
export const DAYTONA_IMAGE_BUILD_TIMEOUT_SEC = 0;

export type SandboxCommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

export type SandboxCommandRunner = (
  command: string,
  timeoutSec: number,
) => Promise<SandboxCommandResult>;

export function sandboxToolCheckCommand(): string {
  const present = SANDBOX_CLI_TOOLS.map((tool) => `command -v ${tool}`).join(" && ");
  const versions = [
    "grep --version",
    "node --version",
    "npm --version",
    "python3 --version",
    "git --version",
  ].join(" && ");
  return `${present} && ${versions}`;
}

/**
 * Installs the CLI as root, or with passwordless sudo when the sandbox user is not root.
 * One shell command so a single image layer (or one startup exec) either finishes or fails.
 * `sudo` drops the caller's environment, so `DEBIAN_FRONTEND` is set inside the script
 * that both branches run. Otherwise debconf can prompt and hang the repair.
 */
export function sandboxToolInstallCommand(): string {
  const packages = SANDBOX_APT_PACKAGES.join(" ");
  const install = `export DEBIAN_FRONTEND=noninteractive && apt-get update && apt-get install -y --no-install-recommends ${packages} && rm -rf /var/lib/apt/lists/*`;
  return `if [ "$(id -u)" -eq 0 ]; then ${install}; else sudo -n sh -c '${install}'; fi`;
}

export function sandboxImage(): Image {
  return Image.base(SANDBOX_BASE_IMAGE).runCommands(
    sandboxToolInstallCommand(),
    sandboxToolCheckCommand(),
  );
}

export function daytonaCreateOptions(): { timeout: number } {
  return { timeout: DAYTONA_IMAGE_BUILD_TIMEOUT_SEC };
}

/**
 * Makes sure the CLI is on PATH. New sandboxes already have it from the image.
 * A sandbox created from the old default snapshot is repaired once, before any agent command.
 */
export async function provisionSandboxToolchain(run: SandboxCommandRunner): Promise<void> {
  const check = await run(sandboxToolCheckCommand(), SANDBOX_TOOL_CHECK_TIMEOUT_SEC);
  if (check.exitCode === 0) return;

  const install = await run(sandboxToolInstallCommand(), SANDBOX_TOOL_INSTALL_TIMEOUT_SEC);
  if (install.exitCode !== 0) {
    throw new Error(
      `Sandbox toolchain install failed (exit ${install.exitCode}): ${commandOutput(install)}`,
    );
  }

  const again = await run(sandboxToolCheckCommand(), SANDBOX_TOOL_CHECK_TIMEOUT_SEC);
  if (again.exitCode !== 0) {
    throw new Error(
      `Sandbox toolchain is still missing after install (exit ${again.exitCode}): ${commandOutput(again)}`,
    );
  }
}

function commandOutput(result: SandboxCommandResult): string {
  const text = `${result.stderr}\n${result.stdout}`.trim();
  if (!text) return "no output";
  return text.length > 500 ? text.slice(-500) : text;
}
