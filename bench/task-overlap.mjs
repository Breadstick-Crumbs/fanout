#!/usr/bin/env node
// How well fanout's task-overlap check tells the same work from different work, on labelled pairs
// (bench/task-pairs.json: 40 pairs, 20 same and 20 different, written by a separate agent that didn't know
// how they would be judged). For each pair, task a is the new claim and task b is one of four live claims
// (b plus three tasks from other pairs), the way a claim is checked against every live one at once.
//   node bench/task-overlap.mjs [--pairs task-pairs-heldout.json] [--words-only] [--agent claude|codex] [--model m] [--effort low] [--limit 40]
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { wordOverlap, judge } from "../skills/fanout/claims.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2), opt = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };
const pairs = JSON.parse(readFileSync(join(HERE, opt("--pairs", "task-pairs.json")), "utf8")).slice(0, Number(opt("--limit", "40")));
if (opt("--model")) process.env.FANOUT_CLAIM_JUDGE_MODEL = opt("--model");
if (opt("--agent")) process.env.FANOUT_CLAIM_JUDGE_AGENT = opt("--agent"); // claude | codex
if (opt("--effort")) process.env.FANOUT_CLAIM_JUDGE_EFFORT = opt("--effort"); // Codex only

const score = (name, preds) => {
  let tp = 0, fp = 0, fn = 0, tn = 0;
  preds.forEach((p, i) => { const s = pairs[i].same; if (p == null) return; if (p && s) tp++; else if (p && !s) fp++; else if (!p && s) fn++; else tn++; });
  const n = tp + fp + fn + tn;
  console.log(`${name.padEnd(22)} correct ${tp + tn}/${n}  caught ${tp}/${tp + fn} duplicates  false alarms ${fp}/${fp + tn}`);
};

const wordScores = pairs.map((p) => wordOverlap(p.a, p.b));
for (const t of [0.3, 0.4, 0.5, 0.6, 0.7]) score(`words >= ${t}`, wordScores.map((s) => s >= t));

if (!argv.includes("--words-only")) {
  // Three distractors per pair, taken from other pairs (deterministic).
  const pool = pairs.flatMap((p, i) => [{ i, task: p.a }, { i, task: p.b }]);
  let cost = 0, failed = 0;
  const secs = [];
  const preds = [], misses = [];
  for (let i = 0; i < pairs.length; i++) {
    const others = [{ name: "target", task: pairs[i].b }];
    // A distractor can't come from a pair that shares a task with this one (some tasks appear in two pairs).
    const related = new Set(pairs.flatMap((p, k) => ([p.a, p.b].some((t) => t === pairs[i].a || t === pairs[i].b) ? [k] : [])));
    for (let k = 1; others.length < 4; k++) { const d = pool[(i * 7 + k * 13) % pool.length]; if (!related.has(d.i) && !others.some((o) => o.task === d.task)) others.push({ name: `other${others.length}`, task: d.task }); }
    others.sort((x, y) => (x.task < y.task ? -1 : 1)); // the target isn't always first
    const t = Date.now(), j = judge(pairs[i].a, others, process.cwd());
    secs.push((Date.now() - t) / 1000);
    if (!j) { failed++; preds.push(null); continue; }
    cost += j.costUsd ?? 0;
    const p = j.same.includes("target");
    preds.push(p);
    if (p !== pairs[i].same) misses.push(`${pairs[i].same ? "MISSED" : "FALSE ALARM"}: ${pairs[i].a} || ${pairs[i].b} (judge: ${j.why})`);
    if (j.same.some((n) => n !== "target")) misses.push(`ALSO FLAGGED a distractor for: ${pairs[i].a} -> ${j.same.join(", ")}`);
  }
  score(`judge (${process.env.FANOUT_CLAIM_JUDGE_AGENT || "auto"} ${process.env.FANOUT_CLAIM_JUDGE_MODEL || "default model"})`, preds);
  secs.sort((a, b) => a - b);
  console.log(`seconds per check: median ${secs[secs.length >> 1]?.toFixed(1)}, slowest ${secs.at(-1)?.toFixed(1)}`);
  console.log(`judge calls failed: ${failed}; cost $${cost.toFixed(3)} for ${pairs.length - failed} calls`);
  misses.forEach((m) => console.log("  " + m));
}
