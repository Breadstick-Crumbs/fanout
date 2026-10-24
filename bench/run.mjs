#!/usr/bin/env node
// Benchmark: the same four tasks (bench/shop/TASKS.md) done by four parallel agents, twice.
//   baseline: plain worktrees, then merge, then one integrator agent cleans up.
//   fanout:   a coordinator agent plans and writes contracts with the fanout skill, lanes are
//             guarded, rehearse finds breaks and the lane that caused one fixes it, then merge.
// The "receipt" lane runs in Codex, the rest in Claude Code, in both conditions.
//
//   node bench/run.mjs [baseline|fanout|both] [--dry] [--model sonnet] [--budget 1] [--codex-lane receipt|none]
// --dry swaps every agent for a no-op (the coordinator writes a canned plan) to test the plumbing.
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parsePlan, parseRegen, blockReason } from "../skills/fanout/fanout.mjs";
import { runAgent } from "../skills/fanout/run.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FANOUT = join(ROOT, "skills", "fanout", "fanout.mjs");
const argv = process.argv.slice(2);
const opt = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };
const MODE = argv[0] && !argv[0].startsWith("--") ? argv[0] : "both";
const DRY = argv.includes("--dry");
const MODEL = opt("--model", "sonnet"), BUDGET = opt("--budget", "1");
const LANES = ["currency", "discounts", "receipt", "tax"];
const CODEX_LANE = opt("--codex-lane", "receipt"); // "none" runs every lane in Claude
const TASKS = Object.fromEntries(readFileSync(join(ROOT, "bench/shop/TASKS.md"), "utf8").split(/^## /m).slice(1)
  .map((b) => { const [name, ...rest] = b.split("\n"); return [name.trim(), rest.join("\n").trim()]; }));

const run = (cmd, args, cwd, input) => {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8", input, shell: process.platform === "win32" && cmd !== "git" && cmd !== process.execPath });
  return { ok: r.status === 0, status: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
};
const git = (cwd, ...a) => run("git", a, cwd);
const tail = (s, n = 15) => s.trimEnd().split("\n").slice(-n).join("\n");
const npmTest = (cwd) => run(process.execPath, ["--test", "test/*.test.mjs"], cwd);
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// One agent call via fanout's own runner (skills/fanout/run.mjs). Never throws.
async function agent({ lane, role, cwd, prompt, plugin = false, allowGit = false, dryAction }) {
  const kind = lane === CODEX_LANE && role !== "coordinator" && role !== "integrator" ? "codex" : "claude";
  if (DRY) { dryAction?.(); return { role, lane, kind, seconds: 0, costUsd: 0, inTokens: 0, outTokens: 0, error: null }; }
  const r = await runAgent({ agent: kind, cwd, prompt, plugin, allowGit, model: kind === "claude" ? MODEL : undefined, budget: kind === "claude" ? BUDGET : undefined });
  return { role, lane, kind, ...r };
}

function setup(name) {
  const dir = mkdtempSync(join(tmpdir(), `fanout-bench-${name}-`));
  const repo = join(dir, "repo");
  cpSync(join(ROOT, "bench/shop"), repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.name", "bench"); git(repo, "config", "user.email", "bench@local");
  writeFileSync(join(repo, ".git/info/exclude"), ".fanout/\nnode_modules/\n");
  git(repo, "add", "-A"); git(repo, "commit", "-qm", "shop");
  return { dir, repo };
}

const COMMON = "Work only in this folder. Run `npm test` before you finish. Don't commit: your changes are committed for you. Don't explore beyond what the task needs.";
const commitAll = (wt, msg) => { git(wt, "add", "-A"); return git(wt, "commit", "-qm", msg); };

// ---------- baseline ----------
async function baseline() {
  const { dir, repo } = setup("baseline");
  const R = { condition: "baseline", agents: [], conflicts: [], brokeAfter: [], repairCommits: 0 };
  log("baseline: repo", repo);
  const wts = Object.fromEntries(LANES.map((l) => [l, join(dir, l)]));
  for (const l of LANES) git(repo, "worktree", "add", "-q", "-b", `lane/${l}`, wts[l], "main");
  R.agents.push(...await Promise.all(LANES.map((l) => agent({ lane: l, role: "lane", cwd: wts[l],
    prompt: `${TASKS[l]}\n\n${COMMON}` }))));
  for (const l of LANES) commitAll(wts[l], l);
  for (const l of LANES) {
    const m = git(repo, "merge", "--no-ff", "--no-edit", `lane/${l}`);
    if (!m.ok) { R.conflicts.push(l); git(repo, "merge", "--abort"); continue; }
    if (!npmTest(repo).ok) R.brokeAfter.push(l);
  }
  const before = git(repo, "rev-parse", "HEAD").out.trim();
  const t = npmTest(repo);
  log(`baseline: conflicts=${R.conflicts.join(",") || "none"} brokeAfter=${R.brokeAfter.join(",") || "none"} testsPass=${t.ok}`);
  if (R.conflicts.length || !t.ok) {
    const prompt = `Four branches (lane/currency, lane/discounts, lane/receipt, lane/tax) were built in parallel and are being integrated into main.\n` +
      (R.conflicts.length ? `These did not merge cleanly and are not merged yet: ${R.conflicts.map((l) => "lane/" + l).join(", ")}.\n` : "") +
      (t.ok ? "" : `npm test currently fails on main:\n${tail(t.out)}\n`) +
      `Merge whatever isn't merged, resolve conflicts, and make main work with all four features and npm test passing. src/index.mjs is generated by \`npm run gen\`. Commit your work on main.`;
    R.agents.push(await agent({ lane: "-", role: "integrator", cwd: repo, prompt, allowGit: true }));
    commitAll(repo, "integrator leftovers");
  }
  R.repairCommits = Number(git(repo, "rev-list", "--count", `${before}..HEAD`).out.trim()) || 0;
  R.finalTestsPass = npmTest(repo).ok;

  return R;
}

// ---------- fanout ----------
const CANNED_PLAN = `test: npm test
regen: src/index.mjs via node scripts/gen-index.mjs

## currency
owns: src/types.mjs, src/format.mjs, test/types.test.mjs, test/format.test.mjs
exposes: src/types.mjs, src/format.mjs
done: prices are integer cents plus currency

## discounts
owns: src/cart.mjs, test/discounts.test.mjs
uses: src/types.mjs
done: SAVE10 and FLAT5 work

## receipt
owns: src/receipt.mjs, test/receipt.test.mjs
uses: src/format.mjs
done: receipt prints items and total

## tax
owns: src/tax.mjs, test/tax.test.mjs
uses: src/types.mjs
done: CA, NY and other rates
`;

async function fanout() {
  const { dir, repo } = setup("fanout");
  const R = { condition: "fanout", agents: [], conflicts: [], brokeAfter: [], repairCommits: 0, rehearsals: [], blockedFiles: [] };
  log("fanout: repo", repo);
  run(process.execPath, [FANOUT, "install-git-hook"], repo);
  const coord = `Follow the fanout skill at ${join(ROOT, "skills/fanout/SKILL.md")} (read it first; its script is ${FANOUT}, run it with node) to split these four tasks into parallel sessions. Do only the planning part: write .fanout/plan.md (sessions named exactly ${LANES.join(", ")}; include test: and regen: lines), run the check until it passes, then write and commit the contract files on main. Do not start any sessions, create worktrees, or implement the tasks beyond the contracts: I start the sessions myself. Treat the plan as approved.\n\n${readFileSync(join(ROOT, "bench/shop/TASKS.md"), "utf8")}`;
  R.agents.push(await agent({ lane: "-", role: "coordinator", cwd: repo, prompt: coord, plugin: true, allowGit: true,
    dryAction: () => { mkdirSync(join(repo, ".fanout"), { recursive: true }); writeFileSync(join(repo, ".fanout/plan.md"), CANNED_PLAN); } }));
  commitAll(repo, "coordinator leftovers");
  const planPath = join(repo, ".fanout/plan.md");
  if (!existsSync(planPath)) { R.error = "coordinator wrote no plan"; return R; }
  const text = readFileSync(planPath, "utf8"), sessions = parsePlan(text), regen = parseRegen(text);
  R.plan = text;
  const chk = run(process.execPath, [FANOUT, "check"], repo);
  if (!chk.ok || LANES.some((l) => !sessions.find((s) => s.name === l))) { R.error = "plan invalid: " + tail(chk.out); return R; }
  const order = chk.out.match(/Merge order: (.*)/)[1].trim().split(" -> ");
  const wts = Object.fromEntries(LANES.map((l) => [l, join(dir, l)]));
  for (const l of LANES) git(repo, "worktree", "add", "-q", "-b", `fanout/${l}`, wts[l], "main");
  const brief = (s) => `You are session "${s.name}" of a parallel fan-out; other sessions are doing the other parts at the same time.\n\nTask:\n${TASKS[s.name]}\n\n` +
    `You may edit only: ${s.owns.join(", ")}.\n` +
    (s.uses.length ? `Interfaces you depend on (frozen; read them, don't edit them): ${s.uses.join(", ")}.\n` : "") +
    (regen.length ? `Generated files (${regen.flatMap((r) => r.paths).join(", ")}) are rebuilt after merging: you may run the generator to test, but your edits to them are discarded.\n` : "") +
    `Read only the files you need. Done when: ${(text.split(`## ${s.name}`)[1] ?? "").match(/^done:(.*)$/m)?.[1]?.trim() ?? "the task works"}.\n\n${COMMON}`;
  // Commit a lane, as the git hook allows; files the plan forbids are reverted and counted.
  const commitLane = (l) => {
    const s = sessions.find((x) => x.name === l);
    git(wts[l], "add", "-A");
    const staged = git(wts[l], "diff", "--cached", "--name-only").out.split("\n").filter(Boolean);
    for (const f of staged) if (blockReason(sessions, s, regen, f)) {
      R.blockedFiles.push(`${l}: ${f}`);
      git(wts[l], "reset", "-q", "--", f);
      const inMain = git(wts[l], "cat-file", "-e", `HEAD:${f}`).ok;
      if (inMain) git(wts[l], "checkout", "--", f); else git(wts[l], "clean", "-fq", "--", f);
    }
    return git(wts[l], "commit", "-qm", l);
  };
  R.agents.push(...await Promise.all(LANES.map((l) => agent({ lane: l, role: "lane", cwd: wts[l], prompt: brief(sessions.find((s) => s.name === l)) }))));
  for (const l of LANES) commitLane(l);
  for (let round = 0; round < 3; round++) {
    const r = run(process.execPath, [FANOUT, "rehearse"], repo);
    R.rehearsals.push(tail(r.out, 3));
    log(`fanout: rehearse #${round + 1}: ${r.ok ? "pass" : r.out.split("\n").find((x) => /^(BROKE|CONFLICT|REGEN FAILED)/.test(x))}`);
    if (r.ok) break;
    const line = r.out.split("\n").find((x) => /^(BROKE after|CONFLICT merging|REGEN FAILED after) /.test(x));
    const l = line?.match(/(?:after|merging) ([\w-]+)/)?.[1];
    if (!l || !wts[l]) break;
    R.agents.push(await agent({ lane: l, role: "fix", cwd: wts[l], prompt: `${brief(sessions.find((s) => s.name === l))}\n\nYour branch was merged with the others in the plan's order and it broke:\n${tail(r.out, 20)}\n\nFix it within the files you may edit.` }));
    if (commitLane(l).ok) R.repairCommits++;
  }
  for (const l of order) {
    const m = git(repo, "merge", "--no-ff", "--no-edit", `fanout/${l}`);
    if (!m.ok) { R.conflicts.push(l); git(repo, "merge", "--abort"); continue; }
    for (const g of regen) run(g.cmd.split(" ")[0] === "node" ? process.execPath : g.cmd.split(" ")[0], g.cmd.split(" ").slice(1), repo);
    commitAll(repo, "regen");
    if (!npmTest(repo).ok) R.brokeAfter.push(l);
  }
  R.finalTestsPass = npmTest(repo).ok;

  return R;
}

// ---------- report ----------
const sum = (R, k) => R.agents.reduce((a, x) => a + (x[k] || 0), 0);
function report(results) {
  const rows = results.map((R) => `| ${R.condition} | ${R.conflicts.length ? R.conflicts.join(", ") : "none"} | ${R.brokeAfter.length ? R.brokeAfter.join(", ") : "none"} | ${R.repairCommits} | ${R.finalTestsPass ? "yes" : "**no**"} | $${sum(R, "costUsd").toFixed(2)} | ${Math.round((sum(R, "inTokens") + sum(R, "outTokens")) / 1000)}k | ${R.agents.length} |`);
  const agents = results.flatMap((R) => R.agents.map((a) => `| ${R.condition} | ${a.role} | ${a.lane} | ${a.kind} | ${a.seconds}s | $${a.costUsd.toFixed(2)} | ${Math.round((a.inTokens + a.outTokens) / 1000)}k | ${a.error ?? ""} |`));
  return `# Benchmark ${new Date().toISOString().slice(0, 16).replace("T", " ")}${DRY ? " (dry run)" : ""}

Model: ${MODEL} (Claude lanes)${CODEX_LANE === "none" ? "" : `, Codex for the "${CODEX_LANE}" lane`}. Budget cap per Claude agent: $${BUDGET}.

| Condition | Conflicts merging into main | Merges that broke tests | Repair commits | Final tests pass | Claude cost | Tokens | Agent runs |
|---|---|---|---|---|---|---|---|
${rows.join("\n")}

${results.map((R) => R.condition === "fanout" ? `fanout: rehearsals ${R.rehearsals.length}, files reverted for leaving their lane: ${R.blockedFiles.length ? R.blockedFiles.join("; ") : "none"}${R.error ? `. Error: ${R.error}` : ""}` : "").filter(Boolean).join("\n")}

| Condition | Role | Lane | Agent | Time | Cost | Tokens | Error |
|---|---|---|---|---|---|---|---|
${agents.join("\n")}
`;
}

const results = [];
if (MODE !== "fanout") results.push(await baseline());
if (MODE !== "baseline") results.push(await fanout());
const md = report(results);
const out = join(ROOT, "bench", "results");
mkdirSync(out, { recursive: true });
const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
writeFileSync(join(out, `${stamp}${DRY ? "-dry" : ""}.md`), md);
writeFileSync(join(out, `${stamp}${DRY ? "-dry" : ""}.json`), JSON.stringify(results, null, 2));
console.log(md);
