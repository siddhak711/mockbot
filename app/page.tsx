import type { Metadata } from "next";
import { LandingPage } from "../components/landing/landing-page";
import { Workspace } from "../components/workspace";
import { prepareUser } from "../src/auth/scope";
import { readSignedInUser } from "../src/auth/guard";
import { getAppContext } from "../src/context";
import { LANDING_DESCRIPTION, LANDING_TITLE } from "../src/landing/content";

export async function generateMetadata(): Promise<Metadata> {
  const user = await readSignedInUser();
  if (user) {
    return {
      title: "Mockbot",
      description: "A multi-agent chat workspace",
    };
  }
  return {
    title: LANDING_TITLE,
    description: LANDING_DESCRIPTION,
    openGraph: {
      title: "mockbot",
      description: LANDING_DESCRIPTION,
    },
  };
}

export default async function HomePage() {
  const user = await readSignedInUser();
  if (!user) return <LandingPage />;
  const { store } = await getAppContext();
  await prepareUser(store.connection, user.id);
  return <Workspace user={user} />;
}
