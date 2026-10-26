import { Composio } from "@composio/core";
import { clip } from "../../tools/http";
import type {
  ComposioBroker,
  ComposioConnectedAccount,
  ComposioToolResult,
  ComposioToolSummary,
  ComposioToolkitSummary,
} from "./types";

const ACTIVE = new Set(["ACTIVE", "INITIATED"]);

export function createSdkComposioBroker(
  env: Record<string, string | undefined>,
  apiKey: string,
): ComposioBroker {
  const versions = toolkitVersions(env);
  const baseURL = env["COMPOSIO_BASE_URL"]?.trim();
  const composio = new Composio({
    apiKey,
    allowTracking: false,
    ...(baseURL ? { baseURL } : {}),
    ...(versions ? { toolkitVersions: versions } : {}),
  });
  const skipVersionCheck = !versions;

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
        statuses: ["ACTIVE", "INITIATED"],
      });
      const match = page.items.find((item) => item.id === input.connectedAccountId);
      if (!match) {
        throw new Error("That Composio account is not connected for this user.");
      }
      if (!ACTIVE.has(match.status)) {
        throw new Error(`Composio reported ${match.status} for this account.`);
      }
      return {
        id: match.id,
        status: match.status,
        label: accountLabel(match.alias, match.data, input.fallbackLabel),
      };
    },

    async listTools(toolkit): Promise<ComposioToolSummary[]> {
      let tools = await composio.tools.getRawComposioTools({
        toolkits: [toolkit],
        important: true,
        limit: 32,
      });
      if (tools.length === 0) {
        tools = await composio.tools.getRawComposioTools({ toolkits: [toolkit], limit: 32 });
      }
      return tools.slice(0, 32).map((tool) => {
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
      try {
        const result = await composio.tools.execute(
          input.slug,
          {
            userId: input.userId,
            connectedAccountId: input.connectedAccountId,
            arguments: input.arguments,
            ...(skipVersionCheck ? { dangerouslySkipVersionCheck: true as const } : {}),
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

function toolkitVersions(
  env: Record<string, string | undefined>,
): Record<string, string> | undefined {
  const raw = env["COMPOSIO_TOOLKIT_VERSIONS"]?.trim();
  if (!raw) return undefined;
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
