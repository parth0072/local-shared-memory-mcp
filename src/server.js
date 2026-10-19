import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { openStore, toMarkdown } from "./store.js";

const INSTRUCTIONS = `Shared long-term memory that persists across AI models and apps.
At the START of every conversation call get_context (pass the project name if known) and use what it returns.
Call remember whenever the user states a preference, decision, fact about themselves/their project, or a task outcome worth keeping.
Before the user switches to another AI or ends a long session, call save_handoff with a summary: goal, decisions made, current state, next steps.
Use recall to look up anything that may have been stored earlier.`;

const text = (t) => ({ content: [{ type: "text", text: typeof t === "string" ? t : JSON.stringify(t, null, 2) }] });

export function createServer(store = openStore()) {
  const server = new McpServer({ name: "ctx-memory", version: "0.1.0" }, { instructions: INSTRUCTIONS });

  server.tool(
    "get_context",
    "Call this first in every new conversation. Returns the latest handoff summary plus the most important memories for the project.",
    { project: z.string().optional().describe("Project name; omit for global context") },
    async ({ project }) => text(toMarkdown(store, project))
  );

  server.tool(
    "remember",
    "Save a durable fact, preference, decision or task note to shared memory.",
    {
      text: z.string().min(1).describe("One self-contained statement"),
      kind: z.enum(["fact", "preference", "decision", "task", "note"]).default("fact"),
      project: z.string().default("global"),
      tags: z.array(z.string()).default([]),
      importance: z.number().int().min(1).max(5).default(3),
      source: z.string().default("").describe("Which AI/app is saving this, e.g. claude, chatgpt"),
    },
    async (a) => text(store.remember({ ...a, tags: a.tags.map((t) => t.replace(/\s+/g, "_")) }))
  );

  server.tool(
    "recall",
    "Search memory by keywords. Returns best matches, including global memories.",
    {
      query: z.string().min(1),
      project: z.string().optional(),
      kind: z.enum(["fact", "preference", "decision", "task", "note"]).optional(),
      limit: z.number().int().min(1).max(50).default(8),
    },
    async (a) => text(store.recall(a))
  );

  server.tool("forget", "Delete a memory by id.", { id: z.number().int() }, async ({ id }) =>
    text({ deleted: store.forget(id) })
  );

  server.tool(
    "save_handoff",
    "Save a where-we-left-off summary so another AI model can continue. Include goal, decisions, current state, next steps.",
    {
      summary: z.string().min(1),
      project: z.string().default("global"),
      from_model: z.string().default(""),
    },
    async (a) => text({ id: store.saveHandoff(a) })
  );

  server.tool("list_projects", "List projects with memory counts.", {}, async () => text(store.projects()));

  server.tool("export_markdown", "Export memory as Markdown to paste into an AI without MCP support.",
    { project: z.string().optional() }, async ({ project }) => text(toMarkdown(store, project)));

  server.resource("context", "memory://context", { mimeType: "text/markdown" }, async (uri) => ({
    contents: [{ uri: uri.href, mimeType: "text/markdown", text: toMarkdown(store) }],
  }));

  return server;
}

export async function serve() {
  await createServer().connect(new StdioServerTransport());
}
