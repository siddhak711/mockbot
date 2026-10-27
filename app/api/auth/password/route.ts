import { publicUser, sessionCookieHeader } from "../../../../src/auth/cookies";
import {
  PasswordAuthError,
  SIGN_UP_FAILED,
  signInWithPassword,
  signUpWithPassword,
} from "../../../../src/auth/password";
import { clientIp, passwordAttempts } from "../../../../src/auth/rate-limit";
import { prepareUser } from "../../../../src/auth/scope";
import { getAppContext } from "../../../../src/context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    return Response.json({ error: "Expected JSON body" }, { status: 415 });
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Expected JSON body" }, { status: 400 });
  }
  if (!body || typeof body !== "object") {
    return Response.json({ error: "Expected JSON body" }, { status: 400 });
  }
  const record = body as { intent?: unknown; email?: unknown; password?: unknown; name?: unknown };
  const intent = record.intent === "sign-up" || record.intent === "sign-in" ? record.intent : null;
  if (!intent) return Response.json({ error: "Choose sign in or sign up." }, { status: 400 });
  const email = typeof record.email === "string" ? record.email : "";
  const password = typeof record.password === "string" ? record.password : "";
  const name = typeof record.name === "string" ? record.name : undefined;
  const attemptKey = `${clientIp(request)}|${email.trim().toLowerCase()}`;
  const wait = passwordAttempts.retryAfter(attemptKey);
  if (wait > 0) {
    return Response.json(
      { error: `Too many attempts. Try again in ${Math.ceil(wait / 60)} min.` },
      { status: 429, headers: { "Retry-After": String(wait) } },
    );
  }
  try {
    const { store } = await getAppContext();
    const result =
      intent === "sign-up"
        ? await signUpWithPassword(store.connection, { email, password, name })
        : await signInWithPassword(store.connection, { email, password });
    passwordAttempts.reset(attemptKey);
    await prepareUser(store.connection, result.user.id);
    const response = Response.json({ user: publicUser(result.user) });
    response.headers.append(
      "Set-Cookie",
      sessionCookieHeader(result.sessionToken, result.expires, request),
    );
    return response;
  } catch (error) {
    if (error instanceof PasswordAuthError) {
      if (error.status === 401 || error.message === SIGN_UP_FAILED)
        passwordAttempts.fail(attemptKey);
      return Response.json({ error: error.message }, { status: error.status });
    }
    throw error;
  }
}
