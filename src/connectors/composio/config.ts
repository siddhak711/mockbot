import { catalogById, type CatalogEntry } from "../catalog";

/** Native per-provider OAuth stays in the tree and runs only when this is "1". */
export function nativeCatalogOAuthEnabled(env: Record<string, string | undefined>): boolean {
  return env["NATIVE_CATALOG_OAUTH"] === "1";
}

export function catalogUsesComposio(
  entry: CatalogEntry,
  env: Record<string, string | undefined>,
): boolean {
  return Boolean(entry.composio?.enabled) && !nativeCatalogOAuthEnabled(env);
}

export function composioToolkitForConnector(
  catalogId: string | null | undefined,
  env: Record<string, string | undefined>,
): string | null {
  if (!catalogId) return null;
  const entry = catalogById(catalogId);
  if (!entry || !catalogUsesComposio(entry, env)) return null;
  return entry.composio?.toolkit ?? null;
}
