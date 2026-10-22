#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { serve } from "./server.js";
import { startUi } from "./ui.js";
import { hooksConfig, installHooks, sessionEnd, sessionStart, summarizeWorker } from "./hooks.js";
import { openStore, toMarkdown } from "./store.js";

const self = resolve(fileURLToPath(import.meta.url));
const cmd = process.argv[2] || "serve";

const clients = {
  "Claude Desktop": platform() === "darwin"
    ? join(homedir(), "Library/Application Support/Claude/claude_desktop_config.json")
    : platform() === "win32"
      ? join(process.env.APPDATA || "", "Claude/claude_desktop_config.json")
      : join(homedir(), ".config/Claude/claude_desktop_config.json"),
  Cursor: join(homedir(), ".cursor/mcp.json"),
  Windsurf: join(homedir(), ".codeium/windsurf/mcp_config.json"),
};

function init() {
  const entry = { command: process.execPath, args: [self, "serve"] };
  for (const [name, file] of Object.entries(clients)) {
    // Only touch clients that appear installed (config dir exists).
    if (!existsSync(dirname(file))) { console.log(`- ${name}: not found, skipped`); continue; }
    let cfg = {};
    if (existsSync(file)) {
      try { cfg = JSON.parse(readFileSync(file, "utf8") || "{}"); }
      catch { console.log(`- ${name}: config is not valid JSON, skipped (${file})`); continue; }
      copyFileSync(file, file + ".bak");
    }
    cfg.mcpServers = { ...cfg.mcpServers, "ctx-memory": entry };
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(cfg, null, 2));
    console.log(`- ${name}: configured (${file})`);
  }
  console.log(`\nClaude Code: claude mcp add ctx-memory -- ${process.execPath} ${self} serve`);
  console.log("Restart the apps above to load the memory server.");
}

const opts = {
  project: { type: "string", short: "p" },
  kind: { type: "string", short: "k" },
  tags: { type: "string", short: "t" },
  importance: { type: "string", short: "i" },
  text: { type: "string" },
  from: { type: "string" },
  limit: { type: "string", short: "n" },
  port: { type: "string" },
  days: { type: "string" },
  summarize: { type: "boolean" },
  write: { type: "boolean" },
};
const { values: o, positionals } = parseArgs({ args: process.argv.slice(3), options: opts, allowPositionals: true });
const tagList = (v) => (v ? v.split(",").map((t) => t.trim().replace(/\s+/g, "_")).filter(Boolean) : undefined);
const readStdin = () => (process.stdin.isTTY ? "" : readFileSync(0, "utf8"));
const need = (v, msg) => { if (!v) { console.error(msg); process.exit(1); } return v; };
const show = (m) => console.log(`#${m.id} [${m.kind}] ${m.text}${m.tags.length ? "  #" + m.tags.join(" #") : ""}  (${m.project}, imp ${m.importance})`);

const help = `usage: ctx-memory <command>
  serve                          run the MCP server (default)
  init                           register in Claude Desktop / Cursor / Windsurf
  ui [--port 4777]               read-only web viewer on http://127.0.0.1:4777
  usage [--days 7] [-p proj]     tokens this server sent to your AIs (estimates)
  hooks install [--summarize] [--write]   Claude Code hooks: auto-load at start, auto-save at end
                                 (prints the settings.json block; --write merges it into ~/.claude/settings.json)
  pending | approve <id|all> | reject <id>   review auto-saved memories
  add <text> [-p proj] [-k kind] [-t a,b] [-i 1-5]
  list [-p proj] [-n 20]         most important / recently used memories
  search <query> [-p proj]
  edit <id> [--text ..] [-p ..] [-k ..] [-t ..] [-i ..]
  forget <id>
  handoff save <summary> [-p proj] [--from model]   (or pipe text on stdin)
  handoff show [-p proj]
  projects
  export [project]               Markdown to paste into any AI
  import [file] [-p proj]        add each "- line" of a Markdown/text file (or stdin)`;

