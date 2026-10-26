const warned = new Set<string>();

/** Server log when a tool runs its stub because configuration is missing. Once per process. */
export function warnMockFallback(tool: string, envName: string): void {
  const key = `${tool}\0${envName}`;
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(`${tool} is using a mock implementation because ${envName} is not set.`);
}
