import type { Sql } from "./db/sql";

/** One model-router decision. `kind` is stable so a run replay log can filter on it. */
export type ModelRouteEvent = {
  id: string;
  kind: "model.route";
  tier: "cheap" | "strong";
  reason: "chat" | "tool" | "plan" | "code" | "retry";
  model: string;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  conversationId?: string;
};

type ColumnInfo = {
  column_name: string;
  is_nullable: "YES" | "NO";
  column_default: string | null;
  udt_name: string;
};

const RECENT_LIMIT = 200;
const recent: ModelRouteEvent[] = [];

type SchemaCache = { status: "missing" } | { status: "ready"; columns: ColumnInfo[] };

/** One probe per process. A missing table stays missing until the process restarts. */
let schemaCache: SchemaCache | null = null;
let schemaProbe: Promise<SchemaCache> | null = null;

/** Tests reset this after they create or drop `run_events` in the same process. */
export function clearRunEventSchemaCache(): void {
  schemaCache = null;
  schemaProbe = null;
}

/**
 * Decisions the helper has seen in this process. Persistence is separate:
 * when `run_events` is missing, `logModelRoute` still records the attempt
 * here and returns `"noop"`.
 */
export function recentRouteLogs(): readonly ModelRouteEvent[] {
  return recent;
}

export function clearRouteLogs(): void {
  recent.length = 0;
}

const WRITABLE = new Set([
  "id",
  "kind",
  "event_type",
  "type",
  "tier",
  "model",
  "model_id",
  "cost",
  "cost_usd",
  "payload",
  "data",
  "body",
  "detail",
  "conversation_id",
  "reason",
  "input_tokens",
  "output_tokens",
]);

/**
 * Write the chosen tier and its cost to `run_events` when that table exists
 * and has a compatible shape. Returns `"noop"` when the table or logger is
 * absent, or when the row cannot be inserted without guessing a schema.
 * Never throws.
 */
export async function logModelRoute(
  event: ModelRouteEvent,
  db?: Sql | null,
): Promise<"logged" | "noop"> {
  recent.push(event);
  if (recent.length > RECENT_LIMIT) recent.shift();
  if (!db) return "noop";
  try {
    return (await insertRunEvent(db, event)) ? "logged" : "noop";
  } catch {
    return "noop";
  }
}

async function insertRunEvent(db: Sql, event: ModelRouteEvent): Promise<boolean> {
  const schema = await loadSchema(db);
  if (schema.status === "missing") return false;
  const columns = schema.columns;
  if (columns.length === 0) return false;

  const payload = {
    id: event.id,
    kind: event.kind,
    tier: event.tier,
    reason: event.reason,
    model: event.model,
    costUsd: event.costUsd,
    inputTokens: event.inputTokens,
    outputTokens: event.outputTokens,
    conversationId: event.conversationId ?? null,
  };
  const assigned = new Map<string, unknown>();
  for (const column of columns) {
    if (!WRITABLE.has(column.column_name)) continue;
    const value = columnValue(column.column_name, event, payload);
    if (value !== undefined) assigned.set(column.column_name, value);
  }

  const keepsTierAndCost = [...assigned.keys()].some((name) =>
    ["tier", "cost", "cost_usd", "payload", "data", "body", "detail"].includes(name),
  );
  if (!keepsTierAndCost) return false;

  for (const column of columns) {
    if (
      column.is_nullable === "NO" &&
      column.column_default == null &&
      !assigned.has(column.column_name)
    ) {
      return false;
    }
  }

  const names = [...assigned.keys()];
  const values = names.map((name) => assigned.get(name));
  const placeholders = names.map((name, index) => {
    const column = columns.find((item) => item.column_name === name);
    if (column?.udt_name === "jsonb" || column?.udt_name === "json") {
      return `$${index + 1}::${column.udt_name}`;
    }
    return `$${index + 1}`;
  });
  await db.query(
    `INSERT INTO run_events (${names.join(", ")}) VALUES (${placeholders.join(", ")})`,
    values,
  );
  return true;
}

async function loadSchema(db: Sql): Promise<SchemaCache> {
  if (schemaCache) return schemaCache;
  if (!schemaProbe) {
    schemaProbe = probeSchema(db)
      .then((result) => {
        schemaCache = result;
        schemaProbe = null;
        return result;
      })
      .catch((error: unknown) => {
        schemaProbe = null;
        throw error;
      });
  }
  return schemaProbe;
}

async function probeSchema(db: Sql): Promise<SchemaCache> {
  const present = await db.query<{ rel: string | null }>(
    `SELECT to_regclass('public.run_events') AS rel`,
  );
  if (!present.rows[0]?.rel) return { status: "missing" };
  const described = await db.query<ColumnInfo>(
    `SELECT column_name, is_nullable, column_default, udt_name
     FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'run_events'`,
  );
  return { status: "ready", columns: described.rows };
}

function columnValue(
  name: string,
  event: ModelRouteEvent,
  payload: Record<string, unknown>,
): unknown {
  switch (name) {
    case "id":
      return event.id;
    case "kind":
    case "event_type":
    case "type":
      return event.kind;
    case "tier":
      return event.tier;
    case "model":
    case "model_id":
      return event.model;
    case "cost":
    case "cost_usd":
      return event.costUsd;
    case "reason":
      return event.reason;
    case "input_tokens":
      return event.inputTokens;
    case "output_tokens":
      return event.outputTokens;
    case "conversation_id":
      return event.conversationId ?? null;
    case "payload":
    case "data":
    case "body":
    case "detail":
      return JSON.stringify(payload);
    default:
      return undefined;
  }
}
