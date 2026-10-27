import { isHostedRuntime, type ProcessEnv } from "../db/open";
import { mockEnabled } from "../mock-gate";
import {
  createSdkFleet,
  DaytonaRuntime,
  readDaytonaSettings,
  type RemoteSandboxFleet,
} from "./daytona";
import { commandTimeoutMs } from "./limits";
import { MockSandboxRuntime } from "./mock";
import type { SandboxRuntime } from "./runtime";
import { ComputerSupervisor } from "./supervisor";
import { SandboxStore } from "./store";

export type SandboxBackend = { kind: "database" } | { kind: "pglite"; dataDir: string };

/**
 * Hosted runtimes and any process with DATABASE_URL use the shared Postgres
 * database. Local dev keeps a PGlite directory (or an explicit dataDir).
 */
export function selectSandboxBackend(env: ProcessEnv, dataDir?: string): SandboxBackend {
  if (env.DATABASE_URL?.trim() || isHostedRuntime(env)) return { kind: "database" };
  return { kind: "pglite", dataDir: dataDir ?? (env.SANDBOX_DATA_DIR?.trim() || ".data/sandbox") };
}

export async function openSandboxStore(env: ProcessEnv, dataDir?: string): Promise<SandboxStore> {
  const backend = selectSandboxBackend(env, dataDir);
  if (backend.kind === "database") return SandboxStore.connect(env);
  return SandboxStore.open(backend.dataDir);
}

export async function openComputer(options: {
  env?: ProcessEnv;
  dataDir?: string;
  fleet?: RemoteSandboxFleet;
}): Promise<ComputerSupervisor> {
  const env = options.env ?? {};
  const store = await openSandboxStore(env, options.dataDir);
  try {
    const settings = readDaytonaSettings(env);
    const reason = sandboxUnavailableReason(env);
    if (reason) throw new Error(reason);
    const runtime: SandboxRuntime = settings
      ? new DaytonaRuntime(options.fleet ?? (await createSdkFleet(env)), store, settings.apiKey)
      : new MockSandboxRuntime(store);
    return new ComputerSupervisor(store, runtime, commandTimeoutMs(env));
  } catch (error) {
    await store.close();
    throw error;
  }
}

export const SANDBOX_NOT_CONFIGURED =
  "The sandbox computer is not configured: DAYTONA_API_KEY is not set. Set DAYTONA_API_KEY, or set MOCK_SANDBOX=1 to use the labeled mock computer outside production.";

/**
 * Why the sandbox cannot open, or null when it can. Daytona needs its key; the
 * mock computer needs MOCK_SANDBOX=1 and refuses production builds.
 */
export function sandboxUnavailableReason(env: ProcessEnv): string | null {
  if (readDaytonaSettings(env)) return null;
  try {
    return mockEnabled(env, "SANDBOX") ? null : SANDBOX_NOT_CONFIGURED;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}
