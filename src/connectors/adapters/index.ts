import { notionAdapter } from "./notion";
import type { ProviderAdapter } from "./types";

const ADAPTERS: Record<string, ProviderAdapter> = {
  [notionAdapter.id]: notionAdapter,
};

export function getAdapter(id: string): ProviderAdapter | undefined {
  return ADAPTERS[id];
}

export function adapterForCatalog(adapterId: string | undefined): ProviderAdapter | null {
  if (!adapterId) return null;
  return getAdapter(adapterId) ?? null;
}
