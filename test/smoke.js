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

const call = async (name, args) => (await client.callTool({ name, arguments: args })).content[0].text;
const idOf = (s) => Number(s.match(/#(\d+)/)[1]);

const tools = (await client.listTools()).tools.map((t) => t.name);
assert.ok(["get_context", "remember", "recall", "save_handoff"].every((t) => tools.includes(t)));

const first = await call("remember", { text: "User prefers TypeScript over JavaScript", kind: "preference", project: "demo", source: "claude" });
assert.match(first, /^saved #\d+$/);
await call("remember", { text: "Database is PostgreSQL 16", project: "demo" });
assert.match(await call("remember", { text: "Database is PostgreSQL 16", project: "demo" }), /already stored/);

// multi-word natural query, stemming ("prefers" ~ "preferred"), prefix ("typesc")
const hit = await call("recall", { query: "which language does the user like? typesc", project: "demo" });
assert.match(hit, /TypeScript/);
assert.match(await call("recall", { query: "preferred", project: "demo" }), /TypeScript/);

await call("save_handoff", { summary: "Building auth. Next: add login route.", project: "demo", from_model: "claude" });
const ctx = await call("get_context", { project: "demo" });
assert.match(ctx, /Building auth/);
assert.match(ctx, /PostgreSQL/);
assert.doesNotMatch(ctx, /\{|\[fact\]/); // compact plain text, no JSON

// near-duplicates collapse
await call("remember", { text: "Database is PostgreSQL 16 in production", project: "demo" });
const dedup = await call("get_context", { project: "demo" });
assert.equal((dedup.match(/PostgreSQL/g) || []).length, 1);

// token budget holds and points to recall for the rest
for (let i = 0; i < 150; i++) {
  await call("remember", { text: `Unique note number ${i} about topic${i} with extra filler words to take space`, project: "big" });
}
const small = await call("get_context", { project: "big", max_tokens: 200 });
assert.ok(small.length <= 200 * 4 + 80, `context too large: ${small.length} chars`);
assert.match(small, /\+\d+ more; use recall/);

const id = idOf(hit);
assert.equal(await call("forget", { id }), `deleted #${id}`);
assert.equal(await call("recall", { query: "typescript", project: "demo" }), "no matches");

await client.close();
console.log("smoke test passed:", tools.join(", "));
