import type { ConversationStore } from "../store";
import { saveMemory } from "../memory/save";
import { SEARCH_TOKEN_BUDGET, SEARCH_TOP_K, trimToTokens } from "../memory/tokens";
import { memoryLine } from "../memory/prompt";
import type { MemoryKind } from "../types";
import type { MemoryToolDeps, ToolDefinition } from "./types";

export function createMemoryTools(
  store: ConversationStore,
  deps: MemoryToolDeps,
): ToolDefinition[] {
  return [
    memoryWriteTool(store, deps),
    memoryUpdateTool(store, deps),
    memoryDeleteTool(store, deps),
    memorySearchTool(store, deps),
  ];
}

function memoryWriteTool(store: ConversationStore, deps: MemoryToolDeps): ToolDefinition {
  return {
    name: "memory_write",
    description:
      "Save a fact the user just stated. An existing key is closed and a new row is stored. Use kind profile for stable identity and preferences, and fact otherwise.",
    exposure: "pinned",
    approval: "never",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string", description: "Short stable name for the fact" },
        text: { type: "string", description: "The fact, in the user's words" },
        kind: { type: "string", enum: ["profile", "fact"], description: "profile or fact" },
      },
      required: ["key", "text"],
      additionalProperties: false,
    },
    prepare: prepareKeyText,
    async invoke(args) {
      const saved = await saveMemory(store.memories, {
        agentId: deps.agentId,
        key: String(args.key),
        content: String(args.text),
        kind: kindOf(args.kind),
        sourceMessageId: deps.sourceMessageId,
        createdBy: "model",
        mode: "write",
        userMessages: deps.userMessages,
        toolOutputs: deps.toolOutputs,
        ground: true,
      });
      if (!saved.ok) return { content: saved.error, isError: true };
      const verb = saved.updated ? "Updated" : "Saved";
      return {
        content: `${verb} memory "${saved.memory.key}" (${saved.memory.kind}). ${
          saved.updated ? "The previous value was kept in history." : "Stored a new memory."
        }`,
      };
    },
  };
}

function memoryUpdateTool(store: ConversationStore, deps: MemoryToolDeps): ToolDefinition {
  return {
    name: "memory_update",
    description:
      "Correct a saved fact. Closes the live row and inserts a new one that supersedes it. Does not overwrite the old row.",
    exposure: "pinned",
    approval: "never",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string", description: "Key of the memory to correct" },
        text: { type: "string", description: "The corrected fact" },
        kind: { type: "string", enum: ["profile", "fact"] },
      },
      required: ["key", "text"],
      additionalProperties: false,
    },
    prepare: prepareKeyText,
    async invoke(args) {
      const saved = await saveMemory(store.memories, {
        agentId: deps.agentId,
        key: String(args.key),
        content: String(args.text),
        kind: kindOf(args.kind),
        sourceMessageId: deps.sourceMessageId,
        createdBy: "model",
        mode: "update",
        userMessages: deps.userMessages,
        toolOutputs: deps.toolOutputs,
        ground: true,
      });
      if (!saved.ok) return { content: saved.error, isError: true };
      return {
        content: `Updated memory "${saved.memory.key}". The previous row stays in history and the new text is the one that will be retrieved.`,
      };
    },
  };
}

function memoryDeleteTool(store: ConversationStore, deps: MemoryToolDeps): ToolDefinition {
  return {
    name: "memory_delete",
    description: "Soft-delete a memory by key so it is no longer retrieved.",
    exposure: "pinned",
    approval: "never",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string", description: "Key of the memory to forget" },
      },
      required: ["key"],
      additionalProperties: false,
    },
    prepare(args) {
      const key = typeof args.key === "string" ? args.key.trim() : "";
      if (!key) return { error: "memory_delete requires a key." };
      return { args: { key } };
    },
    async invoke(args) {
      const deleted = await store.memories.softDeleteByKey(deps.agentId, String(args.key));
      if (!deleted) {
        return {
          content: `No memory with that key is stored for this agent.`,
          isError: true,
        };
      }
      return {
        content: `Forgot "${deleted.key}". The memory was deleted and will not be retrieved.`,
      };
    },
  };
}

function memorySearchTool(store: ConversationStore, deps: MemoryToolDeps): ToolDefinition {
  return {
    name: "memory_search",
    description: "Search this agent's live memories by full text. Returns the top matches.",
    exposure: "pinned",
    approval: "never",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Words to search for" },
        limit: { type: "integer", description: "Maximum matches, up to 8" },
      },
      required: ["query"],
      additionalProperties: false,
    },
    prepare(args) {
      const query = typeof args.query === "string" ? args.query.trim() : "";
      if (!query) return { error: "memory_search requires a query." };
      const limit =
        typeof args.limit === "number" && Number.isFinite(args.limit)
          ? Math.trunc(args.limit)
          : SEARCH_TOP_K;
      return { args: { query, limit } };
    },
    async invoke(args) {
      const query = String(args.query ?? "");
      const limit = typeof args.limit === "number" ? args.limit : SEARCH_TOP_K;
      const matches = await store.memories.search({
        agentId: deps.agentId,
        query,
        limit,
      });
      if (matches.length === 0) return { content: "No matching memories." };
      const lines = matches.map((memory) => memoryLine(memory));
      return {
        content: trimToTokens(lines.join("\n"), SEARCH_TOKEN_BUDGET) || "No matching memories.",
      };
    },
  };
}

function prepareKeyText(args: Record<string, unknown>) {
  const key = typeof args.key === "string" ? args.key.trim() : "";
  const text = typeof args.text === "string" ? args.text.trim() : "";
  if (!key) return { error: "A key string is required." };
  if (!text) return { error: "Text is required." };
  const kind = args.kind === "profile" || args.kind === "fact" ? args.kind : undefined;
  return { args: { key, text, ...(kind ? { kind } : {}) } };
}

function kindOf(value: unknown): MemoryKind | null {
  return value === "profile" || value === "fact" ? value : null;
}
