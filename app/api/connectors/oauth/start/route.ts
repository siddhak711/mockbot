import { handleOAuthStart } from "../../../../../src/connectors/oauth/connect";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  return handleOAuthStart(request);
}
