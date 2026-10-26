import { Workspace } from "../../../components/workspace";
import { requirePageUser } from "../../../src/auth/guard";

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

const LIST_PREVIEWS = new Set([
  "empty",
  "error",
  "reconnect",
  "details",
  "manage",
  "disconnect",
  "connected",
]);

export default async function AddConnectorPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string | string[]; preview?: string | string[] }>;
}) {
  const user = await requirePageUser();
  const params = await searchParams;
  const preview = first(params.preview);
  const query = first(params.q) ?? "";
  return (
    <Workspace
      user={user}
      connectorLaunch={{
        intent: preview && LIST_PREVIEWS.has(preview) ? "list" : "add",
        query,
        preview,
      }}
    />
  );
}
