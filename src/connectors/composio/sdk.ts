import { Composio } from "@composio/core";
import { clip } from "../../tools/http";
import type {
  ComposioBroker,
  ComposioConnectedAccount,
  ComposioToolResult,
  ComposioToolSummary,
  ComposioToolkitSummary,
} from "./types";

/** Pinned Composio toolkit versions. Env COMPOSIO_TOOLKIT_VERSIONS overrides a slug. */
export const DEFAULT_COMPOSIO_TOOLKIT_VERSIONS: Record<string, string> = {
  notion: "20261018_00",
  github: "20261023_00",
};

/**
 * Tools loaded for a toolkit, by slug. GitHub has about 900 tools, and a plain
 * toolkit listing returns the first 32 alphabetically, so it is pinned to the
 * everyday read and write tools instead.
 */
export const COMPOSIO_TOOLKIT_TOOLS: Record<string, readonly string[]> = {
  github: [
    "GITHUB_GET_THE_AUTHENTICATED_USER",
    "GITHUB_LIST_REPOSITORIES_FOR_THE_AUTHENTICATED_USER",
    "GITHUB_SEARCH_REPOSITORIES",
    "GITHUB_GET_A_REPOSITORY",
    "GITHUB_GET_REPOSITORY_CONTENT",
    "GITHUB_SEARCH_CODE",
    "GITHUB_LIST_BRANCHES",
    "GITHUB_LIST_COMMITS",
    "GITHUB_LIST_REPOSITORY_ISSUES",
    "GITHUB_GET_AN_ISSUE",
    "GITHUB_GET_ISSUE_COMMENTS",
    "GITHUB_SEARCH_ISSUES_AND_PULL_REQUESTS",
    "GITHUB_LIST_PULL_REQUESTS",
    "GITHUB_GET_A_PULL_REQUEST",
    "GITHUB_CREATE_REPOSITORY",
    "GITHUB_CREATE_BRANCH",
    "GITHUB_CREATE_OR_UPDATE_FILE_CONTENTS",
    "GITHUB_COMMIT_MULTIPLE_FILES",
    "GITHUB_CREATE_AN_ISSUE",
    "GITHUB_UPDATE_AN_ISSUE",
    "GITHUB_CREATE_AN_ISSUE_COMMENT",
    "GITHUB_CREATE_A_PULL_REQUEST",
  ],
};

const MAX_TOOLKIT_TOOLS = 32;

export function resolveComposioToolkitVersions(
  env: Record<string, string | undefined>,
): Record<string, string> {
  return { ...DEFAULT_COMPOSIO_TOOLKIT_VERSIONS, ...toolkitVersions(env) };
}

