// Claims: which session is doing what, kept in git so every session of a repo sees them at once.
//   fanout init                                   turn claims on for this repo (git config fanout.claims=true, git hook)
//   fanout claim <name> "<task>" [files...] [--exposes a,b] [--distinct "how it differs"]
//   fanout claims [--all]                         live claims (--all: expired ones too)
//   fanout release <name> [--to <branch>]         end a claim, or hand it to another branch
//
// The state is a commit on refs/fanout/state whose tree holds one JSON file per claim (claim-<name>.json),
// written with git plumbing: no checkout, nothing in anyone's diff. Every worktree of a repo shares its refs,
// so a claim is visible to all local sessions the moment it is written; a team can push and fetch the ref.
// Writes are compare-and-swap on the ref (update-ref with the old value), retried, so two sessions claiming
// at once can't lose one.
//
// A session is its checkout's branch. With claims on, the edit guard and the git hook refuse a file another
// session's live claim covers, require a session to claim its task before its first edit, and add each new
// file a session edits to its claim. A new task is checked against the live ones for the same work
// (taskOverlap) before it is accepted.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { matches } from "./fanout.mjs";

export const REF = "refs/fanout/state";
const IDLE_HOURS = 24;

const git = (cwd, args, input) => {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", input, maxBuffer: 64 << 20 });
  return { ok: r.status === 0, out: r.stdout ?? "", err: r.stderr ?? "" };
};
const IDENT = ["-c", "user.name=fanout", "-c", "user.email=fanout@local"];

export const claimsOn = (cwd) => git(cwd, ["config", "--get", "fanout.claims"]).out.trim() === "true";
export const slugName = (s) => String(s).toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
export const branchOf = (cwd) => git(cwd, ["branch", "--show-current"]).out.trim() || null;

// { head, claims: { name: claim } } as stored on the ref (expired ones included).
export function readState(cwd) {
  const head = git(cwd, ["rev-parse", "--verify", "--quiet", REF]).out.trim() || null;
  if (!head) return { head: null, claims: {} };
  const entries = git(cwd, ["ls-tree", head]).out.split("\n").filter(Boolean).map((l) => {
    const [meta, path] = l.split("\t");
    return { sha: meta.split(" ")[2], path };
  });
  const claims = {};
  if (entries.length) {
    // One cat-file for every blob: "<sha> blob <size>\n<content>\n" each.
    const out = Buffer.from(git(cwd, ["cat-file", "--batch"], entries.map((e) => e.sha).join("\n") + "\n").out, "utf8");
    let pos = 0;
    for (const e of entries) {
      const nl = out.indexOf(10, pos), size = Number(out.subarray(pos, nl).toString().split(" ")[2]);
      const body = out.subarray(nl + 1, nl + 1 + size).toString();
      pos = nl + 1 + size + 1;
      if (e.path.startsWith("claim-")) try { const c = JSON.parse(body); claims[c.name] = c; } catch { /* skip a broken entry */ }
    }
  }
  return { head, claims };
}

// mutate(claims) changes the object in place and returns false to write nothing. Retries on a race.
export function writeState(cwd, mutate, msg = "fanout: claims") {
  for (let attempt = 0; attempt < 10; attempt++) {
    const { head, claims } = readState(cwd);
    const result = mutate(claims);
    if (result === false) return { ok: true, written: false, claims };
    const lines = Object.values(claims).map((c) => {
      const sha = git(cwd, ["hash-object", "-w", "--stdin"], JSON.stringify(c, null, 1)).out.trim();
      return `100644 blob ${sha}\tclaim-${c.name}.json`;
    });
    const tree = git(cwd, ["mktree"], lines.join("\n") + (lines.length ? "\n" : "")).out.trim();
    const commit = git(cwd, [...IDENT, "commit-tree", tree, ...(head ? ["-p", head] : []), "-m", msg]).out.trim();
    if (git(cwd, ["update-ref", REF, commit, head ?? ""]).ok) return { ok: true, written: true, claims, result };
  }
  return { ok: false, written: false };
}

