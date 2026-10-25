export type Role = "user" | "assistant";

export type Conversation = {
  id: string;
  title: string;
  agentId: string;
  createdAt: string;
  updatedAt: string;
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
};

export type LlmMessage = {
  role: "system" | Role;
  content: string;
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