export function createSdkComposioBroker(
  env: Record<string, string | undefined>,
  apiKey: string,
): ComposioBroker {
  const versions = resolveComposioToolkitVersions(env);
  const baseURL = env["COMPOSIO_BASE_URL"]?.trim();
  const composio = new Composio({
    apiKey,
    allowTracking: false,
    toolkitVersions: versions,
    ...(baseURL ? { baseURL } : {}),
  });

  return {
    async listToolkits(): Promise<ComposioToolkitSummary[]> {
      const listed = await composio.toolkits.get({ limit: 100, sortBy: "alphabetically" });
      return listed.slice(0, 100).map((toolkit) => ({
        slug: toolkit.slug,
        name: toolkit.name,
        description: toolkit.meta.description?.trim() || toolkit.name,
      }));
    },

    async authorize(input) {
      const session = await composio.create(input.userId, {
        toolkits: [input.toolkit],
        manageConnections: { enable: true, callbackUrl: input.callbackUrl },
      });
      const request = await session.authorize(input.toolkit, { callbackUrl: input.callbackUrl });
      const redirectUrl = request.redirectUrl?.trim() ?? "";
      if (!redirectUrl) throw new Error("Composio did not return a sign-in URL.");
      if (!request.id) throw new Error("Composio did not return a connection id.");
      return { redirectUrl, connectedAccountId: request.id };
    },

    async getConnectedAccount(input): Promise<ComposioConnectedAccount> {
      const page = await composio.connectedAccounts.list({
        userIds: [input.userId],
        toolkitSlugs: [input.toolkit],
        statuses: ["ACTIVE"],
      });
      const match = page.items.find((item) => item.id === input.connectedAccountId);
      if (!match || match.status !== "ACTIVE") {
        throw new Error("That Composio account is not connected for this user.");
      }
      return {
        id: match.id,
        status: match.status,
        label: accountLabel(match.alias, match.data, input.fallbackLabel),
      };
    },

    async listTools(toolkit): Promise<ComposioToolSummary[]> {
      const tools = await listToolkitTools(composio, toolkit);
      if (tools.length === 0) {
        const version = versions[toolkit] ?? "the latest version";
        throw new Error(
          `Composio returned no ${toolkit} tools for version ${version}. Pin a version Composio still serves in COMPOSIO_TOOLKIT_VERSIONS.`,
        );
      }
      return tools.slice(0, MAX_TOOLKIT_TOOLS).map((tool) => {
        const tags = tool.tags ?? [];
        return {
          slug: tool.slug,
          description: tool.description?.trim() || tool.name,
          inputSchema: tool.inputParameters ?? { type: "object", properties: {} },
          readOnlyHint: tags.some((tag) => /readonly/i.test(tag)),
          destructiveHint: tags.some((tag) => /destructive/i.test(tag)),
        };
      });
    },

    async executeTool(input): Promise<ComposioToolResult> {
      const version = versions[input.toolkit];
      if (!version) {
        return {
          content: `Pin a Composio toolkit version for ${input.toolkit}.`,
          isError: true,
        };
      }
      try {
        const result = await composio.tools.execute(
          input.slug,
          {
            userId: input.userId,
            connectedAccountId: input.connectedAccountId,
            arguments: input.arguments,
            version,
          },
          input.signal ? { signal: input.signal } : undefined,
        );
        if (!result.successful) {
          const content = (result.error || "Composio tool failed.").slice(0, 500);
          return { content, isError: true, authExpired: isAuthMessage(content) };
        }
        return { content: clip(JSON.stringify(result.data ?? {}), 8_000), isError: false };
      } catch (error) {
        const content = messageOf(error);
        return { content, isError: true, authExpired: isAuthMessage(content) };
      }
    },
  };
}

type RawTool = Awaited<ReturnType<Composio["tools"]["getRawComposioTools"]>>[number];

/**
 * A pinned slug list wins. Otherwise Composio's "important" tag picks the
 * tools; the API ignores the important filter when a limit is set.
 */
async function listToolkitTools(composio: Composio, toolkit: string): Promise<RawTool[]> {
  const pinned = COMPOSIO_TOOLKIT_TOOLS[toolkit];
  if (pinned) {
    const tools = await composio.tools.getRawComposioTools({ tools: [...pinned] });
    return tools.filter((tool) => pinned.includes(tool.slug));
  }
  const tools = await composio.tools.getRawComposioTools({ toolkits: [toolkit], limit: 1000 });
  const important = tools.filter((tool) => (tool.tags ?? []).includes("important"));
  return important.length > 0 ? important : tools;
}

function toolkitVersions(env: Record<string, string | undefined>): Record<string, string> {
  const raw = env["COMPOSIO_TOOLKIT_VERSIONS"]?.trim();
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error("COMPOSIO_TOOLKIT_VERSIONS must be a JSON object of toolkit versions.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("COMPOSIO_TOOLKIT_VERSIONS must be a JSON object of toolkit versions.");
  }
  const versions: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (!/^[a-z0-9_-]+$/i.test(key) || typeof value !== "string" || !value.trim()) {
      throw new Error("COMPOSIO_TOOLKIT_VERSIONS must be a JSON object of toolkit versions.");
    }
    versions[key] = value.trim();
  }
  return versions;
}

const LABEL_KEYS = ["workspace_name", "login", "email", "name", "username", "account"];

function accountLabel(
  alias: string | null | undefined,
  data: Record<string, unknown> | undefined,
  fallback: string,
): string {
  const named = alias?.trim();
  if (named) return named.slice(0, 80);
  if (data) {
    for (const key of LABEL_KEYS) {
      const value = data[key];
      if (typeof value === "string" && value.trim()) return value.trim().slice(0, 80);
    }
  }
  return fallback;
}

function isAuthMessage(message: string): boolean {
  return /401|unauthorized|connected account|invalid_token|revoked|expired/i.test(message);
}

function messageOf(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message.trim().slice(0, 500);
  return "Composio tool failed.";
}
