# Project rules

## Git
- Commit as the user (the configured `git config user.name` / `user.email`). Never change the author or committer.
- Never add Claude attribution: no `Co-Authored-By: Claude` trailer, no "Generated with Claude Code" line, in commits or PR descriptions.
- Only commit or push when the user asks.

## Project
- Node >= 22.13, ESM, no native deps (uses built-in `node:sqlite`).
- Run `npm test` before committing.
- Never edit a user's MCP client config except via `node src/cli.js init`, which backs up first.