if (cmd === "serve") await serve();
else if (cmd === "init") init();
else if (cmd === "ui") {
  const port = Number(o.port) || 4777;
  try {
    await startUi({ port });
    console.log(`Memory viewer (read-only): http://127.0.0.1:${port}  (Ctrl+C to stop)`);
  } catch (e) {
    console.error(e.code === "EADDRINUSE" ? `port ${port} is in use; try --port <other>` : e.message);
    process.exit(1);
  }
} else if (cmd === "help" || cmd === "--help") console.log(help);
else if (cmd === "hooks") {
  if (positionals[0] !== "install") { console.error("usage: hooks install [--summarize] [--write]"); process.exit(1); }
  const cfg = hooksConfig({ self, summarize: o.summarize });
  if (o.write) console.log(`Hooks written to ${installHooks({ self, summarize: o.summarize })} (previous file saved as .bak). Restart Claude Code.`);
  else console.log(JSON.stringify(cfg, null, 2) + "\n\nMerge this into ~/.claude/settings.json, or re-run with --write to do it for you (backs up first).");
}
else {
  const store = openStore();
  try {
    if (cmd === "add") {
      const text = need(positionals.join(" ") || readStdin().trim(), "add: text required");
      const r = store.remember({ text, kind: o.kind, project: o.project, tags: tagList(o.tags), importance: o.importance && Number(o.importance), source: "manual" });
      console.log(r.duplicate ? `already stored (#${r.id})` : `saved #${r.id}`);
    } else if (cmd === "list") {
      store.recent({ project: o.project, limit: Number(o.limit) || 20 }).forEach(show);
    } else if (cmd === "search") {
      store.recall({ query: need(positionals.join(" "), "search: query required"), project: o.project, limit: Number(o.limit) || 10 }).forEach(show);
    } else if (cmd === "edit") {
      const id = Number(need(positionals[0], "edit: id required"));
      const ok = store.update(id, { text: o.text, kind: o.kind, project: o.project, tags: tagList(o.tags), importance: o.importance && Number(o.importance) });
      console.log(ok ? `updated #${id}` : `no memory #${id}`);
    } else if (cmd === "forget") {
      const id = Number(need(positionals[0], "forget: id required"));
      console.log(store.forget(id) ? `deleted #${id}` : `no memory #${id}`);
    } else if (cmd === "handoff") {
      const [sub, ...rest] = positionals;
      if (sub === "save") {
        const summary = need(rest.join(" ") || readStdin().trim(), "handoff save: summary required");
        console.log(`saved handoff #${store.saveHandoff({ project: o.project, summary, from_model: o.from })}`);
      } else if (sub === "show") {
        const h = store.latestHandoff(o.project);
        console.log(h ? `${h.created_at}${h.from_model ? " from " + h.from_model : ""}\n\n${h.summary}` : "no handoff saved");
      } else { console.error("handoff save|show"); process.exit(1); }
    } else if (cmd === "usage") {
      if (!store.usageEnabled) console.log("usage tracking is off (MEMORY_USAGE=off)");
      const u = store.usageSummary({ days: Math.min(Math.max(Number(o.days) || 7, 1), 90), project: o.project });
      console.log(`last ${u.days} days: ${u.calls} calls, ~${u.tokens} tokens sent${u.calls ? ` (avg ${Math.round(u.tokens / u.calls)})` : ""}`);
      for (const [title, rows] of [["by tool", u.byTool], ["by AI app", u.byClient]]) {
        if (rows.length) console.log(`${title}:\n` + rows.map((r) => `  ${r.name.padEnd(16)} ${String(r.calls).padStart(5)} calls  ~${r.tokens} tokens`).join("\n"));
      }
    } else if (cmd === "pending") {
      const rows = store.pending();
      if (rows.length) rows.forEach(show); else console.log("no pending memories");
    } else if (cmd === "approve") {
      const a = need(positionals[0], "approve: id or 'all' required");
      console.log(`approved ${store.approve(a === "all" ? "all" : Number(a))}`);
    } else if (cmd === "reject") {
      const id = Number(need(positionals[0], "reject: id required"));
      console.log(store.reject(id) ? `rejected #${id}` : `no pending memory #${id}`);
    } else if (cmd === "hook") {
      const sub = positionals[0];
      if (sub === "session-start") sessionStart(store);
      else if (sub === "session-end") sessionEnd(store, { summarize: o.summarize, self });
      else if (sub === "summarize-worker") summarizeWorker(store, { transcript: positionals[1], project: positionals[2] });
      else { console.error("hook session-start | session-end"); process.exitCode = 1; }
    } else if (cmd === "projects") {
      store.projects().forEach((p) => console.log(`${p.project}\t${p.n}`));
    } else if (cmd === "export") {
      console.log(toMarkdown(store, positionals[0]));
    } else if (cmd === "import") {
      const raw = positionals[0] ? readFileSync(positionals[0], "utf8") : readStdin();
      const lines = raw.split("\n").map((l) => l.replace(/^\s*[-*]\s+(\[[^\]]*\]\s*)?/, "").trim()).filter((l) => l && !l.startsWith("#"));
      let n = 0;
      for (const text of lines) if (!store.remember({ text, project: o.project, source: "import" }).duplicate) n++;
      console.log(`imported ${n} of ${lines.length} lines`);
    } else { console.log(help); process.exitCode = 1; }
  } finally { store.close(); }
}
