export type DeploymentTarget = "preview" | "production";

export type DeploymentRecord = {
  url?: string | null;
  readyState?: string | null;
  state?: string | null;
  target?: string | null;
  created?: number | null;
  createdAt?: number | null;
  meta?: { githubCommitSha?: string | null } | null;
};

export function deploymentState(deployment: DeploymentRecord): string {
  return (deployment.readyState || deployment.state || "UNKNOWN").toUpperCase();
}

export function deploymentUrl(deployment: DeploymentRecord): string | null {
  const url = deployment.url?.trim();
  if (!url) return null;
  if (url.startsWith("https://") || url.startsWith("http://")) return url.replace(/\/$/, "");
  return `https://${url.replace(/\/$/, "")}`;
}

function createdAt(deployment: DeploymentRecord): number {
  return deployment.created ?? deployment.createdAt ?? 0;
}

function matchesTarget(deployment: DeploymentRecord, target: DeploymentTarget): boolean {
  const value = deployment.target ?? null;
  if (target === "production") return value === "production";
  return value !== "production";
}

export function deploymentsForCommit(
  deployments: DeploymentRecord[],
  sha: string,
  target: DeploymentTarget,
): DeploymentRecord[] {
  return deployments
    .filter((deployment) => {
      const commit = deployment.meta?.githubCommitSha;
      if (commit && commit !== sha) return false;
      return matchesTarget(deployment, target);
    })
    .sort((a, b) => createdAt(b) - createdAt(a));
}

const PENDING = new Set(["QUEUED", "BUILDING", "INITIALIZING", "PENDING", "UNKNOWN"]);
const FAILED = new Set(["ERROR", "CANCELED", "CANCELLED", "BLOCKED"]);

export type DeploymentChoice =
  | { status: "missing" }
  | { status: "pending"; state: string }
  | { status: "failed"; state: string }
  | { status: "ready"; url: string };

export function chooseDeployment(
  deployments: DeploymentRecord[],
  sha: string,
  target: DeploymentTarget,
): DeploymentChoice {
  const newest = deploymentsForCommit(deployments, sha, target)[0];
  if (!newest) return { status: "missing" };
  const state = deploymentState(newest);
  if (state === "READY") {
    const url = deploymentUrl(newest);
    if (!url) return { status: "pending", state };
    return { status: "ready", url };
  }
  if (FAILED.has(state)) return { status: "failed", state };
  if (PENDING.has(state)) return { status: "pending", state };
  return { status: "pending", state };
}

export function deploymentsFromApi(body: unknown): DeploymentRecord[] {
  if (!body || typeof body !== "object" || !("deployments" in body)) return [];
  const deployments = (body as { deployments: unknown }).deployments;
  if (!Array.isArray(deployments)) return [];
  return deployments.filter(
    (item): item is DeploymentRecord => Boolean(item) && typeof item === "object",
  );
}

export async function waitForReadyDeployment(options: {
  sha: string;
  target: DeploymentTarget;
  list: () => Promise<DeploymentRecord[]>;
  sleep: (ms: number) => Promise<void>;
  now?: () => number;
  timeoutMs: number;
  intervalMs: number;
  log?: (message: string) => void;
}): Promise<string> {
  const now = options.now ?? Date.now;
  const log = options.log ?? (() => {});
  const deadline = now() + options.timeoutMs;
  let last = "no deployment yet";
  while (now() <= deadline) {
    const choice = chooseDeployment(await options.list(), options.sha, options.target);
    if (choice.status === "ready") return choice.url;
    if (choice.status === "failed") {
      throw new Error(
        `Vercel ${options.target} deployment for ${options.sha} finished as ${choice.state}.`,
      );
    }
    last = choice.status === "pending" ? choice.state : "not created yet";
    log(`Waiting for the ${options.target} deployment (${last}).`);
    if (now() + options.intervalMs > deadline) break;
    await options.sleep(options.intervalMs);
  }
  throw new Error(
    `Timed out after ${options.timeoutMs}ms waiting for a READY ${options.target} deployment of ${options.sha} (${last}). ` +
      "Check that the Vercel GitHub integration is deploying this commit and that VERCEL_TOKEN can read the mockbot project.",
  );
}
