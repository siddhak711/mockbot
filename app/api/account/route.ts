import { readAccount, renameAccount } from "../../../src/auth/account";
import { requireApiUser } from "../../../src/auth/guard";
import { PasswordAuthError } from "../../../src/auth/password";
import { getAppContext } from "../../../src/context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const actor = await requireApiUser(request);
  if (!actor.ok) return actor.response;
  const { store } = await getAppContext();
  const account = await readAccount(store.connection, actor.user.id);
  if (!account) return Response.json({ error: "Account not found" }, { status: 404 });
  return Response.json({ account });
}

export async function PATCH(request: Request): Promise<Response> {
  const actor = await requireApiUser(request);
  if (!actor.ok) return actor.response;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Expected JSON body" }, { status: 400 });
  }
  const name = (body as { name?: unknown } | null)?.name;
  try {
    const { store } = await getAppContext();
    const saved = await renameAccount(
      store.connection,
      actor.user.id,
      typeof name === "string" ? name : "",
    );
    return Response.json({ name: saved });
  } catch (error) {
    if (error instanceof PasswordAuthError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    throw error;
  }
}
