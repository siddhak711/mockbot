// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  ComputerPane,
  classifyRun,
  exploredLabel,
  filesChanged,
  previewOutput,
} from "../components/computer-pane";
import { SidePane } from "../components/side-pane";
import type { ComputerSnapshot, SandboxRun } from "../src/sandbox/types";

afterEach(() => {
  cleanup();
});

function run(overrides: Partial<SandboxRun> & Pick<SandboxRun, "id" | "tool">): SandboxRun {
  return {
    agentId: "agent",
    command: null,
    arguments: {},
    stdout: "",
    stderr: "",
    exitCode: 0,
    timedOut: false,
    changedFiles: [],
    createdAt: "2026-10-26T00:00:00.000Z",
    ...overrides,
  };
}

describe("run classification", () => {
  it("treats writes and file-changing commands as changes", () => {
    expect(classifyRun(run({ id: "w", tool: "write", arguments: { path: "a.ts" } }))).toBe(
      "change",
    );
    expect(
      classifyRun(
        run({
          id: "e",
          tool: "exec",
          command: "node build.js",
          changedFiles: ["dist/app.js"],
        }),
      ),
    ).toBe("change");
    expect(
      classifyRun(
        run({
          id: "c",
          tool: "exec",
          command: "cat hello.txt",
          changedFiles: ["hello.txt"],
        }),
      ),
    ).toBe("change");
  });

  it("folds reads, listings, and lookup commands into noise", () => {
    expect(classifyRun(run({ id: "r", tool: "read", arguments: { path: "a.ts" } }))).toBe("noise");
    expect(classifyRun(run({ id: "l", tool: "list", arguments: { path: "." } }))).toBe("noise");
    for (const command of [
      "grep -n foo src",
      "cat hello.txt",
      "ls -la",
      "wc -l notes.txt",
      "sed -n 1p a",
      "head -n 5 a",
      "tail -n 5 a",
      "pwd",
      "/usr/bin/ls",
      "node --version",
    ]) {
      expect(classifyRun(run({ id: command, tool: "exec", command })), command).toBe("noise");
    }
    expect(classifyRun(run({ id: "echo", tool: "exec", command: "echo hi" }))).toBe("command");
    expect(classifyRun(run({ id: "lsof", tool: "exec", command: "lsof -i" }))).toBe("command");
  });

  it("dedupes the files-changed summary onto the newest run", () => {
    const runs = [
      run({ id: "new", tool: "exec", command: "revise", changedFiles: ["a.ts", "b.ts"] }),
      run({ id: "old", tool: "write", changedFiles: ["a.ts", "c.ts"] }),
    ];
    expect(filesChanged(runs)).toEqual([
      { path: "a.ts", runId: "new" },
      { path: "b.ts", runId: "new" },
      { path: "c.ts", runId: "old" },
    ]);
    expect(exploredLabel(runs)).toBeNull();
  });
});

