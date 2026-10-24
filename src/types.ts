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

export type Message = {
  id: string;
  conversationId: string;
  role: Role;
  content: string;
  createdAt: string;
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
