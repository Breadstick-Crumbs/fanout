// Claims: which session is doing what, kept in git so every session of a repo sees them at once.
//   fanout start "<task>" [files...]              claim this session's task (agents without hooks: AGENTS.md says so)
//   fanout done                                   test this branch merged with the other sessions' work (fanout.mjs)
//   fanout claim <name> "<task>" [files...] [--exposes a,b] [--distinct "how it differs"]   files named here are locked
//   fanout claims [--all]                         live claims (--all: expired ones too)
//   fanout release <name> [--to <branch>]         end a claim, or hand it to another branch
//   fanout init                                   claims on for good, git hook, AGENTS.md block
//
// Claims are on by themselves in a repo with two or more checkouts used in the last day (claimsActive). In
// Claude Code nothing has to be run: the session-start hook tells a session what the others are doing, and
// on its first edit the guard claims its task for it, with the user's request as the task (autoClaim).
//
// The state is a commit on refs/fanout/state whose tree holds one JSON file per claim (claim-<name>.json),
// written with git plumbing: no checkout, nothing in anyone's diff. Every worktree of a repo shares its refs,
// so a claim is visible to all local sessions the moment it is written; a team can push and fetch the ref.
// Writes are compare-and-swap on the ref (update-ref with the old value), retried, so two sessions claiming
// at once can't lose one.
//
// A session is its checkout's branch. With claims on, the edit guard and the git hook refuse a file another
// session claimed by name, warn about one another session is also editing, and record each file a session
// edits. Every new task is checked against the live ones for the same work (taskOverlap) before it's accepted.
import { spawnSync } from "node:child_process";
import { existsSync, statSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { matches } from "./fanout.mjs";

export const REF = "refs/fanout/state";
const IDLE_HOURS = 24;

const git = (cwd, args, input) => {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", input, maxBuffer: 64 << 20 });
  return { ok: r.status === 0, out: r.stdout ?? "", err: r.stderr ?? "" };
};
const IDENT = ["-c", "user.name=fanout", "-c", "user.email=fanout@local"];

export const claimsOn = (cwd) => git(cwd, ["config", "--get", "fanout.claims"]).out.trim() === "true";

// Claims switch on by themselves where sessions run in parallel: a repo with two or more checkouts (the main
// one and worktrees) used in the last day. `git config fanout.claims true|false` forces them on or off. A
// checkout counts as used when its index or HEAD changed (git touches the index on every status, add and
// commit); fanout's own lanes and rehearse copy don't count. Reads file times only: the guard runs on every edit.
export function activeCheckouts(cwd, now = Date.now()) {
  const common = git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).out.trim();
  if (!common) return 0;
  const mtime = (p) => { try { return statSync(p).mtimeMs; } catch { return 0; } };
  const dirs = [common];
  try { for (const d of readdirSync(join(common, "worktrees"))) {
    const wt = join(common, "worktrees", d);
    let to = ""; try { to = readFileSync(join(wt, "gitdir"), "utf8"); } catch { /* none */ }
    if (!/[\\/]\.fanout[\\/]/.test(to)) dirs.push(wt);
  } } catch { /* no worktrees */ }
  return dirs.filter((d) => Math.max(mtime(join(d, "index")), mtime(join(d, "HEAD"))) > now - IDLE_HOURS * 3600 * 1000).length;
}
export function claimsActive(cwd) {
  const v = git(cwd, ["config", "--get", "fanout.claims"]).out.trim();
  return v === "true" ? true : v === "false" ? false : activeCheckouts(cwd) >= 2;
}

// What the user asked this session for: the latest user message of at least a few words in its Claude Code
// transcript (hooks get its path). Tool results and fanout's own notes aren't user messages; tags such as
// <system-reminder> blocks are dropped. Used as the task of a claim made for a session on its first edit.
export function taskFromTranscript(path) {
  let lines;
  try { lines = readFileSync(path, "utf8").split("\n"); } catch { return ""; }
  let task = "";
  for (const l of lines) {
    if (!l.includes('"user"')) continue;
    let j; try { j = JSON.parse(l); } catch { continue; }
    if (j.type !== "user" || j.isMeta) continue;
    const c = j.message?.content, text = typeof c === "string" ? c : Array.isArray(c) ? c.filter((x) => x.type === "text").map((x) => x.text).join("\n") : "";
    const clean = text.replace(/<([a-z][\w-]*)[^>]*>[\s\S]*?<\/\1>/gi, "").replace(/\s+/g, " ").trim();
    if (clean.length >= 15) task = clean;
  }
  return task.slice(0, 600);
}
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

// A claim's files and exposes are locks: no other session may change them. Its edits are the files it has
// changed so far, recorded as it goes: another session may change them too (both may need package.json), and
// is told who else is.
const covers = (c, rel) => [...(c.files ?? []), ...(c.exposes ?? [])].some((g) => matches(g, rel));
// The live claim of another branch locking rel, if any.
export const claimedByOther = (claims, branch, rel) => claims.find((c) => c.branch !== branch && covers(c, rel)) ?? null;
export const editedByOthers = (claims, branch, rel) => claims.filter((c) => c.branch !== branch && (c.edits ?? []).includes(rel));

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
  if (!distinct && !(mine && mine.task === task && !mine.refusedAs)) {
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
    // A fresh claim clears an earlier refusal (refusedAs) for this session.
    claims[name] = { name, task, branch, path, files: [...new Set([...(cur?.files ?? []), ...files])], exposes: [...new Set([...(cur?.exposes ?? []), ...exposes])],
      edits: cur?.edits ?? [], start: cur?.start ?? start, at: cur?.at ?? now, updated: now, ...(distinct ? { distinct } : {}) };
  }, `fanout: claim ${name}`);
  if (!w.ok) { console.error("fanout claim: couldn't write the claim (the state ref kept changing); try again."); return 1; }
  console.log(`claimed ${name} for ${branch}: ${task}${files.length ? ` (${files.join(", ")})` : ""}`);
  if (!claimsOn(cwd)) console.log(`Claims aren't enforced in this repo yet: run \`node "${script}" init\` to turn them on.`);
  return 0;
}

