export const MAX_EXPOSED_TOOLS = 15;

export type JsonSchemaProperty = {
  type: "string" | "number" | "integer" | "boolean" | "array" | "object";
  description?: string;
  enum?: readonly string[];
  items?: { type: "string" | "number" | "integer" | "object" };
};

export type JsonSchema = {
  type: "object";
  properties: Record<string, JsonSchemaProperty>;
  required?: readonly string[];
  additionalProperties?: boolean;
};

export type ToolBlockReason = "secret";

export type ToolResult = {
  content: string;
  isError?: boolean;
  blocked?: ToolBlockReason;
  /** Ends the chat run after this round, such as when a per-run cap is spent. */
  halt?: boolean;
};

export type MemoryToolDeps = {
  agentId: string;
  conversationId: string;
  sourceMessageId: string | null;
  userMessages: string[];
  toolOutputs: string[];
};

export type ToolContext = {
  signal?: AbortSignal;
  promote?: (names: string[]) => void;
  memory?: MemoryToolDeps;
  /** Fresh each chat run. Tools count actions here to enforce per-run caps. */
  runCounters?: Map<string, number>;
};

export type PreparedArgs = { args: Record<string, unknown> } | { error: string };

export type ToolDefinition = {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  exposure?: "pinned" | "default" | "hidden";
  approval?: "always" | "never" | ((args: Record<string, unknown>) => boolean);
  /** Read tools and write tools set to always-allow skip the name heuristic. */
  skipHeuristicApproval?: boolean;
  prepare?: (args: Record<string, unknown>) => PreparedArgs;
  invoke: (args: Record<string, unknown>, context: ToolContext) => Promise<ToolResult>;
};

export type FetchLike = typeof fetch;
