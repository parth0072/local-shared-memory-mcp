// Claude Code hooks: load memory when a session starts, save a handoff when it ends.
// Hooks must never break or slow Claude Code, so every entry point swallows its own errors.
import { closeSync, copyFileSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { redact, toMarkdown } from "./store.js";

const GUARD = "CTX_MEMORY_HOOK"; // set on the summarizer's own claude run so its hooks do nothing
const MAX_READ = 30 * 1024 * 1024;

const stdinJson = () => {
  try { return JSON.parse(readFileSync(0, "utf8") || "{}"); } catch { return {}; }
};
const projectFor = (cwd) => process.env.MEMORY_PROJECT || basename(cwd || "") || "global";
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const autosaveOff = () => process.env[GUARD] || process.env.MEMORY_AUTOSAVE === "off";

/** SessionStart: whatever this prints is added to Claude's context, so keep it small and factual. */
export function sessionStart(store) {
  try {
    if (process.env[GUARD]) return;
    const project = projectFor(stdinJson().cwd);
    const text = toMarkdown(store, project, { budget: 700 });
    if (text === "no memories yet") return;
    console.log(`Shared memory (ctx-memory) for project "${project}":\n${text}`);
  } catch { /* never break a session */ }
}

/** Pull human prompts and assistant text out of a Claude Code transcript (JSONL). */
export function readTranscript(path) {
  const prompts = [];
  const convo = [];
  let lastAssistant = "";
  let raw = "";
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const len = Math.min(size, MAX_READ);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    raw = buf.toString("utf8");
  } finally { closeSync(fd); }
  for (const line of raw.split("\n")) {
    if (!line) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; } // also drops a cut-off first line
    if (e.isSidechain) continue;
    const c = e.message?.content;
    if (e.type === "user") {
      if (e.origin?.kind && e.origin.kind !== "human") continue;
      let t = "";
      if (typeof c === "string") t = c;
      else if (Array.isArray(c) && !c.some((b) => b.type === "tool_result")) t = c.filter((b) => b.type === "text").map((b) => b.text).join("\n");
      t = t.trim();
      if (t) { prompts.push(t); convo.push(`User: ${t}`); }
    } else if (e.type === "assistant" && Array.isArray(c)) {
      const t = c.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
      if (t) { lastAssistant = t; convo.push(`Assistant: ${t}`); }
    }
  }
  return { prompts, lastAssistant, convo };
}

/** SessionEnd: save a free, heuristic handoff; optionally hand off to a background summarizer. */
export function sessionEnd(store, { summarize = false, self } = {}) {
  try {
    if (autosaveOff()) return;
    const input = stdinJson();
    if (!input.transcript_path || !existsSync(input.transcript_path)) return;
    const project = projectFor(input.cwd);
    const { prompts, lastAssistant } = readTranscript(input.transcript_path);
    if (!prompts.length) return;
    const lines = prompts.slice(-3).map((p) => `- ${clip(p.replace(/\s+/g, " "), 200)}`);
    const summary = redact(
      `Auto-saved at session end. Recent requests:\n${lines.join("\n")}` +
      (lastAssistant ? `\nLast assistant message: ${clip(lastAssistant.replace(/\s+/g, " "), 500)}` : "")
    );
    store.saveHandoff({ project, summary, from_model: "claude-code (auto)" });
    if (summarize && self) {
      // detached so closing the session is not delayed; GUARD stops the summarizer's own hooks looping
      spawn(process.execPath, [self, "hook", "summarize-worker", input.transcript_path, project], {
        detached: true, stdio: "ignore", env: { ...process.env, [GUARD]: "1" },
      }).unref();
    }
  } catch { /* never break a session */ }
}

/** Background worker: ask Claude (headless) for a real handoff plus a few pending candidate memories. */
export function summarizeWorker(store, { transcript, project }) {
  try {
    if (process.env.MEMORY_AUTOSAVE === "off" || !transcript || !project) return;
    const { convo } = readTranscript(transcript);
    const tail = redact(clip(convo.join("\n\n").slice(-12000), 12000));
    const prompt =
      "Summarize this coding session for the next AI assistant. Reply with ONLY JSON: " +
      '{"handoff": "goal, decisions, current state, next steps in at most 150 words", ' +
      '"memories": [{"text": "one self-contained statement", "kind": "fact|preference|decision|task|note"}]}. ' +
      "At most 5 durable memories (preferences, decisions, facts). No secrets.\n\n" + tail;
    const r = spawnSync("claude", ["-p", "--model", "haiku"], {
      input: prompt, encoding: "utf8", timeout: 120_000, env: { ...process.env, [GUARD]: "1" },
    });
    if (r.status !== 0 || !r.stdout) return;
    const a = r.stdout.indexOf("{");
    const b = r.stdout.lastIndexOf("}");
    if (a < 0 || b < a) return;
    const out = JSON.parse(r.stdout.slice(a, b + 1));
    if (typeof out.handoff === "string" && out.handoff.trim()) {
      store.saveHandoff({ project, summary: redact(out.handoff.trim()), from_model: "claude-code (auto, summarized)" });
    }
    const kinds = ["fact", "preference", "decision", "task", "note"];
    for (const m of (Array.isArray(out.memories) ? out.memories : []).slice(0, 5)) {
      if (typeof m?.text !== "string" || !m.text.trim()) continue;
      store.remember({
        text: redact(clip(m.text.trim(), 300)), kind: kinds.includes(m.kind) ? m.kind : "note",
        project, source: "auto", status: "pending",
      });
    }
  } catch { /* background job: stay silent */ }
}

/** The settings.json block for Claude Code. Exec form (command + args) avoids shell quoting problems. */
export function hooksConfig({ self, summarize = false }) {
  const entry = (evt, extra = []) => [{ hooks: [{ type: "command", command: process.execPath, args: [self, "hook", evt, ...extra], timeout: 10 }] }];
  return { hooks: { SessionStart: entry("session-start"), SessionEnd: entry("session-end", summarize ? ["--summarize"] : []) } };
}

/** Merge our hooks into ~/.claude/settings.json (backup first), replacing any earlier ctx-memory entries. */
export function installHooks({ self, summarize = false, file = join(homedir(), ".claude", "settings.json") }) {
  let cfg = {};
  if (existsSync(file)) {
    cfg = JSON.parse(readFileSync(file, "utf8") || "{}");
    copyFileSync(file, file + ".bak");
  }
  const ours = hooksConfig({ self, summarize }).hooks;
  cfg.hooks ??= {};
  for (const [evt, groups] of Object.entries(ours)) {
    const mine = (g) => g.hooks?.some((h) => h.args?.includes("hook") && h.args?.[0] === self);
    cfg.hooks[evt] = [...(cfg.hooks[evt] || []).filter((g) => !mine(g)), ...groups];
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(cfg, null, 2));
  return file;
}
