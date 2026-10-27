import { requireApiUser, type ApiUser } from "../../../src/auth/guard";
import { getAgents, getAppContext, type AppContext } from "../../../src/context";
import { computerIdFor } from "../../../src/sandbox/limits";
import type { ComputerToolName } from "../../../src/sandbox/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TOOLS = new Set<ComputerToolName>(["list", "read", "write", "exec"]);

/**
 * The computer of an agent the caller owns. No agent id means the caller's lead.
 * Another account's agent is reported as unknown.
 */
async function ownedComputer(
  context: AppContext,
  actor: Extract<ApiUser, { ok: true }>,
  requested: string | undefined,
): Promise<string | null> {
  const directory = await getAgents(context);
  const agents = actor.scoped ? directory.forUser(actor.user.id) : directory;
  const agent = requested?.trim() ? await agents.get(requested.trim()) : await agents.lead();
  return agent ? computerIdFor(agent.id) : null;
}

export async function GET(request: Request): Promise<Response> {
  const actor = await requireApiUser(request);
  if (!actor.ok) return actor.response;
  const context = await getAppContext();
  const { sandbox } = context;
  if (!sandbox) return Response.json({ error: "Sandbox is not available" }, { status: 503 });
  const requested = new URL(request.url).searchParams.get("agentId") ?? undefined;
  const computerId = await ownedComputer(context, actor, requested);
  if (!computerId) return Response.json({ error: "Unknown agent" }, { status: 404 });
  return Response.json(await sandbox.snapshot(computerId));
}

export async function POST(request: Request): Promise<Response> {
  const actor = await requireApiUser(request);
  if (!actor.ok) return actor.response;
  const context = await getAppContext();
  const { sandbox } = context;
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
  const computerId = await ownedComputer(
    context,
    actor,
    typeof record.agentId === "string" ? record.agentId : undefined,
  );
  if (!computerId) return Response.json({ error: "Unknown agent" }, { status: 404 });
  const args: Record<string, unknown> = {};
  if (typeof record.path === "string") args.path = record.path;
  if (typeof record.content === "string") args.content = record.content;
  if (typeof record.command === "string") args.command = record.command;
  try {
    const invocation = await sandbox.invoke(
      computerId,
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
