export type Role = "user" | "assistant";

export type Conversation = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
};

export type Message = {
  id: string;
  conversationId: string;
  role: Role;
  content: string;
  createdAt: string;
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

export type MemoryKind = "profile" | "fact";

export type MemoryVersion = {
  id: string;
  agentId: string;
  kind: MemoryKind;
  key: string;
  content: string;
  sourceMessageId: string | null;
  sourceSnippet: string | null;
  supersedes: string | null;
  validFrom: string;
  validTo: string | null;
  deletedAt: string | null;
  createdBy: string;
};

export type Memory = MemoryVersion & {
  history: MemoryVersion[];
};

export type ConversationSummary = {
  conversationId: string;
  summary: string;
  uptoMessageId: string;
  updatedAt: string;
};
