import { getAppContext } from "../../../src/context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const { provider, store } = await getAppContext();
  return Response.json({
    provider: provider.id,
    model: provider.model,
    database: store.driver,
  });
}
