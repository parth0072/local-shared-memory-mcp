# local-shared-memory-mcp

> 🚧 **In progress.** This project is in early development. Tools, CLI commands and the storage format may change, and the web app is only a read-only viewer so far.

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
| `get_context` | Latest handoff and top memories, capped by `max_tokens` (default 700); called first in every chat |
| `remember` | Save a fact, preference, decision, task or note (dedupes, supports tags, project and importance 1-5) |
| `recall` | Keyword search ranked by relevance and importance (5 results by default) |
| `forget` | Delete a memory by id |
| `save_handoff` | Store a "where we left off" summary for the next model |
| `list_projects` | Projects with memory counts |
| `export_markdown` | Full memory as plain text for pasting anywhere (no size cap) |

## Fast search, small context

**Search** (SQLite FTS5 index):

- Every word must match first; it only widens to "any word" when there are too few hits.
- Filler words ("the", "which", "user") are ignored, and the last word matches as a prefix, so `typesc` finds `typescript`.
- Porter stemming makes `prefers` match `preferred`. Tag matches count double.
- Prepared statements are cached, `recall` does at most one small batched write, and the SQLite cache and memory-mapped reads are tuned.
- Existing databases are migrated and the index rebuilt automatically on first start.

**Context** (what the model actually receives):

- `get_context` fills a token budget with the highest-ranked memories (importance, decayed by time since last use) and stops there. The handoff gets at most 40% of the budget.
- Near-duplicate memories (over 80% shared words) are collapsed.
- Replies are compact plain text, not JSON, with relative ages and long lines cut at 280 characters:

```
Handoff (2d ago, claude): Goal: ship auth. Next: login route.
#2 API runs on port 9090
#1 pref: I prefer tabs over spaces #style #code
(+12 more; use recall)
```

- Tool descriptions and server instructions are kept short, since they are sent every turn.

## Usage tracking

The server records how many tokens it sends back to your AIs, so you can see what your memory costs.

- One small row per tool call: time, tool, which AI app called it, project and the **estimated** reply size (characters ÷ 4). Memory text is never stored. Rows older than 90 days are deleted.
- See it in the web viewer's **Usage** tab (tokens per day, by tool, by AI app, and full memory size vs the `get_context` cap), or in a terminal: `node src/cli.js usage --days 30`.
- Turn it off with `MEMORY_USAGE=off`.
- This measures only what this memory server sent. For your AI tools' total spend, run a tool that reads their logs, such as [AI Token Monitor](https://github.com/soulduse/ai-token-monitor).

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

## Switching between AI tools

Every tool talks to the same server and the same database (`~/.memory/ctx-memory.db`), so you only configure each tool once. Claude Desktop, Cursor and Windsurf are covered by `init`. For the command-line tools below, add the server by hand.

> These configs are written from each tool's documented format and have not all been tested. If one does not load, check that tool's MCP docs.

Replace `/path/to/local-shared-memory-mcp` with where you cloned this repo.

**Gemini CLI**: `~/.gemini/settings.json`

```json
{
  "mcpServers": {
    "ctx-memory": {
      "command": "node",
      "args": ["/path/to/local-shared-memory-mcp/src/cli.js", "serve"]
    }
  }
}
```

**Codex CLI**: `~/.codex/config.toml`

```toml
[mcp_servers.ctx-memory]
command = "node"
args = ["/path/to/local-shared-memory-mcp/src/cli.js", "serve"]
```

**opencode**: `~/.config/opencode/opencode.json` (or `opencode.json` in a project)

```json
{
  "mcp": {
    "ctx-memory": {
      "type": "local",
      "command": ["node", "/path/to/local-shared-memory-mcp/src/cli.js", "serve"],
      "enabled": true
    }
  }
}
```

Restart the tool after editing its config.

### How to switch

1. In the tool you are leaving, ask: *"Save a handoff for project `myapp` with the goal, decisions so far, current state and next steps."* It calls `save_handoff`.
2. Open the next tool in the same project.
3. Start with: *"Call get_context for project `myapp` and continue from there."* You get the latest handoff plus the top memories, capped at about 700 tokens.
4. To check what was saved from a terminal: `node src/cli.js handoff show -p myapp`.

### Tips

- Use the same project name in every tool. Memory is grouped by project, so `myapp` and `my-app` will not connect.
- Ask for `get_context` yourself in the first message. Not every tool follows the server's built-in instruction to call it.
- Save small facts as you go ("remember that we use Postgres 16"), so you do not depend only on the final handoff.
- If a tool cannot connect, run `node src/cli.js export myapp` and paste the output into its first message.

## Test

```bash
npm test
```

## Limits

- Search matches words, not meaning: "which language does the user like" will not find "prefers TypeScript" unless a word overlaps.
- A model only saves memory if it chooses to call the tools; the server instructions push it to, but it is not guaranteed.
- ChatGPT supports only remote MCP connectors, so it needs an HTTP/SSE mode behind a tunnel (planned, not built).

## Roadmap

### Web app to see and review memory

A small local web app so you can see what your AIs have stored and decide what stays. Phase 1 is built; Phases 2 and 3 are planned.

- Runs only on `127.0.0.1`, started with `node src/cli.js ui`. Reads the same SQLite file as the server, so there is no cloud and no account.

**Phase 1: read-only viewer (built)**

```bash
node src/cli.js ui              # http://127.0.0.1:4777
node src/cli.js ui --port 5000
```

- Project list with memory counts.
- Browse memories by project, kind and tag, with search (viewing never changes a memory's "last used" time).
- View the handoff history.
- Preview exactly what `get_context` would send to a model, with its token size and an adjustable cap, so you can see the cost of your memory.
- GET requests only, and requests with a non-local `Host` header are refused.

**Phase 2: review and edit**
- Edit a memory's text, tags, importance and project; delete memories.
- "New since your last visit" inbox for memories AI tools saved, with approve or reject.
- Find and merge near-duplicates.
- Pin memories so they always appear in `get_context`.

**Phase 3: polish**
- Timeline of handoffs, showing which model wrote each.
- Cleanup suggestions for old or never-used memories, with expiry.
- Import and export from the UI.
- Optional access token for the local server.

### Other planned work

- Semantic (embedding) search.
- HTTP/SSE mode so ChatGPT and other remote clients can connect.
- Automatic memory cleanup and expiry.

## License

[MIT](LICENSE)
