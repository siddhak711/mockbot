import type { Metadata } from "next";
import { RoutinesWorkspace } from "../../components/routines-workspace";
import { requirePageUser } from "../../src/auth/guard";

export const metadata: Metadata = {
  title: "Routines · Mockbot",
  description: "Saved prompts that run on a schedule or when an event arrives",
};

export default async function RoutinesPage() {
  const user = await requirePageUser();
  return <RoutinesWorkspace user={user} />;
}
