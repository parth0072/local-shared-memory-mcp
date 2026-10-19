# ctx-memory-mcp

One local SQLite memory (`~/.memory/ctx-memory.db`, override with `MEMORY_DB_PATH`) shared by every MCP client, so you can switch between Claude, Cursor, etc. without losing context.

## Setup
    npm install
    node src/cli.js init      # writes the MCP entry into Claude Desktop / Cursor / Windsurf (backs up configs as .bak)
    claude mcp add ctx-memory -- node /ABS/PATH/src/cli.js serve   # Claude Code

Restart the apps. Requires Node >= 22.13 (uses built-in `node:sqlite`, no native build).

## Tools
get_context, remember, recall, forget, save_handoff, list_projects, export_markdown.
The server's `instructions` tell models to call `get_context` first and `save_handoff` before you switch.

## No-MCP fallback (e.g. ChatGPT web)
    node src/cli.js export [project]   # paste the Markdown into the chat

## Test
    npm test
