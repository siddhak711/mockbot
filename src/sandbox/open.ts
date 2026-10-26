import { isHostedRuntime, type ProcessEnv } from "../db/open";
import { warnMockFallback } from "../tools/mock-fallback";
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
    const runtime: SandboxRuntime = settings
      ? new DaytonaRuntime(options.fleet ?? (await createSdkFleet(env)), store, settings.apiKey)
      : mockSandboxRuntime(store);
    return new ComputerSupervisor(store, runtime, commandTimeoutMs(env));
  } catch (error) {
    await store.close();
    throw error;
  }
}

function mockSandboxRuntime(store: SandboxStore): MockSandboxRuntime {
  warnMockFallback("sandbox", "DAYTONA_API_KEY");
  return new MockSandboxRuntime(store);
}
