export function startMockMcpServer(options?: {
  port?: number;
  leak?: string | null;
  gate?: () => Promise<void>;
}): Promise<{
  url: string;
  authorizations: string[];
  activity: { inflight: number; handled: number };
  close: () => Promise<void>;
}>;

export function createMockServer(leak?: string | null): unknown;
