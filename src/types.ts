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

export type LlmMessage = {
  role: "system" | Role;
  content: string;
};

export type ProviderId = "mock" | "openai";
