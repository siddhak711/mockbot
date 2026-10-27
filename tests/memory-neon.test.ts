import { describe, expect, it } from "vitest";
import { ConversationStore } from "../src/store";

const databaseUrl = process.env.DATABASE_URL?.trim();
const suite = databaseUrl ? describe : describe.skip;

suite("neon durable memory", () => {
  it("migrates and round-trips a memory on DATABASE_URL", async () => {
    const agentId = `test-${crypto.randomUUID()}`;
    const store = await ConversationStore.connect({
      DATABASE_URL: databaseUrl,
      NODE_ENV: "production",
    });
    try {
      expect(store.driver).toBe("neon");
      expect(await store.migrationIds()).toEqual([
        "001_conversations",
        "002_memory",
        "003_tool_trace",
        "004_connectors",
        "005_connector_tools",
        "006_auth",
        "007_composio_connections",
        "008_connector_catalog",
        "009_one_thread_per_agent",
        "011_run_events",
        "012_connectors_user",
        "013_tool_call_scope",
        "014_waitlist",
        "015_agent_grants_and_routines",
      ]);
      const written = await store.memories.write({
        agentId,
        key: "city",
        content: "Lisbon",
        kind: "fact",
        createdBy: "user",
      });
      const updated = await store.memories.update({
        agentId,
        key: "city",
        content: "Porto",
        createdBy: "user",
      });
      expect(updated?.previousId).toBe(written.memory.id);
      const found = await store.memories.search({ agentId, query: "Porto" });
      expect(found.map((memory) => memory.content)).toEqual(["Porto"]);
      await store.memories.softDeleteByKey(agentId, "city");
      expect(await store.memories.search({ agentId, query: "Porto" })).toEqual([]);
      expect(await store.memories.listLive("someone-else")).toEqual([]);
    } finally {
      await store.connection.query("DELETE FROM memories WHERE agent_id = $1", [agentId]);
      await store.close();
    }
  });
});
