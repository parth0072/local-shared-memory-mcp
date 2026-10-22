# local-shared-memory-mcp

> 🚧 **In progress.** Early development: tools, CLI commands and the storage format may change.

**One local memory that every AI tool shares.** Start in Claude, continue in Cursor, Codex, Gemini CLI or opencode, and nothing has to be re-explained. Everything lives in one SQLite file (`~/.memory/ctx-memory.db`) behind an [MCP](https://modelcontextprotocol.io) server. No cloud, no account, no native build (Node >= 22.13, built-in `node:sqlite` + FTS5).

```
Claude Desktop ─┐
Cursor         ─┼──► ctx-memory MCP server ──► ~/.memory/ctx-memory.db
Codex / any MCP ┘
```

## Quick start

```bash
npm install
node src/cli.js init     # Claude Desktop, Cursor, Windsurf (backs up configs as .bak)
claude mcp add ctx-memory -- node /path/to/local-shared-memory-mcp/src/cli.js serve   # Claude Code
```

Restart the apps. Set `MEMORY_DB_PATH` to move the database.

## Switching models

1. In the tool you are leaving: *"Save a handoff for project `myapp`: goal, decisions, state, next steps."*
2. In the next tool: *"Call get_context for project `myapp` and continue."*

Use the same project name everywhere, ask for `get_context` yourself (most tools don't call it automatically; Claude Code with the hooks installed does, see Auto-save), and `remember` small facts as you go. For tools without MCP (e.g. ChatGPT web): `node src/cli.js export myapp` and paste the output.

## Tools

| Tool | Purpose |
| --- | --- |
| `get_context` | Latest handoff + top memories, capped by `max_tokens` (default 700) |
| `remember` | Save a fact, preference, decision, task or note (tags, project, importance 1-5, dedupes) |
| `recall` | Keyword search, ranked by relevance and importance (5 results by default) |
| `forget` | Delete a memory by id |
| `save_handoff` | Store a "where we left off" summary |
| `list_projects` | Projects with memory counts |
| `export_markdown` | Full memory as text, no cap |

**Fast and small:** FTS5 search (AND first, prefix and stemming, filler words ignored); context is ranked by importance and recency, near-duplicates collapsed, and replies are compact text cut at the token cap:

```
Handoff (2d ago, claude): Goal: ship auth. Next: login route.
#2 API runs on port 9090
#1 pref: I prefer tabs over spaces #style #code
(+12 more; use recall)
```

## Auto-save

- **All tools:** the server tells models to `remember` proactively, and `get_context` reminds them to `save_handoff` before the chat ends. Models can still ignore this.
- **Claude Code (hooks):** loads memory automatically at session start and saves a handoff at session end, with no model involved. Hooks work only in Claude Code; other tools get the nudges above.

```bash
node src/cli.js hooks install              # prints the settings.json block
node src/cli.js hooks install --write      # merges it into ~/.claude/settings.json (backs up first)
node src/cli.js hooks install --summarize  # at session end, also ask `claude -p` for a real handoff + candidate memories (uses some of your Claude usage)
```

The project name is the folder Claude Code runs in (override with `MEMORY_PROJECT`). Without `--summarize` the end-of-session handoff is a free, crude extract of your last requests and the last reply.

Safeguards: likely secrets (API keys, tokens, `password=`) are redacted before anything auto-saved is stored. Memories captured by `--summarize` start **pending** and stay out of `get_context` and `recall` until you run `node src/cli.js approve <id|all>` (see them with `pending`, drop one with `reject <id>`). `MEMORY_AUTOSAVE=off` disables saving.

## Other AI tools

Configs below follow each tool's documented format and are not all tested. Replace `/path/to/local-shared-memory-mcp` with your clone. Restart the tool afterwards.

**Gemini CLI**, `~/.gemini/settings.json`:
```json
{ "mcpServers": { "ctx-memory": { "command": "node", "args": ["/path/to/local-shared-memory-mcp/src/cli.js", "serve"] } } }
```

**Codex CLI**, `~/.codex/config.toml`:
```toml
[mcp_servers.ctx-memory]
command = "node"
args = ["/path/to/local-shared-memory-mcp/src/cli.js", "serve"]
```

**opencode**, `~/.config/opencode/opencode.json`:
```json
{ "mcp": { "ctx-memory": { "type": "local", "command": ["node", "/path/to/local-shared-memory-mcp/src/cli.js", "serve"], "enabled": true } } }
```

## CLI and web viewer

```bash
node src/cli.js add "I prefer tabs" -k preference -t style -p myapp   # also: list, search, edit, forget, projects
node src/cli.js handoff save "Goal: ship auth." -p myapp --from claude   # or: handoff show; stdin works too
node src/cli.js export myapp          # Markdown to paste anywhere
node src/cli.js import notes.md -p myapp   # each "- line" becomes a memory
node src/cli.js ui                # read-only viewer at http://127.0.0.1:4777
node src/cli.js usage --days 30   # tokens this server sent to your AIs
node src/cli.js pending           # auto-saved memories awaiting review; then: approve <id|all> | reject <id>
```

The viewer shows memories (search, project/kind/tag filters; auto-saved ones show a "pending review" badge until approved), handoffs, a `get_context` preview with token size, and a **Usage** tab. It binds to `127.0.0.1`, answers GET only and refuses non-local `Host` headers.

Usage tracking stores one row per tool call (time, tool, AI app, project, estimated tokens = chars ÷ 4), never memory text, and prunes after 90 days. Turn it off with `MEMORY_USAGE=off`.

## Limits and roadmap

- Search matches words, not meaning, and a model saves memory only if it chooses to call the tools.
- Planned: editing and deleting in the viewer, approve/reject buttons for pending memories in the viewer (the command line already has them), merge duplicates, pinning, expiry and cleanup, semantic search, and an HTTP/SSE mode for ChatGPT and other remote clients.

Run tests with `npm test`.

## License

[MIT](LICENSE)
