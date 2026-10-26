/** Server log when a tool runs its stub because configuration is missing. */
export function warnMockFallback(tool: string, envName: string): void {
  console.warn(`${tool} is using a mock implementation because ${envName} is not set.`);
}
