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

export type ToolResult = {
  content: string;
  isError?: boolean;
};

export type ToolContext = {
  signal?: AbortSignal;
  promote?: (names: string[]) => void;
};

export type PreparedArgs = { args: Record<string, unknown> } | { error: string };

export type ToolDefinition = {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  exposure?: "pinned" | "default" | "hidden";
  approval?: "always" | "never" | ((args: Record<string, unknown>) => boolean);
  prepare?: (args: Record<string, unknown>) => PreparedArgs;
  invoke: (args: Record<string, unknown>, context: ToolContext) => Promise<ToolResult>;
};

export type FetchLike = typeof fetch;
