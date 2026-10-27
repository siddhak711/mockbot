import type { Metadata } from "next";
import { SettingsWorkspace } from "../../components/settings-workspace";
import { requirePageUser } from "../../src/auth/guard";
import { isSettingsSection } from "../../src/settings";

export const metadata: Metadata = {
  title: "Settings · Mockbot",
  description: "Agents, account, appearance, and the model this workspace runs on",
};

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requirePageUser();
  const raw = (await searchParams).section;
  const section = Array.isArray(raw) ? raw[0] : raw;
  return (
    <SettingsWorkspace
      user={user}
      initialSection={isSettingsSection(section) ? section : "agents"}
    />
  );
}
