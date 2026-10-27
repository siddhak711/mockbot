import { DELEGATE_TOOL_NAME, isLeadAgent } from "./agents/ids";
import { AgentDirectory } from "./agents/directory";
import { NoteMemory, defaultComputer, defaultConnector } from "./agents/ports";
import { buildAgentSystemPrompt } from "./agents/prompt";
import { runWithDelegate } from "./agents/stream";
import { toolsForSpeaker } from "./agents/tool";
import type { AgentMemoryPort, ComputerPort, ConnectorPort } from "./agents/types";
import { findSecrets } from "./memory/scrub";
import { encodeSse, ssePadding } from "./sse";
import { titleFromMessage, type ConversationStore } from "./store";
import type { LlmProvider } from "./llm";
import { ASK_UNATTENDED, ASK_USER_TOOL, type AskGate } from "./tools/ask-user";
import { requiresApproval, type ApprovalGate } from "./tools/approval";
import { runTool, type ToolRegistry } from "./tools/registry";
import {
  activityTitle,
  BLOCKED_MEMORY_OUTPUT,
  describeTool,
  STOPPED_TOOL_OUTPUT,
} from "./tools/display";
import type { ToolContext } from "./tools/types";
import {
  RunLog,
  captureModelEvent,
  cloneMessages,
  elapsedMs,
  emptyModelCapture,
  ignoreRunLog,
} from "./runs/events";
import { buildModelInput, dropAbandonedPrompts } from "./turn";
import { applyStreamEvent, emptyTrace, hasVisibleStream, modelPromptParts } from "./trace";
import type {
  Conversation,
  LlmMessage,
  LlmStreamEvent,
  LlmToolCall,
  MessageTrace,
  StoredToolCall,
} from "./types";

const MAX_MESSAGE_LENGTH = 20_000;
const MAX_ROUNDS = 8;

const SSE_HEADERS = {
  "Content-Type": "text/event-stream; charset=utf-8",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
  "X-Accel-Buffering": "no",
};

type PendingCall = {
  index: number;
  id: string;
  name: string;
  arguments: string;
  result: string | null;
  status: "running" | "approval" | "ask" | "done" | "denied" | "error";
  output: string | null;
};

function isAbort(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  return error instanceof Error && error.name === "AbortError";
}

function eventName(event: LlmStreamEvent): string {
  return event.type === "text" ? "delta" : event.type;
}

function eventData(event: LlmStreamEvent): unknown {
  switch (event.type) {
    case "start":
      return { role: event.role };
    case "reasoning":
    case "text":
      return { text: event.text };
    case "tool_call": {
      const data: { index: number; id?: string; name?: string; arguments?: string } = {
        index: event.index,
      };
      if (event.id) data.id = event.id;
      if (event.name) data.name = event.name;
      if (event.arguments) data.arguments = event.arguments;
      return data;
    }
    case "tool_result":
      return { id: event.id, name: event.name, content: event.content };
    case "end":
      return { finishReason: event.finishReason };
  }
}

function mergeName(current: string, chunk: string): string {
  if (!chunk) return current;
  if (!current || chunk === current || chunk.startsWith(current)) return chunk;
  return current + chunk;
}

function denialText(reason: "user" | "timeout"): string {
  if (reason === "timeout") {
    return "Approval timed out before the user responded, so the action was not run. Do not retry it unless they ask.";
  }
  return "The user denied this action. Do not retry it unless they ask.";
}

function upsertCall(
  calls: PendingCall[],
  event: Extract<LlmStreamEvent, { type: "tool_call" }>,
): void {
  let call = calls.find((item) => item.index === event.index);
  if (!call) {
    call = {
      index: event.index,
      id: "",
      name: "",
      arguments: "",
      result: null,
      status: "running",
      output: null,
    };
    calls.push(call);
  }
  if (event.id && !call.id) call.id = event.id;
  if (event.name) call.name = mergeName(call.name, event.name);
  if (event.arguments) call.arguments += event.arguments;
}

/** What every chat turn needs, whether it starts from a message or resumes an answer. */
export type ChatTurnOptions = {
  store: ConversationStore;
  provider: LlmProvider;
  tools: ToolRegistry;
  approvals: ApprovalGate;
  asks: AskGate;
  /** Routine and other background runs must not wait for a person. */
  unattended?: boolean;
  signal?: AbortSignal;
  agents?: AgentDirectory;
  memory?: AgentMemoryPort;
  computer?: ComputerPort;
  connector?: ConnectorPort;
  userId?: string;
  /** Reuse a run id chosen by the caller, such as a routine run. */
  runId?: string;
};

