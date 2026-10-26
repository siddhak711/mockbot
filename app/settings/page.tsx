import { Workspace } from "../../components/workspace";
import { requirePageUser } from "../../src/auth/guard";

export default async function SettingsPage() {
  const user = await requirePageUser();
  return <Workspace user={user} connectorLaunch={{ intent: "list" }} />;
}
