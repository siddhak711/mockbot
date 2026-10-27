import type { FullConfig } from "@playwright/test";
import { ensureSmokeAccount } from "./auth";

export default async function globalSetup(config: FullConfig): Promise<void> {
  const baseURL = config.projects[0]?.use.baseURL;
  await ensureSmokeAccount(baseURL);
}
