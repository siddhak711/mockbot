import type { ComputerSnapshot } from "./types";

export async function fetchComputerSnapshot(
  fetchImpl: (input: string) => Promise<Response>,
  request: number,
  latest: () => number,
): Promise<ComputerSnapshot | undefined> {
  const response = await fetchImpl("/api/computer");
  if (request !== latest()) return;
  if (!response.ok) return;
  const snapshot = (await response.json()) as ComputerSnapshot;
  if (request !== latest()) return;
  return snapshot;
}
