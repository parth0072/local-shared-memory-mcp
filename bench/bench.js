// usage: node bench/bench.js [path/to/store.js] [rows] [budget]
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const storePath = resolve(process.argv[2] || "src/store.js");
const N = Number(process.argv[3]) || 100_000;
const budget = Number(process.argv[4]) || undefined;
const { openStore, toMarkdown } = await import(pathToFileURL(storePath));

const dbFile = join(mkdtempSync(join(tmpdir(), "bench-")), "b.db");
openStore(dbFile).close();

// deterministic PRNG so runs are comparable
let seed = 42;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
const vocab = Array.from({ length: 3000 }, (_, i) => {
  const s = "bcdfghklmnprstvz", v = "aeiou";
  let w = "", x = i + 7;
  for (let k = 0; k < 3; k++) { w += s[x % s.length] + v[(x >> 4) % v.length]; x = (x * 31 + 11) >>> 0; }
  return w + (i % 7);
});
const pick = () => vocab[Math.floor(rnd() ** 2 * vocab.length)];
const sentence = () => Array.from({ length: 8 + Math.floor(rnd() * 14) }, pick).join(" ");

const raw = new DatabaseSync(dbFile);
raw.exec("BEGIN");
const ins = raw.prepare(
  "INSERT INTO memories (text, kind, project, tags, importance, source, created_at, last_used) VALUES (?,?,?,?,?,?,?,?)"
);
const t0 = Date.now();
for (let i = 0; i < N; i++) {
  ins.run(sentence(), "fact", "p" + (i % 20), pick(), 1 + Math.floor(rnd() * 5), "", t0 - i * 60000, t0 - i * 60000);
}
raw.exec("COMMIT");
raw.close();

const store = openStore(dbFile);
const time = (fn, runs) => {
  const ts = [];
  for (let i = 0; i < runs; i++) {
    const s = process.hrtime.bigint();
    fn();
    ts.push(Number(process.hrtime.bigint() - s) / 1e6);
  }
  ts.sort((a, b) => a - b);
  return `p50 ${ts[Math.floor(runs * 0.5)].toFixed(2)} ms, p95 ${ts[Math.floor(runs * 0.95)].toFixed(2)} ms`;
};
const queries = Array.from({ length: 200 }, () => [pick(), pick(), pick()].join(" "));
let qi = 0;
console.log(`rows=${N}`);
console.log("recall (3 words)        ", time(() => store.recall({ query: queries[qi++ % 200] }), 200));
qi = 0;
console.log("recall (project filter) ", time(() => store.recall({ query: queries[qi++ % 200], project: "p3" }), 200));
console.log("recent (project)        ", time(() => store.recent({ project: "p3", limit: 10 }), 100));
console.log("recall results (q0)     ", store.recall({ query: queries[0] }).length);
const ctx = toMarkdown(store, "p3", budget ? { budget } : undefined);
console.log(`get_context size         ${ctx.length} chars ≈ ${Math.ceil(ctx.length / 4)} tokens`);
store.close();
