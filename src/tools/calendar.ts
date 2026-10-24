import { asRecord, jsonResult, present, readJson, toolSignal } from "./http";
import type { FetchLike, ToolDefinition } from "./types";

const EVENTS_URL = "https://www.googleapis.com/calendar/v3/calendars/primary/events";

const MOCK_EVENTS = [
  {
    id: "evt_planning",
    summary: "Mockbot planning",
    start: "2026-10-25T15:00:00Z",
    end: "2026-10-25T15:30:00Z",
  },
];

function attendeesOf(value: unknown): string[] | null {
  if (value === undefined) return [];
  const rows = Array.isArray(value) ? value : [value];
  const emails: string[] = [];
  for (const row of rows) {
    const email =
      typeof row === "string"
        ? row.trim()
        : typeof asRecord(row)?.email === "string"
          ? String(asRecord(row)?.email).trim()
          : "";
    if (!email) continue;
    if (!/^[^\s@]+@[^\s@]+$/.test(email)) return null;
    emails.push(email);
  }
  return emails;
}

function whenOf(value: unknown): string {
  const record = asRecord(value);
  if (!record) return "";
  if (typeof record.dateTime === "string") return record.dateTime;
  if (typeof record.date === "string") return record.date;
  return "";
}

function mapEvent(value: unknown) {
  const row = asRecord(value) ?? {};
  const attendees = Array.isArray(row.attendees)
    ? row.attendees
        .map((item) => asRecord(item)?.email)
        .filter((email): email is string => typeof email === "string")
    : [];
  return {
    id: typeof row.id === "string" ? row.id : "",
    summary: typeof row.summary === "string" ? row.summary : "",
    start: whenOf(row.start),
    end: whenOf(row.end),
    htmlLink: typeof row.htmlLink === "string" ? row.htmlLink : "",
    attendees,
  };
}

export function calendarNeedsApproval(args: Record<string, unknown>): boolean {
  if (args.action !== "create") return false;
  return Array.isArray(args.attendees) && args.attendees.length > 0;
}

export function calendarTool(
  env: Record<string, string | undefined>,
  fetchImpl: FetchLike,
): ToolDefinition {
  return {
    name: "google_calendar",
    description:
      "List events on the primary Google Calendar, or create an event. Creating an event that invites attendees waits for approval. OAuth is not connected yet; without an access token the tool returns mock data.",
    approval: calendarNeedsApproval,
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "create"], description: "list or create" },
        summary: { type: "string", description: "Event title for create" },
        description: { type: "string", description: "Optional event description" },
        start: { type: "string", description: "ISO-8601 start time" },
        end: { type: "string", description: "ISO-8601 end time" },
        attendees: {
          type: "array",
          items: { type: "string" },
          description: "Email addresses to invite. Invites require approval.",
        },
        maxResults: { type: "integer", description: "Maximum events to list, up to 10" },
      },
      required: ["action"],
      additionalProperties: false,
    },
    prepare(args) {
      const action = typeof args.action === "string" ? args.action.trim() : "";
      if (action === "list") {
        const requested =
          typeof args.maxResults === "number" && Number.isFinite(args.maxResults)
            ? Math.trunc(args.maxResults)
            : 10;
        return { args: { action, maxResults: Math.max(1, Math.min(requested, 10)) } };
      }
      if (action !== "create") {
        return {
          error: `google_calendar does not support "${action || "that action"}". Use list or create.`,
        };
      }
      const summary = typeof args.summary === "string" ? args.summary.trim() : "";
      const start = typeof args.start === "string" ? args.start.trim() : "";
      const end = typeof args.end === "string" ? args.end.trim() : "";
      if (!summary || !start || !end) {
        return { error: "create requires summary, start, and end." };
      }
      const attendees = attendeesOf(args.attendees);
      if (!attendees) return { error: "attendees must be email addresses." };
      const description = typeof args.description === "string" ? args.description.trim() : "";
      return {
        args: {
          action,
          summary,
          start,
          end,
          attendees,
          ...(description ? { description } : {}),
        },
      };
    },
    async invoke(args, context) {
      const token = present(env.GOOGLE_CALENDAR_ACCESS_TOKEN);
      if (!token) {
        if (args.action === "list") {
          return {
            content: jsonResult({
              provider: "mock",
              action: "list",
              note: "Calendar OAuth is not connected. These events are mock data.",
              events: MOCK_EVENTS.slice(0, Number(args.maxResults ?? 10)),
            }),
          };
        }
        return {
          content: jsonResult({
            provider: "mock",
            action: "create",
            note: "Calendar OAuth is not connected. The event was not sent to Google.",
            event: {
              id: "evt_mock",
              summary: args.summary,
              description: args.description ?? "",
              start: args.start,
              end: args.end,
              attendees: args.attendees ?? [],
              htmlLink: "https://calendar.google.com/calendar/mock",
            },
          }),
        };
      }
      const headers = {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      };
      if (args.action === "list") {
        const url = new URL(EVENTS_URL);
        url.searchParams.set("maxResults", String(args.maxResults ?? 10));
        url.searchParams.set("singleEvents", "true");
        url.searchParams.set("orderBy", "startTime");
        url.searchParams.set("timeMin", new Date().toISOString());
        const response = await readJson(
          fetchImpl,
          url.toString(),
          { headers, signal: toolSignal(context.signal) },
          token,
        );
        if (!response.ok) return { content: response.error, isError: true };
        const items = asRecord(response.body)?.items;
        const events = Array.isArray(items) ? items.map(mapEvent) : [];
        return { content: jsonResult({ provider: "google", action: "list", events }, token) };
      }
      const attendees = Array.isArray(args.attendees) ? args.attendees.map(String) : [];
      const url = new URL(EVENTS_URL);
      url.searchParams.set("sendUpdates", attendees.length > 0 ? "all" : "none");
      const response = await readJson(
        fetchImpl,
        url.toString(),
        {
          method: "POST",
          headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify({
            summary: args.summary,
            description: args.description,
            start: { dateTime: args.start },
            end: { dateTime: args.end },
            attendees: attendees.map((email) => ({ email })),
          }),
          signal: toolSignal(context.signal),
        },
        token,
      );
      if (!response.ok) return { content: response.error, isError: true };
      return {
        content: jsonResult(
          { provider: "google", action: "create", event: mapEvent(response.body) },
          token,
        ),
      };
    },
  };
}
