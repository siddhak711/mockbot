import type { LlmProvider } from "../llm";
import { titleFromMessage, type ConversationStore } from "../store";
import { applyStreamEvent, emptyTrace } from "../trace";
import type { LlmMessage, MessageTrace } from "../types";
import type { AgentDirectory } from "./directory";
import { DELEGATE_TOOL_NAME, USE_COMPUTER_TOOL, USE_CONNECTOR_TOOL } from "./ids";
import { buildAgentSystemPrompt } from "./prompt";
import type { Agent, AgentMemoryPort, ComputerPort, ConnectorPort } from "./types";

export type DelegationOutcome = {
  content: string;
  isError: boolean;
  conversationId: string | null;
};

function abortError(): Error {
  return Object.assign(new Error("The operation was aborted"), { name: "AbortError" });
}

function isAbort(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  return error instanceof Error && error.name === "AbortError";
}

function parseObject(raw: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function runChildTool(
  agent: Agent,
  tool: { name: string; arguments: string },
  directory: AgentDirectory,
  computer: ComputerPort,
  connector: ConnectorPort,
): Promise<{ content: string; failed: boolean }> {
  if (tool.name === DELEGATE_TOOL_NAME) {
    return { content: "A child run cannot delegate further.", failed: true };
  }
  if (tool.name !== USE_COMPUTER_TOOL && tool.name !== USE_CONNECTOR_TOOL) {
    return { content: "This tool is not available on a child run.", failed: false };
  }
  const args = parseObject(tool.arguments || "{}");
  if (!args) return { content: "Tool arguments are not JSON.", failed: true };

  if (tool.name === USE_COMPUTER_TOOL) {
    const computerId = typeof args.computerId === "string" ? args.computerId.trim() : "";
    const path = typeof args.path === "string" && args.path.trim() ? args.path.trim() : "notes.txt";
    if (!computerId) return { content: "use_computer requires computerId.", failed: true };
    if (!(await directory.hasGrant(agent.id, "computer", computerId))) {
      return {
        content: `${agent.name} is not granted computer ${computerId}.`,
        failed: true,
      };
    }
    try {
      return { content: await computer.read(computerId, path), failed: false };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Computer read failed.";
      return { content: message, failed: true };
    }
  }

  const connectorId = typeof args.connectorId === "string" ? args.connectorId.trim() : "";
  const toolName = typeof args.tool === "string" && args.tool.trim() ? args.tool.trim() : "call";
  if (!connectorId) return { content: "use_connector requires connectorId.", failed: true };
  if (!(await directory.hasGrant(agent.id, "connector", connectorId))) {
    return {
      content: `${agent.name} is not granted connector ${connectorId}.`,
      failed: true,
    };
  }
  const forwarded =
    args.arguments && typeof args.arguments === "object" && !Array.isArray(args.arguments)
      ? (args.arguments as Record<string, unknown>)
      : {};
  try {
    return { content: await connector.call(connectorId, toolName, forwarded), failed: false };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Connector call failed.";
    return { content: message, failed: true };
  }
}

function summarize(text: string, tools: MessageTrace["tools"], failed: boolean): string {
  const lines: string[] = [];
  if (text.trim()) lines.push(text.trim());
  for (const tool of tools) {
    if (tool.result) lines.push(`${tool.name}: ${tool.result}`);
  }
  const body = lines.join("\n\n") || "The child run returned nothing.";
  return failed ? `Delegation failed: ${body}` : body;
}

export async function performDelegation(
  args: Record<string, unknown>,
  deps: {
    directory: AgentDirectory;
    store: ConversationStore;
    provider: LlmProvider;
    memory: AgentMemoryPort;
    computer: ComputerPort;
    connector: ConnectorPort;
    parentAgentId: string;
    userId?: string;
    signal?: AbortSignal;
  },
): Promise<DelegationOutcome> {
  const agentName = typeof args.agent === "string" ? args.agent.trim() : "";
  const task = typeof args.task === "string" ? args.task.trim() : "";
  if (!agentName || !task) {
    return {
      content: "Delegation failed: agent and task are required.",
      isError: true,
      conversationId: null,
    };
  }
  if (deps.signal?.aborted) throw abortError();

  const agent = await deps.directory.findByName(agentName);
  if (!agent) {
    return {
      content: `Delegation failed: no agent named ${agentName}.`,
      isError: true,
      conversationId: null,
    };
  }
  if (agent.id === deps.parentAgentId) {
    return {
      content: `Delegation failed: ${agent.name} cannot delegate to itself.`,
      isError: true,
      conversationId: null,
    };
  }

  const userId = deps.userId ?? null;
  const conversation = await deps.store.getOrCreateAgentConversation(agent.id, userId);
  await deps.store.nameIfEmpty(conversation.id, titleFromMessage(task), userId);
  await deps.store.addMessage(conversation.id, "user", task);
  const grants = await deps.directory.listGrants(agent.id);
  const memories = await deps.memory.list(agent.id);
  const stored = await deps.store.getConversation(conversation.id, agent.id);
  const messages: LlmMessage[] = [
    {
      role: "system",
      content: buildAgentSystemPrompt({ agent, memories, grants, child: true }),
    },
    ...(stored?.messages ?? [{ role: "user" as const, content: task }]).map((message) => ({
      role: message.role,
      content: message.content,
    })),
  ];

  let trace = emptyTrace();
  try {
    for await (const event of deps.provider.stream(messages, deps.signal)) {
      if (deps.signal?.aborted) throw abortError();
      trace = applyStreamEvent(trace, event);
    }
  } catch (error) {
    if (isAbort(error, deps.signal)) throw error;
    const message = error instanceof Error ? error.message : "The child run failed.";
    const content = `Delegation failed: ${message}`;
    await deps.store.addMessage(conversation.id, "assistant", content, {
      ...emptyTrace(),
      started: true,
      role: "assistant",
      text: content,
      ended: true,
      finishReason: "stop",
    });
    return { content, isError: true, conversationId: conversation.id };
  }

  let failed = false;
  for (const tool of trace.tools) {
    const outcome = await runChildTool(agent, tool, deps.directory, deps.computer, deps.connector);
    tool.result = outcome.content;
    if (outcome.failed) failed = true;
  }
  const content = summarize(trace.text, trace.tools, failed);
  trace.text = trace.text || content;
  await deps.store.addMessage(conversation.id, "assistant", trace.text, trace);
  return { content, isError: failed, conversationId: conversation.id };
}
