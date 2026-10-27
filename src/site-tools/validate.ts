import type { SiteToolSchema } from "./types";

export function validateSiteToolArgs(
  schema: SiteToolSchema,
  args: unknown,
): { ok: true; args: Record<string, string> } | { ok: false; error: string } {
  if (args == null) args = {};
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    return { ok: false, error: "Site tool args must be an object." };
  }
  const record = args as Record<string, unknown>;
  const allowed = new Set(Object.keys(schema.properties));
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) return { ok: false, error: `Unknown site tool arg "${key}".` };
  }
  const out: Record<string, string> = {};
  for (const key of schema.required) {
    if (typeof record[key] !== "string" || record[key].length === 0) {
      return { ok: false, error: `Site tool arg "${key}" is required.` };
    }
  }
  for (const [key, property] of Object.entries(schema.properties)) {
    if (record[key] === undefined) continue;
    if (property.type !== "string" || typeof record[key] !== "string") {
      return { ok: false, error: `Site tool arg "${key}" must be a string.` };
    }
    if (record[key].length > 2_000)
      return { ok: false, error: `Site tool arg "${key}" is too long.` };
    out[key] = record[key];
  }
  return { ok: true, args: out };
}

export function isSiteToolSchema(value: unknown): value is SiteToolSchema {
  if (!value || typeof value !== "object") return false;
  const schema = value as SiteToolSchema;
  if (schema.type !== "object" || schema.additionalProperties !== false) return false;
  if (
    !schema.properties ||
    typeof schema.properties !== "object" ||
    Array.isArray(schema.properties)
  ) {
    return false;
  }
  if (!Array.isArray(schema.required)) return false;
  return true;
}
