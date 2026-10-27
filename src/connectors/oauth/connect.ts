import { beginComposioConnect, completeComposioConnect } from "../composio/flow";
import { catalogUsesComposio } from "../composio/config";
import { catalogById, catalogIsWired, catalogTarget, type CatalogEntry } from "../catalog";
import { discoverTool, resolveToolSettings } from "../policy";
import type { ConnectorRecord } from "../../connectors";
import { requireApiUser } from "../../auth/guard";
import { getAppContext } from "../../context";
import { listMcpTools, type McpToolInfo } from "../../mcp/client";
import { secretsFor } from "../../mcp/secrets";
import { encryptSecret } from "../../mcp/vault";
import { adapterForCatalog } from "../adapters";
import {
  buildAuthorizeUrl,
  createOAuthState,
  createPkcePair,
  exchangeAuthorizationCode,
  oauthRedirectUri,
  publicOrigin,
  readAccountLabel,
} from "./flow";
import {
  clearOAuthCookie,
  OAUTH_COOKIE,
  oauthSetCookie,
  openPending,
  readCookie,
  sealPending,
  type PendingOAuth,
} from "./pending";
import { serializeOAuthToken, type StoredOAuthToken } from "./token";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function handleOAuthStart(request: Request): Promise<Response> {
  const actor = await requireApiUser(request);
  if (!actor.ok) return actor.response;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Expected JSON body" }, 400);
  }
  const record =
    body && typeof body === "object"
      ? (body as { catalogId?: unknown; connectorId?: unknown })
      : {};
  const catalogId = typeof record.catalogId === "string" ? record.catalogId.trim() : "";
  const entry = catalogId ? catalogById(catalogId) : undefined;
  if (!entry) return json({ error: "Unknown connector." }, 400);
  if (!catalogIsWired(entry)) return json({ error: `${entry.name} is not available yet.` }, 400);
  if (catalogUsesComposio(entry, process.env)) {
    return startComposio(request, entry, actor.user.id, record.connectorId);
  }
  const connectorId = typeof record.connectorId === "string" ? record.connectorId.trim() : "";
  if (connectorId && !UUID.test(connectorId)) {
    return json({ error: "Unknown connector." }, 400);
  }
  const origin = publicOrigin(request, process.env);
  const redirectUri = oauthRedirectUri(origin, entry);
  const state = createOAuthState();
  const pkce = entry.oauth?.pkce ? createPkcePair() : undefined;
  let authorizeUrl: string;
  try {
    authorizeUrl = buildAuthorizeUrl(entry, {
      env: process.env,
      redirectUri,
      state,
      challenge: pkce?.challenge,
    });
  } catch (error) {
    return json({ error: messageOf(error) }, statusFor(error));
  }
  let sealed: string;
  try {
    sealed = await sealPending({
      state,
      ...(pkce ? { verifier: pkce.verifier } : {}),
      catalogId: entry.id,
      ...(connectorId ? { connectorId } : {}),
      redirectUri,
      issuedAt: Date.now(),
    });
  } catch (error) {
    return json({ error: messageOf(error) }, statusFor(error));
  }
  const response = json({ authorizeUrl }, 200);
  response.headers.set("set-cookie", oauthSetCookie(sealed, origin.startsWith("https:")));
  return response;
}

