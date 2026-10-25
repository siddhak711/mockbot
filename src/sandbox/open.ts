import { commandTimeoutMs } from "./limits";
import {
  createSdkFleet,
  DaytonaRuntime,
  readDaytonaSettings,
  type RemoteSandboxFleet,
} from "./daytona";
import { MockSandboxRuntime } from "./mock";
import type { SandboxRuntime } from "./runtime";
import { ComputerSupervisor } from "./supervisor";
import { SandboxStore } from "./store";

export async function openComputer(options: {
  env?: Record<string, string | undefined>;
  dataDir?: string;
  fleet?: RemoteSandboxFleet;
}): Promise<ComputerSupervisor> {
  const env = options.env ?? {};
  const dataDir = (options.dataDir ?? env.SANDBOX_DATA_DIR?.trim()) || ".data/sandbox";
  const store = await SandboxStore.open(dataDir);
  const settings = readDaytonaSettings(env);
  const runtime: SandboxRuntime = settings
    ? new DaytonaRuntime(options.fleet ?? (await createSdkFleet(env)), store, settings.apiKey)
    : new MockSandboxRuntime(store);
  return new ComputerSupervisor(store, runtime, commandTimeoutMs(env));
}