export const UNATTENDED_APPROVAL =
  "This run has nobody to approve actions, so this one was not run. Do not retry it unless the person asks.";

/**
 * Conversations whose turn is starting, or whose paused turn is resuming. A new
 * turn holds the lock while it checks for open questions and adds its message.
 * An answer takes it before claiming the question and keeps it until the
 * resumed turn finishes. So the two can never interleave.
 */
const lockedConversations = new Set<string>();

export const CONVERSATION_BUSY = "The previous turn is still finishing in this conversation.";

/** Take the conversation's turn lock. Returns its release, or null when it is held. */
export function lockConversation(conversationId: string): (() => void) | null {
  if (lockedConversations.has(conversationId)) return null;
  lockedConversations.add(conversationId);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    lockedConversations.delete(conversationId);
  };
}

/** New turns wait while a question or approval in this conversation is still open. */
async function pendingTurnBlock(
  options: ChatTurnOptions,
  conversationId: string,
): Promise<Response | null> {
  if (options.approvals.hasPending(conversationId)) {
    return Response.json(
      { error: "An approval is still pending for this conversation." },
      { status: 409 },
    );
  }
  if (options.asks.hasPending(conversationId) || (await options.store.hasOpenAsk(conversationId))) {
    return Response.json(
      { error: "A question is still waiting for an answer in this conversation." },
      { status: 409 },
    );
  }
  return null;
}

export async function streamChatTurn(
  options: ChatTurnOptions & {
    message: string;
    conversationId?: string;
    agentId?: string;
  },
): Promise<Response> {
  const message = options.message.trim();
  if (!message) {
    return Response.json({ error: "Message is required" }, { status: 400 });
  }
  if (message.length > MAX_MESSAGE_LENGTH) {
    return Response.json({ error: "Message is too long" }, { status: 400 });
  }

  const agents = options.agents ?? (await AgentDirectory.attach(options.store));
  const conversationId = options.conversationId?.trim() || undefined;
  const userId = options.userId ?? null;
  let conversation = conversationId
    ? (await options.store.getConversation(conversationId, undefined, options.userId))?.conversation
    : undefined;
  if (conversationId && !conversation) {
    return Response.json({ error: "Conversation not found" }, { status: 404 });
  }
  if (!conversation) {
    const requested = options.agentId?.trim();
    const owner = (requested ? await agents.get(requested) : null) ?? (await agents.lead());
    if (!owner) return Response.json({ error: "Agent not found" }, { status: 404 });
    conversation = await options.store.getOrCreateAgentConversation(owner.id, userId);
  }
  const named = await options.store.nameIfEmpty(conversation.id, titleFromMessage(message), userId);
  if (named) conversation = named;
  const release = lockConversation(conversation.id);
  if (!release) return Response.json({ error: CONVERSATION_BUSY }, { status: 409 });
  let userMessageId: string;
  try {
    const blocked = await pendingTurnBlock(options, conversation.id);
    if (blocked) return blocked;
    userMessageId = (await options.store.addMessage(conversation.id, "user", message)).id;
  } finally {
    release();
  }
  return runChatTurn({ ...options, agents }, conversation, { userMessageId });
}

/**
 * Continue a turn that paused on ask_user after its live waiter is gone. The
 * caller holds the conversation lock (lockConversation) and has claimed the
 * answer row. This takes over `release` and calls it when the resumed turn
 * ends. The same turn builder and loop as a new message run it, seeded with
 * the stored assistant message.
 */
export async function resumeChatTurn(
  options: ChatTurnOptions & { tool: StoredToolCall; answer: string; release: () => void },
): Promise<Response> {
  const { release } = options;
  try {
    const response = await startResume(options);
    // A streamed turn releases the lock when its stream finishes.
    if (!response.headers.get("content-type")?.includes("text/event-stream")) release();
    return response;
  } catch (error) {
    release();
    throw error;
  }
}

