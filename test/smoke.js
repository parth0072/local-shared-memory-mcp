import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const db = join(mkdtempSync(join(tmpdir(), "ctxmem-")), "t.db");
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["src/cli.js", "serve"],
  env: { ...process.env, MEMORY_DB_PATH: db },
});
const client = new Client({ name: "test", version: "0" });
await client.connect(transport);

const call = async (name, args) => {
  const r = await client.callTool({ name, arguments: args });
  return r.content[0].text;
};

const tools = (await client.listTools()).tools.map((t) => t.name);
assert.ok(["get_context", "remember", "recall", "save_handoff"].every((t) => tools.includes(t)));

await call("remember", { text: "User prefers TypeScript over JavaScript", kind: "preference", project: "demo", source: "claude" });
await call("remember", { text: "Database is PostgreSQL 16", kind: "fact", project: "demo" });
const dup = JSON.parse(await call("remember", { text: "Database is PostgreSQL 16", project: "demo" }));
assert.equal(dup.duplicate, true);

const hits = JSON.parse(await call("recall", { query: "which language does the user like?  typescript", project: "demo" }));
assert.equal(hits[0].text, "User prefers TypeScript over JavaScript");

await call("save_handoff", { summary: "Building auth. Next: add login route.", project: "demo", from_model: "claude" });
const ctx = await call("get_context", { project: "demo" });
assert.match(ctx, /Building auth/);
assert.match(ctx, /PostgreSQL/);

const del = JSON.parse(await call("forget", { id: hits[0].id }));
assert.equal(del.deleted, true);
assert.equal(JSON.parse(await call("recall", { query: "typescript" })).length, 0);

await client.close();
console.log("smoke test passed:", tools.join(", "));
