import type { ReactNode } from "react";
import { requirePageUser } from "../../src/auth/guard";

export default async function ConnectorsLayout({ children }: { children: ReactNode }) {
  await requirePageUser();
  return children;
}
