import { getAppContext } from "../../../src/context";
import { WAITLIST_INVALID, normalizeWaitlistEmail } from "../../../src/landing/waitlist";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Public: the landing page posts here before anyone has an account. */
export async function POST(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Expected JSON body" }, { status: 400 });
  }
  const record = body && typeof body === "object" ? (body as { email?: unknown }) : {};
  const email = normalizeWaitlistEmail(record.email);
  if (!email) return Response.json({ error: WAITLIST_INVALID }, { status: 400 });
  const { store } = await getAppContext();
  await store.joinWaitlist(email);
  return Response.json({ ok: true, email });
}
