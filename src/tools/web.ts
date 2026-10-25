import { asRecord, jsonResult, present, readJson, toolFetchInit } from "./http";
import type { FetchLike, ToolDefinition } from "./types";

const SEARCH_URL = "https://api.tavily.com/search";
const EXTRACT_URL = "https://api.tavily.com/extract";

function mockSearch(query: string) {
  return {
    provider: "mock",
    query,
    answer: `Mock results for ${query}. Set TAVILY_API_KEY to search the live web.`,
    results: [
      {
        title: `Overview of ${query}`,
        url: `https://example.com/search?q=${encodeURIComponent(query)}`,
        content: `Deterministic excerpt about ${query}. No network request was made.`,
      },
    ],
  };
}

function mockFetch(url: string) {
  return {
    provider: "mock",
    url,
    title: "Mock page",
    content: `Deterministic mock fetch of ${url}. Set TAVILY_API_KEY to fetch the live page.`,
  };
}

function mapSearch(body: unknown, query: string) {
  const record = asRecord(body) ?? {};
  const rows = Array.isArray(record.results) ? record.results : [];
  return {
    provider: "tavily",
    query,
    answer: typeof record.answer === "string" ? record.answer : null,
    results: rows.slice(0, 5).map((item) => {
      const row = asRecord(item) ?? {};
      return {
        title: typeof row.title === "string" ? row.title : "",
        url: typeof row.url === "string" ? row.url : "",
        content: typeof row.content === "string" ? row.content.slice(0, 500) : "",
      };
    }),
  };
}

function mapExtract(body: unknown, url: string) {
  const record = asRecord(body) ?? {};
  const rows = Array.isArray(record.results) ? record.results : [];
  const match =
    rows.map((item) => asRecord(item)).find((item) => item && item.url === url) ??
    asRecord(rows[0]);
  const failed = Array.isArray(record.failed_results) ? record.failed_results : [];
  if (!match) {
    return {
      provider: "tavily",
      url,
      title: "",
      content: "",
      failed,
    };
  }
  const content =
    typeof match.raw_content === "string"
      ? match.raw_content
      : typeof match.content === "string"
        ? match.content
        : "";
  return {
    provider: "tavily",
    url: typeof match.url === "string" ? match.url : url,
    title: typeof match.title === "string" ? match.title : "",
    content: content.slice(0, 6_000),
  };
}

function httpUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.toString();
  } catch {
    return null;
  }
}

export function webSearchTool(
  env: Record<string, string | undefined>,
  fetchImpl: FetchLike,
): ToolDefinition {
  return {
    name: "web_search",
    description: "Search the public web and return titles, URLs, and short excerpts.",
    approval: "never",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
        max_results: { type: "integer", description: "How many results to return, up to 5" },
      },
      required: ["query"],
      additionalProperties: false,
    },
    prepare(args) {
      const query = typeof args.query === "string" ? args.query.trim() : "";
      if (!query) return { error: "web_search requires a query string." };
      const requested =
        typeof args.max_results === "number" && Number.isFinite(args.max_results)
          ? Math.trunc(args.max_results)
          : 5;
      const maxResults = Math.max(1, Math.min(requested, 5));
      return { args: { query, max_results: maxResults } };
    },
    async invoke(args, context) {
      const query = String(args.query ?? "");
      const apiKey = present(env.TAVILY_API_KEY);
      if (!apiKey) return { content: jsonResult(mockSearch(query)) };
      const response = await readJson(
        fetchImpl,
        SEARCH_URL,
        toolFetchInit(context.signal, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify({
            query,
            max_results: args.max_results ?? 5,
            include_answer: true,
            search_depth: "basic",
          }),
        }),
        apiKey,
      );
      if (!response.ok) return { content: response.error, isError: true };
      return { content: jsonResult(mapSearch(response.body, query), apiKey) };
    },
  };
}

export function webFetchTool(
  env: Record<string, string | undefined>,
  fetchImpl: FetchLike,
): ToolDefinition {
  return {
    name: "web_fetch",
    description: "Fetch a public http(s) page and return its text. Uses Tavily when a key is set.",
    approval: "never",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Absolute http or https URL" },
      },
      required: ["url"],
      additionalProperties: false,
    },
    prepare(args) {
      const raw = typeof args.url === "string" ? args.url.trim() : "";
      const url = httpUrl(raw);
      if (!url) return { error: "web_fetch requires an absolute http or https URL." };
      return { args: { url } };
    },
    async invoke(args, context) {
      const url = String(args.url ?? "");
      const apiKey = present(env.TAVILY_API_KEY);
      if (!apiKey) return { content: jsonResult(mockFetch(url)) };
      const response = await readJson(
        fetchImpl,
        EXTRACT_URL,
        toolFetchInit(context.signal, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify({ urls: [url] }),
        }),
        apiKey,
      );
      if (!response.ok) return { content: response.error, isError: true };
      const mapped = mapExtract(response.body, url);
      if (!mapped.content) {
        return {
          content: jsonResult({ ...mapped, note: "No page text was returned." }, apiKey),
          isError: true,
        };
      }
      return { content: jsonResult(mapped, apiKey) };
    },
  };
}
