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
import { PLAN_MODE_ON } from "./memory/prompt";
import { ASK_USER_TOOL, type AskGate } from "./tools/ask-user";
import { requiresApproval, type ApprovalGate } from "./tools/approval";
import {
  approvedPlanMessage,
  PROPOSE_PLAN_TOOL,
  parsePlan,
  fallbackPlan,
  stepCommand,
  type PlanGate,
  type PlanStep,
} from "./tools/plan";
import { runTool, type ToolRegistry } from "./tools/registry";
import {
  activityTitle,
  BLOCKED_MEMORY_OUTPUT,
  describeTool,
  STOPPED_TOOL_OUTPUT,
} from "./tools/display";
import type { ToolContext } from "./tools/types";
import { buildModelInput } from "./turn";
import { applyStreamEvent, emptyTrace, hasVisibleStream, modelPromptParts } from "./trace";
import type { LlmStreamEvent, LlmToolCall, MessageTrace, ToolCallStatus } from "./types";

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
  status: ToolCallStatus;
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

export async function streamChatTurn(options: {
  store: ConversationStore;
  provider: LlmProvider;
  tools: ToolRegistry;
  approvals: ApprovalGate;
  asks: AskGate;
  plans: PlanGate;
  plan?: boolean;
  message: string;
  conversationId?: string;
  agentId?: string;
  signal?: AbortSignal;
  agents?: AgentDirectory;
  memory?: AgentMemoryPort;
  computer?: ComputerPort;
  connector?: ConnectorPort;
  userId?: string;
}): Promise<Response> {
  const message = options.message.trim();
  if (!message) {
    return Response.json({ error: "Message is required" }, { status: 400 });
  }
  if (message.length > MAX_MESSAGE_LENGTH) {
    return Response.json({ error: "Message is too long" }, { status: 400 });
  }

  const agents = options.agents ?? (await AgentDirectory.attach(options.store));
  const memory = options.memory ?? new NoteMemory(agents);
  const computer = options.computer ?? defaultComputer;
  const connector = options.connector ?? defaultConnector;
  const conversationId = options.conversationId?.trim() || undefined;
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
    conversation = await options.store.createConversation(
      titleFromMessage(message),
      owner.id,
      options.userId,
    );
  }
  if (options.approvals.hasPending(conversation.id)) {
    return Response.json(
      { error: "An approval is still pending for this conversation." },
      { status: 409 },
    );
  }
  if (options.asks.hasPending(conversation.id)) {
    return Response.json(
      { error: "A question is still waiting for an answer in this conversation." },
      { status: 409 },
    );
  }
  if (options.plans.hasPending(conversation.id)) {
    return Response.json(
      { error: "A plan is still waiting for approval in this conversation." },
      { status: 409 },
    );
  }

  const user = await options.store.addMessage(conversation.id, "user", message);
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
  const history = prepared.messages;
  if (options.plan) {
    const system = history.find((item) => item.role === "system");
    if (system) system.content = `${system.content}\n\n${PLAN_MODE_ON}`;
  }
  const memoryDeps = prepared.deps;

  const { store, provider, approvals, asks, plans, signal } = options;
  const tools = toolsForSpeaker(options.tools, speaker, {
    directory: agents,
    store,
    provider,
    memory,
    computer,
    connector,
    parentAgentId: speaker.id,
    userId: options.userId,
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

  let partial = "";
  const promptParts = modelPromptParts(history);
  let trace: MessageTrace = {
    ...emptyTrace(),
    system: promptParts.system,
    prefill: promptParts.prefill,
  };
  let assistantId: string | null = null;
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
          if (
            call.status !== "running" &&
            call.status !== "approval" &&
            call.status !== "ask" &&
            call.status !== "plan"
          ) {
            continue;
          }
          call.status = "error";
          call.output = "Stopped before the tool finished.";
          await saveCall(call);
        }
      };

      type ActivePlan = { call: PendingCall; steps: PlanStep[]; index: number };
      let activePlan: ActivePlan | null = null;

      const publishPlan = async (status: ToolCallStatus) => {
        if (!activePlan) return;
        activePlan.call.status = status;
        activePlan.call.arguments = JSON.stringify({ steps: activePlan.steps });
        await saveCall(activePlan.call);
        enqueue("plan_progress", {
          id: activePlan.call.id,
          name: activePlan.call.name,
          steps: activePlan.steps,
          status,
          arguments: activePlan.call.arguments,
          assistantMessageId: assistantId,
        });
      };

      const advancePlan = async (assistantCommitted: boolean, text: string): Promise<boolean> => {
        if (!activePlan) return false;
        const current = activePlan.steps[activePlan.index];
        if (!current) return false;
        current.state = "done";
        activePlan.index += 1;
        if (activePlan.index >= activePlan.steps.length) {
          activePlan.call.output = activePlan.steps.map((step) => step.title).join("\n");
          activePlan.call.result = activePlan.call.output;
          await publishPlan("done");
          enqueue("tool_result", {
            id: activePlan.call.id,
            name: activePlan.call.name,
            status: "done",
            output: activePlan.call.output,
            assistantMessageId: assistantId,
          });
          return false;
        }
        const next = activePlan.steps[activePlan.index];
        if (!next) return false;
        next.state = "active";
        await publishPlan("running");
        if (!assistantCommitted) {
          history.push({ role: "assistant", content: text || `Finished: ${current.title}` });
        }
        history.push({ role: "user", content: stepCommand(next, activePlan.index) });
        return true;
      };

      try {
        controller.enqueue(ssePadding());
        enqueue("meta", {
          conversationId: conversationSnapshot.id,
          title: conversationSnapshot.title,
          userMessageId: user.id,
        });
        enqueue("prompt", { system: trace.system ?? "", prefill: trace.prefill ?? "" });

        let sawStart = false;
        let roundEnded = false;
        for (let round = 0; round < MAX_ROUNDS; round += 1) {
          if (clientCancelled() || userStopped) break;
          const exposed = tools.exposed({ promoted });
          const roundCalls: PendingCall[] = [];
          let roundText = "";
          let finishReason: string | null = null;
          roundEnded = false;
          const indexBase = trace.tools.length;
          const roundAbort = new AbortController();
          const providerSignal = roundAbort.signal as AbortSignal & {
            tools?: typeof exposed;
            plan?: boolean;
          };
          providerSignal.tools = exposed;
          if (options.plan) providerSignal.plan = true;
          const abortRound = () => roundAbort.abort(signal?.reason);
          if (followRequest) {
            if (signal?.aborted) abortRound();
            else signal?.addEventListener("abort", abortRound, { once: true });
          }

          const modelEvents = provider.stream(history, providerSignal);
          const events =
            delegateTool && (!options.plan || activePlan)
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

          try {
            for await (const event of events) {
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
          const planCall = pending.find((call) => call.name === PROPOSE_PLAN_TOOL);
          if (!activePlan && (planCall || options.plan)) {
            const resolved = resolvePlanSteps(planCall, message, Boolean(options.plan));
            if (resolved) {
              const call: PendingCall = planCall ?? {
                index: roundCalls.length,
                id: `call_plan_${crypto.randomUUID()}`,
                name: PROPOSE_PLAN_TOOL,
                arguments: "",
                result: null,
                status: "plan",
                output: null,
              };
              if (!call.id) call.id = `call_plan_${crypto.randomUUID()}`;
              const steps = resolved.map((step) => ({ ...step, state: "pending" as const }));
              call.name = PROPOSE_PLAN_TOOL;
              call.arguments = JSON.stringify({ steps });
              call.status = "plan";
              call.output = null;
              call.result = null;
              liveCalls.push(call);
              await saveCall(call);
              followRequest = false;
              enqueue("plan_required", {
                id: call.id,
                name: call.name,
                steps,
                arguments: call.arguments,
                assistantMessageId: assistantId,
              });
              const outcome = await plans.wait(
                call.id,
                steps,
                conversationSnapshot.id,
                assistantId ?? "",
              );
              if (!signal?.aborted) followRequest = true;
              if (outcome.reason !== "approved") {
                const cancelled = outcome.reason === "cancelled";
                const output = cancelled
                  ? "Plan cancelled. Nothing ran."
                  : "The plan timed out before it was approved. Nothing ran.";
                const note = cancelled
                  ? "Cancelled the plan. Nothing ran."
                  : "The plan timed out. Nothing ran.";
                call.status = cancelled ? "denied" : "error";
                call.output = output;
                call.result = output;
                await saveCall(call);
                enqueue("tool_result", {
                  id: call.id,
                  name: call.name,
                  status: call.status,
                  output,
                  assistantMessageId: assistantId,
                });
                await publish(applyStreamEvent(trace, { type: "text", text: note }), {
                  type: "text",
                  text: note,
                });
                break;
              }
              const approved = outcome.steps.map((step, index) => ({
                ...step,
                state: index === 0 ? ("active" as const) : ("pending" as const),
              }));
              call.arguments = JSON.stringify({ steps: approved });
              call.status = "running";
              call.result = "approved";
              activePlan = { call, steps: approved, index: 0 };
              await saveCall(call);
              enqueue("plan_progress", {
                id: call.id,
                name: call.name,
                steps: approved,
                status: "running",
                arguments: call.arguments,
                assistantMessageId: assistantId,
              });
              history.push({
                role: "assistant",
                content: roundText,
                tool_calls: [toLlmToolCall(call)],
              });
              history.push({
                role: "tool",
                tool_call_id: call.id,
                content: approvedPlanMessage(approved),
              });
              const first = approved[0];
              if (first) history.push({ role: "user", content: stepCommand(first, 0) });
              continue;
            }
            if (planCall) {
              if (!planCall.id) planCall.id = `call_${planCall.index}_${crypto.randomUUID()}`;
              await finish(planCall, "error", "The plan was not valid, so nothing ran.");
            }
          }

          const runnable = roundCalls.filter((call) => call.name && call.result == null);
          const shouldRun =
            runnable.length > 0 && (finishReason === "tool_calls" || roundText.length === 0);
          if (!shouldRun) {
            if (await advancePlan(false, roundText)) continue;
            break;
          }

          for (const call of runnable) {
            if (!call.id) call.id = `call_${call.index}_${crypto.randomUUID()}`;
          }
          history.push({
            role: "assistant",
            content: roundText,
            tool_calls: runnable.map(toLlmToolCall),
          });
          for (const call of runnable) {
            if (clientCancelled() || userStopped) break;
            liveCalls.push(call);
            const output = await executeCall(call);
            if (output === null) break;
            history.push({ role: "tool", tool_call_id: call.id, content: output });
          }
          if (clientCancelled() || userStopped) break;
          if (activePlan) {
            if (await advancePlan(true, roundText)) continue;
            break;
          }
        }

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
          });
        }
      } catch (error) {
        await persist(partial, trace);
        if (isAbort(error, signal)) {
          await stopOpenCalls();
        } else {
          await stopOpenCalls();
          const text = error instanceof Error ? error.message : "The model request failed";
          enqueue("error", { message: text });
        }
      } finally {
        await persist(partial, trace);
        close();
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
        if (call.name === PROPOSE_PLAN_TOOL) {
          return finish(call, "done", "The plan is already in progress.");
        }
        if (call.name === ASK_USER_TOOL) {
          return askPerson(call, prepared.args);
        }
        if (requiresApproval(tool, prepared.args)) {
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

function resolvePlanSteps(
  call: PendingCall | undefined,
  userText: string,
  forced: boolean,
): PlanStep[] | null {
  if (call?.arguments) {
    const parsed = parsePlan(call.arguments);
    if (parsed.ok) return parsed.steps.map((step) => ({ ...step, state: "pending" as const }));
  }
  if (forced) return fallbackPlan(userText);
  return null;
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
