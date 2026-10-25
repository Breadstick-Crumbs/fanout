#!/usr/bin/env node
// Benchmark: the same tasks (bench/<fixture>/TASKS.md, one "## name" per task), done three ways.
//   single:   one agent does all four tasks, one after another. The "why parallel at all?" baseline.
//   baseline: four parallel agents on plain worktrees, then merge, then one integrator agent cleans up.
//   fanout:   a coordinator agent plans and writes contracts with the fanout skill, lanes are
//             guarded, rehearse finds breaks and the lane that caused one fixes it, then merge.
// The "receipt" lane runs in Codex, the rest in Claude Code, in both conditions.
//
// Fixtures: shop (4 small tasks), library (6 bigger ones) and sheet (6 large ones, minutes each). If bench/<fixture>-acceptance/ exists, its hidden
// tests are copied in at the end and scored, so every setup is judged the same way.
//   node bench/run.mjs [single|baseline|fanout|both|all] [--fixture shop|library|sheet] [--groups a+b,c+d] [--lean] [--draft [--max-sessions 4] [--review]] [--single-budget 5] [--dry]   (both = baseline + fanout; all adds single) [--model sonnet] [--budget 1] [--codex-lane receipt[,csv]|none] [--mix]
// --dry swaps every agent for a no-op (the coordinator writes a canned plan) to test the plumbing.
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { scrub } from "./scrub.mjs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parsePlan, parseRegen, planSetting, blockReason } from "../skills/fanout/fanout.mjs";
import { runAgent, staggered, plannerPrompt, contractsPrompt, contractsReady, bringIn, brief as laneBrief, signInProblem, mixAgents, readyTracker, earlyTest } from "../skills/fanout/run.mjs";
import { failureLines } from "../skills/fanout/fanout.mjs";
import { draftPlan } from "../skills/fanout/draft.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FANOUT = join(ROOT, "skills", "fanout", "fanout.mjs");
const argv = process.argv.slice(2);
const opt = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };
const MODE = argv[0] && !argv[0].startsWith("--") ? argv[0] : "both";
const DRY = argv.includes("--dry");
// --vague: the planner gets a one-line goal and picks the split itself; sessions read TASKS.md from the repo.
const VAGUE = argv.includes("--vague");
// --lean: fanout lanes get fanout run's short-tests brief (fanout run's default; the benchmark's default stays full).
const LEAN = argv.includes("--lean");
const DRAFT = argv.includes("--draft"), REVIEW = argv.includes("--review"), MAX_SESSIONS = Number(opt("--max-sessions", "4"));
const VAGUE_GOAL = "Add the features described in TASKS.md to this library. Split the work however you think best.";
const MODEL = opt("--model", "sonnet"), BUDGET = opt("--budget", "1"), SINGLE_BUDGET = opt("--single-budget", "5");
// The planner (fanout's coordinator) and the parallel session agents can run on other models than --model,
// which the single agent and the integrator use.
const PLANNER_MODEL = opt("--planner-model", MODEL), SESSION_MODEL = opt("--session-model", MODEL);
const modelForRole = (role) => (role === "coordinator" ? PLANNER_MODEL : role === "lane" || role === "fix" ? SESSION_MODEL : MODEL);
const FIXTURE = opt("--fixture", "shop"), FIXTURE_DIR = join(ROOT, "bench", FIXTURE), ACCEPTANCE = join(ROOT, "bench", `${FIXTURE}-acceptance`);
const TASKS_MD = readFileSync(join(FIXTURE_DIR, "TASKS.md"), "utf8");
const CODEX_LANE = opt("--codex-lane", "none"), CODEX_LANES = CODEX_LANE.split(","); // lane name(s), comma-separated, to run in Codex
// --mix: as fanout run --mix, the fanout lanes others build on run in Claude, the rest in Codex (set once the plan is known).
const MIX = argv.includes("--mix");
const TASKS = Object.fromEntries(TASKS_MD.split(/^## /m).slice(1)
  .map((b) => { const [name, ...rest] = b.split("\n"); return [name.trim(), rest.join("\n").trim()]; }));
const LANES = Object.keys(TASKS);
// --groups "formula+csv,recalc+table": parallel setups run one lane per group (named formula-csv, ...) instead of one per task.
const GROUPS = opt("--groups", null)?.split(",").map((g) => g.split("+"));
if (GROUPS) {
  for (const g of GROUPS) TASKS[g.join("-")] = g.map((t) => `### ${t}\n${TASKS[t]}`).join("\n\n");
  LANES.splice(0, LANES.length, ...GROUPS.map((g) => g.join("-")));
}
const membersOf = (l) => GROUPS?.find((g) => g.join("-") === l) ?? [l];
// The fixture-wide notes above the first task go into every brief.
const PREAMBLE = TASKS_MD.split(/^## /m)[0].replace(/^#.*$/m, "").trim();

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
  const kind = CODEX_LANES.includes(lane) && role !== "coordinator" && role !== "integrator" ? "codex" : "claude";
  if (DRY) { dryAction?.(); return { role, lane, kind, seconds: 0, costUsd: 0, inTokens: 0, outTokens: 0, error: null }; }
  const r = await runAgent({ agent: kind, cwd, prompt, plugin, allowGit, model: kind === "claude" ? modelForRole(role) : undefined, budget: kind !== "claude" ? undefined : role === "single" ? SINGLE_BUDGET : BUDGET });
  return { role, lane, kind, ...r };
}

function setup(name) {
  const dir = mkdtempSync(join(tmpdir(), `fanout-bench-${name}-`));
  const repo = join(dir, "repo");
  cpSync(FIXTURE_DIR, repo, { recursive: true });
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
  R.agents.push(...await staggered(LANES, (l) => agent({ lane: l, role: "lane", cwd: wts[l],
    prompt: `${PREAMBLE}\n\n${TASKS[l]}\n\n${COMMON}` })));
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
    const prompt = `${LANES.length} branches (${LANES.map((l) => "lane/" + l).join(", ")}) were built in parallel and are being integrated into main.\n` +
      (R.conflicts.length ? `These did not merge cleanly and are not merged yet: ${R.conflicts.map((l) => "lane/" + l).join(", ")}.\n` : "") +
      (t.ok ? "" : `npm test currently fails on main:\n${tail(t.out)}\n`) +
      `Merge whatever isn't merged, resolve conflicts, and make main work with all ${LANES.length} features and npm test passing. src/index.mjs is generated by \`npm run gen\`. Commit your work on main.`;
    R.agents.push(await agent({ lane: "-", role: "integrator", cwd: repo, prompt, allowGit: true }));
    commitAll(repo, "integrator leftovers");
  }
  R.repairCommits = Number(git(repo, "rev-list", "--count", `${before}..HEAD`).out.trim()) || 0;
  R.finalTestsPass = npmTest(repo).ok; R.repo = repo; // scored, then dropped before saving

  return R;
}

