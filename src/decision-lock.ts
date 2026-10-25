export type DecisionLock = { current: string | null };

export function beginDecision(lock: DecisionLock, id: string): boolean {
  if (lock.current) return false;
  lock.current = id;
  return true;
}

export function releaseDecision(lock: DecisionLock, id: string): void {
  if (lock.current === id) lock.current = null;
}

export function stopDecision(lock: DecisionLock): void {
  lock.current = null;
}

export async function settleDecision(
  lock: DecisionLock,
  id: string,
  request: () => Promise<boolean>,
): Promise<"busy" | "held" | "released"> {
  if (!beginDecision(lock, id)) return "busy";
  try {
    const accepted = await request();
    if (!accepted) {
      releaseDecision(lock, id);
      return "released";
    }
    return "held";
  } catch (error) {
    releaseDecision(lock, id);
    throw error;
  }
}
