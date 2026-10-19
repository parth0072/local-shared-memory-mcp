import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const DEFAULT_DB = join(homedir(), ".memory", "ctx-memory.db");

export function openStore(path = process.env.MEMORY_DB_PATH || DEFAULT_DB) {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
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
    CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts
      USING fts5(text, tags, content='memories', content_rowid='id');
    CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
      INSERT INTO memories_fts(rowid, text, tags) VALUES (new.id, new.text, new.tags);
    END;
    CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, text, tags) VALUES ('delete', old.id, old.text, old.tags);
    END;
    CREATE TABLE IF NOT EXISTS handoffs (
      id INTEGER PRIMARY KEY,
      project TEXT NOT NULL,
      summary TEXT NOT NULL,
      from_model TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL
    );
  `);

  const now = () => Date.now();

  return {
    remember({ text, kind = "fact", project = "global", tags = [], importance = 3, source = "" }) {
      const t = now();
      const dup = db
        .prepare("SELECT id FROM memories WHERE project = ? AND text = ?")
        .get(project, text);
      if (dup) {
        db.prepare("UPDATE memories SET last_used = ?, importance = MAX(importance, ?) WHERE id = ?").run(t, importance, dup.id);
        return { id: Number(dup.id), duplicate: true };
      }
      const r = db
        .prepare("INSERT INTO memories (text, kind, project, tags, importance, source, created_at, last_used) VALUES (?,?,?,?,?,?,?,?)")
        .run(text, kind, project, tags.join(" "), importance, source, t, t);
      return { id: Number(r.lastInsertRowid), duplicate: false };
    },

    recall({ query, project, kind, limit = 8 }) {
      const words = (query.match(/[\p{L}\p{N}_]+/gu) || []).map((w) => `"${w}"`);
      let rows = [];
      if (words.length) {
        const where = ["memories_fts MATCH ?"];
        const args = [words.join(" OR ")];
        if (project) { where.push("m.project IN (?, 'global')"); args.push(project); }
        if (kind) { where.push("m.kind = ?"); args.push(kind); }
        rows = db
          .prepare(
            `SELECT m.*, bm25(memories_fts) AS score FROM memories_fts
             JOIN memories m ON m.id = memories_fts.rowid
             WHERE ${where.join(" AND ")}
             ORDER BY score - (m.importance * 0.5) ASC LIMIT ?`
          )
          .all(...args, limit);
      }
      if (rows.length) {
        const touch = db.prepare("UPDATE memories SET last_used = ? WHERE id = ?");
        for (const r of rows) touch.run(now(), r.id);
      }
      return rows.map(fmt);
    },

    recent({ project, limit = 10 }) {
      const rows = project
        ? db.prepare("SELECT * FROM memories WHERE project IN (?, 'global') ORDER BY importance DESC, last_used DESC LIMIT ?").all(project, limit)
        : db.prepare("SELECT * FROM memories ORDER BY importance DESC, last_used DESC LIMIT ?").all(limit);
      return rows.map(fmt);
    },

    forget(id) {
      return Number(db.prepare("DELETE FROM memories WHERE id = ?").run(id).changes) > 0;
    },

    saveHandoff({ project = "global", summary, from_model = "" }) {
      const r = db
        .prepare("INSERT INTO handoffs (project, summary, from_model, created_at) VALUES (?,?,?,?)")
        .run(project, summary, from_model, now());
      return Number(r.lastInsertRowid);
    },

    latestHandoff(project = "global") {
      const r = db
        .prepare("SELECT * FROM handoffs WHERE project = ? ORDER BY created_at DESC, id DESC LIMIT 1")
        .get(project);
      return r ? { ...r, created_at: new Date(r.created_at).toISOString() } : null;
    },

    projects() {
      return db.prepare("SELECT project, COUNT(*) AS n FROM memories GROUP BY project ORDER BY n DESC").all();
    },

    all() {
      return db.prepare("SELECT * FROM memories ORDER BY project, importance DESC, id").all().map(fmt);
    },

    close() { db.close(); },
  };
}

function fmt(r) {
  return {
    id: Number(r.id),
    text: r.text,
    kind: r.kind,
    project: r.project,
    tags: r.tags ? r.tags.split(" ") : [],
    importance: Number(r.importance),
    created_at: new Date(Number(r.created_at)).toISOString(),
  };
}

export function toMarkdown(store, project) {
  const mems = project ? store.recent({ project, limit: 50 }) : store.all();
  const h = store.latestHandoff(project || "global");
  const lines = ["# Memory context", ""];
  if (h) {
    lines.push(`## Last handoff (${h.created_at}${h.from_model ? ", from " + h.from_model : ""})`, "", h.summary, "");
  }
  lines.push("## Memories", "");
  for (const m of mems) lines.push(`- [${m.kind}] ${m.text}${m.tags.length ? " #" + m.tags.join(" #") : ""} (${m.project})`);
  return lines.join("\n");
}
