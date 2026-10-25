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
