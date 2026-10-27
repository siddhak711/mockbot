import type { ProcessEnv } from "./db/open";

/** Services that have an opt-in mock for local development and tests. */
export type MockService = "LLM" | "WEB" | "GITHUB" | "CALENDAR" | "SANDBOX";

/** NODE_ENV or VERCEL_ENV set to production. Mocks hard-fail there. */
export function isProductionBuild(env: ProcessEnv): boolean {
  return env.NODE_ENV === "production" || env.VERCEL_ENV === "production";
}

export function mockFlag(service: MockService): string {
  return `MOCK_${service}`;
}

/**
 * True only when MOCK_<SERVICE>=1. A missing credential never turns a mock on.
 * Throws when the flag is set in a production build.
 */
export function mockEnabled(env: ProcessEnv, service: MockService): boolean {
  const flag = mockFlag(service);
  if (env[flag]?.trim() !== "1") return false;
  if (isProductionBuild(env)) {
    throw new Error(`${flag}=1 is not allowed in a production build. Configure the real service.`);
  }
  return true;
}

/** The error a tool returns when its credential is missing and its mock is off. */
export function missingCredential(tool: string, envName: string, service: MockService): string {
  return `${tool} is not configured: ${envName} is not set. Set ${envName}, or set ${mockFlag(service)}=1 to use labeled mock data outside production.`;
}
