import { requireApiUser } from "../../../src/auth/guard";
import { getAppContext } from "../../../src/context";
import { normalizeAgentId } from "../../../src/sandbox/limits";
import type { ComputerToolName } from "../../../src/sandbox/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TOOLS = new Set<ComputerToolName>(["list", "read", "write", "exec"]);

export async function GET(request: Request): Promise<Response> {
  const actor = await requireApiUser(request);
  if (!actor.ok) return actor.response;
  const { sandbox } = await getAppContext();
  if (!sandbox) return Response.json({ error: "Sandbox is not available" }, { status: 503 });
  const requested = new URL(request.url).searchParams.get("agentId") ?? undefined;
  const agentId = normalizeAgentId(requested);
  if (!agentId) return Response.json({ error: "Unknown agent" }, { status: 400 });
  return Response.json(await sandbox.snapshot(agentId));
}

export async function POST(request: Request): Promise<Response> {
  const actor = await requireApiUser(request);
  if (!actor.ok) return actor.response;
  const { sandbox } = await getAppContext();
  if (!sandbox) return Response.json({ error: "Sandbox is not available" }, { status: 503 });
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Expected JSON body" }, { status: 400 });
  }
  if (!body || typeof body !== "object") {
    return Response.json({ error: "Expected JSON body" }, { status: 400 });
  }
  const record = body as {
    tool?: unknown;
    agentId?: unknown;
    path?: unknown;
    content?: unknown;
    command?: unknown;
  };
  if (typeof record.tool !== "string" || !TOOLS.has(record.tool as ComputerToolName)) {
    return Response.json({ error: "Unknown computer tool" }, { status: 400 });
  }
  const agentId = normalizeAgentId(typeof record.agentId === "string" ? record.agentId : undefined);
  if (!agentId) return Response.json({ error: "Unknown agent" }, { status: 400 });
  const args: Record<string, unknown> = {};
  if (typeof record.path === "string") args.path = record.path;
  if (typeof record.content === "string") args.content = record.content;
  if (typeof record.command === "string") args.command = record.command;
  try {
    const invocation = await sandbox.invoke(
      agentId,
      record.tool as ComputerToolName,
      args,
      request.signal,
    );
    return Response.json(invocation);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Sandbox request failed";
    return Response.json({ error: message }, { status: 400 });
  }
}