async function startResume(
  options: ChatTurnOptions & { tool: StoredToolCall; answer: string; release: () => void },
): Promise<Response> {
  const loaded = await options.store.getConversation(
    options.tool.conversationId,
    undefined,
    options.userId,
  );
  if (!loaded) return Response.json({ error: "Conversation not found" }, { status: 404 });
  const message = loaded.messages.find((item) => item.id === options.tool.messageId);
  if (!message) return Response.json({ error: "Question message not found" }, { status: 404 });
  if (loaded.messages.at(-1)?.id !== message.id) {
    return Response.json(
      { error: "The conversation moved on after this question." },
      { status: 409 },
    );
  }
  if (options.approvals.hasPending(loaded.conversation.id)) {
    return Response.json(
      { error: "An approval is still pending for this conversation." },
      { status: 409 },
    );
  }
  const trace = applyStreamEvent(message.trace ?? emptyTrace(), {
    type: "tool_result",
    id: options.tool.id,
    name: ASK_USER_TOOL,
    content: options.answer,
  });
  await options.store.updateMessage(message.id, trace.text, trace);
  return runChatTurn(options, loaded.conversation, {
    resume: { messageId: message.id, trace, release: options.release },
  });
}

type TurnStart =
  | { userMessageId: string }
  | { resume: { messageId: string; trace: MessageTrace; release: () => void } };

/** The stored turn as model history: one assistant message with its calls, then each result. */
function resumedHistory(trace: MessageTrace): LlmMessage[] {
  const calls = trace.tools.filter((tool) => tool.id && tool.name);
  const messages: LlmMessage[] = [
    {
      role: "assistant",
      content: trace.text,
      ...(calls.length
        ? {
            tool_calls: calls.map((tool) => ({
              id: tool.id,
              type: "function" as const,
              function: { name: tool.name, arguments: tool.arguments || "{}" },
            })),
          }
        : {}),
    },
  ];
  for (const tool of calls) {
    messages.push({
      role: "tool",
      tool_call_id: tool.id,
      content: tool.result ?? "This tool did not finish.",
    });
  }
  return messages;
}

