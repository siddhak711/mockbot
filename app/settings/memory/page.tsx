import { MemorySettingsScreen } from "../../../components/memory/memory-settings";
import { requirePageUser } from "../../../src/auth/guard";

export default async function MemorySettingsPage() {
  await requirePageUser();
  return <MemorySettingsScreen />;
}
