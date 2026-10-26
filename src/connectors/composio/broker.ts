import type { ComposioBroker } from "./types";

let override: ComposioBroker | null = null;
let cached: { apiKey: string; broker: ComposioBroker } | null = null;

export function setComposioBrokerForTests(broker: ComposioBroker | null): void {
  if (process.env.VITEST !== "true") {
    throw new Error("Composio test broker is only available in tests.");
  }
  override = broker;
  cached = null;
}

export async function getComposioBroker(
  env: Record<string, string | undefined>,
): Promise<ComposioBroker> {
  if (override) return override;
  const apiKey = env["COMPOSIO_API_KEY"]?.trim() ?? "";
  if (!apiKey) throw new Error("Set COMPOSIO_API_KEY to connect catalog apps.");
  if (cached && cached.apiKey === apiKey) return cached.broker;
  const { createSdkComposioBroker } = await import("./sdk");
  const broker = createSdkComposioBroker(env, apiKey);
  cached = { apiKey, broker };
  return broker;
}
