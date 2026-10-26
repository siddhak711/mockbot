import { NextRequest } from "next/server";
import { afterEach, expect, it, vi } from "vitest";
import { POST as signInPassword } from "../app/api/auth/password/route";
import { signOutAction } from "../src/auth/actions";
import { SESSION_COOKIE } from "../src/auth/cookies";
import { requirePageUser } from "../src/auth/guard";
import { readSessionUser } from "../src/auth/sessions";
import { resetAppContext, setAppContext } from "../src/context";
import { MockProvider } from "../src/llm";
import { ConversationStore } from "../src/store";
import { proxy } from "../proxy";

const cookieJar = vi.hoisted(() => {
  const values = new Map<string, string>();
  const cleared: string[] = [];
  return {
    values,
    cleared,
    reset() {
      values.clear();
      cleared.length = 0;
    },
    get(name: string) {
      const value = values.get(name);
      return value ? { value } : undefined;
    },
    set(name: string, value: string, options?: { maxAge?: number }) {
      if (!value || options?.maxAge === 0) {
        values.delete(name);
        cleared.push(name);
        return;
      }
      values.set(name, value);
    },
  };
});

vi.mock("next/headers", () => ({
  cookies: async () => cookieJar,
}));

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    const error = new Error(`NEXT_REDIRECT:${url}`);
    error.name = "RedirectError";
    throw error;
  },
}));

afterEach(async () => {
  cookieJar.reset();
  await resetAppContext();
});

function request(path: string, cookie?: string): NextRequest {
  return new NextRequest(`http://localhost:3000${path}`, {
    headers: cookie ? { cookie } : {},
  });
}

it("redirects anonymous app requests to login and leaves auth routes public", async () => {
  const home = proxy(request("/"));
  expect(home.status).toBe(200);
  expect(home.headers.get("location")).toBeNull();

  const routines = proxy(request("/routines?tab=runs"));
  expect(routines.status).toBe(307);
  expect(routines.headers.get("location")).toBe(
    "http://localhost:3000/login?next=%2Froutines%3Ftab%3Druns",
  );

  const settings = proxy(request("/settings"));
  expect(settings.headers.get("location")).toBe("http://localhost:3000/login?next=%2Fsettings");

  expect(proxy(request("/login")).headers.get("location")).toBeNull();
  expect(proxy(request("/login?error=Configuration")).headers.get("location")).toBeNull();
  expect(proxy(request("/api/auth/session")).status).toBe(200);
  expect(proxy(request("/api/auth/password")).status).toBe(200);
  expect(proxy(request("/api/auth/callback/google")).status).toBe(200);

  const api = proxy(request("/api/conversations"));
  expect(api.status).toBe(401);
  expect(await api.json()).toEqual({ error: "Unauthorized" });

  const signedIn = proxy(request("/", `${SESSION_COOKIE}=session-token`));
  expect(signedIn.status).toBe(200);
  expect(signedIn.headers.get("location")).toBeNull();

  const secure = proxy(request("/routines", `__Secure-${SESSION_COOKIE}=session-token`));
  expect(secure.status).toBe(200);
  expect(secure.headers.get("location")).toBeNull();
});

function passwordRequest(body: Record<string, string>): Request {
  return new Request("http://localhost:3000/api/auth/password", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

it("signs the page in from the password cookie and logs out completely", async () => {
  const store = await ConversationStore.open();
  setAppContext({ store, provider: new MockProvider({ delayMs: 0 }) });

  await expect(requirePageUser()).rejects.toThrow("NEXT_REDIRECT:/login");

  const created = await signInPassword(
    passwordRequest({
      intent: "sign-up",
      name: "Ada",
      email: "ada@example.com",
      password: "correct horse battery",
    }),
  );
  expect(created.status).toBe(200);
  const setCookie = created.headers.get("set-cookie") ?? "";
  const token = setCookie.match(/authjs\.session-token=([^;]+)/)?.[1];
  expect(token).toBeTruthy();
  cookieJar.values.set(SESSION_COOKIE, token ?? "");

  const user = await requirePageUser();
  expect(user.email).toBe("ada@example.com");
  expect(user.name).toBe("Ada");
  expect(await readSessionUser(store.connection, token ?? "")).toMatchObject({
    email: "ada@example.com",
  });

  await expect(signOutAction()).rejects.toThrow("NEXT_REDIRECT:/login");
  expect(cookieJar.cleared).toEqual([SESSION_COOKIE, `__Secure-${SESSION_COOKIE}`]);
  expect(cookieJar.values.size).toBe(0);
  expect(await readSessionUser(store.connection, token ?? "")).toBeNull();
  await expect(requirePageUser()).rejects.toThrow("NEXT_REDIRECT:/login");
});
