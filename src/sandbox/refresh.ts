import type { ComputerSnapshot } from "./types";

export async function fetchComputerSnapshot(
  fetchImpl: (input: string) => Promise<Response>,
  request: number,
  latest: () => number,
  agentId?: string | null,
): Promise<ComputerSnapshot | undefined> {
  const url = agentId ? `/api/computer?agentId=${encodeURIComponent(agentId)}` : "/api/computer";
  const response = await fetchImpl(url);
  if (request !== latest()) return;
  if (!response.ok) return;
  const snapshot = (await response.json()) as ComputerSnapshot;
  if (request !== latest()) return;
  return snapshot;
}
