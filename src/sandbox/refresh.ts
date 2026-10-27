import type { ComputerSnapshot } from "./types";

/** The server has no sandbox. The message is its sandboxError, or empty when it gave none. */
export class ComputerUnavailableError extends Error {
  override name = "ComputerUnavailableError";
}

export async function fetchComputerSnapshot(
  fetchImpl: (input: string) => Promise<Response>,
  request: number,
  latest: () => number,
): Promise<ComputerSnapshot | undefined> {
  const response = await fetchImpl("/api/computer");
  if (request !== latest()) return;
  if (response.status === 503) {
    const body = (await response.json().catch(() => null)) as { sandboxError?: unknown } | null;
    if (request !== latest()) return;
    const reason = typeof body?.sandboxError === "string" ? body.sandboxError.trim() : "";
    throw new ComputerUnavailableError(reason);
  }
  if (!response.ok) return;
  const snapshot = (await response.json()) as ComputerSnapshot;
  if (request !== latest()) return;
  return snapshot;
}
