/**
 * Turns that are generating right now, by conversation. A page that reloads
 * mid-reply asks here whether to keep watching, and Stop ends the turn here
 * instead of by dropping the connection.
 */
type LiveTurn = { stop: AbortController };

const GLOBAL_KEY = Symbol.for("mockbot.liveTurns");

function turns(): Map<string, LiveTurn> {
  const g = globalThis as typeof globalThis & { [GLOBAL_KEY]?: Map<string, LiveTurn> };
  if (!g[GLOBAL_KEY]) g[GLOBAL_KEY] = new Map();
  return g[GLOBAL_KEY];
}

/** Registers a turn. Call the returned function when it ends. */
export function beginLiveTurn(conversationId: string): {
  signal: AbortSignal;
  end: () => void;
} {
  const turn: LiveTurn = { stop: new AbortController() };
  turns().set(conversationId, turn);
  return {
    signal: turn.stop.signal,
    end: () => {
      if (turns().get(conversationId) === turn) turns().delete(conversationId);
    },
  };
}

export function isTurnLive(conversationId: string): boolean {
  return turns().has(conversationId);
}

/** Stops the conversation's running turn. Returns false when none is running. */
export function stopLiveTurn(conversationId: string): boolean {
  const turn = turns().get(conversationId);
  if (!turn) return false;
  turn.stop.abort(new DOMException("Stopped by the user", "AbortError"));
  return true;
}
