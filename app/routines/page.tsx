import type { Metadata } from "next";
import { RoutinesWorkspace } from "../../components/routines-workspace";

export const metadata: Metadata = {
  title: "Routines · Mockbot",
  description: "Saved prompts that run on a schedule or when an event arrives",
};

export default function RoutinesPage() {
  return <RoutinesWorkspace />;
}
