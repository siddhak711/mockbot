import { afterEach, expect, it } from "vitest";
import { POST } from "../app/api/chat/route";
import { resetAppContext, setAppContext } from "../src/context";
import type { LlmProvider, ProviderEvent } from "../src/llm";
import type { LlmMessage } from "../src/types";
import { SseParser } from "../src/sse";
import { ConversationStore } from "../src/store";

class PausingProvider implements LlmProvider {
  readonly id = "mock" as const;
  readonly model = null;

  async *stream(
    _messages: LlmMessage[],
    options?: { signal?: AbortSignal },
  ): AsyncIterable<ProviderEvent> {
    const signal = options?.signal;
    yield { type: "text", text: "Hello " };
    await new Promise<void>((_resolve, reject) => {
      const fail = () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      if (signal?.aborted) {
        fail();
        return;
      }
      signal?.addEventListener("abort", fail, { once: true });
    });
    yield { type: "text", text: "this should not be kept" };
  }
}

afterEach(async () => {
  await resetAppContext();
});

it("keeps the user message and partial assistant text when the stream is stopped", async () => {
  const store = await ConversationStore.open();
  setAppContext({ store, provider: new PausingProvider() });
  const controller = new AbortController();
  const response = await POST(
    new Request("http://localhost/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Remember this" }),
      signal: controller.signal,
    }),
  );

  const parser = new SseParser();
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let sawDelta = false;
  while (!sawDelta) {
    const { value, done } = await reader.read();
    expect(done).toBe(false);
    const events = parser.push(decoder.decode(value, { stream: true }));
    sawDelta = events.some((event) => event.event === "delta");
  }

  controller.abort();
  try {
    while (true) {
      const { done } = await reader.read();
      if (done) break;
    }
  } catch (error) {
    if (!(error instanceof Error) || error.name !== "AbortError") throw error;
  }

  const listed = await store.listConversations();
  expect(listed).toHaveLength(1);
  const loaded = await store.getConversation(listed[0]!.id);
  expect(loaded?.messages.map((message) => [message.role, message.content])).toEqual([
    ["user", "Remember this"],
    ["assistant", "Hello "],
  ]);
});
