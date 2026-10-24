import { asRecord, jsonResult, present, readJson, toolSignal } from "./http";
import type { FetchLike, ToolDefinition } from "./types";

const ACTIONS = ["list_issues", "get_issue", "list_pulls", "get_pull", "get_file"] as const;
type GithubAction = (typeof ACTIONS)[number];

const MOCK_ISSUES = [
  {
    number: 12,
    title: "Show tool calls in the transcript",
    state: "open",
    body: "Tool cards should stream into the conversation.",
  },
  {
    number: 9,
    title: "Persist conversations",
    state: "closed",
    body: "Stored in embedded Postgres.",
  },
];

const MOCK_PULLS = [
  {
    number: 8,
    title: "Add the tool registry",
    state: "open",
    body: "Expose a capped tool list and a tool_search tool.",
  },
];

const MOCK_FILE =
  "# Mock repository\n\nThis file is deterministic mock data. No GitHub request was made.\n";

function isAction(value: string): value is GithubAction {
  return (ACTIONS as readonly string[]).includes(value);
}

function safeName(value: string): boolean {
  return /^[A-Za-z0-9_.-]+$/.test(value);
}

function safePath(value: string): boolean {
  if (!value || value.startsWith("/") || value.includes("\\")) return false;
  return value.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

function mockResult(action: GithubAction, args: Record<string, unknown>) {
  const owner = String(args.owner ?? "");
  const repo = String(args.repo ?? "");
  const base = { provider: "mock", action, owner, repo };
  if (action === "list_issues") return { ...base, issues: MOCK_ISSUES };
  if (action === "get_issue") {
    const number = args.number;
    const issue = MOCK_ISSUES.find((item) => item.number === number) ?? MOCK_ISSUES[0];
    return { ...base, issue };
  }
  if (action === "list_pulls") return { ...base, pulls: MOCK_PULLS };
  if (action === "get_pull") {
    const number = args.number;
    const pull = MOCK_PULLS.find((item) => item.number === number) ?? MOCK_PULLS[0];
    return { ...base, pull };
  }
  return { ...base, path: args.path, content: MOCK_FILE };
}

function mapIssue(value: unknown) {
  const row = asRecord(value) ?? {};
  return {
    number: typeof row.number === "number" ? row.number : null,
    title: typeof row.title === "string" ? row.title : "",
    state: typeof row.state === "string" ? row.state : "",
    body: typeof row.body === "string" ? row.body.slice(0, 1_000) : "",
    html_url: typeof row.html_url === "string" ? row.html_url : "",
  };
}

function decodeFile(body: Record<string, unknown>): string {
  if (body.encoding === "base64" && typeof body.content === "string") {
    return Buffer.from(body.content.replace(/\n/g, ""), "base64").toString("utf8");
  }
  return typeof body.content === "string" ? body.content : "";
}

export function githubTool(
  env: Record<string, string | undefined>,
  fetchImpl: FetchLike,
): ToolDefinition {
  return {
    name: "github",
    description:
      "Read GitHub issues, pull requests, and file contents for a repository. This tool does not write to GitHub.",
    approval: "never",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ACTIONS,
          description: "list_issues, get_issue, list_pulls, get_pull, or get_file",
        },
        owner: { type: "string", description: "Repository owner" },
        repo: { type: "string", description: "Repository name" },
        number: { type: "integer", description: "Issue or pull request number" },
        path: { type: "string", description: "File path inside the repository for get_file" },
      },
      required: ["action", "owner", "repo"],
      additionalProperties: false,
    },
    prepare(args) {
      const action = typeof args.action === "string" ? args.action.trim() : "";
      if (!isAction(action)) {
        return {
          error: `github does not support "${action || "that action"}". It can read issues, pull requests, and files.`,
        };
      }
      const owner = typeof args.owner === "string" ? args.owner.trim() : "";
      const repo = typeof args.repo === "string" ? args.repo.trim() : "";
      if (!safeName(owner) || !safeName(repo)) {
        return {
          error:
            "github requires an owner and repo made of letters, numbers, dots, dashes, or underscores.",
        };
      }
      const number =
        typeof args.number === "number" && Number.isFinite(args.number)
          ? Math.trunc(args.number)
          : undefined;
      const path = typeof args.path === "string" ? args.path.trim() : "";
      if ((action === "get_issue" || action === "get_pull") && (!number || number < 1)) {
        return { error: `${action} requires a positive issue or pull request number.` };
      }
      if (action === "get_file" && !safePath(path)) {
        return { error: "get_file requires a relative file path without .. segments." };
      }
      return {
        args: {
          action,
          owner,
          repo,
          ...(number ? { number } : {}),
          ...(path ? { path } : {}),
        },
      };
    },
    async invoke(args, context) {
      const action = args.action as GithubAction;
      const token = present(env.GITHUB_TOKEN);
      if (!token) return { content: jsonResult(mockResult(action, args)) };
      const owner = String(args.owner);
      const repo = String(args.repo);
      const headers = {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "User-Agent": "mockbot",
        "X-GitHub-Api-Version": "2022-11-28",
      };
      let url = `https://api.github.com/repos/${owner}/${repo}`;
      if (action === "list_issues") url += "/issues?state=open&per_page=5";
      else if (action === "get_issue") url += `/issues/${args.number}`;
      else if (action === "list_pulls") url += "/pulls?state=open&per_page=5";
      else if (action === "get_pull") url += `/pulls/${args.number}`;
      else url += `/contents/${encodeURIComponent(String(args.path)).replaceAll("%2F", "/")}`;
      const response = await readJson(
        fetchImpl,
        url,
        { headers, signal: toolSignal(context.signal) },
        token,
      );
      if (!response.ok) return { content: response.error, isError: true };
      if (action === "list_issues" && Array.isArray(response.body)) {
        const issues = response.body
          .filter((item) => !asRecord(item)?.pull_request)
          .slice(0, 5)
          .map(mapIssue);
        return { content: jsonResult({ provider: "github", action, owner, repo, issues }, token) };
      }
      if (action === "list_pulls" && Array.isArray(response.body)) {
        return {
          content: jsonResult(
            {
              provider: "github",
              action,
              owner,
              repo,
              pulls: response.body.slice(0, 5).map(mapIssue),
            },
            token,
          ),
        };
      }
      if (action === "get_file") {
        const record = asRecord(response.body) ?? {};
        return {
          content: jsonResult(
            {
              provider: "github",
              action,
              owner,
              repo,
              path: args.path,
              content: decodeFile(record).slice(0, 6_000),
            },
            token,
          ),
        };
      }
      return {
        content: jsonResult(
          {
            provider: "github",
            action,
            owner,
            repo,
            ...(action === "get_pull"
              ? { pull: mapIssue(response.body) }
              : { issue: mapIssue(response.body) }),
          },
          token,
        ),
      };
    },
  };
}
