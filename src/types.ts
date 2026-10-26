export type Role = "user" | "assistant";

export type Conversation = {
  id: string;
  title: string;
  agentId: string;
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

/** Ordered pieces of one assistant turn, in the order the model produced them. */
export type TraceSegment =
  | { type: "reasoning"; text: string }
  | { type: "text"; text: string }
  | { type: "tool"; index: number };

export type MessageTrace = {
  started: boolean;
  role: "assistant" | null;
  reasoning: string;
  tools: ToolTrace[];
  text: string;
  finishReason: string | null;
  ended: boolean;
  /** System prompt sent for this turn. Empty when the turn did not record one. */
  system?: string;
  /** Assistant prefill sent after the user message and before generation. */
  prefill?: string;
  /** Production order. Absent on traces stored before ordered segments existed. */
  segments?: TraceSegment[];
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

export type LivePhase = "start" | "reasoning" | "tool" | "text" | "end";

export type LlmStreamEvent =
  | { type: "start"; role: "assistant" }
  | { type: "reasoning"; text: string }
  | { type: "tool_call"; index: number; id?: string; name?: string; arguments?: string }
  | { type: "tool_result"; id: string; name: string; content: string }
  | { type: "text"; text: string }
  | { type: "end"; finishReason: string | null };
