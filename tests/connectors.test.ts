import { expect, it, vi } from "vitest";
import { createDefaultTools } from "../src/tools/builtins";

const SECRET = "super-secret-tool-key";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

it("uses deterministic web, github, and calendar results when keys are missing", async () => {
  const fetchImpl = vi.fn<typeof fetch>();
  const tools = createDefaultTools({}, fetchImpl);
  const search = await tools.get("web_search")!.invoke({ query: "mockbot" }, {});
  const page = await tools.get("web_fetch")!.invoke({ url: "https://example.com/docs" }, {});
  const issues = await tools
    .get("github")!
    .invoke({ action: "list_issues", owner: "mockbot", repo: "mockbot" }, {});
  const calendar = await tools.get("google_calendar")!.invoke({ action: "list" }, {});

  expect(fetchImpl).not.toHaveBeenCalled();
  expect(search.content).toContain("mockbot");
  expect(search.content).toContain('"provider": "mock"');
  expect(page.content).toContain("https://example.com/docs");
  expect(issues.content).toContain("Show tool calls in the transcript");
  expect(calendar.content).toContain("Calendar OAuth is not connected");
  expect(calendar.content).toContain("Mockbot planning");
});

it("calls Tavily, GitHub, and Calendar when credentials are set and redacts them", async () => {
  const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input);
    const body = typeof init?.body === "string" ? init.body : "";
    if (url.endsWith("/search")) {
      expect(init?.headers).toMatchObject({ Authorization: `Bearer ${SECRET}` });
      expect(body).toContain("weather");
      return jsonResponse({
        answer: `forecast ${SECRET}`,
        results: [{ title: "Weather", url: "https://example.com/weather", content: "Sunny" }],
      });
    }
    if (url.includes("api.github.com")) {
      expect(url).toContain("/repos/acme/app/issues");
      expect(init?.headers).toMatchObject({ Authorization: `Bearer ${SECRET}` });
      return jsonResponse([{ number: 4, title: "Real issue", state: "open", body: "Details" }]);
    }
    expect(url).toContain("calendar/v3");
    expect(url).toContain("sendUpdates=all");
    return jsonResponse({
      id: "evt_live",
      summary: "Planning",
      htmlLink: "https://calendar.google.com/event",
    });
  });

  const web = createDefaultTools({ TAVILY_API_KEY: SECRET }, fetchImpl);
  const search = await web.get("web_search")!.invoke({ query: "weather" }, {});
  expect(search.isError).toBeFalsy();
  expect(search.content).toContain("Sunny");
  expect(search.content).toContain("[redacted]");
  expect(search.content).not.toContain(SECRET);

  const github = createDefaultTools({ GITHUB_TOKEN: SECRET }, fetchImpl);
  const issues = await github
    .get("github")!
    .invoke({ action: "list_issues", owner: "acme", repo: "app" }, {});
  expect(issues.content).toContain("Real issue");
  expect(issues.content).not.toContain(SECRET);

  const calendar = createDefaultTools({ GOOGLE_CALENDAR_ACCESS_TOKEN: SECRET }, fetchImpl);
  const created = await calendar.get("google_calendar")!.invoke(
    {
      action: "create",
      summary: "Planning",
      start: "2026-10-25T15:00:00Z",
      end: "2026-10-25T15:30:00Z",
      attendees: ["team@example.com"],
    },
    {},
  );
  expect(created.content).toContain("evt_live");
  expect(created.content).not.toContain(SECRET);

  const failing = vi.fn<typeof fetch>(async () =>
    jsonResponse({ error: `rejected ${SECRET}` }, 401),
  );
  const broken = createDefaultTools({ TAVILY_API_KEY: SECRET }, failing);
  const error = await broken.get("web_search")!.invoke({ query: "weather" }, {});
  expect(error.isError).toBe(true);
  expect(error.content).toContain("[redacted]");
  expect(error.content).not.toContain(SECRET);
});
