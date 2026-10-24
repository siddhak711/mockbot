import { getAppContext } from "../../../src/context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const { store } = await getAppContext();
  const conversations = await store.listConversations();
  return Response.json({ conversations });
}
