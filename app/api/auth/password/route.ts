import { publicUser, sessionCookieHeader } from "../../../../src/auth/cookies";
import {
  PasswordAuthError,
  signInWithPassword,
  signUpWithPassword,
} from "../../../../src/auth/password";
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
  try {
    const { store } = await getAppContext();
    const result =
      intent === "sign-up"
        ? await signUpWithPassword(store.connection, { email, password, name })
        : await signInWithPassword(store.connection, { email, password });
    await prepareUser(store.connection, result.user.id);
    const response = Response.json({ user: publicUser(result.user) });
    response.headers.append(
      "Set-Cookie",
      sessionCookieHeader(result.sessionToken, result.expires, request),
    );
    return response;
  } catch (error) {
    if (error instanceof PasswordAuthError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    throw error;
  }
}
