import type { MemoryKind, MemoryOrigin, MemoryVersion } from "../types";
import { copiedFromToolOutput, groundedInUserMessages } from "./grounding";
import { normalizeKey } from "./prompt";
import { MemoryRepository } from "./repository";
import { findSecrets, logBlockedMemory, type SecretKind } from "./scrub";

const MAX_CONTENT = 4_000;

export type SaveResult =
  | { ok: true; memory: MemoryVersion; previousId: string | null; updated: boolean }
  | { ok: false; error: string; blocked: "secret" | "grounding" | "validation" | "missing" };

export async function saveMemory(
  memories: MemoryRepository,
  input: {
    agentId: string;
    key: string;
    content: string;
    kind?: MemoryKind | null;
    sourceMessageId?: string | null;
    createdBy: string;
    origin?: MemoryOrigin | null;
    signal?: string | null;
    edited?: boolean;
    fromAgent?: string | null;
    evidence?: string | null;
    mode: "write" | "update";
    userMessages?: readonly string[];
    toolOutputs?: readonly string[];
    ground?: boolean;
  },
): Promise<SaveResult> {
  const key = normalizeKey(input.key);
  const content = input.content.trim();
  if (!key) return { ok: false, blocked: "validation", error: "A memory key is required." };
  if (!content) return { ok: false, blocked: "validation", error: "Memory text is required." };
  if (content.length > MAX_CONTENT) {
    return { ok: false, blocked: "validation", error: "Memory text is too long." };
  }
  const secrets = findSecrets(`${key}\n${content}`);
  if (secrets.length > 0) {
    logBlockedMemory({ agentId: input.agentId, kinds: secrets });
    return {
      ok: false,
      blocked: "secret",
      error: blockedSecretMessage(secrets),
    };
  }
  if (input.ground) {
    const userMessages = input.userMessages ?? [];
    const toolOutputs = input.toolOutputs ?? [];
    if (
      !groundedInUserMessages(content, userMessages) ||
      copiedFromToolOutput(content, userMessages, toolOutputs)
    ) {
      return {
        ok: false,
        blocked: "grounding",
        error:
          "Not saved. Only facts the user stated in this conversation can be stored. Tool and web output cannot be saved.",
      };
    }
  }
  if (input.mode === "update") {
    const live = await memories.getLiveByKey(input.agentId, key);
    if (live?.kind === "journal") {
      return { ok: false, blocked: "validation", error: "Journal is read-only." };
    }
    const updated = await memories.update({
      agentId: input.agentId,
      key,
      content,
      kind: input.kind,
      sourceMessageId: input.sourceMessageId,
      createdBy: input.createdBy,
      origin: input.origin,
      signal: input.signal,
      edited: input.edited,
      fromAgent: input.fromAgent,
      evidence: input.evidence,
    });
    if (!updated) {
      return {
        ok: false,
        blocked: "missing",
        error: `No memory with that key is stored for this agent. Use memory_write to create "${key}".`,
      };
    }
    return { ok: true, memory: updated.memory, previousId: updated.previousId, updated: true };
  }
  const written = await memories.write({
    agentId: input.agentId,
    key,
    content,
    kind: input.kind,
    sourceMessageId: input.sourceMessageId,
    createdBy: input.createdBy,
    origin: input.origin,
    signal: input.signal,
    edited: input.edited,
    fromAgent: input.fromAgent,
    evidence: input.evidence,
  });
  return {
    ok: true,
    memory: written.memory,
    previousId: written.previousId,
    updated: written.previousId != null,
  };
}

function blockedSecretMessage(kinds: SecretKind[]): string {
  return `Blocked. The text looks like a secret (${kinds.join(", ")}) and was not stored. Tell the user you did not save it. Do not retry with the same secret.`;
}