// fanout start "<task>" [files...]: claim this session's task without picking a name (its claim, or one named
// after its branch). For agents told about fanout in AGENTS.md; Claude Code sessions are claimed on their own.
export function startCmd(cwd, argv, base, script) {
  const branch = branchOf(cwd);
  if (!branch) { console.error("fanout start: check out a branch first."); return 2; }
  const mine = liveClaims(cwd, base).filter((c) => c.branch === branch).sort((a, b) => Date.parse(b.updated ?? b.at) - Date.parse(a.updated ?? a.at))[0];
  return claimCmd(cwd, [mine?.name ?? slugName(branch), ...argv], base, script);
}

// Claude Code sessions, on their first edit: the claim is made for them, with the user's request as the task,
// and checked against the others like any claim. A session doing work another already claimed is stopped,
// and stays stopped (refusedAs) until it claims something else or says how its work differs.
export function autoClaim(cwd, branch, task, base, live) {
  const others = live.filter((c) => c.branch !== branch);
  const o = taskOverlap(task, others, cwd);
  const name = slugName(branch), now = new Date().toISOString();
  const claim = { name, task: task.slice(0, 300), branch, path: git(cwd, ["rev-parse", "--show-toplevel"]).out.trim(), files: [], exposes: [], edits: [],
    start: git(cwd, ["rev-parse", "HEAD"]).out.trim(), at: now, updated: now, auto: true, ...(o.same.length ? { refusedAs: o.same.map((c) => c.name), why: o.why } : {}) };
  writeState(cwd, (claims) => { if (claims[name]?.branch === branch) return false; claims[name] = claim; }, `fanout: claim ${name} (first edit)`);
  return claim;
}
export const refusalText = (c, live, script) => {
  const same = live.filter((x) => (c.refusedAs ?? []).includes(x.name));
  return `this session's task looks like the same work as another session's:\n${same.map((x) => `  ${x.name} (branch ${x.branch}): ${x.task}`).join("\n") || `  ${c.refusedAs.join(", ")}`}${c.why ? `\n  (${c.why})` : ""}\n`
    + `Don't do it twice: tell the user which session already has it. If the user wants a different part, claim that: node "${script}" start "<what you'll do instead>". If it really is different work: node "${script}" start "${c.task.slice(0, 80).replace(/"/g, "'")}" --distinct "<how it differs>"`;
};

export function showClaims(cwd, base, all) {
  const { claims } = readState(cwd);
  const list = Object.values(claims).map((c) => ({ ...c, live: isLive(cwd, c, base) })).filter((c) => all || c.live);
  if (!list.length) { console.log(all ? "No claims." : "No live claims."); return 0; }
  for (const c of list.sort((a, b) => (a.branch < b.branch ? -1 : 1)))
    console.log(`${c.name}${c.live ? "" : " (expired)"}${c.refusedAs ? ` (stopped: same work as ${c.refusedAs.join(", ")})` : ""}  ${c.branch}  ${ago(c.updated ?? c.at)} ago  ${c.task || "(no task)"}`
      + `${c.files?.length ? `\n  files: ${c.files.join(", ")}` : ""}${c.exposes?.length ? `\n  exposes: ${c.exposes.join(", ")}` : ""}${c.edits?.length ? `\n  editing: ${c.edits.join(", ")}` : ""}`);
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

// The block fanout init puts in AGENTS.md, for agents without fanout's hooks (Codex and others): two commands,
// with this machine's path to the fanout script.
const BLOCK_START = "<!-- fanout -->", BLOCK_END = "<!-- /fanout -->";
export const agentsBlock = (script) => `${BLOCK_START}
## Other sessions may be working here too (fanout)

- Before you change anything, run \`node "${script}" start "<your task in one line>"\`. It shows what the other sessions are doing and claims your task. If it says another session already has that work, don't do it: tell the user which one has it.
- When you've committed, run \`node "${script}" done\`. It tests your branch merged with the other sessions' work and says if one breaks the other.
${BLOCK_END}`;

// Turns claims on for good (not only when two sessions are active), installs the git hook, and writes the
// AGENTS.md block (replacing an earlier one) so agents without hooks know the two commands.
export function initCmd(cwd, script, installHook, argv) {
  git(cwd, ["config", "fanout.claims", "true"]);
  const hook = installHook(cwd, argv.includes("--force"));
  const root = git(cwd, ["rev-parse", "--show-toplevel"]).out.trim(), file = join(root, "AGENTS.md");
  let text = ""; try { text = readFileSync(file, "utf8"); } catch { /* new file */ }
  const block = agentsBlock(script), i = text.indexOf(BLOCK_START), j = text.indexOf(BLOCK_END);
  text = i >= 0 && j > i ? text.slice(0, i) + block + text.slice(j + BLOCK_END.length) : `${text}${text && !text.endsWith("\n") ? "\n" : ""}${text ? "\n" : ""}${block}\n`;
  writeFileSync(file, text);
  console.log(`Claims are on for this repo. Each session's task is claimed before its first edit; work another session already has is refused.`);
  if (hook) console.log("(The git hook wasn't installed, so only Claude Code sessions are held to claims; see above.)");
  console.log(`Wrote the instructions for agents without fanout's hooks (Codex and others) to AGENTS.md. Commit it so every session sees it.`);
  return 0;
}
