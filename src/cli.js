#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "./server.js";
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

if (cmd === "serve") await serve();
else if (cmd === "init") init();
else if (cmd === "export") {
  const store = openStore();
  console.log(toMarkdown(store, process.argv[3]));
  store.close();
} else {
  console.log("usage: ctx-memory [serve|init|export [project]]");
  process.exit(1);
}
