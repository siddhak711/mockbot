import { clip } from "../../tools/http";
import type { AdapterCall, AdapterResult, AdapterTool, ProviderAdapter } from "./types";

const NOTION_VERSION = "2026-03-11";

const searchSchema = {
  type: "object",
  properties: {
    query: { type: "string", description: "Text to search for. Empty lists recent results." },
    object: {
      type: "string",
      enum: ["page", "database"],
      description: "Limit results to pages or databases.",
    },
    page_size: { type: "integer", description: "How many results to return, from 1 to 20." },
  },
  additionalProperties: false,
};

const pageSchema = {
  type: "object",
  properties: {
    page_id: { type: "string", description: "Notion page id." },
  },
  required: ["page_id"],
  additionalProperties: false,
};

const blocksSchema = {
  type: "object",
  properties: {
    block_id: { type: "string", description: "Block or page id whose children to read." },
    page_size: { type: "integer", description: "How many blocks to return, from 1 to 20." },
  },
  required: ["block_id"],
  additionalProperties: false,
};

const databasesSchema = {
  type: "object",
  properties: {
    query: { type: "string", description: "Optional text to match against databases." },
    page_size: { type: "integer", description: "How many databases to return, from 1 to 20." },
  },
  additionalProperties: false,
};

const createPageSchema = {
  type: "object",
  properties: {
    parent_id: { type: "string", description: "Id of the parent page or database." },
    parent_type: {
      type: "string",
      enum: ["page", "database"],
      description: "Whether parent_id is a page or a database.",
    },
    title: { type: "string", description: "Title of the new page." },
    title_property: {
      type: "string",
      description:
        "Database title property name. Defaults to title for a page and Name for a database.",
    },
  },
  required: ["parent_id", "title"],
  additionalProperties: false,
};

function tool(
  name: string,
  description: string,
  inputSchema: unknown,
  hints: { readOnlyHint?: boolean; destructiveHint?: boolean } = {},
): AdapterTool {
  return { name, description, inputSchema, ...hints };
}

export const notionAdapter: ProviderAdapter = {
  id: "notion",
  listTools() {
    return [
      tool("search", "Search pages and databases shared with this connection.", searchSchema, {
        readOnlyHint: true,
      }),
      tool("get_page", "Read a page's properties.", pageSchema, { readOnlyHint: true }),
      tool("get_block_children", "Read the blocks inside a page or block.", blocksSchema, {
        readOnlyHint: true,
      }),
      tool("list_databases", "List databases shared with this connection.", databasesSchema, {
        readOnlyHint: true,
      }),
      tool("create_page", "Create a page under a shared page or database.", createPageSchema),
    ];
  },
  async callTool(call) {
    try {
      return await dispatch(call);
    } catch (error) {
      const message = error instanceof Error ? error.message : "The Notion request failed.";
      return { content: clip(redact(message, call.token)), isError: true };
    }
  },
};

async function dispatch(call: AdapterCall): Promise<AdapterResult> {
  switch (call.name) {
    case "search":
      return notion(call, "POST", "search", {
        ...(stringArg(call.args.query) ? { query: stringArg(call.args.query) } : {}),
        ...(call.args.object === "page" || call.args.object === "database"
          ? { filter: { property: "object", value: call.args.object } }
          : {}),
        page_size: pageSize(call.args.page_size),
      });
    case "list_databases":
      return notion(call, "POST", "search", {
        filter: { property: "object", value: "database" },
        ...(stringArg(call.args.query) ? { query: stringArg(call.args.query) } : {}),
        page_size: pageSize(call.args.page_size),
      });
    case "get_page": {
      const pageId = requiredId(call.args.page_id, "page_id");
      return notion(call, "GET", `pages/${encodeURIComponent(pageId)}`);
    }
    case "get_block_children": {
      const blockId = requiredId(call.args.block_id, "block_id");
      const size = pageSize(call.args.page_size);
      return notion(
        call,
        "GET",
        `blocks/${encodeURIComponent(blockId)}/children?page_size=${size}`,
      );
    }
    case "create_page": {
      const parentId = requiredId(call.args.parent_id, "parent_id");
      const title = stringArg(call.args.title);
      if (!title) return { content: "title is required.", isError: true };
      const parentType = call.args.parent_type === "database" ? "database" : "page";
      const property =
        stringArg(call.args.title_property) || (parentType === "database" ? "Name" : "title");
      return notion(call, "POST", "pages", {
        parent: parentType === "database" ? { database_id: parentId } : { page_id: parentId },
        properties: {
          [property]: { title: [{ type: "text", text: { content: title.slice(0, 2000) } }] },
        },
      });
    }
    default:
      return { content: `Unknown Notion tool ${call.name}.`, isError: true };
  }
}

async function notion(
  call: AdapterCall,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<AdapterResult> {
  const response = await fetch(joinUrl(call.baseUrl, path), {
    method,
    headers: {
      Authorization: `Bearer ${call.token}`,
      "Notion-Version": NOTION_VERSION,
      Accept: "application/json",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: call.signal,
  });
  const text = await response.text();
  const content = clip(redact(text.trim() || "Notion returned no content.", call.token));
  if (response.status === 401) return { content, isError: true, authExpired: true };
  if (!response.ok)
    return { content: `Notion returned HTTP ${response.status}. ${content}`, isError: true };
  return { content, isError: false };
}

function joinUrl(base: string, path: string): string {
  const root = base.endsWith("/") ? base : `${base}/`;
  return new URL(path.replace(/^\//, ""), root).toString();
}

function stringArg(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function requiredId(value: unknown, name: string): string {
  const id = stringArg(value);
  if (!id || id.length > 100 || !/^[A-Za-z0-9-]+$/.test(id)) {
    throw new Error(`${name} must be a Notion id.`);
  }
  return id;
}

function pageSize(value: unknown): number {
  const parsed = typeof value === "number" ? value : 10;
  if (!Number.isFinite(parsed)) return 10;
  return Math.max(1, Math.min(20, Math.floor(parsed)));
}

function redact(text: string, token: string): string {
  if (!token) return text;
  return text.split(token).join("[redacted]");
}
