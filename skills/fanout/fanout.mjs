#!/usr/bin/env node
// fanout: plan parallel sessions, check for overlap, verify branches, guard edits.
//   fanout check  [plan.md]                         plan defaults to .fanout/plan.md in the main checkout
//   fanout verify [--session name] [--base main]    session defaults to the fanout/<name> branch
//   fanout rehearse [plan.md] [--base main] [--test cmd]   merge every branch in order on a scratch worktree, test once (bisect on failure)
//   fanout guard                                    PreToolUse hook (installed by the plugin)
//   fanout install-git-hook [--force]               same rules as a git pre-commit hook, for agents outside Claude Code
//   fanout run ["goal"] [--yes] [--agent claude|codex|"<cmd>"]   do the whole fan-out: plan, agents, rehearse, fix, merge (see run.mjs)
//   fanout status [--base main]                     one table: each session's branch, commits, files, worktree, verify flags, last run and rehearse
//   fanout log [--last 20]                          past runs and rehearsals from .fanout/log.jsonl: time, cost, fixes, test runs
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, chmodSync, existsSync, realpathSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { resolve, relative, isAbsolute, join, dirname } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const SESSION_KEYS = ["owns", "after", "exposes", "uses", "done", "task", "agent", "model"];
const PLAN_KEYS = ["test", "regen"];

