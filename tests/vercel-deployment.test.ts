import { expect, it } from "vitest";
import {
  chooseDeployment,
  deploymentUrl,
  deploymentsFromApi,
  waitForReadyDeployment,
  type DeploymentRecord,
} from "../e2e/deployment";

const sha = "abc123";

function deployment(overrides: DeploymentRecord): DeploymentRecord {
  return {
    url: "mockbot-preview.vercel.app",
    readyState: "READY",
    target: null,
    created: 2,
    meta: { githubCommitSha: sha },
    ...overrides,
  };
}

it("prefers the newest preview deployment and ignores production", () => {
  const choice = chooseDeployment(
    [
      deployment({ url: "old.vercel.app", created: 1, readyState: "READY" }),
      deployment({
        url: "prod.vercel.app",
        created: 3,
        target: "production",
        readyState: "READY",
      }),
      deployment({ url: "new.vercel.app", created: 2, readyState: "BUILDING" }),
    ],
    sha,
    "preview",
  );
  expect(choice).toEqual({ status: "pending", state: "BUILDING" });
});

it("returns the production URL only after that deployment is ready", () => {
  const choice = chooseDeployment(
    [
      deployment({ url: "preview.vercel.app", target: null, created: 5 }),
      deployment({
        url: "mockbot-prod.vercel.app",
        target: "production",
        created: 4,
        readyState: "READY",
      }),
    ],
    sha,
    "production",
  );
  expect(choice).toEqual({ status: "ready", url: "https://mockbot-prod.vercel.app" });
});

it("fails closed when the newest deployment errored", () => {
  expect(
    chooseDeployment([deployment({ readyState: "ERROR", created: 9 })], sha, "preview"),
  ).toEqual({ status: "failed", state: "ERROR" });
});

it("ignores a different commit when the sha is present", () => {
  expect(
    chooseDeployment(
      [deployment({ meta: { githubCommitSha: "other" }, readyState: "READY" })],
      sha,
      "preview",
    ),
  ).toEqual({ status: "missing" });
});

it("formats hostnames and parses the API envelope", () => {
  expect(deploymentUrl({ url: "https://mockbot-jet.vercel.app/" })).toBe(
    "https://mockbot-jet.vercel.app",
  );
  expect(deploymentsFromApi({ deployments: [{ url: "a.vercel.app" }] })).toEqual([
    { url: "a.vercel.app" },
  ]);
  expect(deploymentsFromApi({})).toEqual([]);
});

it("waits until the deployment is ready", async () => {
  const states = ["BUILDING", "READY"];
  let clock = 0;
  const url = await waitForReadyDeployment({
    sha,
    target: "preview",
    timeoutMs: 50,
    intervalMs: 10,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
    list: async () => [deployment({ readyState: states.shift() ?? "READY" })],
  });
  expect(url).toBe("https://mockbot-preview.vercel.app");
});

it("stops when the deployment fails instead of waiting out the timeout", async () => {
  await expect(
    waitForReadyDeployment({
      sha,
      target: "production",
      timeoutMs: 1_000,
      intervalMs: 10,
      sleep: async () => {},
      list: async () => [deployment({ target: "production", readyState: "CANCELED" })],
    }),
  ).rejects.toThrow(/CANCELED/);
});