async function runChatTurn(
  options: ChatTurnOptions,
  conversation: Conversation,
  start: TurnStart,
): Promise<Response> {
  const agents = options.agents ?? (await AgentDirectory.attach(options.store));
  const memory = options.memory ?? new NoteMemory(agents);
  const computer = options.computer ?? defaultComputer;
  const connector = options.connector ?? defaultConnector;
  const resume = "resume" in start ? start.resume : null;
  const speaker = (await agents.get(conversation.agentId)) ?? (await agents.lead());
  if (!speaker) return Response.json({ error: "Agent not found" }, { status: 404 });
  const [memories, grants] = await Promise.all([
    memory.list(speaker.id),
    agents.listGrants(speaker.id),
  ]);
  const prepared = await buildModelInput({
    store: options.store,
    conversationId: conversation.id,
    agentId: conversation.agentId,
    agentPrompt: buildAgentSystemPrompt({ agent: speaker, memories, grants, child: false }),
  });
  if (!prepared) return Response.json({ error: "Conversation not found" }, { status: 404 });
  const history = options.unattended ? dropAbandonedPrompts(prepared.messages) : prepared.messages;
  if (resume) {
    // The paused message is the last one. Replace its plain text with the full
    // turn so far: every tool call this turn made and its result.
    if (history.at(-1)?.role === "assistant") history.pop();
    history.push(...resumedHistory(resume.trace));
  }
  const memoryDeps = prepared.deps;

  const { store, provider, approvals, asks, signal } = options;
  const runLog = new RunLog(store.connection, options.runId);
  const tools = toolsForSpeaker(options.tools, speaker, {
    directory: agents,
    store,
    provider,
    memory,
    computer,
    connector,
    parentAgentId: speaker.id,
    userId: options.userId,
    runLog,
  });
  const delegateTool = isLeadAgent(speaker) ? tools.get("delegate") : undefined;
  const conversationSnapshot = conversation;
  const promoted = new Set<string>();
  const toolContext: ToolContext = {
    signal,
    memory: memoryDeps,
    promote(names) {
      for (const name of names) promoted.add(name);
    },
  };

  const promptParts = modelPromptParts(history);
  let trace: MessageTrace = resume
    ? resume.trace
    : {
        ...emptyTrace(),
        system: promptParts.system,
        prefill: promptParts.prefill,
      };
  let partial = trace.text;
  let assistantId: string | null = resume?.messageId ?? null;
  let saved = "";
  let persistQueue = Promise.resolve();
  let userStopped = false;
  let followRequest = true;
  const clientCancelled = () => followRequest && Boolean(signal?.aborted);
  const liveCalls: PendingCall[] = [];

  const persist = (text: string, current: MessageTrace) => {
    const encoded = JSON.stringify({ text, trace: current });
    persistQueue = persistQueue.then(async () => {
      if (encoded === saved) return;
      if (!hasVisibleStream(current, text)) return;
      if (!assistantId) {
        const created = await store.addMessage(conversationSnapshot.id, "assistant", text, current);
        assistantId = created.id;
      } else {
        await store.updateMessage(assistantId, text, current);
      }
      saved = encoded;
    });
    return persistQueue;
  };

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const enqueue = (event: string, data: unknown) => {
        if (closed || signal?.aborted) return;
        try {
          controller.enqueue(encodeSse(event, data));
        } catch {
          closed = true;
        }
      };
      const close = () => {
        if (closed) return;
        closed = true;
        try {
          controller.close();
        } catch {
          closed = true;
        }
      };

      const publish = async (next: MessageTrace, event: LlmStreamEvent) => {
        trace = next;
        partial = next.text;
        await persist(partial, trace);
        if (signal?.aborted) return;
        enqueue(eventName(event), eventData(event));
      };

      const remember = async (next: MessageTrace) => {
        trace = next;
        partial = next.text;
        await persist(partial, trace);
      };

      const saveCall = async (call: PendingCall) => {
        if (!assistantId) {
          const created = await store.addMessage(
            conversationSnapshot.id,
            "assistant",
            partial,
            trace,
          );
          assistantId = created.id;
        }
        await store.saveToolCall({
          id: call.id,
          conversationId: conversationSnapshot.id,
          messageId: assistantId,
          name: call.name,
          arguments: call.arguments,
          status: call.status,
          output: call.output,
        });
      };

      const stopOpenCalls = async () => {
        for (const call of liveCalls) {
          if (call.status !== "running" && call.status !== "approval" && call.status !== "ask") {
            continue;
          }
          call.status = "error";
          call.output = "Stopped before the tool finished.";
          await saveCall(call);
        }
      };

      let runStatus = "completed";
      try {
        controller.enqueue(ssePadding());
        await ignoreRunLog(runLog.mark("run.started", { conversationId: conversationSnapshot.id }));
        enqueue("meta", {
          conversationId: conversationSnapshot.id,
          title: conversationSnapshot.title,
          userMessageId: "userMessageId" in start ? start.userMessageId : null,
          runId: runLog.id,
          ...(resume ? { resumedMessageId: resume.messageId } : {}),
        });
        enqueue("prompt", { system: trace.system ?? "", prefill: trace.prefill ?? "" });

        let sawStart = Boolean(resume?.trace.started);
        let roundEnded = false;
        for (let round = 0; round < MAX_ROUNDS; round += 1) {
          if (clientCancelled() || userStopped) break;
          const exposed = tools.exposed({ promoted });
          const roundCalls: PendingCall[] = [];
          let roundText = "";
          let finishReason: string | null = null;
          roundEnded = false;
          const indexBase = trace.tools.length;
          // A later round, or a resumed one, can reuse an id this turn already
          // stored. A fresh id keeps the new call from overwriting that row.
          const takenIds = new Set(trace.tools.map((tool) => tool.id).filter(Boolean));
          const renamed = new Map<string, string>();
          const idsByIndex = new Map<number, string>();
          const roundAbort = new AbortController();
          const providerSignal = roundAbort.signal as AbortSignal & {
            tools?: typeof exposed;
          };
          providerSignal.tools = exposed;
          const abortRound = () => roundAbort.abort(signal?.reason);
          if (followRequest) {
            if (signal?.aborted) abortRound();
            else signal?.addEventListener("abort", abortRound, { once: true });
          }

          const modelInput = cloneMessages(history);
          const capture = emptyModelCapture();
          const modelStarted = performance.now();
          const modelEvents = provider.stream(history, providerSignal);
          const events = delegateTool
            ? runWithDelegate(modelEvents, async (call) => {
                let args: Record<string, unknown>;
                try {
                  const parsed: unknown = JSON.parse(call.arguments);
                  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
                    return "Delegation failed: arguments are not JSON.";
                  }
                  args = parsed as Record<string, unknown>;
                } catch {
                  return "Delegation failed: arguments are not JSON.";
                }
                const result = await delegateTool.invoke(args, { signal });
                return result.content;
              })
            : modelEvents;

          runLog.holdWrites();
          try {
            for await (const raw of events) {
              captureModelEvent(capture, raw);
              const event = freshToolIds(raw, takenIds, renamed, idsByIndex);
              if (clientCancelled() || userStopped) break;
              if (!sawStart && event.type !== "start") {
                sawStart = true;
                await publish(applyStreamEvent(trace, { type: "start", role: "assistant" }), {
                  type: "start",
                  role: "assistant",
                });
                if (clientCancelled() || userStopped) break;
              }
              if (event.type === "start") sawStart = true;
              if (event.type === "text") roundText += event.text;
              if (event.type === "tool_call") upsertCall(roundCalls, event);
              if (event.type === "tool_result") {
                const match =
                  roundCalls.find((call) => call.id === event.id) ??
                  roundCalls.find((call) => call.name === event.name && call.result == null);
                if (match) match.result = event.content;
              }
              if (event.type === "end") {
                roundEnded = true;
                finishReason = event.finishReason;
              }
              const published =
                event.type === "tool_call" ? { ...event, index: indexBase + event.index } : event;
              await publish(applyStreamEvent(trace, published), published);
              if (clientCancelled() || userStopped) break;
            }
          } finally {
            signal?.removeEventListener("abort", abortRound);
            const deferred = runLog.drainHeld();
            try {
              await ignoreRunLog(
                runLog.recordModel({
                  model: provider.model,
                  messages: modelInput,
                  capture,
                  ms: elapsedMs(modelStarted),
                }),
              );
            } finally {
              await ignoreRunLog(runLog.appendHeld(deferred));
            }
          }
          if (clientCancelled() || userStopped) break;

          for (const call of roundCalls) {
            if (call.name !== DELEGATE_TOOL_NAME || call.result == null || call.output != null) {
              continue;
            }
            if (!call.id) call.id = `call_${crypto.randomUUID()}`;
            call.status = call.result.startsWith("Delegation failed") ? "error" : "done";
            call.output = call.result;
            await saveCall(call);
          }

          const pending = roundCalls.filter((call) => call.name && call.result == null);
          const shouldRun =
            pending.length > 0 && (finishReason === "tool_calls" || roundText.length === 0);
          if (!shouldRun) break;

          for (const call of pending) {
            if (!call.id) call.id = `call_${call.index}_${crypto.randomUUID()}`;
          }
          history.push({
            role: "assistant",
            content: roundText,
            tool_calls: pending.map(toLlmToolCall),
          });
          for (const call of pending) {
            if (clientCancelled() || userStopped) break;
            liveCalls.push(call);
            const output = await executeCall(call);
            if (output === null) break;
            history.push({ role: "tool", tool_call_id: call.id, content: output });
          }
          if (clientCancelled() || userStopped) break;
        }

        if (clientCancelled() || userStopped) runStatus = "stopped";
        if (!clientCancelled() && !userStopped && sawStart && !roundEnded) {
          await publish(applyStreamEvent(trace, { type: "end", finishReason: "stop" }), {
            type: "end",
            finishReason: "stop",
          });
        }
        await persist(partial, trace);
        if (clientCancelled() || userStopped) {
          await stopOpenCalls();
        } else {
          enqueue("done", {
            conversationId: conversationSnapshot.id,
            assistantMessageId: assistantId,
            runId: runLog.id,
          });
        }
      } catch (error) {
        await persist(partial, trace);
        if (isAbort(error, signal)) {
          runStatus = "stopped";
          await stopOpenCalls();
        } else {
          runStatus = "error";
          await stopOpenCalls();
          // A failed turn is over. Ending its trace lets a client watching a
          // resumed turn stop waiting and unlock the composer.
          if (trace.started) {
            trace = applyStreamEvent(trace, { type: "end", finishReason: "error" });
          }
          const text = error instanceof Error ? error.message : "The model request failed";
          await ignoreRunLog(runLog.fail(text));
          enqueue("error", { message: text });
        }
      } finally {
        try {
          await persist(partial, trace);
          await ignoreRunLog(runLog.mark("run.finished", { status: runStatus }));
        } finally {
          resume?.release();
          close();
        }
      }

      async function askPerson(
        call: PendingCall,
        args: Record<string, unknown>,
      ): Promise<string | null> {
        const question = typeof args.question === "string" ? args.question : "";
        const options = Array.isArray(args.options)
          ? args.options.filter((option): option is string => typeof option === "string")
          : [];
        const allowCustom = args.allowCustom === true;
        call.arguments = JSON.stringify({ question, options, allowCustom });
        call.status = "ask";
        await saveCall(call);
        followRequest = false;
        enqueue("ask_user", {
          id: call.id,
          name: call.name,
          question,
          options,
          allowCustom,
          arguments: call.arguments,
          assistantMessageId: assistantId,
        });
        const outcome = await asks.wait(
          call.id,
          { question, options, allowCustom },
          conversationSnapshot.id,
        );
        if (outcome.reason === "timeout") {
          // The answer route may have claimed the row as the waiter timed out.
          // That route continues the turn, so this loop steps aside.
          const stored = await store.getToolCall(call.id);
          if (stored && stored.status !== "ask") {
            call.status = "done";
            call.output = stored.output;
            userStopped = true;
            return null;
          }
        }
        if (!signal?.aborted) followRequest = true;
        if (outcome.reason === "stopped") {
          userStopped = true;
          call.status = "error";
          call.output = STOPPED_TOOL_OUTPUT;
          await saveCall(call);
          await remember(
            applyStreamEvent(trace, {
              type: "tool_result",
              id: call.id,
              name: call.name,
              content: call.output,
            }),
          );
          return null;
        }
        if (outcome.reason === "timeout") {
          return finish(
            call,
            "error",
            "The user did not answer before the question timed out. Do not invent an answer.",
          );
        }
        return finish(call, "done", outcome.answer);
      }

      async function executeCall(call: PendingCall): Promise<string | null> {
        const toolStarted = performance.now();
        try {
          return await runCall(call);
        } finally {
          await ignoreRunLog(
            runLog.recordTool({
              name: call.name || "tool",
              input: call.arguments,
              output: call.output ?? "",
              ms: elapsedMs(toolStarted),
            }),
          );
        }
      }

      async function runCall(call: PendingCall): Promise<string | null> {
        call.status = "running";
        await saveCall(call);
        enqueue("tool_start", {
          id: call.id,
          name: call.name,
          assistantMessageId: assistantId,
        });
        enqueue("tool_args", { id: call.id, arguments: call.arguments });

        const parsed = parseArguments(call.arguments);
        if (!parsed.ok) return finish(call, "error", parsed.error);
        const tool = tools.get(call.name);
        if (!tool) {
          return finish(
            call,
            "error",
            `Unknown tool "${call.name}". Call tool_search to find a tool.`,
          );
        }
        const prepared = tool.prepare ? tool.prepare(parsed.args) : { args: parsed.args };
        if ("error" in prepared) return finish(call, "error", prepared.error);
        if (call.name === ASK_USER_TOOL) {
          if (options.unattended) return finish(call, "error", ASK_UNATTENDED);
          return askPerson(call, prepared.args);
        }
        if (requiresApproval(tool, prepared.args)) {
          if (options.unattended) return finish(call, "denied", UNATTENDED_APPROVAL);
          // Store what will run if approved, not the raw model arguments.
          call.arguments = JSON.stringify(prepared.args);
          call.status = "approval";
          await saveCall(call);
          const described = describeTool(call.name, JSON.stringify(prepared.args));
          enqueue("approval_required", {
            id: call.id,
            name: call.name,
            arguments: JSON.stringify(prepared.args),
            summary: described.summary,
            assistantMessageId: assistantId,
          });
          const outcome = await approvals.wait(call.id, undefined, conversationSnapshot.id);
          if (outcome.reason === "stopped") {
            userStopped = true;
            call.status = "error";
            call.output = STOPPED_TOOL_OUTPUT;
            await saveCall(call);
            await remember(
              applyStreamEvent(trace, {
                type: "tool_result",
                id: call.id,
                name: call.name,
                content: call.output,
              }),
            );
            return null;
          }
          if (outcome.decision !== "approve") {
            return finish(
              call,
              "denied",
              denialText(outcome.reason === "timeout" ? "timeout" : "user"),
            );
          }
          call.status = "running";
          await saveCall(call);
          enqueue("tool_status", {
            id: call.id,
            name: call.name,
            status: "running",
            assistantMessageId: assistantId,
          });
        }
        const result = await runTool(tool, prepared.args, {
          ...toolContext,
          signal: followRequest && !signal?.aborted ? toolContext.signal : undefined,
        });
        if (!call.name.startsWith("memory_")) memoryDeps.toolOutputs.push(result.content);
        const blocked = result.blocked === "secret";
        const shown = blocked ? BLOCKED_MEMORY_OUTPUT : result.content;
        const activity = toolActivity(
          {
            id: call.id,
            name: call.name,
            output: shown,
            isError: Boolean(result.isError),
            blocked: result.blocked,
          },
          "done",
        );
        return finish(
          call,
          result.isError ? "error" : "done",
          shown,
          result.content,
          call.name.startsWith("memory_") ? activity.title : undefined,
        );
      }

      async function finish(
        call: PendingCall,
        status: PendingCall["status"],
        output: string,
        modelOutput = output,
        title?: string,
      ): Promise<string> {
        const resolvedTitle =
          title ??
          (call.name.startsWith("memory_")
            ? activityTitle(call.name, "done", status === "error", output === BLOCKED_MEMORY_OUTPUT)
            : undefined);
        call.status = status;
        call.output = output;
        call.result = output;
        enqueue("tool_result", {
          id: call.id,
          name: call.name,
          status,
          output,
          ...(resolvedTitle ? { title: resolvedTitle } : {}),
          assistantMessageId: assistantId,
        });
        await saveCall(call);
        await remember(
          applyStreamEvent(trace, {
            type: "tool_result",
            id: call.id,
            name: call.name,
            content: output,
          }),
        );
        return modelOutput;
      }
    },
    async cancel() {
      await persist(partial, trace);
    },
  });

  return new Response(stream, { headers: SSE_HEADERS });
}

