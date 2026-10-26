export function createMockServer(leak?: string | null, extraTools?: string[]): unknown;

export function startMockMcpServer(options?: {
  port?: number;
  leak?: string | null;
  gate?: () => Promise<void>;
  auth?: "none" | "apikey" | "oauth";
  token?: string;
  extraTools?: string[];
}): Promise<{
  url: string;
  authorizations: string[];
  activity: { inflight: number; handled: number };
  close: () => Promise<void>;
}>;
