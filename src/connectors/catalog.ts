export type CatalogCategory = "popular" | "productivity" | "dev" | "data" | "design";

export type CatalogTool = {
  name: string;
  description: string;
  risk: "read" | "write" | "destructive";
};

export type CatalogPermission = {
  allowed: boolean;
  text: string;
};

/**
 * Deprecated native OAuth config. Catalog connects use Composio.
 * This block runs only when NATIVE_CATALOG_OAUTH=1.
 * Credentials are read from the named environment variables.
 */
export type CatalogOAuth = {
  authorizeUrl: string;
  tokenUrl: string;
  scopes: readonly string[];
  /** S256 PKCE when the provider accepts it. Notion's public integration does not. */
  pkce: boolean;
  clientIdEnv: string;
  clientSecretEnv: string;
  /** "basic" is HTTP Basic plus a JSON body. "body" puts the client secret in a form body. */
  tokenAuth: "basic" | "body";
  authorizeParams?: Readonly<Record<string, string>>;
  /** Hosted MCP server. Tools are listed and called with the MCP client. */
  mcpUrl?: string;
  /** REST adapter used when this OAuth token is not accepted by a hosted MCP server. */
  adapterId?: string;
  /** API root stored as the connector target for an adapter. */
  apiBase?: string;
  /** Token-response field used as the account label. */
  accountField?: string;
  /** Authorized GET whose JSON field is the account label. */
  userInfoUrl?: string;
  userInfoField?: string;
  redirectPath: string;
};

/** Composio toolkit used as the broker for this catalog app. */
export type CatalogComposio = {
  /** Composio toolkit slug, such as "notion" or "github". */
  toolkit: string;
  /** Connect and execute when true. False keeps the app as catalog config only. */
  enabled: boolean;
};

export type CatalogEntry = {
  id: string;
  name: string;
  description: string;
  categories: CatalogCategory[];
  tags: string[];
  /** Brand fill for the monogram. Near-black brands set inkMonogram instead. */
  color: string;
  inkMonogram: boolean;
  auth: "oauth";
  samplePrompt: string;
  permissions: CatalogPermission[];
  /** Branding shown before connect. Live tools come from Composio, or from the deprecated native adapter. */
  tools: CatalogTool[];
  composio?: CatalogComposio;
  oauth?: CatalogOAuth;
};

export const CATALOG_CATEGORIES: { id: CatalogCategory; label: string }[] = [
  { id: "popular", label: "Popular" },
  { id: "productivity", label: "Productivity" },
  { id: "dev", label: "Dev" },
  { id: "data", label: "Data" },
  { id: "design", label: "Design" },
];

