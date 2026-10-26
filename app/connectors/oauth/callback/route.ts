import { handleOAuthCallback } from "../../../../src/connectors/oauth/connect";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  return handleOAuthCallback(request);
}
