// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useState } from "react";
import { AgentPanel } from "../components/agent-panel";
import { CommandPalette } from "../components/command-palette";
import { Sidebar } from "../components/sidebar";
import { SidePane } from "../components/side-pane";
import { ThreadActions } from "../components/thread-actions";
import { ThemeProvider } from "../components/theme";

afterEach(() => {
  cleanup();
});

it("gives thread actions their labels and clicks", () => {
  const onMemory = vi.fn();
  const onShowComputer = vi.fn();
  render(
    <ThreadActions computerOpen={false} onMemory={onMemory} onShowComputer={onShowComputer} />,
  );

  fireEvent.click(screen.getByRole("button", { name: "Memory" }));
  fireEvent.click(screen.getByRole("button", { name: "Show computer" }));

  expect(onMemory).toHaveBeenCalledOnce();
  expect(onShowComputer).toHaveBeenCalledOnce();
  expect(screen.queryByRole("button", { name: "Rename" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
});

it("gives side-panel tabs their labels and clicks", () => {
  const onTab = vi.fn();
  const onHide = vi.fn();
  render(
    <SidePane
      tab="computer"
      onTab={onTab}
      onHide={onHide}
      memories={null}
      memoryError={null}
      agentId="agent_default"
      onMemoriesChanged={async () => {}}
    />,
  );

  fireEvent.click(screen.getByRole("tab", { name: "Computer" }));
  fireEvent.click(screen.getByRole("tab", { name: "Memory" }));
  fireEvent.click(screen.getByRole("tab", { name: "Trace" }));
  fireEvent.click(screen.getByRole("button", { name: "Hide" }));

  expect(onTab).toHaveBeenNthCalledWith(1, "computer");
  expect(onTab).toHaveBeenNthCalledWith(2, "memory");
  expect(onTab).toHaveBeenNthCalledWith(3, "trace");
  expect(onHide).toHaveBeenCalledOnce();
});

it("renders the theme toggle in the sidebar header", () => {
  render(
    <ThemeProvider>
      <Sidebar
        agents={[]}
        activeAgentId="agent_default"
        spriteState="idle"
        runtimeStatus={{
          provider: "mock",
          model: "deepseek/deepseek-v4.1-flash",
          database: "local",
        }}
        busy={false}
        open
        onSelectAgent={() => {}}
        onCreateAgent={async () => null}
        onOpenConnectors={() => {}}
        user={{ id: "user_1", name: "Ada", email: "ada@example.com", image: null }}
      />
    </ThemeProvider>,
  );

  const toggle = screen.getByRole("button", { name: /Switch to (light|dark) theme/ });
  const header = document.querySelector(".side-head");
  const footer = document.querySelector("footer.me");
  expect(header?.contains(toggle)).toBe(true);
  expect(footer?.contains(toggle)).toBe(false);
  expect(footer?.textContent).toContain("Ada");
  expect(footer?.textContent).toContain("ada@example.com");
  expect(footer?.textContent).toContain("deepseek/deepseek-v4.1-flash");

  fireEvent.click(screen.getByRole("button", { name: /ada@example.com/i }));
  const logout = screen.getByRole("menuitem", { name: "Log out" });
  expect(footer?.contains(logout)).toBe(true);
  expect(logout.closest("form")?.getAttribute("action")).toBeTruthy();
  expect(screen.queryByRole("menuitem", { name: "Connectors" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Settings" })).toBeNull();
});

it("opens a new-agent dialog and closes it from Escape, the backdrop, and the X", () => {
  render(
    <AgentPanel
      agents={[]}
      activeAgentId="agent_default"
      spriteState="idle"
      busy={false}
      onSelect={() => {}}
      onCreate={async () => null}
    />,
  );

  fireEvent.click(screen.getByRole("button", { name: "New agent" }));
  expect(screen.getByRole("dialog").getAttribute("aria-modal")).toBe("true");

  fireEvent.keyDown(document, { key: "Escape" });
  expect(screen.queryByRole("dialog")).toBeNull();

  fireEvent.click(screen.getByRole("button", { name: "New agent" }));
  fireEvent.mouseDown(document.querySelector(".agent-modal") as Element);
  expect(screen.queryByRole("dialog")).toBeNull();

  fireEvent.click(screen.getByRole("button", { name: "New agent" }));
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("keeps Tab inside the new-agent dialog", () => {
  render(
    <>
      <button type="button">Send</button>
      <AgentPanel
        agents={[]}
        activeAgentId="agent_default"
        spriteState="idle"
        busy={false}
        onSelect={() => {}}
        onCreate={async () => null}
      />
    </>,
  );

  const send = screen.getByRole("button", { name: "Send" });
  fireEvent.click(screen.getByRole("button", { name: "New agent" }));
  const dialog = screen.getByRole("dialog");
  const close = screen.getByRole("button", { name: "Close" });
  const create = screen.getByRole("button", { name: "Create agent" });
  expect(send.closest("[inert]")).toBeTruthy();

  create.focus();
  fireEvent.keyDown(document, { key: "Tab" });
  expect(document.activeElement).toBe(close);
  expect(dialog.contains(document.activeElement)).toBe(true);

  fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
  expect(document.activeElement).toBe(create);

  send.focus();
  fireEvent.keyDown(document, { key: "Tab" });
  expect(document.activeElement).toBe(close);
  expect(document.activeElement).not.toBe(send);

  fireEvent.keyDown(document, { key: "Escape" });
  expect(send.closest("[inert]")).toBeNull();
});

it("ignores Escape and backdrop dismissal while create is pending", async () => {
  let finish: (message: string | null) => void = () => {};
  const onCreate = vi.fn(
    () =>
      new Promise<string | null>((resolve) => {
        finish = resolve;
      }),
  );
  render(
    <AgentPanel
      agents={[]}
      activeAgentId="agent_default"
      spriteState="idle"
      busy={false}
      onSelect={() => {}}
      onCreate={onCreate}
    />,
  );

  fireEvent.click(screen.getByRole("button", { name: "New agent" }));
  fireEvent.click(screen.getByRole("button", { name: "Create agent" }));
  await waitFor(() => expect(onCreate).toHaveBeenCalledOnce());

  fireEvent.keyDown(document, { key: "Escape" });
  fireEvent.mouseDown(document.querySelector(".agent-modal") as Element);
  expect(screen.getByRole("dialog")).toBeTruthy();

  finish(null);
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});

it("unlocks the new-agent dialog and shows the error when create throws", async () => {
  const onCreate = vi.fn(async (): Promise<string | null> => {
    throw new TypeError("Failed to fetch");
  });
  render(
    <>
      <button type="button">Send</button>
      <AgentPanel
        agents={[]}
        activeAgentId="agent_default"
        spriteState="idle"
        busy={false}
        onSelect={() => {}}
        onCreate={onCreate}
      />
    </>,
  );

  fireEvent.click(screen.getByRole("button", { name: "New agent" }));
  fireEvent.click(screen.getByRole("button", { name: "Create agent" }));
  expect((await screen.findByRole("alert")).textContent).toBe("Failed to fetch");
  expect(screen.getByRole("button", { name: "Create agent" }).hasAttribute("disabled")).toBe(false);

  fireEvent.keyDown(document, { key: "Escape" });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.getByRole("button", { name: "Send" }).closest("[inert]")).toBeNull();
});

function PaletteHarness() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open palette
      </button>
      <CommandPalette
        open={open}
        onClose={() => setOpen(false)}
        commands={[{ id: "routines", label: "Routines", run: () => {} }]}
      />
    </>
  );
}

it("closes the command palette from Escape anywhere and the backdrop, and restores focus", () => {
  render(<PaletteHarness />);
  const opener = screen.getByRole("button", { name: "Open palette" });

  opener.focus();
  fireEvent.click(opener);
  expect(screen.getByRole("dialog")).toBeTruthy();
  document.body.focus();
  fireEvent.keyDown(document, { key: "Escape" });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(document.activeElement).toBe(opener);

  fireEvent.click(opener);
  fireEvent.mouseDown(screen.getByRole("dialog"));
  expect(screen.getByRole("dialog")).toBeTruthy();
  fireEvent.mouseDown(document.querySelector(".command-modal") as Element);
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(document.activeElement).toBe(opener);
});

it("keeps Tab inside the command palette", () => {
  render(<PaletteHarness />);
  const opener = screen.getByRole("button", { name: "Open palette" });
  fireEvent.click(opener);
  const search = screen.getByRole("textbox", { name: "Command" });
  const option = screen.getByRole("option", { name: "Routines" });

  option.focus();
  fireEvent.keyDown(document, { key: "Tab" });
  expect(document.activeElement).toBe(search);

  fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
  expect(document.activeElement).toBe(option);

  opener.focus();
  fireEvent.keyDown(document, { key: "Tab" });
  expect(document.activeElement).toBe(search);
});
