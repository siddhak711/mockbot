import { requireApiUser } from "../../../../src/auth/guard";
import { searchCatalog } from "../../../../src/connectors/catalog";
import { detectInput, INVALID_TARGET_MESSAGE } from "../../../../src/connectors/policy";
import { probeConnector } from "../../../../src/connectors/probe";
import { isAbortError } from "../../../../src/tools/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const actor = await requireApiUser(request);
  if (!actor.ok) return actor.response;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Expected JSON body" }, { status: 400 });
  }
  if (!body || typeof body !== "object") {
    return Response.json({ error: "Expected JSON body" }, { status: 400 });
  }
  const record = body as { input?: unknown; apiKey?: unknown };
  const input = typeof record.input === "string" ? record.input : "";
  const apiKey = typeof record.apiKey === "string" ? record.apiKey : "";
  if (apiKey.length > 2_000)
    return Response.json({ error: "API key is too long." }, { status: 400 });
  const detected = detectInput(input);
  if (detected.kind === "search") {
    return Response.json({
      kind: "search",
      query: detected.query,
      matches: searchCatalog(detected.query),
    });
  }
  if (!detected.valid || !detected.target || (detected.kind === "config" && !detected.transport)) {
    return Response.json(
      { kind: detected.kind, code: "invalid", error: detected.error ?? INVALID_TARGET_MESSAGE },
      { status: 400 },
    );
  }
  const transport =
    detected.kind === "command"
      ? "stdio"
      : detected.kind === "config"
        ? detected.transport!
        : "http";
  const target = detected.target;
  try {
    const probe = await probeConnector({
      transport,
      target,
      name: detected.kind === "config" ? detected.name : undefined,
      apiKey: apiKey || undefined,
      signal: request.signal,
    });
    if (!probe.ok && probe.code === "auth" && apiKey) {
      return Response.json({ code: "auth", error: probe.message, auth: "apikey" }, { status: 400 });
    }
    if (!probe.ok && probe.code === "auth" && probe.auth) {
      return Response.json({
        kind: detected.kind,
        transport,
        transportLabel: probe.transportLabel,
        auth: probe.auth,
        target,
        name: detected.kind === "config" ? detected.name : undefined,
        tools: [],
        elapsedMs: probe.elapsedMs,
      });
    }
    if (!probe.ok) {
      return Response.json(
        { code: probe.code, error: probe.message, transportLabel: probe.transportLabel },
        { status: 400 },
      );
    }
    const visible = probe.tools.filter((tool) => tool.name);
    return Response.json({
      kind: detected.kind,
      transport,
      transportLabel: probe.transportLabel,
      auth: probe.auth,
      target,
      name: detected.kind === "config" ? detected.name : undefined,
      elapsedMs: probe.elapsedMs,
      tools: visible,
    });
  } catch (error) {
    if (request.signal.aborted || isAbortError(error)) {
      return Response.json({ error: "The connection was cancelled." }, { status: 400 });
    }
    return Response.json(
      { code: "unreachable", error: "Could not reach the MCP server." },
      { status: 400 },
    );
  }
}
