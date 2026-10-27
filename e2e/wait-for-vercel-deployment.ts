import { appendFileSync } from "node:fs";
import { deploymentsFromApi, waitForReadyDeployment, type DeploymentTarget } from "./deployment";

const PROJECT_ID = process.env.VERCEL_PROJECT_ID?.trim() || "prj_8eZarx7J93N9I98K1Tpwo4tVi5yR";
const TEAM_ID = process.env.VERCEL_TEAM_ID?.trim() || "team_i7qtAESwPEcnE6oij072KIei";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(
      `${name} is empty. Add it as a repository secret. The smoke workflow cannot discover the deployment without it.`,
    );
  }
  return value;
}

function targetFromEnv(): DeploymentTarget {
  const target = process.env.DEPLOYMENT_TARGET?.trim();
  if (target === "production" || target === "preview") return target;
  throw new Error('DEPLOYMENT_TARGET must be "preview" or "production".');
}

function writeOutput(name: string, value: string): void {
  const file = process.env.GITHUB_OUTPUT;
  if (!file) {
    console.log(`${name}=${value}`);
    return;
  }
  appendFileSync(file, `${name}=${value}\n`);
}

async function listDeployments(token: string, sha: string) {
  const url = new URL("https://api.vercel.com/v6/deployments");
  url.searchParams.set("projectId", PROJECT_ID);
  url.searchParams.set("teamId", TEAM_ID);
  url.searchParams.set("sha", sha);
  url.searchParams.set("limit", "20");
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `Vercel deployments API returned ${response.status}. Confirm VERCEL_TOKEN belongs to team siddhas-projects and can read project mockbot. ${text.slice(0, 300)}`,
    );
  }
  return deploymentsFromApi(JSON.parse(text) as unknown);
}

async function main(): Promise<void> {
  const token = required("VERCEL_TOKEN");
  const sha = required("DEPLOYMENT_SHA");
  const target = targetFromEnv();
  const timeoutMs = Number(process.env.DEPLOYMENT_WAIT_MS ?? 12 * 60 * 1000);
  const intervalMs = Number(process.env.DEPLOYMENT_POLL_MS ?? 15_000);
  const url = await waitForReadyDeployment({
    sha,
    target,
    timeoutMs,
    intervalMs,
    list: () => listDeployments(token, sha),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    log: (message) => console.log(message),
  });
  console.log(`Smoke target: ${url}`);
  writeOutput("url", url);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
