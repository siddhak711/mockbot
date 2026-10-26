// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ComputerPane, filesChanged } from "../components/computer-pane";
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

describe("files changed", () => {
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
  });
});

describe("computer pane", () => {
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

  it("shows files changed and the all-files toggle, and nothing below them", () => {
    render(<ComputerPane snapshot={snapshot()} />);

    expect(screen.getByRole("region", { name: "Files changed" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "dist/app.js" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "a.ts" })).toBeTruthy();
    expect(screen.queryByText("notes/deep.txt")).toBeNull();

    expect(screen.queryByRole("list", { name: "Sandbox runs" })).toBeNull();
    expect(screen.queryByRole("list", { name: "Tool calls" })).toBeNull();
    expect(screen.queryByRole("list", { name: "Explored commands" })).toBeNull();
    expect(screen.queryByText(/Explored \d/)).toBeNull();
    expect(screen.queryByText("echo hi")).toBeNull();
    expect(screen.queryByText("cat hello.txt")).toBeNull();
    expect(screen.queryByText("node build.js")).toBeNull();
    expect(screen.queryByText("write a.ts")).toBeNull();
    expect(screen.queryByText("Command")).toBeNull();
    expect(screen.queryByText("Exit code")).toBeNull();
    expect(screen.queryByRole("heading", { name: "Output" })).toBeNull();
    expect(screen.queryByText("Arguments")).toBeNull();
    expect(screen.queryByText("Result")).toBeNull();
    expect(screen.queryByText("Done")).toBeNull();
    expect(screen.queryByText("Failed")).toBeNull();
    expect(document.querySelector("[data-command]")).toBeNull();
    expect(document.querySelector("[data-output]")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "a.ts" }));
    expect(screen.getByRole("button", { name: "a.ts" }).className).toContain("on");
    expect(screen.queryByText("write a.ts")).toBeNull();
    expect(screen.queryByText("Wrote a.ts")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "All files" }));
    expect(screen.getByRole("list", { name: "All sandbox files" })).toBeTruthy();
    expect(screen.getByText("notes/deep.txt")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Hide all files" }));
    expect(screen.queryByText("notes/deep.txt")).toBeNull();
  });

  it("keeps the file highlight when a refresh rebuilds the same runs", () => {
    const { rerender } = render(<ComputerPane snapshot={snapshot()} />);
    fireEvent.click(screen.getByRole("button", { name: "a.ts" }));
    expect(screen.getByRole("button", { name: "a.ts" }).className).toContain("on");

    rerender(
      <ComputerPane
        snapshot={{
          ...snapshot(),
          runs: runs.map((item) => ({ ...item, arguments: { ...item.arguments } })),
        }}
      />,
    );
    expect(screen.getByRole("button", { name: "a.ts" }).className).toContain("on");
    expect(screen.queryByRole("list", { name: "Sandbox runs" })).toBeNull();
  });

  it("stops after the files section when nothing has changed", () => {
    render(<ComputerPane />);
    expect(screen.getByRole("region", { name: "Files changed" })).toBeTruthy();
    expect(screen.getByText("No files changed.")).toBeTruthy();
    expect(screen.queryByRole("list", { name: "Sandbox runs" })).toBeNull();
    expect(screen.queryByRole("list", { name: "Tool calls" })).toBeNull();
    expect(screen.queryByText("Arguments")).toBeNull();
    expect(screen.queryByText("Result")).toBeNull();
    expect(screen.queryByText("Nothing has run")).toBeNull();
  });
});
