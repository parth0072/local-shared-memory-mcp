import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const DEFAULT_DB = join(homedir(), ".memory", "ctx-memory.db");

const SCHEMA_VERSION = 2;
const HOUR = 3600_000;
const STOP = new Set(
  "a an the is are was were be been am do does did to of in on at for with and or but not no it its this that these those i you he she we they me my your our their what which who whom how when where why can could should would will shall may might about tell user please".split(" ")
);

export function openStore(path = process.env.MEMORY_DB_PATH || DEFAULT_DB) {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA cache_size = -64000;
    PRAGMA temp_store = MEMORY;
    PRAGMA mmap_size = 268435456;
    PRAGMA busy_timeout = 3000;
    CREATE TABLE IF NOT EXISTS memories (
      id INTEGER PRIMARY KEY,
      text TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'fact',
      project TEXT NOT NULL DEFAULT 'global',
      tags TEXT NOT NULL DEFAULT '',
      importance INTEGER NOT NULL DEFAULT 3,
      source TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      last_used INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS memories_rank ON memories(project, importance DESC, last_used DESC);
    CREATE INDEX IF NOT EXISTS memories_dup ON memories(project, text);
    CREATE TABLE IF NOT EXISTS handoffs (
      id INTEGER PRIMARY KEY,
      project TEXT NOT NULL,
      summary TEXT NOT NULL,
      from_model TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS handoffs_project ON handoffs(project, created_at DESC);
    CREATE TABLE IF NOT EXISTS usage (
      id INTEGER PRIMARY KEY,
      ts INTEGER NOT NULL,
      tool TEXT NOT NULL,
      client TEXT NOT NULL DEFAULT '',
      project TEXT NOT NULL DEFAULT '',
      tokens INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS usage_ts ON usage(ts);
  `);

  // Added later: auto-captured memories start 'pending' until approved. Plain ALTER, no index rebuild.
  if (!db.prepare("PRAGMA table_info(memories)").all().some((c) => c.name === "status")) {
    db.exec("ALTER TABLE memories ADD COLUMN status TEXT NOT NULL DEFAULT 'approved'");
  }

  // v2: porter stemming + weighted columns; rebuild the search index once.
  if (db.prepare("PRAGMA user_version").get().user_version < SCHEMA_VERSION) {
    db.exec(`
      DROP TRIGGER IF EXISTS memories_ai;
      DROP TRIGGER IF EXISTS memories_ad;
      DROP TRIGGER IF EXISTS memories_au;
      DROP TABLE IF EXISTS memories_fts;
    `);
  }
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts
      USING fts5(text, tags, content='memories', content_rowid='id', tokenize='porter unicode61');
    CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
      INSERT INTO memories_fts(rowid, text, tags) VALUES (new.id, new.text, new.tags);
    END;
    CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, text, tags) VALUES ('delete', old.id, old.text, old.tags);
    END;
    CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE OF text, tags ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, text, tags) VALUES ('delete', old.id, old.text, old.tags);
      INSERT INTO memories_fts(rowid, text, tags) VALUES (new.id, new.text, new.tags);
    END;
  `);
  if (db.prepare("PRAGMA user_version").get().user_version < SCHEMA_VERSION) {
    db.exec(`INSERT INTO memories_fts(memories_fts) VALUES ('rebuild'); PRAGMA user_version = ${SCHEMA_VERSION};`);
  }

  // Prepared statements are cached by SQL text so hot paths never re-parse.
  const cache = new Map();
  const stmt = (sql) => {
    let s = cache.get(sql);
    if (!s) cache.set(sql, (s = db.prepare(sql)));
    return s;
  };
  const now = () => Date.now();
  const usageOn = process.env.MEMORY_USAGE !== "off";
  try { stmt("DELETE FROM usage WHERE ts < ?").run(now() - 90 * 86400_000); } catch { /* best effort */ }

  function search(match, { project, kind }, fetch) {
    const where = ["memories_fts MATCH ?", "m.status = 'approved'"];
    const args = [match];
    if (project) { where.push("m.project IN (?, 'global')"); args.push(project); }
    if (kind) { where.push("m.kind = ?"); args.push(kind); }
    return stmt(
      `SELECT m.*, bm25(memories_fts, 1.0, 2.0) AS score FROM memories_fts
       JOIN memories m ON m.id = memories_fts.rowid
       WHERE ${where.join(" AND ")}
       ORDER BY score - m.importance * 0.5 LIMIT ?`
    ).all(...args, fetch);
  }

  return {
    remember({ text, kind = "fact", project = "global", tags = [], importance = 3, source = "", status = "approved" }) {
      const t = now();
      const dup = stmt("SELECT id FROM memories WHERE project = ? AND text = ?").get(project, text);
      if (dup) {
        stmt("UPDATE memories SET last_used = ?, importance = MAX(importance, ?) WHERE id = ?").run(t, importance, dup.id);
        return { id: Number(dup.id), duplicate: true };
      }
      const r = stmt(
        "INSERT INTO memories (text, kind, project, tags, importance, source, created_at, last_used, status) VALUES (?,?,?,?,?,?,?,?,?)"
      ).run(text, kind, project, tags.join(" "), importance, source, t, t, status);
      return { id: Number(r.lastInsertRowid), duplicate: false };
    },

    // AND match first (every word must appear, last word as prefix); widen to OR only if too few hits.
    recall({ query, project, kind, limit = 5, touch = true }) {
      const ts = terms(query);
      if (!ts.length) return [];
      const fetch = Math.min(limit * 3, 60);
      const opts = { project, kind };
      let rows = search(ftsQuery(ts, "AND"), opts, fetch);
      if (rows.length < limit && ts.length > 1) {
        const seen = new Set(rows.map((r) => r.id));
        for (const r of search(ftsQuery(ts, "OR"), opts, fetch)) if (!seen.has(r.id)) rows.push(r);
      }
      const out = dedupe(rows.map(fmt)).slice(0, limit);
      if (touch && out.length) {
        // one batched write, and only for rows not touched in the last hour
        const ids = out.map((r) => r.id);
        stmt(`UPDATE memories SET last_used = ? WHERE id IN (${ids.map(() => "?").join(",")}) AND last_used < ?`)
          .run(now(), ...ids, now() - HOUR);
      }
      return out;
    },

    // Best memories for a project (plus global), ranked by importance decayed by time since last use.
    recent({ project, limit = 10 }) {
      const cand = limit <= 100 ? Math.max(limit * 5, 50) : limit;
      const q = "SELECT * FROM memories WHERE project = ? AND status = 'approved' ORDER BY importance DESC, last_used DESC LIMIT ?";
      let rows;
      if (project) {
        rows = [...stmt(q).all(project, cand), ...(project === "global" ? [] : stmt(q).all("global", cand))];
      } else {
        rows = stmt("SELECT * FROM memories WHERE status = 'approved' ORDER BY importance DESC, last_used DESC LIMIT ?").all(cand);
      }
      const t = now();
      const rank = (r) => Number(r.importance) * 0.5 ** ((t - Number(r.last_used)) / 86400_000 / 60);
      return rows.sort((a, b) => rank(b) - rank(a)).slice(0, limit).map(fmt);
    },

    update(id, { text, kind, project, tags, importance }) {
      const cur = stmt("SELECT * FROM memories WHERE id = ?").get(id);
      if (!cur) return false;
      stmt("UPDATE memories SET text=?, kind=?, project=?, tags=?, importance=?, last_used=? WHERE id=?").run(
        text ?? cur.text, kind ?? cur.kind, project ?? cur.project,
        tags ? tags.join(" ") : cur.tags, importance ?? cur.importance, now(), id);
      return true;
    },

    forget(id) {
      return Number(stmt("DELETE FROM memories WHERE id = ?").run(id).changes) > 0;
    },

    saveHandoff({ project = "global", summary, from_model = "" }) {
      const r = stmt("INSERT INTO handoffs (project, summary, from_model, created_at) VALUES (?,?,?,?)")
        .run(project, summary, from_model, now());
      return Number(r.lastInsertRowid);
    },

    latestHandoff(project = "global") {
      const r = stmt("SELECT * FROM handoffs WHERE project = ? ORDER BY created_at DESC, id DESC LIMIT 1").get(project);
      return r ? { ...r, created_ms: Number(r.created_at), created_at: new Date(Number(r.created_at)).toISOString() } : null;
    },

    // Plain newest-first listing for browsing (read-only; used by the web viewer).
    list({ project, kind, tag, limit = 200 }) {
      const where = [];
      const args = [];
      if (project) { where.push("project = ?"); args.push(project); }
      if (kind) { where.push("kind = ?"); args.push(kind); }
      if (tag) { where.push("(' ' || tags || ' ') LIKE ?"); args.push(`% ${tag} %`); }
      return stmt(`SELECT * FROM memories ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY created_at DESC, id DESC LIMIT ?`)
        .all(...args, limit).map(fmt);
    },

    handoffs({ project, limit = 50 } = {}) {
      const rows = project
        ? stmt("SELECT * FROM handoffs WHERE project = ? ORDER BY created_at DESC, id DESC LIMIT ?").all(project, limit)
        : stmt("SELECT * FROM handoffs ORDER BY created_at DESC, id DESC LIMIT ?").all(limit);
      return rows.map((r) => ({
        id: Number(r.id), project: r.project, summary: r.summary, from_model: r.from_model,
        created_at: new Date(Number(r.created_at)).toISOString(),
      }));
    },

    // Usage tracking: counts only, never memory text. Token figures are estimates (chars / 4).
    usageEnabled: usageOn,

    recordUsage({ tool, client = "", project = "", tokens }) {
      if (!usageOn) return;
      stmt("INSERT INTO usage (ts, tool, client, project, tokens) VALUES (?,?,?,?,?)").run(now(), tool, client, project, tokens);
    },

    usageSummary({ days = 7, project } = {}) {
      const since = now() - days * 86400_000;
      const where = "ts >= ?" + (project ? " AND project = ?" : "");
      const args = project ? [since, project] : [since];
      const totals = stmt(`SELECT COUNT(*) AS calls, COALESCE(SUM(tokens), 0) AS tokens FROM usage WHERE ${where}`).get(...args);
      const group = (col) =>
        stmt(`SELECT ${col} AS name, COUNT(*) AS calls, SUM(tokens) AS tokens FROM usage WHERE ${where} GROUP BY ${col} ORDER BY tokens DESC`)
          .all(...args)
          .map((r) => ({ name: r.name || "(unknown)", calls: Number(r.calls), tokens: Number(r.tokens) }));
      const perDay = new Map(
        stmt(`SELECT strftime('%Y-%m-%d', ts / 1000, 'unixepoch', 'localtime') AS day, SUM(tokens) AS tokens FROM usage WHERE ${where} GROUP BY day`)
          .all(...args).map((r) => [r.day, Number(r.tokens)])
      );
      const byDay = [];
      for (let i = days - 1; i >= 0; i--) {
        const d = new Date(Date.now() - i * 86400_000);
        const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
        byDay.push({ day: key, tokens: perDay.get(key) || 0 });
      }
      return { days, calls: Number(totals.calls), tokens: Number(totals.tokens), byDay, byTool: group("tool"), byClient: group("client") };
    },

    projects() {
      return stmt("SELECT project, COUNT(*) AS n FROM memories GROUP BY project ORDER BY n DESC").all();
    },

    all() {
      return stmt("SELECT * FROM memories WHERE status = 'approved' ORDER BY project, importance DESC, id").all().map(fmt);
    },

    // Auto-captured memories waiting for review (kept out of search and context until approved).
    pending() {
      return stmt("SELECT * FROM memories WHERE status = 'pending' ORDER BY id").all().map(fmt);
    },

    approve(id) { // a memory id, or "all"
      const r = id === "all"
        ? stmt("UPDATE memories SET status = 'approved' WHERE status = 'pending'").run()
        : stmt("UPDATE memories SET status = 'approved' WHERE id = ? AND status = 'pending'").run(id);
      return Number(r.changes);
    },

    reject(id) {
      return Number(stmt("DELETE FROM memories WHERE id = ? AND status = 'pending'").run(id).changes) > 0;
    },

    close() { db.close(); },
  };
}

function terms(q) {
  const all = (q.toLowerCase().match(/[\p{L}\p{N}_]+/gu) || []);
  const kept = all.filter((w) => !STOP.has(w));
  return (kept.length ? kept : all).slice(0, 12);
}

const ftsQuery = (ts, op) => ts.map((t, i) => `"${t}"${i === ts.length - 1 ? "*" : ""}`).join(` ${op} `);

function fmt(r) {
  return {
    id: Number(r.id),
    text: r.text,
    kind: r.kind,
    project: r.project,
    tags: r.tags ? r.tags.split(" ") : [],
    importance: Number(r.importance),
    created_at: new Date(Number(r.created_at)).toISOString(),
    used: Number(r.last_used),
    status: r.status ?? "approved",
  };
}

// Scrub likely secrets before anything auto-captured is stored.
const SECRET_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/g,
  /\bAIza[0-9A-Za-z_-]{30,}/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/gi,
];
export function redact(s) {
  let out = s;
  for (const p of SECRET_PATTERNS) out = out.replace(p, "[redacted]");
  return out.replace(/\b(password|passwd|secret|token|api[_-]?key)(\s*[:=]\s*)\S+/gi, "$1$2[redacted]");
}

// ---- context shaping: keep what the model sees small ----

const words = (s) => new Set(s.toLowerCase().match(/[\p{L}\p{N}_]+/gu) || []);

/** Drop rows whose word set overlaps >80% with an already-kept row (input order = rank order). */
export function dedupe(rows) {
  const kept = [];
  const sets = [];
  for (const r of rows) {
    const w = words(r.text);
    const dup = sets.some((s) => {
      let hit = 0;
      for (const x of w) if (s.has(x)) hit++;
      return hit / (w.size + s.size - hit || 1) > 0.8;
    });
    if (!dup) { kept.push(r); sets.push(w); }
  }
  return kept;
}

export const tokens = (s) => Math.ceil(s.length / 4);
const ABBR = { fact: "", preference: "pref", decision: "dec", task: "task", note: "note" };

export function line(m, { maxChars = 280, showProject = false } = {}) {
  const t = m.text.length > maxChars ? m.text.slice(0, maxChars - 1) + "…" : m.text;
  const k = ABBR[m.kind] ?? m.kind;
  return `#${m.id} ${k ? k + ": " : ""}${t}${m.tags.length ? " #" + m.tags.join(" #") : ""}${showProject && m.project !== "global" ? ` (${m.project})` : ""}`;
}

/** Compact lines for rows, stopping at the token budget. */
export function render(rows, { budget = Infinity, maxChars = 280, showProject = false } = {}) {
  const out = [];
  let used = 0;
  let omitted = 0;
  for (const r of dedupe(rows)) {
    const l = line(r, { maxChars, showProject });
    const cost = tokens(l) + 1;
    if (used + cost > budget) { omitted++; continue; }
    out.push(l);
    used += cost;
  }
  return { text: out.join("\n"), omitted };
}

function ago(ms) {
  const m = (Date.now() - ms) / 60000;
  if (m < 60) return "<1h";
  if (m < 1440) return `${Math.floor(m / 60)}h`;
  if (m < 43200) return `${Math.floor(m / 1440)}d`;
  return `${Math.floor(m / 43200)}mo`;
}

/** Handoff + top memories as plain compact text. budget = max tokens (Infinity = everything, for export). */
export function toMarkdown(store, project, { budget = Infinity } = {}) {
  const limited = Number.isFinite(budget);
  const parts = [];
  let used = 0;
  const h = store.latestHandoff(project || "global");
  if (h) {
    let s = h.summary.trim();
    const cap = Math.floor(budget * 0.4);
    if (limited && tokens(s) > cap) s = s.slice(0, Math.max(cap * 4 - 1, 0)) + "…";
    const l = `Handoff (${ago(h.created_ms)} ago${h.from_model ? ", " + h.from_model : ""}): ${s}`;
    parts.push(l);
    used += tokens(l);
  }
  const pool = limited ? store.recent({ project, limit: 200 }) : project ? store.recent({ project, limit: 100000 }) : store.all();
  const { text, omitted } = render(pool, { budget: budget - used, maxChars: limited ? 280 : Infinity, showProject: !project });
  if (text) parts.push(text);
  if (omitted) parts.push(`(+${omitted} more; use recall)`);
  return parts.join("\n") || "no memories yet";
}
