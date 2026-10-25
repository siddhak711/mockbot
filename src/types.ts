export type Role = "user" | "assistant";

export type Conversation = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
};

export type ToolCallStatus = "running" | "approval" | "done" | "denied" | "error";

export type StoredToolCall = {
  id: string;
  conversationId: string;
  messageId: string;
  name: string;
  arguments: string;
  status: ToolCallStatus;
  output: string | null;
  createdAt: string;
};

export type ToolTrace = {
  index: number;
  id: string;
  name: string;
  arguments: string;
  result: string | null;
};

export type MessageTrace = {
  started: boolean;
  role: "assistant" | null;
  reasoning: string;
  tools: ToolTrace[];
  text: string;
  finishReason: string | null;
  ended: boolean;
};

export type Message = {
  id: string;
  conversationId: string;
  role: Role;
  content: string;
  createdAt: string;
  trace: MessageTrace | null;
  tools?: StoredToolCall[];
};

export type LlmToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

export type LlmMessage = {
  role: "system" | Role | "tool";
  content: string;
  tool_calls?: LlmToolCall[];
  tool_call_id?: string;
};

export type ProviderId = "mock" | "openai";

export type LivePhase = "start" | "reasoning" | "tool" | "text" | "end";

export type LlmStreamEvent =
  | { type: "start"; role: "assistant" }
  | { type: "reasoning"; text: string }
  | { type: "tool_call"; index: number; id?: string; name?: string; arguments?: string }
  | { type: "tool_result"; id: string; name: string; content: string }
  | { type: "text"; text: string }
  | { type: "end"; finishReason: string | null };
