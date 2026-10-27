// @vitest-environment happy-dom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { RoutinesWorkspace, routineAgentLink } from "../components/routines-workspace";
import { ThemeProvider } from "../components/theme";

const user = { id: "user_1", name: "Ada", email: "ada@example.com", image: null };

const routine = {
  id: "r1",
  name: "Morning brief",
  prompt: "Summarize",
  trigger: { kind: "cron", cron: "0 9 * * *" },
  status: "active",
  conversationId: "c-research",
  userId: "user_1",
  agentId: "agent_research",
  nextRunAt: "2026-01-01T09:00:00.000Z",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  runs: [],
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("links a routine to its agent, or to the lead when it has none", () => {
  expect(routineAgentLink({ agentId: "agent_research" })).toBe("/?agent=agent_research");
  expect(routineAgentLink({ agentId: null })).toBe("/");
});

it("polls one request at a time and shows loading, error, and list states", async () => {
  vi.useFakeTimers();
  const responses: Array<(response: Response) => void> = [];
  const fetchMock = vi.fn(
    () =>
      new Promise<Response>((resolve) => {
        responses.push(resolve);
      }),
  );
  vi.stubGlobal("fetch", fetchMock);
  render(
    <ThemeProvider>
      <RoutinesWorkspace user={user} />
    </ThemeProvider>,
  );

  expect(screen.getByText("Loading routines")).toBeTruthy();
  expect(screen.queryByText("No routines yet")).toBeNull();
  await act(async () => {
    vi.advanceTimersByTime(3500);
  });
  expect(fetchMock).toHaveBeenCalledTimes(1);

  await act(async () => {
    responses[0]?.(new Response("down", { status: 500 }));
  });
  expect(screen.getByRole("alert").textContent).toContain("Could not load routines.");
  expect(screen.queryByText("No routines yet")).toBeNull();
  expect(screen.queryByText("Loading routines")).toBeNull();

  await act(async () => {
    vi.advanceTimersByTime(1000);
  });
  expect(fetchMock).toHaveBeenCalledTimes(2);
  await act(async () => {
    responses[1]?.(Response.json({ routines: [routine] }));
  });
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.getByText("Morning brief")).toBeTruthy();
  const open = screen.getByRole("link", { name: "Open agent" });
  expect(open.getAttribute("href")).toBe("/?agent=agent_research");
  expect(screen.queryByRole("link", { name: "Open conversation" })).toBeNull();
});