describe("computer trace", () => {
  const runs = [
    run({ id: "echo", tool: "exec", command: "echo hi", stdout: "hi" }),
    run({ id: "cat", tool: "exec", command: "cat hello.txt", stdout: "hello" }),
    run({ id: "read", tool: "read", arguments: { path: "src/app.ts" }, stdout: "export {}" }),
    run({
      id: "build",
      tool: "exec",
      command: "node build.js",
      stdout: "built",
      changedFiles: ["dist/app.js"],
    }),
    run({ id: "list", tool: "list", arguments: { path: "." }, stdout: "a.ts" }),
    run({
      id: "write",
      tool: "write",
      arguments: { path: "a.ts" },
      stdout: "Wrote a.ts",
      changedFiles: ["a.ts"],
    }),
  ];

  function snapshot(): ComputerSnapshot {
    return {
      provider: "mock",
      computer: {
        id: "computer",
        agentId: "agent",
        provider: "mock",
        createdAt: "2026-10-26T00:00:00.000Z",
      },
      files: [
        { path: "a.ts", kind: "file" },
        { path: "dist/app.js", kind: "file" },
        { path: "notes/deep.txt", kind: "file" },
      ],
      runs,
    };
  }

  it("labels mock and Daytona output inside the side pane", () => {
    const props = {
      tab: "computer" as const,
      onTab: () => {},
      memories: [],
      memoryError: null,
      agentId: "agent",
      onMemoriesChanged: async () => {},
    };
    const { rerender } = render(<SidePane {...props} snapshot={snapshot()} />);
    expect(screen.getByText("Mock sandbox")).toBeTruthy();
    rerender(<SidePane {...props} snapshot={{ ...snapshot(), provider: "daytona" }} />);
    expect(screen.getByText("Daytona sandbox")).toBeTruthy();
    expect(screen.queryByText("Mock sandbox")).toBeNull();
  });

  it("shows files changed, keeps the full tree folded, and collapses reads", () => {
    render(<ComputerPane snapshot={snapshot()} />);

    expect(screen.getByRole("region", { name: "Files changed" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "dist/app.js" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "a.ts" })).toBeTruthy();
    expect(screen.queryByText("notes/deep.txt")).toBeNull();
    expect(exploredLabel(runs)).toBe("Explored 2 files / 1 command");

    const list = screen.getByRole("list", { name: "Sandbox runs" });
    expect(within(list).getByText("Explored 2 files / 1 command")).toBeTruthy();
    expect(within(list).getByText("echo hi")).toBeTruthy();
    expect(within(list).getByText("node build.js")).toBeTruthy();
    expect(within(list).getByText("write a.ts")).toBeTruthy();
    expect(within(list).queryByText("cat hello.txt")).toBeNull();
    expect(within(list).queryByText("read src/app.ts")).toBeNull();

    fireEvent.click(screen.getByText("Explored 2 files / 1 command"));
    expect(within(list).getByText("cat hello.txt")).toBeTruthy();
    expect(within(list).getByText("read src/app.ts")).toBeTruthy();
    expect(within(list).getByText("list .")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "a.ts" }));
    expect(document.querySelector("[data-command]")?.getAttribute("data-command")).toBe(
      "write a.ts",
    );

    fireEvent.click(screen.getByRole("button", { name: "All files" }));
    expect(screen.getByText("notes/deep.txt")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Hide all files" }));
    expect(screen.queryByText("notes/deep.txt")).toBeNull();
  });

  it("expands explored commands when the selected run is inside them", () => {
    const noiseFirst = [
      run({ id: "cat", tool: "exec", command: "cat hello.txt", stdout: "hello" }),
      run({
        id: "write",
        tool: "write",
        arguments: { path: "a.ts" },
        stdout: "Wrote a.ts",
        changedFiles: ["a.ts"],
      }),
    ];
    render(<ComputerPane snapshot={{ ...snapshot(), runs: noiseFirst }} />);
    const list = screen.getByRole("list", { name: "Sandbox runs" });
    expect(within(list).getByText("cat hello.txt")).toBeTruthy();
    expect(within(list).getByText("Hide")).toBeTruthy();

    fireEvent.click(screen.getByText("Hide"));
    expect(within(list).queryByText("cat hello.txt")).toBeNull();
  });

  it("stays collapsed when a refresh rebuilds the same runs", () => {
    const noiseFirst = [
      run({ id: "cat", tool: "exec", command: "cat hello.txt", stdout: "hello" }),
      run({
        id: "write",
        tool: "write",
        arguments: { path: "a.ts" },
        stdout: "Wrote a.ts",
        changedFiles: ["a.ts"],
      }),
    ];
    const view = snapshot();
    const { rerender } = render(<ComputerPane snapshot={{ ...view, runs: noiseFirst }} />);
    const list = screen.getByRole("list", { name: "Sandbox runs" });
    fireEvent.click(within(list).getByText("Hide"));
    expect(within(list).queryByText("cat hello.txt")).toBeNull();

    rerender(
      <ComputerPane
        snapshot={{
          ...view,
          runs: noiseFirst.map((item) => ({ ...item, arguments: { ...item.arguments } })),
        }}
      />,
    );
    const refreshed = screen.getByRole("list", { name: "Sandbox runs" });
    expect(within(refreshed).queryByText("cat hello.txt")).toBeNull();
    expect(within(refreshed).getByText("Show")).toBeTruthy();
  });

  it("truncates long output until it is expanded", () => {
    const lines = Array.from({ length: 24 }, (_, index) => `line-${index + 1}`);
    lines.push("TAIL_MARKER");
    const stdout = lines.join("\n");
    const long = run({
      id: "read-long",
      tool: "read",
      arguments: { path: "notes/deep.txt" },
      stdout,
    });
    const preview = previewOutput(stdout);
    expect(preview.truncated).toBe(true);
    expect(preview.text).not.toContain("TAIL_MARKER");

    render(
      <ComputerPane
        snapshot={{
          ...snapshot(),
          runs: [long],
          files: [{ path: "notes/deep.txt", kind: "file" }],
        }}
      />,
    );

    const output = document.querySelector("[data-output='true']");
    expect(output?.getAttribute("data-truncated")).toBe("true");
    expect(output?.textContent).toContain("line-1");
    expect(output?.textContent).not.toContain("TAIL_MARKER");

    fireEvent.click(screen.getByRole("button", { name: "Show full output" }));
    expect(document.querySelector("[data-output='true']")?.textContent).toContain("TAIL_MARKER");
    expect(document.querySelector("[data-output='true']")?.getAttribute("data-truncated")).toBe(
      "false",
    );

    fireEvent.click(screen.getByRole("button", { name: "Show less" }));
    expect(document.querySelector("[data-output='true']")?.textContent).not.toContain(
      "TAIL_MARKER",
    );
  });
});
