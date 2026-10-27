// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  COMPUTER_LOADING_DELAY_MS,
  ComputerPane,
  clampPaneWidth,
  computerPresence,
  filesChanged,
  lineCount,
  providerLabel,
  resizePaneWidth,
  terminalCommand,
  terminalMeta,
  widthForContentTab,
} from "../components/computer-pane";
import { SidePane } from "../components/side-pane";
import { ComputerUnavailableError, fetchComputerSnapshot } from "../src/sandbox/refresh";
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

  it("names the provider and keeps the files list free of phase-2 chrome", () => {
    const onContentTab = vi.fn();
    render(<ComputerPane snapshot={snapshot()} onContentTab={onContentTab} />);

    expect(screen.getByRole("heading", { name: /mockbot's computer/ })).toBeTruthy();
    expect(screen.getByText("· Mock sandbox")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain("Idle");
    expect(screen.getByRole("status").getAttribute("aria-live")).toBe("polite");
    expect(document.querySelector("[data-sprite-state]")?.getAttribute("data-sprite-state")).toBe(
      "idle",
    );
    expect(screen.getByRole("tab", { name: "Files 2" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.queryByRole("button", { name: "Take over" })).toBeNull();
    expect(screen.queryByRole("slider")).toBeNull();
    expect(screen.queryByText("Showing on screen")).toBeNull();

    fireEvent.click(screen.getByRole("tab", { name: "Screen" }));
    expect(onContentTab).toHaveBeenCalledWith("screen");
    expect(screen.getByRole("heading", { name: "Nothing on screen yet" })).toBeTruthy();
    expect(screen.queryByRole("slider")).toBeNull();
    expect(screen.queryByRole("img", { name: /Step/ })).toBeNull();

    fireEvent.click(screen.getByRole("tab", { name: "Browser" }));
    expect(onContentTab).toHaveBeenCalledWith("browser");
    const address = screen.getByRole("textbox", { name: "Address" });
    expect(address.getAttribute("value")).toBe("");
    expect(screen.queryByText("Open on my computer")).toBeNull();
  });

  it("mirrors runs in the terminal, oldest first, without a duration we do not have", () => {
    render(
      <ComputerPane
        snapshot={{
          ...snapshot(),
          runs: [
            run({
              id: "serve",
              tool: "exec",
              command: "node serve.js",
              stdout: "listening on :3000\n",
              stderr: "EADDRINUSE\n",
              exitCode: 1,
              createdAt: "2026-10-26T00:00:02.000Z",
            }),
            run({
              id: "write",
              tool: "write",
              arguments: { path: "a.ts" },
              stdout: "Wrote a.ts",
              changedFiles: ["a.ts"],
              createdAt: "2026-10-26T00:00:01.000Z",
            }),
          ],
        }}
      />,
    );

    fireEvent.click(screen.getByRole("tab", { name: "Terminal" }));
    const blocks = document.querySelectorAll(".computer-term-run");
    expect(blocks[0]?.getAttribute("data-run-id")).toBe("write");
    expect(blocks[1]?.getAttribute("data-run-id")).toBe("serve");
    expect(screen.getAllByText("sandbox:~$")[0]?.className).toContain("computer-term-prompt");
    expect(screen.getByText("EADDRINUSE").className).toContain("computer-term-err");
    expect(screen.getByText("listening on :3000").className).toContain("computer-term-out");
    expect(screen.getByText("exit 1 · duration — · 1 stdout line · 1 stderr line")).toBeTruthy();
    expect(screen.getByText("write a.ts")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Take over" })).toBeNull();
  });

  it("marks a directory with a trailing slash in the full file list", () => {
    const data = snapshot();
    data.files = [{ path: "notes", kind: "dir" }, ...data.files];
    render(<ComputerPane snapshot={data} />);
    fireEvent.click(screen.getByRole("button", { name: "All files" }));
    expect(screen.getByText("notes/")).toBeTruthy();
  });

  it("shows needs help from a sandbox approval and working from a running sandbox tool", () => {
    const { rerender } = render(
      <ComputerPane snapshot={snapshot()} activities={[{ name: "exec", state: "approval" }]} />,
    );
    const help = screen.getByRole("status");
    expect(help.textContent).toContain("Needs help");
    expect(help.getAttribute("aria-live")).toBe("assertive");
    expect(document.querySelector("[data-sprite-state]")?.getAttribute("data-sprite-state")).toBe(
      "thinking",
    );

    rerender(
      <ComputerPane snapshot={snapshot()} activities={[{ name: "write", state: "running" }]} />,
    );
    expect(screen.getByRole("status").textContent).toContain("Working");
    expect(screen.getByRole("status").getAttribute("aria-live")).toBe("polite");
    expect(document.querySelector("[data-sprite-state]")?.getAttribute("data-sprite-state")).toBe(
      "working",
    );

    rerender(
      <ComputerPane
        snapshot={snapshot()}
        activities={[{ name: "memory_write", state: "approval" }]}
      />,
    );
    expect(screen.getByRole("status").textContent).toContain("Idle");
  });

  it("waits 150ms before the loading skeleton and names an inspector failure", () => {
    vi.useFakeTimers();
    try {
      const { rerender } = render(<ComputerPane status="loading" />);
      expect(screen.queryByRole("heading", { name: "Loading computer" })).toBeNull();
      act(() => {
        vi.advanceTimersByTime(COMPUTER_LOADING_DELAY_MS);
      });
      expect(screen.getByRole("heading", { name: "Loading computer" })).toBeTruthy();
      expect(document.querySelector(".computer-skeleton")).toBeTruthy();
      expect(screen.getByText("· Sandbox")).toBeTruthy();

      rerender(<ComputerPane status="error" />);
      expect(screen.getByRole("heading", { name: "Computer unavailable" })).toBeTruthy();
      expect(screen.getByText("The sandbox inspector could not be loaded.")).toBeTruthy();
      expect(screen.getByRole("status").textContent).toContain("Offline");
      expect(document.querySelector("[data-sprite-state]")?.getAttribute("data-sprite-state")).toBe(
        "error",
      );
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("computer pane logic", () => {
  it("labels providers from the snapshot", () => {
    expect(providerLabel(null)).toBe("Sandbox");
    expect(
      providerLabel({
        provider: "daytona",
        computer: {
          id: "c",
          agentId: "a",
          provider: "daytona",
          createdAt: "2026-10-26T00:00:00.000Z",
        },
        files: [],
        runs: [],
      }),
    ).toBe("Daytona sandbox");
    expect(
      providerLabel({
        provider: "mock",
        computer: {
          id: "c",
          agentId: "a",
          provider: "mock",
          createdAt: "2026-10-26T00:00:00.000Z",
        },
        files: [],
        runs: [],
      }),
    ).toBe("Mock sandbox");
  });

  it("derives presence without a new snapshot field", () => {
    expect(computerPresence("error", false)).toBe("offline");
    expect(computerPresence("ready", true, [{ name: "exec", state: "approval" }])).toBe(
      "needs_help",
    );
    expect(computerPresence("ready", true, [{ name: "read", state: "running" }])).toBe("working");
    expect(computerPresence("loading", false)).toBe("idle");
    expect(computerPresence("ready", true, [{ name: "github", state: "running" }])).toBe("idle");
  });

  it("clamps the pane and opens the screen tab at 560", () => {
    expect(clampPaneWidth(100)).toBe(360);
    expect(clampPaneWidth(900)).toBe(720);
    expect(clampPaneWidth(501.4)).toBe(501);
    expect(resizePaneWidth(420, 200, 140)).toBe(480);
    expect(resizePaneWidth(420, 200, 400)).toBe(360);
    expect(widthForContentTab(420, "screen")).toBe(560);
    expect(widthForContentTab(640, "screen")).toBe(640);
    expect(widthForContentTab(560, "terminal")).toBe(560);
  });

  it("formats terminal commands and footer meta from the run record", () => {
    const read = run({
      id: "read",
      tool: "read",
      arguments: { path: "src/app.ts" },
      stdout: "a\nb\n",
    });
    expect(terminalCommand(read)).toBe("read src/app.ts");
    expect(lineCount("a\nb\n")).toBe(2);
    expect(lineCount("")).toBe(0);
    expect(terminalMeta(read)).toBe("exit 0 · duration — · 2 stdout lines · 0 stderr lines");
    expect(
      terminalMeta(
        run({
          id: "sleep",
          tool: "exec",
          command: "sleep 9",
          timedOut: true,
          exitCode: null,
          stderr: "killed",
        }),
      ),
    ).toBe("timed out · duration — · 0 stdout lines · 1 stderr line");
  });
});

it("resizes the computer pane from the keyboard", () => {
  const onPaneWidth = vi.fn();
  render(
    <SidePane
      tab="computer"
      onTab={() => {}}
      memories={null}
      memoryError={null}
      agentId="agent_default"
      onMemoriesChanged={async () => {}}
      paneWidth={420}
      onPaneWidth={onPaneWidth}
      onPop={() => {}}
    />,
  );

  const handle = screen.getByRole("separator", { name: "Resize computer pane" });
  fireEvent.keyDown(handle, { key: "ArrowLeft" });
  fireEvent.keyDown(handle, { key: "ArrowRight" });
  expect(onPaneWidth).toHaveBeenNthCalledWith(1, 436);
  expect(onPaneWidth).toHaveBeenNthCalledWith(2, 404);
  expect(screen.getByRole("button", { name: "Pop out" })).toBeTruthy();
});
describe("computer pane when the server has no sandbox", () => {
  afterEach(() => cleanup());

  const REASON =
    "The sandbox computer is not configured: DAYTONA_API_KEY is not set. Set it, or set MOCK_SANDBOX=1 to use the labeled mock computer outside production.";

  async function reasonFrom(response: Response): Promise<string | null> {
    try {
      await fetchComputerSnapshot(
        async () => response,
        1,
        () => 1,
      );
      return null;
    } catch (error) {
      if (!(error instanceof ComputerUnavailableError)) throw error;
      return error.message || null;
    }
  }

  it("shows the sandboxError from a 503 body instead of the generic message", async () => {
    const reason = await reasonFrom(
      Response.json({ error: REASON, sandboxError: REASON }, { status: 503 }),
    );
    render(<ComputerPane status="error" unavailableReason={reason} />);
    expect(screen.getByRole("alert").textContent).toBe(REASON);
    expect(screen.queryByText("Computer unavailable")).toBeNull();
  });

  it("falls back to Computer unavailable when the 503 carries no sandboxError", async () => {
    const reason = await reasonFrom(
      Response.json({ error: "Sandbox is not available" }, { status: 503 }),
    );
    expect(reason).toBeNull();
    render(<ComputerPane status="error" unavailableReason={reason} />);
    expect(screen.getByText("Computer unavailable")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
