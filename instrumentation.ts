import { shouldStartInlineWorker } from "./src/routines/clock";

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "edge") return;
  if (!shouldStartInlineWorker(process.env)) return;
  const { startInlineWorker } = await import("./src/routines/inline");
  await startInlineWorker();
}
