import { changePassword } from "../../../../src/auth/account";
import { readSessionToken } from "../../../../src/auth/cookies";
import { requireApiUser } from "../../../../src/auth/guard";
import { PasswordAuthError } from "../../../../src/auth/password";
import { getAppContext } from "../../../../src/context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const actor = await requireApiUser(request);
  if (!actor.ok) return actor.response;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Expected JSON body" }, { status: 400 });
  }
  const record = (body ?? {}) as { current?: unknown; next?: unknown };
  try {
    const { store } = await getAppContext();
    await changePassword(store.connection, {
      userId: actor.user.id,
      current: typeof record.current === "string" ? record.current : "",
      next: typeof record.next === "string" ? record.next : "",
      keepSessionToken: readSessionToken(request),
    });
    return new Response(null, { status: 204 });
  } catch (error) {
    if (error instanceof PasswordAuthError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    throw error;
  }
}