export const CATALOG: readonly CatalogEntry[] = [
  {
    id: "notion",
    name: "Notion",
    description: "Pages, databases",
    categories: ["popular", "productivity"],
    tags: ["pages", "docs", "wiki"],
    color: "#191919",
    inkMonogram: true,
    auth: "oauth",
    composio: { toolkit: "notion", enabled: true },
    oauth: {
      authorizeUrl: "https://api.notion.com/v1/oauth/authorize",
      tokenUrl: "https://api.notion.com/v1/oauth/token",
      scopes: [],
      pkce: false,
      clientIdEnv: "NOTION_OAUTH_CLIENT_ID",
      clientSecretEnv: "NOTION_OAUTH_CLIENT_SECRET",
      tokenAuth: "basic",
      authorizeParams: { owner: "user", response_type: "code" },
      adapterId: "notion",
      apiBase: "https://api.notion.com/v1",
      accountField: "workspace_name",
      redirectPath: "/connectors/oauth/callback",
    },
    samplePrompt: "Find my Q2 planning page in Notion",
    permissions: [
      { allowed: true, text: "Search and read pages you share" },
      { allowed: true, text: "Create pages (asks you first)" },
      { allowed: false, text: "Never sees your password" },
    ],
    tools: [
      { name: "search_pages", description: "Search pages", risk: "read" },
      { name: "get_page", description: "Read a page", risk: "read" },
      { name: "list_databases", description: "List databases", risk: "read" },
      { name: "create_page", description: "Create a page", risk: "write" },
      { name: "delete_page", description: "Delete a page", risk: "destructive" },
    ],
  },
  {
    id: "github",
    name: "GitHub",
    description: "Repos, issues, PRs",
    categories: ["popular", "dev"],
    tags: ["git", "pull requests", "code"],
    color: "#24292f",
    inkMonogram: true,
    auth: "oauth",
    composio: { toolkit: "github", enabled: true },
    oauth: {
      authorizeUrl: "https://github.com/login/oauth/authorize",
      tokenUrl: "https://github.com/login/oauth/access_token",
      scopes: ["repo", "read:org", "read:user"],
      pkce: true,
      clientIdEnv: "GITHUB_OAUTH_CLIENT_ID",
      clientSecretEnv: "GITHUB_OAUTH_CLIENT_SECRET",
      tokenAuth: "body",
      mcpUrl: "https://api.githubcopilot.com/mcp/",
      userInfoUrl: "https://api.github.com/user",
      userInfoField: "login",
      redirectPath: "/connectors/oauth/callback",
    },
    samplePrompt: "List open pull requests that mention me",
    permissions: [
      { allowed: true, text: "Read repos, issues, and pull requests you can see" },
      { allowed: true, text: "Open issues (asks you first)" },
      { allowed: false, text: "Never sees your password" },
    ],
    tools: [
      { name: "list_issues", description: "List issues", risk: "read" },
      { name: "get_file", description: "Read a file", risk: "read" },
      { name: "search_code", description: "Search code", risk: "read" },
      { name: "create_issue", description: "Open an issue", risk: "write" },
    ],
  },
  {
    id: "linear",
    name: "Linear",
    description: "Issues, projects",
    categories: ["popular", "productivity", "dev"],
    tags: ["issues", "tickets"],
    color: "#5e6ad2",
    inkMonogram: false,
    auth: "oauth",
    composio: { toolkit: "linear", enabled: false },
    samplePrompt: "Show my Linear issues that are in progress",
    permissions: [
      { allowed: true, text: "Search and read issues you can see" },
      { allowed: true, text: "Create issues (asks you first)" },
      { allowed: false, text: "Never sees your password" },
    ],
    tools: [
      { name: "search_issues", description: "Search issues", risk: "read" },
      { name: "get_issue", description: "Read an issue", risk: "read" },
      { name: "create_issue", description: "Create an issue", risk: "write" },
      { name: "delete_issue", description: "Delete an issue", risk: "destructive" },
    ],
  },
  {
    id: "slack",
    name: "Slack",
    description: "Channels, messages",
    categories: ["popular", "productivity"],
    tags: ["chat", "messages"],
    color: "#e01e5a",
    inkMonogram: false,
    auth: "oauth",
    composio: { toolkit: "slack", enabled: false },
    samplePrompt: "Summarize unread mentions in Slack",
    permissions: [
      { allowed: true, text: "Read channels and messages you can see" },
      { allowed: true, text: "Send messages (asks you first)" },
      { allowed: false, text: "Never sees your password" },
    ],
    tools: [
      { name: "search_messages", description: "Search messages", risk: "read" },
      { name: "list_channels", description: "List channels", risk: "read" },
      { name: "post_message", description: "Send a message", risk: "write" },
    ],
  },
  {
    id: "google-drive",
    name: "Google Drive",
    description: "Docs, files",
    categories: ["popular", "productivity"],
    tags: ["docs", "files", "drive"],
    color: "#188038",
    inkMonogram: false,
    auth: "oauth",
    composio: { toolkit: "googledrive", enabled: false },
    samplePrompt: "Find the Q2 planning doc in Google Drive",
    permissions: [
      { allowed: true, text: "Search and read files you share" },
      { allowed: true, text: "Create files (asks you first)" },
      { allowed: false, text: "Never sees your password" },
    ],
    tools: [
      { name: "search_files", description: "Search files", risk: "read" },
      { name: "get_file", description: "Read a file", risk: "read" },
      { name: "list_files", description: "List files", risk: "read" },
      { name: "create_file", description: "Create a file", risk: "write" },
      { name: "delete_file", description: "Delete a file", risk: "destructive" },
    ],
  },
  {
    id: "postgres",
    name: "Postgres",
    description: "Query a database",
    categories: ["popular", "data"],
    tags: ["sql", "database"],
    color: "#336791",
    inkMonogram: false,
    auth: "oauth",
    composio: { toolkit: "postgres", enabled: false },
    samplePrompt: "How many rows are in the users table?",
    permissions: [
      { allowed: true, text: "Run read-only queries you allow" },
      { allowed: true, text: "Change rows (asks you first)" },
      { allowed: false, text: "Never sees your password" },
    ],
    tools: [
      { name: "search_tables", description: "Search tables", risk: "read" },
      { name: "read_query", description: "Run a read query", risk: "read" },
      { name: "write_query", description: "Change rows", risk: "write" },
      { name: "drop_table", description: "Drop a table", risk: "destructive" },
    ],
  },
  {
    id: "figma",
    name: "Figma",
    description: "Files, comments",
    categories: ["popular", "design"],
    tags: ["design", "comments"],
    color: "#9351e9",
    inkMonogram: false,
    auth: "oauth",
    composio: { toolkit: "figma", enabled: false },
    samplePrompt: "List comments on the latest Figma file",
    permissions: [
      { allowed: true, text: "Read files and comments you can see" },
      { allowed: true, text: "Post comments (asks you first)" },
      { allowed: false, text: "Never sees your password" },
    ],
    tools: [
      { name: "search_files", description: "Search files", risk: "read" },
      { name: "get_file", description: "Read a file", risk: "read" },
      { name: "list_comments", description: "List comments", risk: "read" },
      { name: "post_comment", description: "Post a comment", risk: "write" },
    ],
  },
  {
    id: "jira",
    name: "Jira",
    description: "Tickets, sprints",
    categories: ["popular", "productivity", "dev"],
    tags: ["tickets", "sprints"],
    color: "#0c66e4",
    inkMonogram: false,
    auth: "oauth",
    composio: { toolkit: "jira", enabled: false },
    samplePrompt: "Show my open Jira tickets",
    permissions: [
      { allowed: true, text: "Search and read tickets you can see" },
      { allowed: true, text: "Create tickets (asks you first)" },
      { allowed: false, text: "Never sees your password" },
    ],
    tools: [
      { name: "search_issues", description: "Search tickets", risk: "read" },
      { name: "get_issue", description: "Read a ticket", risk: "read" },
      { name: "create_issue", description: "Create a ticket", risk: "write" },
      { name: "delete_issue", description: "Delete a ticket", risk: "destructive" },
    ],
  },
];