export async function handleOAuthCallback(request: Request): Promise<Response> {
  const actor = await requireApiUser(request);
  if (!actor.ok) return actor.response;
  const url = new URL(request.url);
  const origin = publicOrigin(request, process.env);
  const secure = origin.startsWith("https:");
  const fail = (title: string, message: string, status = 400) =>
    htmlResponse({ ok: false, title, message, origin }, status, secure);

  const pending = await openPending(readCookie(request.headers.get("cookie"), OAUTH_COOKIE));
  if (!pending) {
    return fail("Sign-in expired", "Start the connection again. The sign-in session expired.");
  }
  const owner = actor.scoped ? actor.user.id : null;
  if (pending.broker === "composio") {
    return finishComposio(request, pending, actor.user.id, owner, origin, secure, fail);
  }
  const entry = catalogById(pending.catalogId);
  if (!entry || !catalogIsWired(entry)) {
    return fail("Connector unavailable", "That connector is not available.");
  }
  const returnedState = url.searchParams.get("state") ?? "";
  if (!returnedState || returnedState !== pending.state) {
    return fail("Sign-in rejected", "The sign-in state did not match. Start the connection again.");
  }
  const providerError = url.searchParams.get("error");
  if (providerError) {
    const detail =
      providerError === "access_denied"
        ? `${entry.name} returned "access_denied". You may have closed the window or declined access.`
        : `${entry.name} returned "${providerError.slice(0, 80)}".`;
    return fail(`Could not connect ${entry.name}`, detail);
  }
  const code = url.searchParams.get("code")?.trim() ?? "";
  if (!code) return fail(`Could not connect ${entry.name}`, `${entry.name} did not return a code.`);
  if (entry.oauth?.pkce && !pending.verifier) {
    return fail(
      `Could not connect ${entry.name}`,
      `${entry.name} requires PKCE. Start the connection again.`,
    );
  }

  try {
    const tokenSet = await exchangeAuthorizationCode({
      entry,
      env: process.env,
      code,
      redirectUri: pending.redirectUri,
      verifier: pending.verifier,
    });
    const account = await readAccountLabel({ entry, token: tokenSet });
    const stored: StoredOAuthToken = {
      v: 1,
      kind: "oauth",
      accessToken: tokenSet.accessToken,
      ...(tokenSet.refreshToken ? { refreshToken: tokenSet.refreshToken } : {}),
      ...(tokenSet.expiresAt ? { expiresAt: tokenSet.expiresAt } : {}),
      ...(tokenSet.scope ? { scope: tokenSet.scope } : {}),
      ...(tokenSet.tokenType ? { tokenType: tokenSet.tokenType } : {}),
    };
    const connector = await saveCatalogConnector({
      entry,
      token: stored,
      accountLabel: account,
      connectorId: pending.connectorId,
      ownerId: owner,
      signal: request.signal,
    });
    return htmlResponse(
      {
        ok: true,
        title: `${entry.name} connected`,
        message: `${account} is connected. You can close this window.`,
        account,
        connectorId: connector.id,
        origin,
      },
      200,
      secure,
    );
  } catch (error) {
    return fail(`Could not connect ${entry.name}`, messageOf(error), statusFor(error));
  }
}

async function startComposio(
  request: Request,
  entry: CatalogEntry,
  userId: string,
  connectorId: unknown,
): Promise<Response> {
  const origin = publicOrigin(request, process.env);
  try {
    const started = await beginComposioConnect({
      entry,
      userId,
      origin,
      connectorId: typeof connectorId === "string" ? connectorId.trim() : undefined,
      env: process.env,
    });
    const sealed = await sealPending(started.pending);
    const response = json({ authorizeUrl: started.authorizeUrl }, 200);
    response.headers.set("set-cookie", oauthSetCookie(sealed, origin.startsWith("https:")));
    return response;
  } catch (error) {
    return json({ error: messageOf(error) }, statusFor(error));
  }
}

async function finishComposio(
  request: Request,
  pending: PendingOAuth,
  userId: string,
  ownerId: string | null,
  origin: string,
  secure: boolean,
  fail: (title: string, message: string, status?: number) => Response,
): Promise<Response> {
  const url = new URL(request.url);
  const entry = catalogById(pending.catalogId);
  const name = entry?.name ?? "Connector";
  try {
    const finished = await completeComposioConnect({
      pending,
      userId,
      ownerId,
      returnedState: url.searchParams.get("state") ?? "",
      status: url.searchParams.get("status") ?? "",
      connectedAccountId: url.searchParams.get("connected_account_id") ?? "",
      signal: request.signal,
    });
    return htmlResponse(
      {
        ok: true,
        title: `${name} connected`,
        message: `${finished.account} is connected. You can close this window.`,
        account: finished.account,
        connectorId: finished.connector.id,
        origin,
      },
      200,
      secure,
    );
  } catch (error) {
    return fail(`Could not connect ${name}`, messageOf(error), statusFor(error));
  }
}

