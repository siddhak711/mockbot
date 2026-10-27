import { afterEach, expect, it } from "vitest";
import { POST as postChat } from "../app/api/chat/route";
import { GET as getComputer } from "../app/api/computer/route";
import {
  COMPUTER_NOT_WIRED,
  CONNECTOR_NOT_WIRED,
  defaultComputer,
  defaultConnector,
} from "../src/agents/ports";
import { resetAppContext, setAppContext } from "../src/context";
import type { LlmProvider } from "../src/llm";
import { isProductionBuild, mockEnabled } from "../src/mock-gate";
import {
  openComputer,
  SANDBOX_NOT_CONFIGURED,
  sandboxUnavailableReason,
} from "../src/sandbox/open";
import { ConversationStore } from "../src/store";
import type { LlmStreamEvent } from "../src/types";
import { readSse } from "./helpers";

afterEach(async () => {
  await resetAppContext();
});

it("turns a mock on only for MOCK_<SERVICE>=1 and refuses it in production builds", () => {
  expect(mockEnabled({}, "WEB")).toBe(false);
  expect(mockEnabled({ MOCK_WEB: "true" }, "WEB")).toBe(false);
  expect(mockEnabled({ MOCK_WEB: "1" }, "WEB")).toBe(true);
  expect(() => mockEnabled({ MOCK_WEB: "1", NODE_ENV: "production" }, "WEB")).toThrow(
    "MOCK_WEB=1 is not allowed in a production build",
  );
  expect(() => mockEnabled({ MOCK_WEB: "1", VERCEL_ENV: "production" }, "WEB")).toThrow(
    /not allowed/,
  );
  expect(isProductionBuild({ VERCEL_ENV: "preview" })).toBe(false);
});

it("will not open the mock computer without DAYTONA_API_KEY unless it is opted in", async () => {
  expect(sandboxUnavailableReason({})).toBe(SANDBOX_NOT_CONFIGURED);
  expect(sandboxUnavailableReason({ MOCK_SANDBOX: "1" })).toBeNull();
  expect(sandboxUnavailableReason({ DAYTONA_API_KEY: "key" })).toBeNull();
  expect(sandboxUnavailableReason({ MOCK_SANDBOX: "1", NODE_ENV: "production" })).toContain(
    "MOCK_SANDBOX=1 is not allowed in a production build",
  );
  await expect(openComputer({ env: {}, dataDir: "memory://" })).rejects.toThrow(
    SANDBOX_NOT_CONFIGURED,
  );
});

/** A mock model that asks for one exec, then stops. */
const execOnce: LlmProvider = {
  id: "mock",
  model: null,
  async *stream(messages): AsyncIterable<LlmStreamEvent> {
    if (messages.some((message) => message.role === "tool")) {
      yield { type: "text", text: "The computer is not set up." };
      yield { type: "end", finishReason: "stop" };
      return;
    }
    yield { type: "tool_call", index: 0, id: "call_exec", name: "exec" };
    yield { type: "tool_call", index: 0, arguments: JSON.stringify({ command: "ls" }) };
    yield { type: "end", finishReason: "tool_calls" };
  },
};

it("surfaces the missing sandbox in the tool result and the computer pane", async () => {
  const store = await ConversationStore.open();
  setAppContext({ store, provider: execOnce, sandboxError: SANDBOX_NOT_CONFIGURED });

  const events = await readSse(
    await postChat(
      new Request("http://localhost/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "List my files" }),
      }),
    ),
  );
  const result = events.find((event) => event.event === "tool_result")?.data as {
    name: string;
    status: string;
    output: string;
  };
  expect(result).toMatchObject({ name: "exec", status: "error" });
  expect(result.output).toBe(SANDBOX_NOT_CONFIGURED);
  expect(result.output).not.toContain('"provider":"mock"');

  const pane = await getComputer(new Request("http://localhost/api/computer"));
  expect(pane.status).toBe(503);
  expect(await pane.json()).toEqual({ error: SANDBOX_NOT_CONFIGURED });
});

it("fails child-run computer and connector calls instead of inventing content", async () => {
  await expect(defaultComputer.read("desk", "notes.txt")).rejects.toThrow(COMPUTER_NOT_WIRED);
  await expect(defaultConnector.call("notion", "search", {})).rejects.toThrow(CONNECTOR_NOT_WIRED);
});