// A claim ends when its branch is gone, when its branch has moved and is now merged into the base, or
// after IDLE_HOURS with no commit on the branch and no claim update.
export function isLive(cwd, c, base, now = Date.now()) {
  const head = git(cwd, ["rev-parse", "--verify", "--quiet", `refs/heads/${c.branch}`]).out.trim();
  if (!head) return false;
  if (c.path && !existsSync(c.path)) return false;
  if (base && c.branch !== base && head !== c.start && git(cwd, ["merge-base", "--is-ancestor", head, base]).ok) return false;
  const lastCommit = (Number(git(cwd, ["log", "-1", "--format=%ct", head]).out.trim()) || 0) * 1000;
  return Math.max(lastCommit, Date.parse(c.updated ?? c.at) || 0) > now - IDLE_HOURS * 3600 * 1000;
}
export function liveClaims(cwd, base) {
  const { claims } = readState(cwd);
  return Object.values(claims).filter((c) => isLive(cwd, c, base));
}

const covers = (c, rel) => [...(c.files ?? []), ...(c.exposes ?? [])].some((g) => matches(g, rel));
// The live claim of another branch covering rel, if any.
export const claimedByOther = (claims, branch, rel) => claims.find((c) => c.branch !== branch && covers(c, rel)) ?? null;

// ---------- task overlap ----------
// A model call compares the new task with every live one (judge). Measured with bench/task-overlap.mjs on
// two sets of 40 labelled pairs written by other agents, the second held out until the prompt was fixed:
//   shared words (wordOverlap, kept as the baseline): at best 17/40 and 20/40, no better than chance;
//   Haiku: 36/40 and 33/40, no false alarms, but it missed a third of the held-out duplicates, mostly a bug
//     described by its symptom against the same bug described by its fix;
//   Sonnet: 40/40 on both, about $0.012 per check.
// So the judge runs on Sonnet (FANOUT_CLAIM_JUDGE_MODEL changes it), and with no judge the claim goes ahead
// with a warning rather than a word count's guess.
const STOP = new Set("a an the and or of to in on for with by from at as is are be into onto this that it its their our your new add make use using via so all any each per when then than not no".split(" "));
const stem = (w) => w.replace(/(ing|ed|es|s)$/, "") || w;
export const words = (s) => new Set(String(s).toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !STOP.has(w)).map(stem));
export function wordOverlap(a, b) {
  const A = words(a), B = words(b);
  if (!A.size || !B.size) return 0;
  let n = 0;
  for (const w of A) if (B.has(w)) n++;
  return n / Math.min(A.size, B.size);
}

// The model reasons about each session before it decides: asked for the decision first, it flagged pairs its
// own reason called different (5 of 8 false alarms in the first validation run).
export function judgePrompt(task, others) {
  return `Coding sessions are working in parallel on one repository. A new session wants to start the task below. Compare it with each existing session.

SAME work means: once either task is done, most of the other one is already done too, so doing both would duplicate effort or produce two competing implementations of one thing. This includes the same change described in different words or detail, one task containing the other, and a bug described by its symptom in one and by its fix in the other.
DIFFERENT work means: each task delivers something the other doesn't, so both are needed. Sharing a feature area, a file, a command, or a kind of work (both add tests, both add a flag, both improve search) does not make them the same.

New task: ${task}

Existing sessions:
${others.map((c) => `- ${c.name}: ${c.task || "(no task given)"}${c.files?.length ? ` [files: ${c.files.slice(0, 8).join(", ")}]` : ""}`).join("\n")}

For each existing session, first say what each task delivers, then decide. Reply with only JSON:
{"sessions": [{"name": "<session>", "reason": "<what each delivers, one sentence>", "same": true|false}]}`;
}