async function saveCatalogConnector(options: {
  entry: CatalogEntry;
  token: StoredOAuthToken;
  accountLabel: string;
  connectorId?: string;
  /** Signed-in owner. Null on the unscoped path. */
  ownerId: string | null;
  signal?: AbortSignal;
}): Promise<ConnectorRecord> {
  const target = catalogTarget(options.entry);
  if (!target) throw new Error(`${options.entry.name} is not available yet.`);
  const secretCipher = await encryptSecret(serializeOAuthToken(options.token));
  const { store } = await getAppContext();
  const existing = await store.listConnectors(options.ownerId);
  const current = options.connectorId
    ? existing.find((item) => item.id === options.connectorId)
    : existing.find((item) => item.catalogId === options.entry.id);
  if (options.connectorId && !current) throw new Error("That connector no longer exists.");
  if (current && current.catalogId && current.catalogId !== options.entry.id) {
    throw new Error("That connector belongs to a different app.");
  }
  const draft: ConnectorRecord = {
    id: current?.id ?? crypto.randomUUID(),
    name: options.entry.name,
    transport: "http",
    target,
    secretRef: null,
    secretCipher,
    enabled: true,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    catalogId: options.entry.id,
    authType: "oauth",
    accountLabel: options.accountLabel,
  };
  const listed = await listCatalogTools(options.entry, draft, options.signal);
  const discovered = listed.tools.length
    ? resolveToolSettings(
        listed.tools.map((tool) =>
          discoverTool(tool.name, tool.description, tool.inputSchema, {
            readOnlyHint: tool.readOnlyHint,
            destructiveHint: tool.destructiveHint,
          }),
        ),
        current?.tools,
        "defaults",
      )
    : {};
  const settings = current ? { ...(current.tools ?? {}), ...discovered } : discovered;
  const status = listed.error ? "error" : "connected";
  const statusDetail = listed.error;
  if (current) {
    const saved = await store.saveOAuthConnector(
      current.id,
      {
        secretCipher,
        accountLabel: options.accountLabel,
        target,
        tools: settings,
        status,
        statusDetail,
      },
      options.ownerId,
    );
    if (!saved) throw new Error("That connector no longer exists.");
    return saved;
  }
  return store.insertCatalogConnector({
    name: options.entry.name,
    transport: "http",
    target,
    secretRef: null,
    secretCipher,
    catalogId: options.entry.id,
    authType: "oauth",
    accountLabel: options.accountLabel,
    status,
    statusDetail,
    tools: settings,
    seenTools: [],
    userId: options.ownerId,
  });
}

async function listCatalogTools(
  entry: CatalogEntry,
  connector: ConnectorRecord,
  signal?: AbortSignal,
): Promise<{ tools: McpToolInfo[]; error: string | null }> {
  const adapter = adapterForCatalog(entry.oauth?.adapterId);
  if (entry.oauth?.adapterId) {
    if (!adapter) return { tools: [], error: `No adapter is registered for ${entry.name}.` };
    return { tools: adapter.listTools(), error: null };
  }
  try {
    const secrets = await secretsFor([connector], process.env);
    const tools = await listMcpTools(connector, process.env, secrets, signal);
    return { tools: tools.slice(0, 32), error: null };
  } catch (error) {
    return { tools: [], error: messageOf(error) };
  }
}

function json(body: unknown, status: number): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

function htmlResponse(
  result: {
    ok: boolean;
    title: string;
    message: string;
    account?: string;
    connectorId?: string;
    origin: string;
  },
  status: number,
  secure: boolean,
): Response {
  const payload = {
    type: "mockbot-oauth",
    ok: result.ok,
    account: result.account ?? "",
    connectorId: result.connectorId ?? "",
    message: result.message,
  };
  const html = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>${escapeHtml(result.title)}</title></head>
<body>
<main>
  <h1>${escapeHtml(result.title)}</h1>
  <p>${escapeHtml(result.message)}</p>
</main>
<script>
  const payload = ${scriptJson(payload)};
  const origin = ${scriptJson(result.origin)};
  if (window.opener) window.opener.postMessage(payload, origin);
  window.close();
</script>
</body>
</html>`;
  return new Response(html, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "set-cookie": clearOAuthCookie(secure),
    },
  });
}

/** JSON for an inline script. Escapes characters that can close the script tag. */
export function scriptJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/[<>&]/g, (char) => {
      if (char === "<") return "\\u003c";
      if (char === ">") return "\\u003e";
      return "\\u0026";
    })
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    if (char === "&") return "&amp;";
    if (char === "<") return "&lt;";
    if (char === ">") return "&gt;";
    if (char === '"') return "&quot;";
    return "&#39;";
  });
}

function messageOf(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message.trim().slice(0, 500);
  return "Could not finish sign-in.";
}

function statusFor(error: unknown): number {
  const message = error instanceof Error ? error.message : "";
  if (/CONNECTOR_SECRET_KEY/i.test(message)) return 500;
  return 400;
}
