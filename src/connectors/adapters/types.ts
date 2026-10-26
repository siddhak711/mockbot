export type AdapterTool = {
  name: string;
  description: string;
  inputSchema: unknown;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
};

export type AdapterCall = {
  name: string;
  args: Record<string, unknown>;
  token: string;
  baseUrl: string;
  signal?: AbortSignal;
};

export type AdapterResult = {
  content: string;
  isError: boolean;
  authExpired?: boolean;
};

export type ProviderAdapter = {
  id: string;
  listTools(): AdapterTool[];
  callTool(call: AdapterCall): Promise<AdapterResult>;
};