// ---------- single agent ----------
async function single() {
  const { repo } = setup("single");
  const R = { condition: "single", agents: [], conflicts: [], brokeAfter: [], repairCommits: 0 };
  log("single: repo", repo);
  R.agents.push(await agent({ lane: "-", role: "single", cwd: repo, prompt: `Do all of these tasks in this codebase.

${TASKS_MD}

${COMMON}` }));
  commitAll(repo, "single agent");
  R.finalTestsPass = npmTest(repo).ok; R.repo = repo; // scored, then dropped before saving
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
  // The same planner prompt `fanout run` uses; the benchmark only pins the session names to its tasks.
  // --draft: fanout run's path for a goal in sections: the plan is drafted without AI, an agent reviews it and
  // writes the contracts, and the test runs on main before the lanes start (one retry with the failure).
  let specs = null;
  if (DRAFT) {
    const d = draftPlan({ goal: TASKS_MD, root: repo, maxSessions: MAX_SESSIONS });
    if (!d) { R.error = "no draft"; return R; }
    mkdirSync(join(repo, ".fanout"), { recursive: true });
    writeFileSync(join(repo, ".fanout/plan.md"), d.text);
    specs = d.specs;
    // As fanout run: an agent only for flagged names and contracts, or the whole plan with --review.
    R.flags = d.flags;
    const prompt = contractsPrompt({ goal: TASKS_MD, base: "main", plan: d.text, maxSessions: MAX_SESSIONS, flags: d.flags, full: REVIEW });
    let retry = "";
    for (let i = 0; i < (REVIEW || d.flags.length || d.contracts ? 2 : 0); i++) {
      const a = await agent({ lane: "-", role: "coordinator", cwd: repo, prompt: prompt + retry, plugin: true });
      R.agents.push(a);
      // A failed coordinator (signed out, budget) leaves no contracts: the score after it would mean nothing.
      if (a.error) { R.error = `coordinator failed: ${a.error}`; return R; }
      const t = contractsReady(repo, readFileSync(join(repo, ".fanout/plan.md"), "utf8"));
      if (t.ok) break;
      retry = `\n\nAfter your changes, the tests fail on main:\n${tail(t.out)}\nFix it.`;
    }
  }
  const coord = DRAFT ? null : VAGUE ? plannerPrompt({ goal: VAGUE_GOAL, base: "main", root: repo })
    : plannerPrompt({ goal: TASKS_MD, base: "main", root: repo, extra: GROUPS ? `\nUse exactly ${LANES.length} sessions, each doing the tasks it is named after: ${LANES.join(", ")}.\n` : `\nUse exactly one session per task, named ${LANES.join(", ")}.\n` });
  if (coord) {
    const a = await agent({ lane: "-", role: "coordinator", cwd: repo, prompt: coord, plugin: true, allowGit: true,
      dryAction: () => { mkdirSync(join(repo, ".fanout"), { recursive: true }); writeFileSync(join(repo, ".fanout/plan.md"), FIXTURE === "shop" ? CANNED_PLAN : `test: npm test\n\n${LANES.map((l) => `## ${l}\nowns: ${membersOf(l).map((m) => `src/${m}.mjs, test/${m}.test.mjs`).join(", ")}\ntask: ${l}\n`).join("\n")}`); } });
    R.agents.push(a);
    if (a.error) { R.error = `coordinator failed: ${a.error}`; return R; }
  }
  commitAll(repo, "coordinator leftovers");
  const planPath = join(repo, ".fanout/plan.md");
  if (!existsSync(planPath)) { R.error = "coordinator wrote no plan"; return R; }
  const text = readFileSync(planPath, "utf8"), sessions = parsePlan(text), regen = parseRegen(text);
  R.plan = text;
  const chk = run(process.execPath, [FANOUT, "check"], repo);
  if (!chk.ok || (!VAGUE && !DRAFT && LANES.some((l) => !sessions.find((s) => s.name === l)))) { R.error = "plan invalid: " + tail(chk.out); return R; }
  const order = chk.out.match(/Merge order: (.*)/)[1].trim().split(" -> ");
  const names = VAGUE || DRAFT ? sessions.map((s) => s.name) : LANES;
  const wts = Object.fromEntries(names.map((l) => [l, join(dir, l)]));
  for (const l of names) git(repo, "worktree", "add", "-q", "-b", `fanout/${l}`, wts[l], "main");
  // The same brief `fanout run` gives, with the full task spec appended (the plan's task: line is one line).
  const brief = (s) => laneBrief(s, sessions, regen, planSetting(text, "test"), (specs?.[s.name] ? `\nFull spec for this session:\n${specs[s.name]}` : VAGUE ? "\nThe full spec is in TASKS.md: read the parts your task covers." : `\nFull task spec:\n${PREAMBLE}\n\n${TASKS[s.name]}`), repo, { shortTests: LEAN });
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
  if (MIX) { const m = mixAgents(sessions); CODEX_LANES.splice(0, CODEX_LANES.length, ...names.filter((l) => m[l] === "codex")); R.mix = m; log(`fanout: --mix: ${names.map((l) => `${l} ${m[l]}`).join(", ")}`); }
  // As fanout run: each lane is committed as it finishes, and a lane that builds on others is tested against
  // them as soon as they and it are done (earlyTest); a failure goes straight back to it, before rehearse.
  const tracker = readyTracker(sessions), rounds = [];
  R.earlyTests = [];
  const earlyRound = async (s) => {
    const e = earlyTest(wts[s.name], order, s.name, regen, planSetting(text, "test"));
    if (!e) return;
    R.earlyTests.push(`${s.name} with ${e.merged.join(", ")}: ${e.ok ? "pass" : "fail"}`);
    log(`fanout: early test ${s.name} with ${e.merged.join(", ")}: ${e.ok ? "pass" : "fail"}`);
    if (e.ok) return;
    R.agents.push(await agent({ lane: s.name, role: "fix", cwd: wts[s.name], prompt: `${brief(s)}\n\nYour work was committed. ${e.merged.join(", ")} finished too and ${e.merged.length > 1 ? "are" : "is"} now merged into your branch, and \`${planSetting(text, "test")}\` fails there:\n${failureLines(e.out)}\n\nTheir real code is in your checkout: fix the break within the files you may change.` }));
    if (commitLane(s.name).ok) R.repairCommits++;
  };
  const startRounds = (ready) => ready.forEach((s) => rounds.push(earlyRound(s).catch((e) => log(`fanout: early test ${s.name} failed to run: ${e.message}`)).then(() => startRounds(tracker.settle(s.name)))));
  R.agents.push(...await staggered(names, async (l) => {
    const a = await agent({ lane: l, role: "lane", cwd: wts[l], prompt: brief(sessions.find((s) => s.name === l)) });
    commitLane(l);
    if (!a.error) startRounds(tracker.done(l));
    return a;
  }));
  for (let i = 0; i < rounds.length; i++) await rounds[i];
  for (let round = 0; round < 3; round++) {
    const r = run(process.execPath, [FANOUT, "rehearse"], repo);
    R.rehearsals.push(tail(r.out, 3));
    log(`fanout: rehearse #${round + 1}: ${r.ok ? "pass" : r.out.split("\n").find((x) => /^(BROKE|CONFLICT|REGEN FAILED)/.test(x))}`);
    if (r.ok) break;
    const line = r.out.split("\n").find((x) => /^(BROKE after|CONFLICT merging|REGEN FAILED after) /.test(x));
    const l = line?.match(/(?:after|merging) ([\w-]+)/)?.[1];
    if (!l || !wts[l]) break;
    // As fanout run: the branches merged ahead of the lane are merged into it first, so it fixes against their real code.
    const { merged } = bringIn(wts[l], order, l, regen);
    R.broughtIn = [...(R.broughtIn ?? []), ...merged.map((m) => `${m} -> ${l}`)];
    const brought = merged.length ? `\n\n${merged.join(", ")} ${merged.length > 1 ? "are" : "is"} now merged into your branch, so their real code is in your checkout: run the tests there to see the break.` : "";
    R.agents.push(await agent({ lane: l, role: "fix", cwd: wts[l], prompt: `${brief(sessions.find((s) => s.name === l))}\n\nYour branch was merged with the others in the plan's order and it broke:\n${r.out.trimEnd()}${brought}\n\nFix it within the files you may edit.` }));
    if (commitLane(l).ok) R.repairCommits++;
  }
  for (const l of order) {
    const m = git(repo, "merge", "--no-ff", "--no-edit", `fanout/${l}`);
    if (!m.ok) { R.conflicts.push(l); git(repo, "merge", "--abort"); continue; }
    for (const g of regen) run(g.cmd.split(" ")[0] === "node" ? process.execPath : g.cmd.split(" ")[0], g.cmd.split(" ").slice(1), repo);
    commitAll(repo, "regen");
    if (!npmTest(repo).ok) R.brokeAfter.push(l);
  }
  R.finalTestsPass = npmTest(repo).ok; R.repo = repo; // scored, then dropped before saving

  return R;
}

// ---------- report ----------
const sum = (R, k) => R.agents.reduce((a, x) => a + (x[k] || 0), 0);
const usd = (v) => (v == null ? "?" : `$${v.toFixed(2)}`);
const costOf = (R) => `${usd(sum(R, "costUsd"))}${R.agents.some((a) => a.costUsd == null) ? " + ?" : ""}`;
const wall = (s) => (s == null ? "" : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`);
function report(results) {
  const rows = results.map((R) => `| ${R.condition} | ${R.conflicts.length ? R.conflicts.join(", ") : "none"} | ${R.brokeAfter.length ? R.brokeAfter.join(", ") : "none"} | ${R.repairCommits} | ${R.finalTestsPass ? "yes" : "**no**"} | ${R.acceptance ? `${R.acceptance.pass}/${R.acceptance.total}` : "-"} | ${wall(R.seconds)} | ${costOf(R)} | ${Math.round((sum(R, "inTokens") + sum(R, "outTokens")) / 1000)}k | ${R.agents.length} |`);
  const toolsOf = (a) => Object.entries(a.tools ?? {}).map(([k, v]) => `${k} ${v.length}`).join(", ");
  const agents = results.flatMap((R) => R.agents.map((a) => `| ${R.condition} | ${a.role} | ${a.lane} | ${a.kind} | ${a.seconds}s | ${a.modelSeconds ?? "?"}s | ${a.turns ?? "?"} | ${toolsOf(a)} | ${usd(a.costUsd)} | ${Math.round((a.inTokens + a.outTokens) / 1000)}k | ${a.error ?? ""} |`));
  return `# Benchmark ${new Date().toISOString().slice(0, 16).replace("T", " ")}${DRY ? " (dry run)" : ""}

Models: ${MODEL} (single agent, integrator), planner ${PLANNER_MODEL}, sessions ${SESSION_MODEL}${MIX ? `, --mix (Codex for ${CODEX_LANES.map((l) => `"${l}"`).join(", ") || "none"})` : CODEX_LANE === "none" ? "" : `, Codex for ${CODEX_LANES.map((l) => `"${l}"`).join(", ")}`}. Fixture: ${FIXTURE}${VAGUE ? " (vague goal: the planner picks the split)" : ""}${GROUPS ? `, lanes ${LANES.join(", ")}` : ""}${LEAN ? ", lean lanes (at most 3 tests each)" : ""}${DRAFT ? `, plan drafted without AI${REVIEW ? " (full review)" : ""}` : ""}. Budget cap per Claude agent: ${BUDGET} (single agent: ${SINGLE_BUDGET}).

| Condition | Conflicts merging into main | Merges that broke tests | Repair commits | Final tests pass | Hidden tests | Wall time | Agent cost | Tokens | Agent runs |
|---|---|---|---|---|---|---|---|---|---|
${rows.join("\n")}

${results.map((R) => R.condition === "fanout" ? `fanout: rehearsals ${R.rehearsals.length}, early tests: ${R.earlyTests?.length ? R.earlyTests.join("; ") : "none"}, files reverted for leaving their lane: ${R.blockedFiles.length ? R.blockedFiles.join("; ") : "none"}${R.error ? `. Error: ${R.error}` : ""}` : "").filter(Boolean).join("\n")}

| Condition | Role | Lane | Agent | Time | Model time | Turns | Tools | Cost | Tokens | Error |
|---|---|---|---|---|---|---|---|---|---|---|
${agents.join("\n")}
`;
}

const results = [];
function acceptance(repo) {
  if (!repo || !existsSync(ACCEPTANCE)) return null;
  cpSync(ACCEPTANCE, join(repo, "acceptance"), { recursive: true });
  const out = run(process.execPath, ["--test", "acceptance/*.test.mjs"], repo).out;
  const n = (k) => Number(out.match(new RegExp(`^# ${k} (\\d+)`, "m"))?.[1] ?? 0);
  // A file whose imports fail counts as one test, so the total comes from the test files themselves.
  const total = readdirSync(ACCEPTANCE).filter((f) => f.endsWith(".test.mjs")).reduce((t, f) => t + (readFileSync(join(ACCEPTANCE, f), "utf8").match(/^test\(/gm) ?? []).length, 0);
  return { pass: n("pass"), total, failed: [...out.matchAll(/^not ok \d+ - (.*)$/gm)].map((m) => m[1]).filter((t) => !t.includes(".test.mjs")) };
}
const timed = async (fn) => { const t0 = Date.now(), R = await fn(); R.seconds = Math.round((Date.now() - t0) / 1000); R.acceptance = acceptance(R.repo); delete R.repo; results.push(R); };
const want = { single: ["single"], baseline: ["baseline"], fanout: ["fanout"], both: ["baseline", "fanout"], all: ["single", "baseline", "fanout"] }[MODE];
if (!want) { console.error("usage: node bench/run.mjs [single|baseline|fanout|both|all] [--dry] ..."); process.exit(2); }
const signIn = DRY ? null : signInProblem(["claude", ...(MIX || CODEX_LANE !== "none" ? ["codex"] : [])]);
if (signIn) { console.error(`bench: ${signIn}`); process.exit(2); }
for (const c of want) await timed({ single, baseline, fanout }[c]);
const md = report(results);
const out = join(ROOT, "bench", "results");
mkdirSync(out, { recursive: true });
// Results are committed: local paths in agents' commands are scrubbed first (bench/scrub.mjs).
const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
writeFileSync(join(out, `${stamp}${DRY ? "-dry" : ""}.md`), scrub(md));
writeFileSync(join(out, `${stamp}${DRY ? "-dry" : ""}.json`), scrub(JSON.stringify(results, null, 2)));
console.log(md);
