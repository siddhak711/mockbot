import { Workspace } from "../../components/workspace";
import { requirePageUser } from "../../src/auth/guard";

/** Opens the workspace with the Connectors panel showing. /settings used to do this. */
export default async function ConnectorsPage() {
  const user = await requirePageUser();
  return <Workspace user={user} connectorLaunch={{ intent: "list" }} />;
}
