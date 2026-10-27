import { afterEach, expect, it } from "vitest";
import { POST as postChat } from "../app/api/chat/route";
import { POST as postStop } from "../app/api/chat/stop/route";
import { GET as getConversation } from "../app/api/conversations/[id]/route";
import { resetAppContext, setAppContext } from "../src/context";
import type { LlmProvider } from "../src/llm";
import { isTurnLive } from "../src/live-turns";
import { SseParser } from "../src/sse";
import { ConversationStore } from "../src/store";
import { phaseFromTrace } from "../src/trace";
import { emptyTrace } from "../src/trace";
import type { LlmMessage, LlmStreamEvent } from "../src/types";

/** Streams "Hello ", then waits for the test to open the gate before "world". */
class GatedProvider implements LlmProvider {
  readonly id = "mock" as const;
  readonly model = null;
  private open: () => void = () => {};
  readonly gate = new Promise<void>((resolve) => {
    this.open = resolve;
  });

  release() {
    this.open();
  }

  async *stream(
    _messages: LlmMessage[],
    options?: { signal?: AbortSignal },
  ): AsyncIterable<LlmStreamEvent> {
    const signal = options?.signal;
    yield { type: "start", role: "assistant" };
    yield { type: "text", text: "Hello " };
    await new Promise<void>((resolve, reject) => {
      const fail = () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      if (signal?.aborted) return fail();
      signal?.addEventListener("abort", fail, { once: true });
      void this.gate.then(resolve);
    });
    yield { type: "text", text: "world" };
    yield { type: "end", finishReason: "stop" };
  }
}

afterEach(async () => {
  await resetAppContext();
});

async function startTurn(detach: boolean) {
  const store = await ConversationStore.open();
  const provider = new GatedProvider();
  setAppContext({ store, provider });
  const controller = new AbortController();
  const response = await postChat(
    new Request("http://localhost/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Say hello", detach }),
      signal: controller.signal,
    }),
  );
  const parser = new SseParser();
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let conversationId = "";
  let sawDelta = false;
  while (!sawDelta) {
    const { value, done } = await reader.read();
    if (done) throw new Error("stream ended early");
    for (const event of parser.push(decoder.decode(value, { stream: true }))) {
      if (event.event === "meta") conversationId = String(JSON.parse(event.data).conversationId);
      if (event.event === "delta") sawDelta = true;
    }
  }
  // A reload: the page drops its connection.
  controller.abort();
  void reader.cancel().catch(() => {});
  return { store, provider, conversationId };
}

async function readThread(id: string) {
  const response = await getConversation(new Request(`http://localhost/api/conversations/${id}`), {
    params: Promise.resolve({ id }),
  });
  return (await response.json()) as {
    running: boolean;
    messages: Array<{ role: string; content: string }>;
  };
}

async function until(check: () => Promise<boolean>) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out");
}

it("keeps generating after the page disconnects and finishes the reply", async () => {
  const { provider, conversationId } = await startTurn(true);

  const during = await readThread(conversationId);
  expect(during.running).toBe(true);
  expect(during.messages.at(-1)).toMatchObject({ role: "assistant", content: "Hello " });

  provider.release();
  await until(async () => !(await readThread(conversationId)).running);
  const after = await readThread(conversationId);
  expect(after.messages.map((message) => [message.role, message.content])).toEqual([
    ["user", "Say hello"],
    ["assistant", "Hello world"],
  ]);
});

it("stops a detached reply from the Stop route and keeps the partial text", async () => {
  const { conversationId } = await startTurn(true);
  expect(isTurnLive(conversationId)).toBe(true);

  const stopped = await postStop(
    new Request("http://localhost/api/chat/stop", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ conversationId }),
    }),
  );
  expect(await stopped.json()).toEqual({ stopped: true });

  await until(async () => !(await readThread(conversationId)).running);
  const after = await readThread(conversationId);
  expect(after.messages.map((message) => message.content)).toEqual(["Say hello", "Hello "]);
});

it("still stops on disconnect when the client did not ask to detach", async () => {
  const { conversationId } = await startTurn(false);
  await until(async () => !(await readThread(conversationId)).running);
  expect((await readThread(conversationId)).messages.at(-1)?.content).toBe("Hello ");
});

it("refuses to stop a conversation it can't find and reports when nothing runs", async () => {
  const store = await ConversationStore.open();
  setAppContext({ store, provider: new GatedProvider() });
  const stop = (conversationId: unknown) =>
    postStop(
      new Request("http://localhost/api/chat/stop", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversationId }),
      }),
    );
  expect((await stop("missing")).status).toBe(404);
  expect((await stop(42)).status).toBe(400);
  const idle = await store.createConversation("Idle");
  expect(await (await stop(idle.id)).json()).toEqual({ stopped: false });
});

it("names the phase of a stored turn from its newest segment", () => {
  expect(phaseFromTrace(null)).toBe("start");
  const started = { ...emptyTrace(), started: true };
  expect(phaseFromTrace({ ...started, segments: [{ type: "reasoning", text: "hm" }] })).toBe(
    "reasoning",
  );
  expect(
    phaseFromTrace({
      ...started,
      segments: [
        { type: "reasoning", text: "hm" },
        { type: "text", text: "Hi" },
      ],
    }),
  ).toBe("text");
  expect(phaseFromTrace({ ...started, ended: true })).toBe("end");
});
