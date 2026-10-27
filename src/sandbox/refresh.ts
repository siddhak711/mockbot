import type { ComputerSnapshot } from "./types";

export async function fetchComputerSnapshot(
  fetchImpl: (input: string) => Promise<Response>,
  request: number,
  latest: () => number,
  agentId?: string,
): Promise<ComputerSnapshot | undefined> {
  const query = agentId ? `?agentId=${encodeURIComponent(agentId)}` : "";
  const response = await fetchImpl(`/api/computer${query}`);
  if (request !== latest()) return;
  if (!response.ok) return;
  const snapshot = (await response.json()) as ComputerSnapshot;
  if (request !== latest()) return;
  return snapshot;
}