const claudeBin = () => process.env.FANOUT_CLAUDE_BIN || "claude";
// One cheap model call (Haiku, no tools, project settings only). Returns { same: [names], why, costUsd } or
// null when it can't run (no CLI, signed out, unreadable answer): the caller then goes by words alone.
export function judge(task, others, cwd) {
  if (process.env.FANOUT_CLAIM_JUDGE === "off" || !others.length) return null;
  const model = process.env.FANOUT_CLAIM_JUDGE_MODEL || "sonnet";
  const r = spawnSync(`${claudeBin()} -p --model ${model} --tools "" --setting-sources project,local --strict-mcp-config --output-format json`,
    { cwd, shell: true, encoding: "utf8", input: judgePrompt(task, others), timeout: 120000 });
  try {
    const out = r.stdout ?? "", j = JSON.parse(out.slice(out.indexOf("{")));
    if (j.is_error) return null;
    const text = String(j.result ?? ""), a = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
    const names = new Set(others.map((c) => c.name)), hits = (a.sessions ?? []).filter((s) => s.same === true && names.has(s.name));
    return { same: hits.map((s) => s.name), why: hits.map((s) => s.reason).join(" ") || String((a.sessions ?? [])[0]?.reason ?? ""), costUsd: j.total_cost_usd ?? null };
  } catch { return null; }
}

// The live claims of other branches doing the same work as `task`. by: "judge", "none" (nothing to compare),
// or "unchecked" (the judge couldn't run).
export function taskOverlap(task, others, cwd) {
  if (!task || !others.length) return { same: [], by: "none" };
  const j = judge(task, others, cwd);
  if (!j) return { same: [], by: "unchecked" };
  return { same: others.filter((c) => j.same.includes(c.name)), why: j.why, by: "judge", costUsd: j.costUsd };
}

// ---------- commands ----------
const ago = (iso) => { const m = Math.round((Date.now() - Date.parse(iso)) / 60000); return m < 60 ? `${m}m` : m < 2880 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`; };
const optOf = (argv, f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };
const positional = (argv) => argv.filter((a, i) => !a.startsWith("--") && !(i > 0 && ["--exposes", "--distinct", "--to", "--base"].includes(argv[i - 1])));

export function claimCmd(cwd, argv, base, script) {
  const [name0, task, ...files] = positional(argv);
  const name = slugName(name0 ?? "");
  if (!name || !task) { console.error(`usage: fanout claim <name> "<what this session is doing>" [files or globs...] [--exposes a,b]`); return 2; }
  const branch = branchOf(cwd);
  if (!branch) { console.error("fanout claim: check out a branch first; a claim belongs to a branch."); return 2; }
  const exposes = (optOf(argv, "--exposes") ?? "").split(",").map((s) => s.trim()).filter(Boolean), distinct = optOf(argv, "--distinct");
  const live = liveClaims(cwd, base), mine = live.find((c) => c.name === name);
  const taken = live.find((c) => c.name === name && c.branch !== branch);
  if (taken) { console.error(`fanout claim: "${name}" is already claimed by branch ${taken.branch} (${taken.task}). Pick another name, or if that session is finished: fanout release ${name}`); return 1; }
  const others = live.filter((c) => c.branch !== branch);
  const clash = [...files, ...exposes].flatMap((f) => others.filter((c) => [...(c.files ?? []), ...(c.exposes ?? [])].some((g) => matches(g, f) || matches(f, g))).map((c) => `${f} (claimed by ${c.name} on ${c.branch})`));
  if (clash.length) { console.error(`fanout claim: these are already claimed:\n  ${clash.join("\n  ")}\nLeave them to that session, or ask it to release them.`); return 1; }
  if (!distinct && !(mine && mine.task === task)) {
    const o = taskOverlap(task, others, cwd);
    if (o.same.length) {
      console.error(`fanout claim: this looks like the same work as:\n${o.same.map((c) => `  ${c.name} (branch ${c.branch}, ${ago(c.updated ?? c.at)} ago): ${c.task}`).join("\n")}${o.why ? `\n  (${o.why})` : ""}\n`
        + `Don't do it twice: pick other work, or coordinate with that session. If it really is different, run again with --distinct "<how it differs>".`);
      return 1;
    }
    if (o.by === "unchecked") console.log(`fanout claim: couldn't check for duplicate work (no claude CLI, or it's signed out). Other sessions are doing:\n${others.map((c) => `  ${c.name}: ${c.task || "(no task)"}`).join("\n")}\nMake sure yours isn't one of these.`);
  }
  const start = git(cwd, ["rev-parse", "HEAD"]).out.trim(), now = new Date().toISOString();
  const path = git(cwd, ["rev-parse", "--show-toplevel"]).out.trim();
  const w = writeState(cwd, (claims) => {
    for (const c of Object.values(claims)) if (!isLive(cwd, c, base)) delete claims[c.name]; // prune expired ones
    const cur = claims[name];
    claims[name] = { name, task, branch, path, files: [...new Set([...(cur?.files ?? []), ...files])], exposes: [...new Set([...(cur?.exposes ?? []), ...exposes])],
      start: cur?.start ?? start, at: cur?.at ?? now, updated: now, ...(distinct ? { distinct } : {}) };
  }, `fanout: claim ${name}`);
  if (!w.ok) { console.error("fanout claim: couldn't write the claim (the state ref kept changing); try again."); return 1; }
  console.log(`claimed ${name} for ${branch}: ${task}${files.length ? ` (${files.join(", ")})` : ""}`);
  if (!claimsOn(cwd)) console.log(`Claims aren't enforced in this repo yet: run \`node "${script}" init\` to turn them on.`);
  return 0;
}

