#!/usr/bin/env node
// fanout: plan parallel sessions, check for overlap, verify branches, guard edits.
//   fanout check  [plan.md]                         plan defaults to .fanout/plan.md in the main checkout
//   fanout verify [--session name] [--base main]    session defaults to the fanout/<name> branch
//   fanout rehearse [plan.md] [--base main] [--test cmd]   merge every branch in order on a scratch worktree, test after each
//   fanout guard                                    PreToolUse hook (installed by the plugin)
import { readFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { resolve, relative, isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";

export function parsePlan(text) {
  const sessions = [];
  for (const block of text.split(/^## /m).slice(1)) {
    const [name, ...rest] = block.split("\n");
    const get = (k) => (rest.find((l) => l.startsWith(k + ":")) ?? "").slice(k.length + 1).trim();
    const list = (k) => get(k).split(",").map((s) => s.trim()).filter(Boolean);
    sessions.push({ name: name.trim(), owns: list("owns"), after: list("after"), exposes: list("exposes"), uses: list("uses") });
  }
  return sessions;
}

// Plan-wide settings sit above the first "## " block, e.g. "test: npm test".
export const planSetting = (text, key) =>
  (text.split(/^## /m)[0].split("\n").find((l) => l.startsWith(key + ":")) ?? "").slice(key.length + 1).trim();

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
export function check(sessions, cwd) {
  const problems = [];
  const files = cwd ? repoFiles(cwd) : null;
  for (let i = 0; i < sessions.length; i++)
    for (let j = i + 1; j < sessions.length; j++)
      for (const a of sessions[i].owns) for (const b of sessions[j].owns) {
        const label = `${sessions[i].name} (${a}) <-> ${sessions[j].name} (${b})`;
        if (files) {
          const shared = files.filter((f) => matches(a, f) && matches(b, f));
          if (shared.length) {
            const more = shared.length > 3 ? ` +${shared.length - 3} more` : "";
            problems.push(`CLASH ${label}: ${shared.slice(0, 3).join(", ")}${more}`);
            continue;
          }
          const ma = files.some((f) => matches(a, f)), mb = files.some((f) => matches(b, f));
          if ((!ma || !mb) && prefixClash(a, b)) problems.push(`CLASH ${label}: new paths may overlap`);
        } else if (prefixClash(a, b)) {
          problems.push(`CLASH ${label}`);
        }
      }
  // A session that uses a contract merges after the session exposing it.
  const deps = new Map(sessions.map((s) => [s.name, [...s.after]]));
  for (const s of sessions) {
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
function mainRoot(cwd) {
  try { return resolve(git(["rev-parse", "--path-format=absolute", "--git-common-dir"], cwd).trim(), ".."); }
  catch { return cwd; }
}
const defaultPlan = (cwd) => resolve(mainRoot(cwd), ".fanout", "plan.md");

// Merges the branches in plan order on a throwaway worktree and runs the test command after
// each merge, so a break is caught before pushing and pinned to the branch that caused it.
// The worktree sits in .fanout/ inside the main checkout so node_modules etc. still resolve.
// Output is a few lines plus the tail of a failing run: cheap for an agent to read and act on.
export function rehearse(order, { cwd, base = "main", test, tail = 20 }) {
  const log = [], root = mainRoot(cwd), wt = join(root, ".fanout", "rehearse");
  const sh = (cmd) => spawnSync(cmd, { cwd: wt, shell: true, encoding: "utf8" });
  const g = (...a) => execFileSync("git", ["-c", "user.name=fanout", "-c", "user.email=fanout@local", ...a],
    { cwd: wt, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const drop = () => { try { git(["worktree", "remove", "--force", wt], root); } catch { /* not there */ } };
  drop();
  git(["worktree", "add", "--detach", wt, base], root);
  let ok = true;
  try {
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
      if (!test) { log.push(`MERGED ${name}`); continue; }
      const r = sh(test);
      if (r.status === 0) { log.push(`OK after ${name}`); continue; }
      const out = `${r.stdout ?? ""}${r.stderr ?? ""}`.trimEnd().split("\n").slice(-tail).join("\n");
      log.push(`BROKE after ${name}: \`${test}\` exited ${r.status}`, out);
      ok = false; break;
    }
  } finally { drop(); }
  if (ok) log.push(test ? "All branches merge and pass together." : "All branches merge cleanly (no test command: add `test:` to the plan).");
  return { ok, log };
}
const explicitPlan = (argv) => (argv[1] && !argv[1].startsWith("--") ? argv[1] : null);

function main(argv) {
  const cmd = argv[0];
  if (cmd === "guard") return guard(argv);
  if (!["check", "verify", "rehearse"].includes(cmd)) { console.error("usage: fanout check [plan.md] | verify [--session name] [--base main] | rehearse [--base main] [--test cmd] | guard"); return 2; }
  const cwd = resolve(arg(argv, "--cwd", process.cwd()));
  const planPath = explicitPlan(argv) ?? defaultPlan(cwd);
  let text;
  try { text = readFileSync(planPath, "utf8"); } catch { console.error(`No plan at ${planPath}`); return 2; }
  const sessions = parsePlan(text);
  if (cmd === "check") {
    const { problems, order } = check(sessions, cwd);
    problems.forEach((p) => console.log(p));
    console.log("Merge order:", order.join(" -> "));
    return problems.length ? 1 : 0;
  }
  if (cmd === "rehearse") {
    const { problems, order } = check(sessions, cwd);
    if (problems.length) { problems.forEach((p) => console.log(p)); console.log("Fix the plan first (fanout check)."); return 1; }
    const { ok, log } = rehearse(order, { cwd, base: arg(argv, "--base", "main"), test: arg(argv, "--test") ?? planSetting(text, "test") });
    log.forEach((l) => console.log(l));
    return ok ? 0 : 1;
  }
  const name = arg(argv, "--session") ?? currentSession(cwd);
  const s = sessions.find((x) => x.name === name);
  if (!s) { console.error(`No session "${name}" in plan. Pass --session or run from a fanout/<name> branch.`); return 2; }
  const base = arg(argv, "--base", "main"), head = arg(argv, "--head", "HEAD");
  const changed = git(["diff", "--name-only", `${base}...${head}`], cwd).split("\n").filter(Boolean);
  const out = verify(s, changed), frozen = contractChanges(sessions, changed);
  out.forEach((f) => console.log(`OUT OF LANE ${name}: ${f}`));
  frozen.forEach((f) => console.log(`CONTRACT CHANGED ${name}: ${f} (exposed by ${contractOwner(sessions, f).name})`));
  console.log(`${name}: ${changed.length} changed, ${out.length} outside its owns, ${frozen.length} contracts changed`);
  return out.length || frozen.length ? 1 : 0;
}

// PreToolUse hook: blocks Write/Edit/NotebookEdit outside the session's owns, and on any contract.
// Active only on a fanout/<name> branch with a plan present, so it does nothing in normal work.
function guard() {
  let input = {};
  try { input = JSON.parse(readFileSync(0, "utf8")); } catch { return 0; }
  const target = input.tool_input?.file_path ?? input.tool_input?.notebook_path;
  if (!target) return 0;
  const cwd = input.cwd ?? process.cwd();
  const session = currentSession(cwd);
  if (!session) return 0;
  let text;
  try { text = readFileSync(defaultPlan(cwd), "utf8"); } catch { return 0; }
  const sessions = parsePlan(text), s = sessions.find((x) => x.name === session);
  if (!s) return 0;
  let root = cwd;
  try { root = git(["rev-parse", "--show-toplevel"], cwd).trim(); } catch { /* not a repo */ }
  const rel = norm(relative(root, isAbsolute(target) ? target : resolve(cwd, target)));
  if (rel.startsWith("..")) return 0; // outside the repo: not our business
  const owner = contractOwner(sessions, rel);
  if (owner) {
    console.error(`fanout: ${rel} is a contract (exposed by "${owner.name}") and is frozen during the fan-out. Ask the coordinator to change it on main; sessions that use it will be told.`);
    return 2;
  }
  if (ownsFile(s, rel)) return 0;
  console.error(`fanout: session "${session}" does not own ${rel}. Owned: ${s.owns.join(", ")}. Ask the coordinator to change the plan.`);
  return 2;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) process.exit(main(process.argv.slice(2)));
