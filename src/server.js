import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { openStore, toMarkdown, render, tokens } from "./store.js";

// Tool descriptions and instructions are sent to the model every turn, so keep them short.
const INSTRUCTIONS =
  "Shared memory across AI apps. Call get_context at the start of each conversation. " +
  "Call remember for durable preferences, decisions and facts. " +
  "Before the user switches AI or ends a long session, call save_handoff (goal, decisions, state, next steps). " +
  "Use recall to look things up.";

const text = (t) => ({ content: [{ type: "text", text: t }] });
const KINDS = ["fact", "preference", "decision", "task", "note"];

export function createServer(store = openStore()) {
  const server = new McpServer({ name: "ctx-memory", version: "0.2.0" }, { instructions: INSTRUCTIONS });

  // Wrap a tool handler so every call logs its (estimated) reply size. Never lets tracking break a call.
  const track = (name, fn) => async (args, extra) => {
    const res = await fn(args, extra);
    try {
      store.recordUsage({
        tool: name,
        client: server.server.getClientVersion()?.name ?? "",
        project: args?.project ?? "",
        tokens: tokens(res.content.map((c) => c.text ?? "").join("")),
      });
    } catch { /* tracking is best effort */ }
    return res;
  };
  const tool = (name, description, schema, fn) => server.tool(name, description, schema, track(name, fn));

  tool(
    "get_context",
    "Latest handoff + top memories. Call first in every chat.",
    {
      project: z.string().optional(),
      max_tokens: z.number().int().min(100).max(4000).default(700).describe("size cap for the reply"),
    },
    async ({ project, max_tokens }) => text(toMarkdown(store, project, { budget: max_tokens }))
  );

  tool(
    "remember",
    "Save a durable fact, preference, decision or task.",
    {
      text: z.string().min(1).describe("one self-contained statement"),
      kind: z.enum(KINDS).default("fact"),
      project: z.string().default("global"),
      tags: z.array(z.string()).default([]),
      importance: z.number().int().min(1).max(5).default(3),
      source: z.string().default("").describe("which AI/app is saving"),
    },
    async (a) => {
      const r = store.remember({ ...a, tags: a.tags.map((t) => t.replace(/\s+/g, "_")) });
      return text(r.duplicate ? `already stored #${r.id}` : `saved #${r.id}`);
    }
  );

  tool(
    "recall",
    "Search memory by keywords.",
    {
      query: z.string().min(1),
      project: z.string().optional(),
      kind: z.enum(KINDS).optional(),
      limit: z.number().int().min(1).max(30).default(5),
    },
    async (a) => {
      const { text: t } = render(store.recall(a), { showProject: !a.project });
      return text(t || "no matches");
    }
  );

  tool("forget", "Delete a memory by id.", { id: z.number().int() }, async ({ id }) =>
    text(store.forget(id) ? `deleted #${id}` : `no memory #${id}`)
  );

  tool(
    "save_handoff",
    "Save a where-we-left-off summary for the next AI.",
    {
      summary: z.string().min(1).describe("goal, decisions, current state, next steps"),
      project: z.string().default("global"),
      from_model: z.string().default(""),
    },
    async (a) => text(`saved handoff #${store.saveHandoff(a)}`)
  );

  tool("list_projects", "Projects with memory counts.", {}, async () =>
    text(store.projects().map((p) => `${p.project}: ${p.n}`).join("\n") || "none")
  );

  tool("export_markdown", "Full memory as text, to paste into an AI without MCP.",
    { project: z.string().optional() }, async ({ project }) => text(toMarkdown(store, project)));

  server.resource("context", "memory://context", { mimeType: "text/plain" }, async (uri) => ({
    contents: [{ uri: uri.href, mimeType: "text/plain", text: toMarkdown(store, undefined, { budget: 700 }) }],
  }));

  return server;
}

export async function serve() {
  await createServer().connect(new StdioServerTransport());
}