export function parsePlan(text) {
  const sessions = [];
  for (const block of text.split(/^## /m).slice(1)) {
    const [name, ...rest] = block.split("\n");
    const get = (k) => (rest.find((l) => l.startsWith(k + ":")) ?? "").slice(k.length + 1).trim();
    const list = (k) => get(k).split(",").map((s) => s.trim()).filter(Boolean);
    const keys = rest.map((l) => l.match(/^([A-Za-z_-]+):/)?.[1]).filter(Boolean);
    sessions.push({ name: name.trim(), owns: list("owns"), after: list("after"), exposes: list("exposes"), uses: list("uses"),
      task: get("task"), done: get("done"), agent: get("agent"), model: get("model"), keys });
  }
  return sessions;
}

// Plan-wide settings sit above the first "## " block, e.g. "test: npm test".
export const planSetting = (text, key) =>
  (text.split(/^## /m)[0].split("\n").find((l) => l.startsWith(key + ":")) ?? "").slice(key.length + 1).trim();

// "regen: src/gen/**, api.d.ts via npm run codegen" (any number of lines above the first "## "):
// generated files no session owns or commits; the command rebuilds them after merging.
export const parseRegen = (text) => text.split(/^## /m)[0].split("\n").filter((l) => l.startsWith("regen:")).map((l) => {
  const [paths, cmd = ""] = l.slice(6).split(/\s+via\s+/);
  return { paths: paths.split(",").map((x) => x.trim()).filter(Boolean), cmd: cmd.trim() };
});

const norm = (p) => p.replaceAll("\\", "/").replace(/^\.\//, "");

// Glob to regex: ** = any depth, * = within a segment, ? = one char, {a,b} = alternatives.
export function globToRegex(glob) {
  const g = norm(glob);
  let re = "", i = 0, brace = 0;
  while (i < g.length) {
    const c = g[i];
    if (c === "*") {
      if (g[i + 1] === "*") {
        i += 2;
        if (g[i] === "/") { re += "(?:.*/)?"; i++; } else re += ".*";
        continue;
      }
      re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else if (c === "{") { re += "(?:"; brace++; }
    else if (c === "}" && brace) { re += ")"; brace--; }
    else if (c === "," && brace) re += "|";
    else re += c.replace(/[.+^$()|[\]\\]/g, "\\$&");
    i++;
  }
  return new RegExp("^" + re + "$");
}

export const matches = (glob, path) => {
  const g = norm(glob);
  // A trailing slash means "everything under this directory".
  if (g.endsWith("/")) return norm(path).startsWith(g);
  return globToRegex(g).test(norm(path));
};
export const ownsFile = (session, path) => session.owns.some((g) => matches(g, path));
// Contracts: files a session exposes to others. They are committed to main before the
// sessions start and stay frozen on every fanout branch, the owner's included.
const exposes = (session, path) => (session.exposes ?? []).some((g) => g === path || matches(g, path));
export const contractOwner = (sessions, path) => sessions.find((s) => exposes(s, path));
export const contractChanges = (sessions, changed) => changed.filter((f) => contractOwner(sessions, f));
export const regenFor = (regen, path) => regen.find((r) => r.paths.some((g) => matches(g, path)));

// Why this session may not change rel, or null if it may. Shared by the edit guard and the git hook.
export function blockReason(sessions, s, regen, rel) {
  const owner = contractOwner(sessions, rel);
  if (owner && owner.name !== s.name) return `${rel} is a contract (exposed by "${owner.name}") and is frozen for every other session. Ask the coordinator to change the plan, or ask "${owner.name}" to evolve it.`;
  const r = regenFor(regen, rel);
  if (r) return `${rel} is generated (\`${r.cmd}\` rebuilds it after merging). Change its source instead, and don't commit it.`;
  if (ownsFile(s, rel)) return null;
  return `session "${s.name}" does not own ${rel}. Owned: ${s.owns.join(", ")}. Ask the coordinator to change the plan.`;
}

const isGlob = (s) => /[*?{]/.test(s);
const prefix = (g) => norm(g).split(/[*?{]/)[0];
const prefixClash = (a, b) => {
  const pa = prefix(a), pb = prefix(b);
  return pa === pb || (isGlob(a) && pb.startsWith(pa)) || (isGlob(b) && pa.startsWith(pb));
};

function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
}
function repoFiles(cwd) {
  try { return git(["ls-files", "--cached", "--others", "--exclude-standard"], cwd).split("\n").filter(Boolean); }
  catch { return null; }
}

// With a git repo, two patterns clash only if a real file matches both, or if one
// of them names paths that don't exist yet and the prefixes overlap.
// Without a repo, falls back to comparing the literal prefixes.
// Returns null for no overlap, else a detail string ("" when there is nothing to add).
function overlap(a, b, files) {
  if (!files) return prefixClash(a, b) ? "" : null;
  const shared = files.filter((f) => matches(a, f) && matches(b, f));
  if (shared.length) return `: ${shared.slice(0, 3).join(", ")}${shared.length > 3 ? ` +${shared.length - 3} more` : ""}`;
  const ma = files.some((f) => matches(a, f)), mb = files.some((f) => matches(b, f));
  return (!ma || !mb) && prefixClash(a, b) ? ": new paths may overlap" : null;
}

export function check(sessions, cwd, regen = []) {
  const problems = [];
  const files = cwd ? repoFiles(cwd) : null;
  for (let i = 0; i < sessions.length; i++)
    for (let j = i + 1; j < sessions.length; j++)
      for (const a of sessions[i].owns) for (const b of sessions[j].owns) {
        const o = overlap(a, b, files);
        if (o !== null) problems.push(`CLASH ${sessions[i].name} (${a}) <-> ${sessions[j].name} (${b})${o}`);
      }
  for (const r of regen) {
    if (!r.cmd) problems.push(`REGEN ${r.paths.join(", ")}: no command (write "regen: <paths> via <command>")`);
    for (const g of r.paths) for (const s of sessions) for (const a of s.owns) {
      const o = overlap(g, a, files);
      if (o !== null) problems.push(`REGEN ${g} is generated but ${s.name} owns ${a}${o}`);
    }
  }
  // A session that uses a contract merges after the session exposing it.
  const deps = new Map(sessions.map((s) => [s.name, [...s.after]]));
  for (const s of sessions) {
    if (!s.owns.length) problems.push(`PLAN ${s.name} has no owns: line`);
    for (const k of s.keys ?? []) {
      if (PLAN_KEYS.includes(k)) problems.push(`PLAN ${k}: goes above the first "##" line, once for the whole plan, not inside ${s.name}`);
      else if (!SESSION_KEYS.includes(k)) problems.push(`PLAN unknown field "${k}:" in ${s.name} (known: ${SESSION_KEYS.join(", ")})`);
    }
    for (const e of s.exposes ?? [])
      if (!ownsFile(s, e)) problems.push(`EXPOSES ${e} (in ${s.name}): not in its owns`);
    for (const u of s.uses ?? []) {
      const owner = contractOwner(sessions.filter((x) => x !== s), u);
      if (!owner) { problems.push(`USES ${u} (in ${s.name}): no other session exposes it`); continue; }
      if (!deps.get(s.name).includes(owner.name)) deps.get(s.name).push(owner.name);
    }
  }
  const order = [], seen = new Set();
  const visit = (s, stack = []) => {
    if (seen.has(s.name)) return;
    if (stack.includes(s.name)) { problems.push("CYCLE in after/uses: " + [...stack, s.name].join(" -> ")); return; }
    for (const d of deps.get(s.name)) {
      const t = sessions.find((x) => x.name === d);
      if (t) visit(t, [...stack, s.name]); else problems.push(`UNKNOWN after: ${d} (in ${s.name})`);
    }
    seen.add(s.name); order.push(s.name);
  };
  sessions.forEach((s) => visit(s));
  return { problems, order };
}

export const verify = (session, changed) => changed.filter((f) => !ownsFile(session, f));

const arg = (argv, flag, dflt) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : dflt; };

// Sessions work on branch fanout/<name>; the plan lives in the main checkout at .fanout/plan.md.
// Both can be found from inside any worktree, so nothing needs configuring.
const BRANCH_PREFIX = "fanout/";
function currentSession(cwd) {
  try {
    const b = git(["branch", "--show-current"], cwd).trim();
    return b.startsWith(BRANCH_PREFIX) ? b.slice(BRANCH_PREFIX.length) : null;
  } catch { return null; }
}
export function mainRoot(cwd) {
  try { return resolve(git(["rev-parse", "--path-format=absolute", "--git-common-dir"], cwd).trim(), ".."); }
  catch { return cwd; }
}
const defaultPlan = (cwd) => resolve(mainRoot(cwd), ".fanout", "plan.md");

// Merges the branches in plan order on a throwaway worktree, then rebuilds generated files and runs the
// test command once. Only if that fails does it bisect over the merge order (about log2(n) more runs)
// to name the branch whose merge broke things, so a passing rehearsal costs one test run, not n.
// The worktree sits in .fanout/ inside the main checkout so node_modules etc. still resolve.
// Output is a few lines plus the tail of a failing run: cheap for an agent to read and act on.
export function rehearse(order, { cwd, base = "main", test, regen = [], tail = 20 }) {
  const log = [], root = mainRoot(cwd), wt = join(root, ".fanout", "rehearse");
  let testRuns = 0;
  const sh = (cmd) => { if (cmd === test) testRuns++; return spawnSync(cmd, { cwd: wt, shell: true, encoding: "utf8" }); };
  const tailOf = (r) => `${r.stdout ?? ""}${r.stderr ?? ""}`.trimEnd().split("\n").slice(-tail).join("\n");
  const g = (...a) => execFileSync("git", ["-c", "user.name=fanout", "-c", "user.email=fanout@local", ...a],
    { cwd: wt, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const drop = () => { try { git(["worktree", "remove", "--force", wt], root); } catch { /* not there */ } };
  drop();
  git(["worktree", "add", "--detach", wt, base], root);
  let ok = true;
  try {
    const merged = [[base, g("rev-parse", "HEAD").trim()]]; // [name, commit]: merged[k] = state after k merges
    for (const name of order) {
      const branch = BRANCH_PREFIX + name;
      try { git(["rev-parse", "--verify", "--quiet", branch], root); }
      catch { log.push(`SKIP ${name}: no branch ${branch}`); continue; }
      try { g("merge", "--no-ff", "--no-edit", branch); }
      catch {
        const files = g("diff", "--name-only", "--diff-filter=U").split("\n").filter(Boolean);
        log.push(`CONFLICT merging ${name}: ${files.join(", ")}`);
        ok = false; break;
      }
      merged.push([name, g("rev-parse", "HEAD").trim()]);
    }
    // State after the first k merges: rebuild generated files (as the real merge will), then test.
    const probe = (k) => {
      g("reset", "-q", "--hard", merged[k][1]); g("clean", "-fdq");
      for (const x of regen.filter((x) => x.cmd)) {
        const r = sh(x.cmd);
        if (r.status !== 0) return { pass: false, lines: [`REGEN FAILED after ${merged[k][0]}: \`${x.cmd}\` exited ${r.status}`, tailOf(r)] };
      }
      if (!test) return { pass: true };
      const r = sh(test);
      return { pass: r.status === 0, lines: [`BROKE after ${merged[k][0]}: \`${test}\` exited ${r.status}`, tailOf(r)] };
    };
    const n = merged.length - 1;
    if (ok && n) {
      const full = probe(n);
      if (full.pass) log.push(...(test ? [`OK after ${merged[n][0]} (all ${n} merged)`] : merged.slice(1).map(([name]) => `MERGED ${name}`)));
      else {
        // Invariant: state lo passes (the base is assumed to until checked below), state hi fails.
        let lo = 0, hi = n, bad = full;
        while (hi - lo > 1) {
          const mid = (lo + hi) >> 1, r = probe(mid);
          if (r.pass) { lo = mid; log.push(`OK after ${merged[mid][0]}`); } else { hi = mid; bad = r; }
        }
        // Before blaming a branch: the same code failing again rules out a flaky test, and when the
        // first branch is blamed, the base itself must pass. Each costs a run only on this failure path.
        const baseRun = () => (hi === 1 ? probe(0) : { pass: true });
        let b;
        if (probe(hi).pass) {
          log.push(`FLAKY: \`${test}\` failed, then passed on a rerun of the same code (after ${merged[hi][0]}). No branch is blamed; fix or quarantine the flaky test.`, bad.lines[1]);
        } else if (!(b = baseRun()).pass) {
          log.push(`BASE FAILS: \`${test}\` already fails on ${base} before any branch is merged. Fix ${base} first.`, b.lines[1]);
        } else log.push(...bad.lines);
        ok = false;
      }
    }
  } finally { drop(); }
  if (ok) log.push(test ? "All branches merge and pass together." : "All branches merge cleanly (no test command: add `test:` to the plan).");
  return { ok, log, testRuns };
}

// Run log: one JSON line per fan-out or rehearsal in .fanout/log.jsonl (git-ignored, stays local),
// so real projects produce their own numbers: time, cost, fixes, test runs, result.
export function appendLog(cwd, rec) {
  try {
    const dir = join(mainRoot(cwd), ".fanout");
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, "log.jsonl"), JSON.stringify({ at: new Date().toISOString(), ...rec }) + "\n");
  } catch { /* logging must never break a run */ }
}

function showLog(cwd, limit = 20) {
  let lines = [];
  try { lines = readFileSync(join(mainRoot(cwd), ".fanout", "log.jsonl"), "utf8").split("\n").filter(Boolean); } catch { /* none yet */ }
  if (!lines.length) { console.log("No runs logged yet."); return 0; }
  const recs = lines.slice(-limit).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const mins = (s) => (s == null ? "" : s < 90 ? `${Math.round(s)}s` : `${(s / 60).toFixed(1)}m`);
  console.log("when              kind      sessions  time    fixes  test runs  cost     result");
  for (const r of recs) {
    const cost = r.costUsd == null ? "" : `$${r.costUsd.toFixed(2)}${r.costUnknown ? "+?" : ""}`;
    console.log([r.at.slice(0, 16).replace("T", " "), (r.kind ?? "").padEnd(8), String(r.sessions ?? "").padEnd(8),
      mins(r.seconds).padEnd(6), String(r.fixes ?? "").padEnd(5), String(r.testRuns ?? "").padEnd(9), cost.padEnd(7), r.result ?? ""].join("  "));
  }
  return 0;
}
// Reads only existing state (plan, branches, lanes, log); works from the main checkout or any lane worktree.
function showStatus(cwd, base) {
  const root = mainRoot(cwd);
  let text;
  try { text = readFileSync(join(root, ".fanout", "plan.md"), "utf8"); } catch { console.log("No plan"); return 0; }
  const sessions = parsePlan(text), regen = parseRegen(text);
  if (!sessions.length) { console.log("No plan"); return 0; }
  const rows = [["session", "branch", "ahead", "files", "worktree", "verify"]];
  for (const s of sessions) {
    const branch = BRANCH_PREFIX + s.name, lane = existsSync(join(root, ".fanout", "lanes", s.name)) ? "yes" : "no";
    try { git(["rev-parse", "--verify", "--quiet", "refs/heads/" + branch], root); }
    catch { rows.push([s.name, "not started", "-", "-", lane, "-"]); continue; }
    try {
      const ahead = git(["rev-list", "--count", `${base}..${branch}`], root).trim();
      const changed = git(["diff", "--name-only", `${base}...${branch}`], root).split("\n").filter(Boolean);
      const contracts = contractChanges(sessions, changed);
      const frozen = contracts.filter((f) => contractOwner(sessions, f).name !== s.name);
      const generated = changed.filter((f) => regenFor(regen, f));
      const out = verify(s, changed).filter((f) => !contracts.includes(f) && !generated.includes(f));
      const flags = [out.length && `out of lane ${out.length}`, frozen.length && `contract ${frozen.length}`, generated.length && `generated ${generated.length}`].filter(Boolean);
      rows.push([s.name, branch, ahead, String(changed.length), lane, flags.join(", ") || "ok"]);
    } catch { rows.push([s.name, branch, "?", "?", lane, `no base ${base}`]); }
  }
  const w = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length)));
  rows.forEach((r) => console.log(r.map((c, i) => c.padEnd(w[i])).join("  ").trimEnd()));
  let recs = [];
  try { recs = readFileSync(join(root, ".fanout", "log.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { /* none yet */ }
  for (const kind of ["run", "rehearse"]) {
    const r = recs.findLast((x) => x.kind === kind);
    console.log(`last ${kind}: ${r ? `${r.at.slice(0, 16).replace("T", " ")}  ${r.result ?? ""}` : "none"}`);
  }
  return 0;
}
const explicitPlan = (argv) => (argv[1] && !argv[1].startsWith("--") ? argv[1] : null);

function main(argv) {
  const cmd = argv[0];
  if (cmd === "guard") return guard(argv);
  if (cmd === "run") return import("./run.mjs").then((m) => m.cli(argv.slice(1)));
  const cwd = resolve(arg(argv, "--cwd", process.cwd()));
  if (cmd === "precommit") return precommit(cwd);
  if (cmd === "install-git-hook") return installHook(cwd, argv.includes("--force"));
  if (cmd === "status") return showStatus(cwd, arg(argv, "--base", "main"));
  if (cmd === "log") return showLog(cwd, Number(arg(argv, "--last", "20")));
  if (!["check", "verify", "rehearse"].includes(cmd)) { console.error("usage: fanout check [plan.md] | verify [--session name] [--base main] | rehearse [--base main] [--test cmd] | run [\"goal\"] [--yes] | status [--base main] | log [--last 20] | install-git-hook [--force] | guard"); return 2; }
  const planPath = explicitPlan(argv) ?? defaultPlan(cwd);
  let text;
  try { text = readFileSync(planPath, "utf8"); } catch { console.error(`No plan at ${planPath}`); return 2; }
  const sessions = parsePlan(text), regen = parseRegen(text);
  if (cmd === "check") {
    const { problems, order } = check(sessions, cwd, regen);
    problems.forEach((p) => console.log(p));
    if (!planSetting(text, "test")) console.log('NOTE no "test:" line above the first "##": rehearse can only check that branches merge, not that they work together.');
    console.log("Merge order:", order.join(" -> "));
    return problems.length ? 1 : 0;
  }
  if (cmd === "rehearse") {
    const { problems, order } = check(sessions, cwd, regen);
    if (problems.length) { problems.forEach((p) => console.log(p)); console.log("Fix the plan first (fanout check)."); return 1; }
    const t0 = Date.now();
    const { ok, log, testRuns } = rehearse(order, { cwd, base: arg(argv, "--base", "main"), test: arg(argv, "--test") ?? planSetting(text, "test"), regen });
    log.forEach((l) => console.log(l));
    appendLog(cwd, { kind: "rehearse", sessions: order.length, seconds: Math.round((Date.now() - t0) / 1000), testRuns,
      result: ok ? "pass" : (log.find((l) => /^(BROKE|CONFLICT|REGEN FAILED|FLAKY|BASE FAILS)/.test(l)) ?? "fail").split(":")[0] });
    return ok ? 0 : 1;
  }
  const name = arg(argv, "--session") ?? currentSession(cwd);
  const s = sessions.find((x) => x.name === name);
  if (!s) { console.error(`No session "${name}" in plan. Pass --session or run from a fanout/<name> branch.`); return 2; }
  const base = arg(argv, "--base", "main"), head = arg(argv, "--head", "HEAD");
  const changed = git(["diff", "--name-only", `${base}...${head}`], cwd).split("\n").filter(Boolean);
  const contracts = contractChanges(sessions, changed);
  const frozen = contracts.filter((f) => contractOwner(sessions, f).name !== name), evolved = contracts.filter((f) => !frozen.includes(f));
  const generated = changed.filter((f) => regenFor(regen, f));
  const out = verify(s, changed).filter((f) => !contracts.includes(f) && !generated.includes(f));
  out.forEach((f) => console.log(`OUT OF LANE ${name}: ${f}`));
  frozen.forEach((f) => console.log(`CONTRACT CHANGED ${name}: ${f} (exposed by ${contractOwner(sessions, f).name})`));
  evolved.forEach((f) => console.log(`NOTE ${name} changed its exposed file ${f}; sessions that use it should merge ${name} first and be told`));
  generated.forEach((f) => console.log(`GENERATED CHANGED ${name}: ${f} (rebuilt after merging; don't commit it)`));
  console.log(`${name}: ${changed.length} changed, ${out.length} outside its owns, ${frozen.length} contracts changed, ${generated.length} generated`);
  return out.length || frozen.length || generated.length ? 1 : 0;
}

// Files a tool call would write. Claude Code sends file_path / notebook_path; Codex sends
// apply_patch with the patch text in tool_input.command ("*** Update File: path" etc.).
export function editTargets(toolInput = {}) {
  const direct = toolInput.file_path ?? toolInput.notebook_path;
  if (direct) return [direct];
  const patch = typeof toolInput.command === "string" ? toolInput.command : typeof toolInput.input === "string" ? toolInput.input : "";
  return [...patch.matchAll(/^\*\*\* (?:(?:Add|Update|Delete) File|Move to): (.+)$/gm)].map((m) => m[1].trim());
}

// The plan and this checkout's session, or null when not on a fanout/<name> branch with a plan.
function loadSession(cwd) {
  const name = currentSession(cwd);
  if (!name) return null;
  let text;
  try { text = readFileSync(defaultPlan(cwd), "utf8"); } catch { return null; }
  const sessions = parsePlan(text), s = sessions.find((x) => x.name === name);
  return s ? { sessions, s, regen: parseRegen(text) } : null;
}

// PreToolUse hook (Claude Code and Codex): blocks file edits outside the session's owns, on contracts and on generated files.
// Active only on a fanout/<name> branch with a plan present, so it does nothing in normal work.
function guard() {
  let input = {};
  try { input = JSON.parse(readFileSync(0, "utf8")); } catch { return 0; }
  const targets = editTargets(input.tool_input);
  if (!targets.length) return 0;
  const cwd = input.cwd ?? process.cwd();
  // The session comes from the checkout the file is in, not the agent's cwd, so a subagent or
  // parallel session working from the main checkout is still held to its lane's plan.
  const why = targets.map((t) => {
    const abs = isAbsolute(t) ? t : resolve(cwd, t);
    let dir = dirname(abs);
    while (!existsSync(dir) && dirname(dir) !== dir) dir = dirname(dir);
    const ctx = loadSession(dir);
    if (!ctx) return null;
    let root = dir;
    try { root = git(["rev-parse", "--show-toplevel"], dir).trim(); } catch { /* not a repo */ }
    const rel = norm(relative(root, abs));
    if (rel.startsWith("..")) return null; // outside the repo: not our business
    return blockReason(ctx.sessions, ctx.s, ctx.regen, rel);
  }).filter(Boolean);
  why.forEach((w) => console.error("fanout: " + w));
  return why.length ? 2 : 0;
}

// git pre-commit hook: the same rules on staged files, so agents outside Claude Code are held to the plan too.
function precommit(cwd) {
  const ctx = loadSession(cwd);
  if (!ctx) return 0;
  const staged = git(["diff", "--cached", "--name-only"], cwd).split("\n").filter(Boolean);
  const why = staged.map((f) => blockReason(ctx.sessions, ctx.s, ctx.regen, f)).filter(Boolean);
  why.forEach((w) => console.error("fanout: " + w));
  return why.length ? 1 : 0;
}

const HOOK_MARK = "# fanout pre-commit";
function installHook(cwd, force) {
  let path;
  try { path = resolve(cwd, git(["rev-parse", "--git-path", "hooks/pre-commit"], cwd).trim()); }
  catch { console.error("Not a git repo."); return 2; }
  if (existsSync(path) && !readFileSync(path, "utf8").includes(HOOK_MARK) && !force) {
    console.error(`${path} already exists and isn't fanout's. Add "node <fanout.mjs> precommit" to it, or pass --force to replace it.`);
    return 1;
  }
  const script = norm(fileURLToPath(import.meta.url));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `#!/bin/sh
${HOOK_MARK}
case "$(git branch --show-current)" in fanout/*) ;; *) exit 0 ;; esac
script='${script}'
[ -f "$script" ] || { echo "fanout: $script is gone (plugin updated?). Run: node <new fanout.mjs> install-git-hook" >&2; exit 1; }
exec node "$script" precommit
`);
  chmodSync(path, 0o755);
  console.log(`Installed ${path}. Commits on fanout/* branches now follow the plan, whatever agent makes them.`);
  return 0;
}

// Run when executed directly, including through an npm/npx bin link (argv[1] is then the link).
const isMain = () => { try { return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch { return false; } };
if (isMain()) Promise.resolve(main(process.argv.slice(2))).then((code) => process.exit(code));