export function showClaims(cwd, base, all) {
  const { claims } = readState(cwd);
  const list = Object.values(claims).map((c) => ({ ...c, live: isLive(cwd, c, base) })).filter((c) => all || c.live);
  if (!list.length) { console.log(all ? "No claims." : "No live claims."); return 0; }
  for (const c of list.sort((a, b) => (a.branch < b.branch ? -1 : 1)))
    console.log(`${c.name}${c.live ? "" : " (expired)"}  ${c.branch}  ${ago(c.updated ?? c.at)} ago  ${c.task || "(no task)"}${c.files?.length ? `\n  files: ${c.files.join(", ")}` : ""}${c.exposes?.length ? `\n  exposes: ${c.exposes.join(", ")}` : ""}`);
  return 0;
}

export function releaseCmd(cwd, argv) {
  const name = slugName(positional(argv)[0] ?? ""), to = optOf(argv, "--to");
  if (!name) { console.error("usage: fanout release <name> [--to <branch>]"); return 2; }
  let was = null;
  const w = writeState(cwd, (claims) => {
    if (!claims[name]) return false;
    was = claims[name];
    if (to) claims[name] = { ...was, branch: to, path: null, updated: new Date().toISOString() };
    else delete claims[name];
  }, `fanout: release ${name}`);
  if (!w.ok) { console.error("fanout release: couldn't write; try again."); return 1; }
  if (!was) { console.error(`fanout release: no claim named ${name}.`); return 1; }
  console.log(to ? `handed ${name} from ${was.branch} to ${to}` : `released ${name} (was ${was.branch}: ${was.task})`);
  return 0;
}

// The block AGENTS.md / CLAUDE.md gets, so any agent knows the rules before the hooks have to stop it.
export const agentsBlock = (script) => `<!-- fanout claims -->
## Working alongside other sessions (fanout)

Other agent sessions may be working in this repo at the same time. Before you change anything:
1. \`node "${script}" claims\` to see what the others are doing. Don't start work another session has claimed.
2. \`node "${script}" claim <short-name> "<what you're doing>" [files you'll change]\` to claim your task. If it says the work is already claimed, pick other work or coordinate; don't do it twice.
3. Edit only files no other session has claimed. Files you edit are added to your claim.
When you're finished and merged, your claim ends by itself; \`node "${script}" release <short-name>\` ends it early.
<!-- /fanout claims -->`;

export function initCmd(cwd, script, installHook, argv) {
  git(cwd, ["config", "fanout.claims", "true"]);
  const hook = installHook(cwd, argv.includes("--force"));
  console.log(`Claims are on for this repo. Sessions must claim a task before their first edit, and can't edit files another session has claimed.`);
  if (hook) console.log("(The git hook wasn't installed, so only Claude Code sessions are held to claims; see above.)");
  console.log(`\nAdd this to AGENTS.md and/or CLAUDE.md so agents know before they're stopped:\n\n${agentsBlock(script)}`);
  return 0;
}
