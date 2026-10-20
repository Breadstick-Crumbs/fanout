#!/usr/bin/env node
// fanout: plan parallel sessions, check for overlap, verify branches, guard edits.
//   fanout check  [plan.md]                         plan defaults to .fanout/plan.md in the main checkout
//   fanout verify [--session name] [--base main]    session defaults to the fanout/<name> branch
//   fanout guard                                    PreToolUse hook (installed by the plugin)
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve, relative, isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";

export function parsePlan(text) {
  const sessions = [];
  for (const block of text.split(/^## /m).slice(1)) {
    const [name, ...rest] = block.split("\n");
    const get = (k) => (rest.find((l) => l.startsWith(k + ":")) ?? "").slice(k.length + 1).trim();
    const list = (k) => get(k).split(",").map((s) => s.trim()).filter(Boolean);
    sessions.push({ name: name.trim(), owns: list("owns"), after: list("after") });
  }
  return sessions;
}

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
  const order = [], seen = new Set();
  const visit = (s, stack = []) => {
    if (seen.has(s.name)) return;
    if (stack.includes(s.name)) { problems.push("CYCLE in after: " + [...stack, s.name].join(" -> ")); return; }
    for (const d of s.after) {
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
function defaultPlan(cwd) {
  try {
    const common = git(["rev-parse", "--path-format=absolute", "--git-common-dir"], cwd).trim();
    return resolve(common, "..", ".fanout", "plan.md");
  } catch { return resolve(cwd, ".fanout", "plan.md"); }
}
const explicitPlan = (argv) => (argv[1] && !argv[1].startsWith("--") ? argv[1] : null);

function main(argv) {
  const cmd = argv[0];
  if (cmd === "guard") return guard(argv);
  if (cmd !== "check" && cmd !== "verify") { console.error("usage: fanout check [plan.md] | verify [--session name] [--base main] | guard"); return 2; }
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
  const name = arg(argv, "--session") ?? currentSession(cwd);
  const s = sessions.find((x) => x.name === name);
  if (!s) { console.error(`No session "${name}" in plan. Pass --session or run from a fanout/<name> branch.`); return 2; }
  const base = arg(argv, "--base", "main"), head = arg(argv, "--head", "HEAD");
  const changed = git(["diff", "--name-only", `${base}...${head}`], cwd).split("\n").filter(Boolean);
  const out = verify(s, changed);
  out.forEach((f) => console.log(`OUT OF LANE ${name}: ${f}`));
  console.log(`${name}: ${changed.length} changed, ${out.length} outside its owns`);
  return out.length ? 1 : 0;
}

// PreToolUse hook: blocks Write/Edit/NotebookEdit outside the session's owns.
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
  const s = parsePlan(text).find((x) => x.name === session);
  if (!s) return 0;
  let root = cwd;
  try { root = git(["rev-parse", "--show-toplevel"], cwd).trim(); } catch { /* not a repo */ }
  const rel = norm(relative(root, isAbsolute(target) ? target : resolve(cwd, target)));
  if (rel.startsWith("..")) return 0; // outside the repo: not our business
  if (ownsFile(s, rel)) return 0;
  console.error(`fanout: session "${session}" does not own ${rel}. Owned: ${s.owns.join(", ")}. Ask the coordinator to change the plan.`);
  return 2;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) process.exit(main(process.argv.slice(2)));
