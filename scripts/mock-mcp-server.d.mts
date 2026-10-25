export function startMockMcpServer(options?: { port?: number; leak?: string | null }): Promise<{
  url: string;
  authorizations: string[];
  close: () => Promise<void>;
}>;

export function createMockServer(leak?: string | null): unknown;