function freshToolIds(
  event: LlmStreamEvent,
  takenIds: Set<string>,
  renamed: Map<string, string>,
  idsByIndex: Map<number, string>,
): LlmStreamEvent {
  if (event.type === "tool_result") {
    const id = renamed.get(event.id);
    return id ? { ...event, id } : event;
  }
  if (event.type !== "tool_call") return event;
  const assigned = idsByIndex.get(event.index);
  if (assigned) return event.id ? { ...event, id: assigned } : event;
  if (!event.id) return event;
  let id = event.id;
  if (takenIds.has(id)) {
    id = `call_${crypto.randomUUID()}`;
    renamed.set(event.id, id);
  }
  idsByIndex.set(event.index, id);
  takenIds.add(id);
  return id === event.id ? event : { ...event, id };
}

function parseArguments(
  raw: string,
): { ok: true; args: Record<string, unknown> } | { ok: false; error: string } {
  const text = raw.trim() ? raw : "{}";
  try {
    const value = JSON.parse(text) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return { ok: false, error: "Tool arguments must be a JSON object." };
    }
    return { ok: true, args: value as Record<string, unknown> };
  } catch {
    return { ok: false, error: "Tool arguments were not valid JSON." };
  }
}

function toLlmToolCall(call: PendingCall): LlmToolCall {
  return {
    id: call.id,
    type: "function",
    function: { name: call.name, arguments: call.arguments || "{}" },
  };
}

export function toolActivity(
  call: { id: string; name: string; output: string; isError: boolean; blocked?: "secret" },
  phase: "running" | "done",
): {
  id: string;
  title: string;
  detail: string;
  state: "running" | "done";
  kind: "search" | "draft";
} {
  const secret = phase === "done" && findSecrets(call.output).length > 0;
  const blockedWrite = phase === "done" && call.blocked === "secret";
  const title = activityTitle(call.name, phase, call.isError, blockedWrite);
  const detail =
    phase === "running"
      ? "Running"
      : blockedWrite
        ? "Blocked. A secret was not stored."
        : secret
          ? "Finished. The result was not shown."
          : call.output.slice(0, 240);
  return {
    id: call.id,
    title,
    detail,
    state: phase === "running" ? "running" : "done",
    kind: call.name === "memory_search" ? "search" : "draft",
  };
}
