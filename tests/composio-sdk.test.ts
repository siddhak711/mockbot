import { beforeEach, expect, it, vi } from "vitest";

type RawTool = { slug: string; name: string; description: string; tags?: string[] };

const sdk = vi.hoisted(() => ({
  options: [] as unknown[],
  queries: [] as unknown[],
  tools: [] as RawTool[],
}));

vi.mock("@composio/core", () => ({
  Composio: class {
    tools = {
      getRawComposioTools: async (query: unknown) => {
        sdk.queries.push(query);
        return sdk.tools;
      },
    };
    constructor(options: unknown) {
      sdk.options.push(options);
    }
  },
}));

const { COMPOSIO_TOOLKIT_TOOLS, createSdkComposioBroker } =
  await import("../src/connectors/composio/sdk");

function raw(slug: string, tags: string[] = []): RawTool {
  return { slug, name: slug, description: `${slug} description`, tags };
}

beforeEach(() => {
  sdk.options.length = 0;
  sdk.queries.length = 0;
  sdk.tools = [];
});

it("loads GitHub's pinned tools by slug at the pinned toolkit version", async () => {
  sdk.tools = [
    raw("GITHUB_CREATE_REPOSITORY", ["createHint"]),
    raw("GITHUB_GET_REPOSITORY_CONTENT", ["readOnlyHint"]),
    raw("GITHUB_DELETE_A_REPOSITORY", ["destructiveHint"]),
  ];
  const broker = createSdkComposioBroker({}, "test-key");
  const tools = await broker.listTools("github");

  expect(sdk.options[0]).toMatchObject({ toolkitVersions: { github: "20261023_00" } });
  expect(sdk.queries).toEqual([{ tools: [...(COMPOSIO_TOOLKIT_TOOLS.github ?? [])] }]);
  expect(tools.map((tool) => tool.slug)).toEqual([
    "GITHUB_CREATE_REPOSITORY",
    "GITHUB_GET_REPOSITORY_CONTENT",
  ]);
  expect(tools[1]).toMatchObject({ readOnlyHint: true, destructiveHint: false });
});

it("prefers Composio's important tools for a toolkit without a pinned list", async () => {
  sdk.tools = [
    raw("NOTION_APPEND_TEXT_BLOCKS"),
    raw("NOTION_SEARCH_NOTION_PAGE", ["important", "readOnlyHint"]),
    raw("NOTION_DELETE_BLOCK", ["important", "destructiveHint"]),
  ];
  const broker = createSdkComposioBroker({}, "test-key");
  const tools = await broker.listTools("notion");

  expect(sdk.queries).toEqual([{ toolkits: ["notion"], limit: 1000 }]);
  expect(tools.map((tool) => tool.slug)).toEqual([
    "NOTION_SEARCH_NOTION_PAGE",
    "NOTION_DELETE_BLOCK",
  ]);
  expect(tools[1]).toMatchObject({ destructiveHint: true });
});

it("fails loudly when Composio returns no tools for the pinned version", async () => {
  const broker = createSdkComposioBroker(
    { COMPOSIO_TOOLKIT_VERSIONS: '{"github":"20250909_00"}' },
    "test-key",
  );
  await expect(broker.listTools("github")).rejects.toThrow(
    "Composio returned no github tools for version 20250909_00.",
  );
});
