import { AgentInputError } from "../../../../src/agents/directory";
import { requireApiUser } from "../../../../src/auth/guard";
import { getAgents, getAppContext } from "../../../../src/context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asStrings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

async function directoryFor(request: Request) {
  const actor = await requireApiUser(request);
  if (!actor.ok) return { ok: false as const, response: actor.response };
  const app = await getAppContext();
  const directory = actor.scoped
    ? (await getAgents(app)).forUser(actor.user.id)
    : await getAgents(app);
  return { ok: true as const, directory };
}

function agentError(error: unknown): Response {
  if (error instanceof AgentInputError) {
    return Response.json({ error: error.message }, { status: error.status });
  }
  throw error;
}

/** Saves an agent's name, instructions, memory note, and grants from Settings. */
export async function PATCH(request: Request, context: RouteContext): Promise<Response> {
  const scoped = await directoryFor(request);
  if (!scoped.ok) return scoped.response;
  const { id } = await context.params;
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
    name?: unknown;
    instructions?: unknown;
    memoryNote?: unknown;
    computerIds?: unknown;
    connectorIds?: unknown;
  };
  try {
    const saved = await scoped.directory.update(id, {
      name: asString(record.name),
      instructions: asString(record.instructions),
      memoryNote: asString(record.memoryNote),
      computerIds: asStrings(record.computerIds),
      connectorIds: asStrings(record.connectorIds),
    });
    return Response.json(saved);
  } catch (error) {
    return agentError(error);
  }
}

/** Deletes an agent with its thread and memories. The lead can't be deleted. */
export async function DELETE(request: Request, context: RouteContext): Promise<Response> {
  const scoped = await directoryFor(request);
  if (!scoped.ok) return scoped.response;
  const { id } = await context.params;
  try {
    await scoped.directory.remove(id);
    return new Response(null, { status: 204 });
  } catch (error) {
    return agentError(error);
  }
}