export const OAUTH_CALLBACK_PATH = "/connectors/oauth/callback";

export const LEGACY_CATALOG_TARGET_PREFIX = "https://catalog.mockbot.local/";

export function catalogById(id: string): CatalogEntry | undefined {
  return CATALOG.find((entry) => entry.id === id);
}

export const COMPOSIO_TARGET_PREFIX = "https://backend.composio.dev/v3/toolkits/";

export function composioConnectorTarget(toolkit: string): string {
  return `${COMPOSIO_TARGET_PREFIX}${encodeURIComponent(toolkit)}`;
}

export function catalogIsWired(entry: CatalogEntry): boolean {
  if (entry.composio?.enabled) return true;
  return Boolean(
    entry.oauth && (entry.oauth.mcpUrl || (entry.oauth.adapterId && entry.oauth.apiBase)),
  );
}

export function catalogTarget(entry: CatalogEntry): string | null {
  if (!entry.oauth) return null;
  return entry.oauth.mcpUrl ?? entry.oauth.apiBase ?? null;
}

export function isLegacyCatalogTarget(target: string): boolean {
  return target.startsWith(LEGACY_CATALOG_TARGET_PREFIX);
}

export function catalogInCategory(category: CatalogCategory): CatalogEntry[] {
  return CATALOG.filter((entry) => entry.categories.includes(category));
}

export function searchCatalog(
  query: string,
  entries: readonly CatalogEntry[] = CATALOG,
): CatalogEntry[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return [...entries];
  const terms = normalized.split(/\s+/).filter(Boolean);
  return entries
    .map((entry) => {
      const name = entry.name.toLowerCase();
      const description = entry.description.toLowerCase();
      const tags = entry.tags.join(" ").toLowerCase();
      let score = 0;
      if (name === normalized) score += 100;
      else if (name.includes(normalized)) score += 40;
      if (description.includes(normalized)) score += 20;
      for (const term of terms) {
        if (name.includes(term)) score += 10;
        if (description.includes(term)) score += 4;
        if (tags.includes(term)) score += 6;
        if (entry.categories.some((category) => category.includes(term))) score += 2;
      }
      return { entry, score };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.entry.name.localeCompare(b.entry.name))
    .map((item) => item.entry);
}
