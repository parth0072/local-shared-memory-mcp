import http from "node:http";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { openStore, toMarkdown, tokens } from "./store.js";

const PAGE = join(dirname(fileURLToPath(import.meta.url)), "ui.html");
const HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

const json = (res, code, body) => {
  res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
};

/** Read-only viewer: binds to 127.0.0.1, answers GET only. */
export function startUi({ port = 4777, store = openStore() } = {}) {
  const server = http.createServer((req, res) => {
    // Refuse non-local Host headers (blocks DNS-rebinding from web pages) and anything but GET.
    const host = (req.headers.host || "").replace(/:\d+$/, "");
    if (!HOSTS.has(host)) return json(res, 403, { error: "forbidden host" });
    if (req.method !== "GET") return json(res, 405, { error: "read-only" });

    const url = new URL(req.url, "http://127.0.0.1");
    const q = url.searchParams;
    const project = q.get("project") || undefined;

    try {
      switch (url.pathname) {
        case "/":
          res.writeHead(200, {
            "content-type": "text/html; charset=utf-8",
            "content-security-policy":
              "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'",
            "x-content-type-options": "nosniff",
            "cache-control": "no-store",
          });
          return res.end(readFileSync(PAGE));
        case "/api/projects":
          return json(res, 200, store.projects().map((p) => ({ project: p.project, n: Number(p.n) })));
        case "/api/memories": {
          const kind = q.get("kind") || undefined;
          const tag = q.get("tag") || undefined;
          const query = (q.get("q") || "").trim();
          let rows = query
            ? store.recall({ query, project, kind, limit: 100, touch: false })
            : store.list({ project, kind, tag });
          if (query && tag) rows = rows.filter((m) => m.tags.includes(tag));
          return json(res, 200, rows);
        }
        case "/api/handoffs":
          return json(res, 200, store.handoffs({ project }));
        case "/api/usage": {
          const days = Math.min(Math.max(Number(q.get("days")) || 7, 1), 90);
          return json(res, 200, {
            ...store.usageSummary({ days, project }),
            enabled: store.usageEnabled,
            full: tokens(toMarkdown(store, project)), // whole memory if pasted in full
            cap: 700, // default get_context budget
          });
        }
        case "/api/context": {
          const budget = Math.min(Math.max(Number(q.get("max_tokens")) || 700, 100), 4000);
          const text = toMarkdown(store, project, { budget });
          return json(res, 200, { text, tokens: tokens(text), budget });
        }
        default:
          return json(res, 404, { error: "not found" });
      }
    } catch (e) {
      return json(res, 500, { error: String(e.message || e) });
    }
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}
