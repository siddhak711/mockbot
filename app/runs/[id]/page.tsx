import type { Metadata } from "next";
import { RunTimeline } from "../../../components/run-timeline";
import { requirePageUser } from "../../../src/auth/guard";
import { getAppContext } from "../../../src/context";
import { listRunEvents } from "../../../src/runs/events";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Run replay · Mockbot",
  description: "Ordered model calls, tool calls, and errors for one agent run",
};

export default async function RunReplayPage({ params }: { params: Promise<{ id: string }> }) {
  await requirePageUser();
  const { id } = await params;
  const { store } = await getAppContext();
  const events = await listRunEvents(store.connection, id);
  return (
    <div className="app">
      <main className="main">
        <header className="top">
          <h1>Run replay</h1>
          <a className="ghost-text" href="/">
            Chat
          </a>
        </header>
        <div className="routines-body">
          <RunTimeline runId={id} events={events} />
        </div>
      </main>
    </div>
  );
}
