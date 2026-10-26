import { Workspace } from "../../components/workspace";

export default function SettingsPage() {
  return <Workspace connectorLaunch={{ intent: "list" }} />;
}
