import { expect, it } from "vitest";
import { ToolCallAssembler } from "../src/llm";
import { toolSearchTool, ToolRegistry } from "../src/tools/registry";
import { MAX_EXPOSED_TOOLS, type ToolDefinition } from "../src/tools/types";

function stub(
  name: string,
  exposure: ToolDefinition["exposure"],
  description = name,
): ToolDefinition {
  return {
    name,
    description,
    exposure,
    approval: "never",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    async invoke() {
      return { content: name };
    },
  };
}

it("caps the tools exposed to the model and lets tool_search promote the rest", async () => {
  const registry = new ToolRegistry();
  registry.register(toolSearchTool(registry));
  for (let index = 0; index < 14; index += 1) {
    registry.register(stub(`tool_${String(index).padStart(2, "0")}`, "default", `Helper ${index}`));
  }
  registry.register(stub("archive_lookup", "hidden", "Search the secret archive"));

  const first = registry.exposed({ limit: 100 });
  expect(first).toHaveLength(MAX_EXPOSED_TOOLS);
  expect(first.map((tool) => tool.name)).toContain("tool_search");
  expect(first.map((tool) => tool.name)).not.toContain("archive_lookup");

  const found = registry.search("secret archive");
  expect(found.map((tool) => tool.name)).toEqual(["archive_lookup"]);

  const promoted = new Set<string>();
  const result = await registry
    .get("tool_search")!
    .invoke(
      { query: "secret archive" },
      { promote: (names) => names.forEach((name) => promoted.add(name)) },
    );
  expect(result.content).toContain("archive_lookup");
  expect(result.isError).toBeFalsy();

  const second = registry.exposed({ promoted });
  expect(second).toHaveLength(MAX_EXPOSED_TOOLS);
  expect(second.map((tool) => tool.name)).toContain("archive_lookup");
  expect(second.map((tool) => tool.name)).toContain("tool_search");
  expect(second.map((tool) => tool.name)).not.toContain("tool_13");
});

it("moves every promoted tool ahead of the cap, including defaults", () => {
  const registry = new ToolRegistry();
  registry.register(toolSearchTool(registry));
  for (let index = 0; index < 20; index += 1) {
    registry.register(stub(`tool_${String(index).padStart(2, "0")}`, "default", `Helper ${index}`));
  }

  const before = registry.exposed().map((tool) => tool.name);
  expect(before).toContain("tool_search");
  expect(before).not.toContain("tool_14");

  const after = registry.exposed({ promoted: ["tool_14"] }).map((tool) => tool.name);
  expect(after).toHaveLength(MAX_EXPOSED_TOOLS);
  expect(after[0]).toBe("tool_14");
  expect(after).toContain("tool_search");
  expect(after).not.toContain("tool_13");
});

it("keeps tool_search when promotions fill the cap", () => {
  const registry = new ToolRegistry();
  registry.register(toolSearchTool(registry));
  for (let index = 0; index < 20; index += 1) {
    registry.register(stub(`tool_${String(index).padStart(2, "0")}`, "default", `Helper ${index}`));
  }

  const promoted = Array.from({ length: MAX_EXPOSED_TOOLS }, (_, index) => {
    return `tool_${String(index).padStart(2, "0")}`;
  });
  const names = registry.exposed({ promoted }).map((tool) => tool.name);
  expect(names).toHaveLength(MAX_EXPOSED_TOOLS);
  expect(names).toContain("tool_search");
  expect(names[0]).toBe("tool_00");
  expect(names.at(-1)).toBe("tool_search");
  expect(names).not.toContain("tool_14");
});

it("assembles streamed tool-call arguments without repeating earlier chunks", () => {
  const assembler = new ToolCallAssembler();
  expect(
    assembler.push({
      index: 0,
      id: "call_1",
      function: { name: "web_search", arguments: "" },
    }),
  ).toEqual([{ type: "tool_call", id: "call_1", name: "web_search", argumentsDelta: "" }]);
  expect(assembler.push({ index: 0, function: { arguments: '{"query":' } })).toEqual([
    { type: "tool_call", id: "call_1", argumentsDelta: '{"query":' },
  ]);
  expect(assembler.push({ index: 0, function: { arguments: '"weather"}' } })).toEqual([
    { type: "tool_call", id: "call_1", argumentsDelta: '"weather"}' },
  ]);
});
