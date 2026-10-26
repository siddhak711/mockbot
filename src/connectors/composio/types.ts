export type ComposioToolkitSummary = {
  slug: string;
  name: string;
  description: string;
};

export type ComposioToolSummary = {
  slug: string;
  description: string;
  inputSchema: unknown;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
};

export type ComposioConnectedAccount = {
  id: string;
  status: string;
  label: string;
};

export type ComposioToolResult = {
  content: string;
  isError: boolean;
  authExpired?: boolean;
};

/**
 * The catalog talks to Composio through this surface.
 * Tests install a fake. Production uses the SDK client.
 */
export type ComposioBroker = {
  listToolkits(): Promise<ComposioToolkitSummary[]>;
  authorize(input: {
    userId: string;
    toolkit: string;
    callbackUrl: string;
  }): Promise<{ redirectUrl: string; connectedAccountId: string }>;
  getConnectedAccount(input: {
    userId: string;
    toolkit: string;
    connectedAccountId: string;
    fallbackLabel: string;
  }): Promise<ComposioConnectedAccount>;
  listTools(toolkit: string): Promise<ComposioToolSummary[]>;
  executeTool(input: {
    userId: string;
    toolkit: string;
    connectedAccountId: string;
    slug: string;
    arguments: Record<string, unknown>;
    signal?: AbortSignal;
  }): Promise<ComposioToolResult>;
};
