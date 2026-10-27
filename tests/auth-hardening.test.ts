import { afterEach, expect, it } from "vitest";
import { POST as passwordRoute } from "../app/api/auth/password/route";
import { readCookie, readSessionToken } from "../src/auth/cookies";
import { requireApiUser } from "../src/auth/guard";
import { AttemptLimiter, clientIp, passwordAttempts } from "../src/auth/rate-limit";
import { resetAppContext, setAppContext } from "../src/context";
import { MockProvider } from "../src/llm";
import { ConversationStore } from "../src/store";

const originalRequireAuth = process.env.MOCKBOT_REQUIRE_AUTH;

afterEach(async () => {
  if (originalRequireAuth === undefined) delete process.env.MOCKBOT_REQUIRE_AUTH;
  else process.env.MOCKBOT_REQUIRE_AUTH = originalRequireAuth;
  passwordAttempts.reset();
  await resetAppContext();
});

function passwordRequest(body: Record<string, string>, ip = "203.0.113.7"): Request {
  return new Request("http://localhost:3000/api/auth/password", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-forwarded-for": `${ip}, 10.0.0.1` },
    body: JSON.stringify(body),
  });
}

it("returns null for a malformed cookie escape instead of throwing", async () => {
  expect(readCookie("authjs.session-token=%E0", "authjs.session-token")).toBeNull();
  expect(readCookie("a=1; authjs.session-token=ok%20token", "authjs.session-token")).toBe(
    "ok token",
  );
  const request = new Request("http://localhost/api/agents", {
    headers: { cookie: "authjs.session-token=%E0%A4%A" },
  });
  expect(readSessionToken(request)).toBeNull();

  process.env.MOCKBOT_REQUIRE_AUTH = "1";
  const store = await ConversationStore.open();
  setAppContext({ store, provider: new MockProvider({ delayMs: 0 }) });
  const actor = await requireApiUser(request);
  expect(actor.ok).toBe(false);
  if (!actor.ok) expect(actor.response.status).toBe(401);
});

it("blocks a key after max failures inside the window and forgets them after", () => {
  let now = 0;
  const limiter = new AttemptLimiter(3, 60_000, () => now);
  for (let index = 0; index < 3; index += 1) {
    expect(limiter.retryAfter("k")).toBe(0);
    limiter.fail("k");
  }
  expect(limiter.retryAfter("k")).toBe(60);
  expect(limiter.retryAfter("other")).toBe(0);
  now = 30_000;
  expect(limiter.retryAfter("k")).toBe(30);
  now = 60_001;
  expect(limiter.retryAfter("k")).toBe(0);
  limiter.fail("k");
  limiter.reset("k");
  expect(limiter.retryAfter("k")).toBe(0);
});

it("reads the client ip from the first forwarded hop", () => {
  const forwarded = new Request("http://x", { headers: { "x-forwarded-for": "1.2.3.4, 5.6.7.8" } });
  expect(clientIp(forwarded)).toBe("1.2.3.4");
  expect(clientIp(new Request("http://x", { headers: { "x-real-ip": "9.9.9.9" } }))).toBe(
    "9.9.9.9",
  );
  expect(clientIp(new Request("http://x"))).toBe("unknown");
});

it("rate limits password sign-in per ip and email", async () => {
  const store = await ConversationStore.open();
  setAppContext({ store, provider: new MockProvider({ delayMs: 0 }) });
  const created = await passwordRoute(
    passwordRequest({
      intent: "sign-up",
      email: "grace@example.com",
      password: "correct horse battery",
    }),
  );
  expect(created.status).toBe(200);

  for (let index = 0; index < 5; index += 1) {
    const wrong = await passwordRoute(
      passwordRequest({ intent: "sign-in", email: "grace@example.com", password: "wrong guess!" }),
    );
    expect(wrong.status).toBe(401);
  }
  const blocked = await passwordRoute(
    passwordRequest({
      intent: "sign-in",
      email: "Grace@Example.com",
      password: "correct horse battery",
    }),
  );
  expect(blocked.status).toBe(429);
  expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThan(0);

  const otherIp = await passwordRoute(
    passwordRequest(
      { intent: "sign-in", email: "grace@example.com", password: "correct horse battery" },
      "198.51.100.9",
    ),
  );
  expect(otherIp.status).toBe(200);
});

it("does not confirm an existing email on sign-up", async () => {
  const store = await ConversationStore.open();
  setAppContext({ store, provider: new MockProvider({ delayMs: 0 }) });
  await passwordRoute(
    passwordRequest({ intent: "sign-up", email: "lin@example.com", password: "lin password 1" }),
  );
  const taken = await passwordRoute(
    passwordRequest({ intent: "sign-up", email: "lin@example.com", password: "a different one" }),
  );
  expect(taken.status).toBe(400);
  const body = (await taken.json()) as { error: string };
  expect(body.error).not.toMatch(/exist/i);
  expect(taken.headers.get("set-cookie")).toBeNull();
});
