// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SettingsWorkspace } from "../components/settings-workspace";
import { ThemeProvider } from "../components/theme";
import { THEME_STORAGE_KEY } from "../src/theme";

vi.mock("../src/auth/actions", () => ({ signOutAction: vi.fn() }));

const user = { id: "user_1", name: "Ada", email: "ada@example.com", image: null };

const agents = [
  {
    id: "agent_default",
    name: "Mockbot",
    instructions: "Lead",
    memoryNote: "",
    isLead: true,
    createdAt: "2020-01-01T00:00:00.000Z",
    grants: [],
  },
  {
    id: "agent_builder",
    name: "Builder",
    instructions: "Ship it.",
    memoryNote: "",
    isLead: false,
    createdAt: "2020-01-02T00:00:00.000Z",
    grants: [{ id: "g1", agentId: "agent_builder", kind: "connector", resourceId: "github" }],
  },
];

function respond(body: unknown, status = 200) {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function renderSettings(section: "agents" | "account" | "appearance" | "workspace") {
  return render(
    <ThemeProvider>
      <SettingsWorkspace user={user} initialSection={section} />
    </ThemeProvider>,
  );
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("edits an agent and sends the full grant set", async () => {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({
        url,
        method: init?.method ?? "GET",
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      if (url === "/api/agents") return respond({ agents });
      if (url === "/api/connectors") {
        return respond({
          connectors: [
            { id: "github", name: "GitHub" },
            { id: "slack", name: "Slack" },
          ],
        });
      }
      return respond({});
    }),
  );
  renderSettings("agents");

  fireEvent.click(await screen.findByRole("button", { name: "Builder" }));
  const nameInput = await screen.findByDisplayValue("Builder");
  fireEvent.change(nameInput, { target: { value: "Builder Two" } });
  fireEvent.click(screen.getByRole("checkbox", { name: "Slack" }));
  fireEvent.change(screen.getByPlaceholderText("Computer ids, separated by commas"), {
    target: { value: "desk, lab" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

  await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Saved."));
  const patch = calls.find((call) => call.method === "PATCH");
  expect(patch?.url).toBe("/api/agents/agent_builder");
  expect(patch?.body).toEqual({
    name: "Builder Two",
    instructions: "Ship it.",
    memoryNote: "",
    computerIds: ["desk", "lab"],
    connectorIds: ["github", "slack"],
  });
});

it("asks before deleting and never offers delete for the lead", async () => {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === "DELETE") return respond(null, 204);
    if (url === "/api/agents") return respond({ agents });
    return respond({ connectors: [] });
  });
  vi.stubGlobal("fetch", fetchMock);
  renderSettings("agents");

  expect(await screen.findByText("The lead agent can't be deleted.")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Delete agent" })).toBeNull();

  fireEvent.click(screen.getByRole("button", { name: "Builder" }));
  fireEvent.click(await screen.findByRole("button", { name: "Delete agent" }));
  expect(screen.getByText(/Its chat and memories go with it/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(fetchMock.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(false);

  fireEvent.click(screen.getByRole("button", { name: "Delete agent" }));
  fireEvent.click(screen.getByRole("button", { name: "Delete" }));
  await waitFor(() =>
    expect(
      fetchMock.mock.calls.some(
        ([url, init]) => url === "/api/agents/agent_builder" && init?.method === "DELETE",
      ),
    ).toBe(true),
  );
});

it("stores the chosen theme and paints it", () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => respond({})),
  );
  renderSettings("appearance");

  fireEvent.click(screen.getByRole("radio", { name: /Dark/ }));
  expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
  expect(document.documentElement.dataset.theme).toBe("dark");

  fireEvent.click(screen.getByRole("radio", { name: /Light/ }));
  expect(document.documentElement.dataset.theme).toBe("light");

  fireEvent.click(screen.getByRole("radio", { name: /System/ }));
  expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
});

it("shows the password form only for password accounts and checks the confirmation", async () => {
  const fetchMock = vi.fn(async (url: string) =>
    url === "/api/account"
      ? respond({
          account: { ...user, hasPassword: true, providers: ["google"] },
        })
      : respond(null, 204),
  );
  vi.stubGlobal("fetch", fetchMock);
  renderSettings("account");

  expect(await screen.findByText("Email and password, Google")).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Current password"), {
    target: { value: "correct horse battery" },
  });
  fireEvent.change(screen.getByLabelText(/^New password/), {
    target: { value: "a brand new secret" },
  });
  fireEvent.change(screen.getByLabelText("Confirm new password"), {
    target: { value: "a different secret" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Change password" }));
  expect(screen.getByRole("alert").textContent).toBe("The new passwords don't match.");
  expect(fetchMock.mock.calls.some(([url]) => url === "/api/account/password")).toBe(false);
});

it("shows the model and database", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      respond({ provider: "openai", model: "deepseek/deepseek-v4.1-flash", database: "pglite" }),
    ),
  );
  renderSettings("workspace");
  expect(await screen.findByText("deepseek/deepseek-v4.1-flash")).toBeTruthy();
  expect(screen.getByText("Local Postgres (PGlite)")).toBeTruthy();
  expect(screen.getByRole("link", { name: "Connectors" }).getAttribute("href")).toBe("/connectors");
});
