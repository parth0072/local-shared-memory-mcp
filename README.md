# local-shared-memory-mcp

**One local memory that every AI tool shares.** Start a task in Claude, continue it in Cursor or another MCP-capable model, and nothing has to be re-explained.

## The problem

Every AI app keeps its own isolated memory, or none at all. When you switch from Claude to another model you lose the context: your preferences, the decisions you made, and where you left off. You end up re-typing background or pasting long summaries by hand.

## The idea

Keep memory in **one place you own**, and let every AI reach it through [MCP](https://modelcontextprotocol.io) (Model Context Protocol).

```
Claude Desktop ─┐
Cursor         ─┼──► ctx-memory MCP server ──► ~/.memory/ctx-memory.db (SQLite, local)
Windsurf / any ─┘
MCP client
```

- **Local-first.** Everything lives in a single SQLite file on your machine. No cloud, no account, no API keys.
- **Model-agnostic.** Any client that speaks MCP reads and writes the same memory.
- **Near zero configuration.** `init` registers the server in your installed clients. After that, the models are told (via the server's `instructions`) to load context at the start of a chat and to save a handoff before you switch.
- **No native build.** Uses Node's built-in `node:sqlite` with FTS5 full-text search.

## How switching models works

1. While working, the model calls `remember` to store preferences, facts and decisions.
2. Before you switch, you say "save a handoff". The model calls `save_handoff` with the goal, decisions, current state and next steps.
3. In the new model, `get_context` runs first and returns the latest handoff plus the most important memories for the project.
4. You carry on where you stopped.

For apps without MCP support (for example ChatGPT web), run `node src/cli.js export [project]` and paste the Markdown into the chat.

## Tools

| Tool | Purpose |
| --- | --- |
| `get_context` | Latest handoff and top memories; called first in every chat |
| `remember` | Save a fact, preference, decision, task or note (dedupes, supports tags, project and importance 1-5) |
| `recall` | Keyword search ranked by relevance and importance |
| `forget` | Delete a memory by id |
| `save_handoff` | Store a "where we left off" summary for the next model |
| `list_projects` | Projects with memory counts |
| `export_markdown` | Memory as Markdown for pasting anywhere |

## Manual control (no AI needed)

You can manage the same database yourself from the terminal:

```bash
node src/cli.js add "I prefer tabs over spaces" -k preference -t style -p myproject
node src/cli.js list -p myproject
node src/cli.js search "tabs"
node src/cli.js edit 3 --text "new wording" -i 5
node src/cli.js forget 3
node src/cli.js handoff save "Goal: ship auth. Next: login route." -p myproject --from claude
node src/cli.js handoff show -p myproject
node src/cli.js export myproject            # Markdown to paste into any AI
node src/cli.js import notes.md -p myproject  # each "- line" becomes a memory
```

`add` and `handoff save` also read from stdin, so `pbpaste | node src/cli.js handoff save` stores whatever is on your clipboard.

## Setup

Requires Node >= 22.13.

```bash
npm install
node src/cli.js init   # configures Claude Desktop, Cursor, Windsurf (backs up configs as .bak)
```

For Claude Code:

```bash
claude mcp add ctx-memory -- node /ABS/PATH/src/cli.js serve
```

Restart the apps afterwards. Set `MEMORY_DB_PATH` to move the database.

## Test

```bash
npm test
```

## Limits and roadmap

- A model only saves memory if it chooses to call the tools; the server instructions push it to, but it is not guaranteed.
- ChatGPT supports only remote MCP connectors, so it needs an HTTP/SSE mode behind a tunnel (planned, not built).
- Planned: semantic (embedding) search, memory cleanup and expiry, a small web UI to review and edit memories.
