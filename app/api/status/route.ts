import { requireApiUser } from "../../../src/auth/guard";
import { getAppContext } from "../../../src/context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request?: Request): Promise<Response> {
  const actor = await requireApiUser(request);
  if (!actor.ok) return actor.response;
  const { provider, store } = await getAppContext();
  return Response.json({
    provider: provider.id,
    model: provider.model,
    database: store.driver,
  });
}
