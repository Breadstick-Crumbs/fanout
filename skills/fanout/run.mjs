// fanout run: the whole fan-out as one command.
//   fanout run ["goal"] [--yes] [--agent claude|codex|"<cmd>"] [--model m] [--budget usd] [--fixes 2] [--no-merge]
//
// 1. Plan: uses .fanout/plan.md if it exists; otherwise a coordinator agent writes it from the goal,
//    from the plan rules (plannerPrompt), and commits the contract files.
// 2. Approve: shows the plan once (skip with --yes).
// 3. Lanes: one agent per session, in parallel, each in .fanout/lanes/<name> on branch fanout/<name>.
//    Their work is committed for them; files the plan forbids are reverted.
// 4. Rehearse: merge everything on a scratch copy and test. A break goes back to the lane that caused
//    it, which fixes its own branch. A lane that fails --fixes times stops the run for a human.
// 5. Merge into the base branch in order, rebuild generated files, test once more.
//
// Agents: "claude" and "codex" run headless; anything else is a shell command that gets the brief on
// stdin and runs in the lane's folder, so any CLI agent works. A session can pick its own with "agent:".
import { spawn, execFileSync, spawnSync } from "node:child_process";
import { readFileSync, existsSync, appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parsePlan, parseRegen, planSetting, check, rehearse, blockReason, mainRoot, appendLog } from "./fanout.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, "fanout.mjs");
const PLUGIN_ROOT = join(HERE, "..", "..");
const WIN = process.platform === "win32";

const git = (cwd, ...a) => {
  const r = spawnSync("git", a, { cwd, encoding: "utf8" });
  return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
};
const tail = (s, n = 20) => s.trimEnd().split("\n").slice(-n).join("\n");
const sh = (cmd, cwd) => {
  const r = spawnSync(cmd, { cwd, shell: true, encoding: "utf8" });
  return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
};
const q = (s) => (WIN ? `"${s}"` : `'${s.replaceAll("'", `'\\''`)}'`);

// Binaries can be swapped (tests point these at a fake agent).
const bin = (name) => process.env[`FANOUT_${name.toUpperCase()}_BIN`] || name;

// Runs one agent with the prompt on stdin. Never throws; returns cost, tokens, seconds, any error and
// the agent's session id. With `resume` (a session id from an earlier run) it continues that session
// with just `prompt`; if that fails it starts fresh with `fallbackPrompt`.
export async function runAgent({ resume, fallbackPrompt, ...opts }) {
  if (!resume) return runOnce({ ...opts, prompt: fallbackPrompt ?? opts.prompt });
  const r = await runOnce({ ...opts, resume });
  if (!r.error) return r;
  const fresh = await runOnce({ ...opts, prompt: fallbackPrompt ?? opts.prompt });
  fresh.seconds += r.seconds; fresh.inTokens += r.inTokens; fresh.outTokens += r.outTokens;
  if (fresh.costUsd != null && r.costUsd != null) fresh.costUsd += r.costUsd;
  return fresh;
}

// Headless Claude startup cost, trivial "say ok" call through `claude -p` with the flags below:
//   before (default tool set): ~39k input tokens, $0.31 cold cache / $0.08 warm
//   --tools Read,Edit,Write,Glob,Grep,Bash: ~8.6k input tokens, $0.03 cold / $0.002 warm
// The built-in tool schemas (Task, WebFetch, notebook, cron, ...) were most of that. --allowedTools still
// limits Bash to node/npm/npx(/git). --setting-sources and --disable-slash-commands made no measurable
// difference here, and --bare needs an API key, so they are not used.
const CLAUDE_TOOLS = "Read,Edit,Write,Glob,Grep,Bash";
// Read-only shell tools agents reach for (piping test output to tail, listing files). Without them each
// attempt is refused and costs a turn. Writes still go through Edit/Write, where the guard checks them.
const READ_ONLY_BASH = ["ls", "cat", "head", "tail", "grep", "wc", "pwd", "echo"].map((c) => `Bash(${c}:*)`);
// Session agents start with the project's settings only, not the user's own: personal hooks and plugins
// run on every agent and tool call (measured here: a trivial call went from 9s to 15s and doubled its
// tokens). fanout's guard is loaded directly with --plugin-dir instead. FANOUT_USER_SETTINGS=1 keeps them.
const settingSources = () => (process.env.FANOUT_USER_SETTINGS ? [] : ["--setting-sources", "project,local", "--plugin-dir", q(PLUGIN_ROOT)]);

function runOnce({ agent = "claude", cwd, prompt, model, budget, plugin = false, allowGit = false, resume }) {
  // Only Claude reports a dollar cost; for any other agent it is unknown (null), not zero.
  const rec = { agent, seconds: 0, costUsd: agent === "claude" ? 0 : null, inTokens: 0, outTokens: 0, error: null, sessionId: null };
  const t0 = Date.now();
  let cmd;
  if (agent === "claude") {
    const tools = ["Read", "Edit", "Write", "Glob", "Grep", "Bash(node:*)", "Bash(npm:*)", "Bash(npx:*)", ...READ_ONLY_BASH, ...(allowGit ? ["Bash(git:*)"] : [])];
    const sources = settingSources();
    cmd = [bin("claude"), "-p", ...(resume ? ["--resume", resume] : []), "--tools", CLAUDE_TOOLS, "--permission-mode", "acceptEdits", "--allowedTools", q(tools.join(",")), "--output-format", "stream-json", "--verbose",
      "--strict-mcp-config", ...sources, ...(model ? ["--model", model] : []), ...(budget ? ["--max-budget-usd", budget] : []),
      ...(plugin && !sources.length ? ["--plugin-dir", q(PLUGIN_ROOT)] : [])].join(" ");
  } else if (agent === "codex") {
    cmd = [bin("codex"), "exec", "--json", "-s", "workspace-write", "--skip-git-repo-check", "-C", q(cwd), ...(model ? ["-m", model] : []),
      ...(resume ? ["resume", resume] : [])].join(" ");
  } else cmd = agent;
  return new Promise((done) => {
    const p = spawn(cmd, { cwd, shell: true });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    p.stdin.on("error", () => {});
    p.stdin.end(prompt);
    p.on("close", (code) => {
      rec.seconds = Math.round((Date.now() - t0) / 1000);
      try {
        if (agent === "claude") {
          // stream-json: one event per line, the last one the result. The tool calls in between show
          // where an agent's time goes (turns, reads, searches, test runs).
          const events = out.split("\n").filter((l) => l.startsWith("{")).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
          const j = events.findLast((e) => e.type === "result") ?? JSON.parse(out.slice(out.indexOf("{")));
          const u = j.usage ?? {};
          rec.sessionId = j.session_id ?? null;
          rec.costUsd = j.total_cost_usd ?? 0;
          rec.inTokens = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
          rec.outTokens = u.output_tokens ?? 0;
          rec.turns = j.num_turns ?? null;
          rec.modelSeconds = j.duration_api_ms != null ? Math.round(j.duration_api_ms / 1000) : null;
          rec.tools = {};
          for (const e of events) for (const c of e.type === "assistant" ? e.message?.content ?? [] : [])
            if (c.type === "tool_use") (rec.tools[c.name] ??= []).push(c.input?.file_path ?? c.input?.pattern ?? c.input?.command ?? "");
          if (process.env.FANOUT_TRACE_DIR) writeFileSync(join(process.env.FANOUT_TRACE_DIR, `${Date.now()}-${(rec.sessionId ?? "agent").slice(0, 8)}.jsonl`), out);
          if (j.is_error) rec.error = String(j.result ?? j.subtype).slice(0, 200);
        } else if (agent === "codex") {
          for (const line of out.split("\n")) {
            if (!line.startsWith("{")) continue;
            const e = JSON.parse(line);
            if (e.type === "thread.started" && e.thread_id) rec.sessionId = e.thread_id;
            if (e.type === "turn.completed" && e.usage) { rec.inTokens += e.usage.input_tokens ?? 0; rec.outTokens += e.usage.output_tokens ?? 0; }
            if (e.type === "turn.failed") rec.error = JSON.stringify(e.error ?? e).slice(0, 200);
          }
        }
      } catch { rec.error = `exit ${code}: ${tail(out, 3)}`.slice(0, 300); }
      if (code !== 0 && !rec.error) rec.error = `exit ${code}: ${tail(out, 3)}`.slice(0, 300);
      done(rec);
    });
  });
}

// Starts one agent per item, a moment apart. Launching several headless Claude agents in the same instant
// sometimes left their shells without PATH ("npm: command not found"), and each agent then lost turns.
export const staggered = (items, fn, gapMs = Number(process.env.FANOUT_STAGGER_MS ?? 1500)) =>
  Promise.all(items.map((x, i) => new Promise((r) => setTimeout(r, i * gapMs)).then(() => fn(x))));

// Stages a lane's work, reverts files the plan forbids it to change, commits the rest.
export function commitLane(wt, sessions, s, regen, msg) {
  git(wt, "add", "-A");
  const staged = git(wt, "diff", "--cached", "--name-only").out.split("\n").filter(Boolean);
  const reverted = [];
  for (const f of staged) {
    if (!blockReason(sessions, s, regen, f)) continue;
    reverted.push(f);
    git(wt, "reset", "-q", "--", f);
    if (git(wt, "cat-file", "-e", `HEAD:${f}`).ok) git(wt, "checkout", "--", f); else git(wt, "clean", "-fq", "--", f);
  }
  const c = git(wt, "commit", "-qm", msg);
  return { committed: c.ok, reverted };
}

export function brief(s, sessions, regen, test, note = "") {
  const others = sessions.filter((x) => x !== s).map((x) => x.name);
  return [
    `You are session "${s.name}" of a parallel fan-out. ${others.length ? `Other agents are working on ${others.join(", ")} at the same time.` : ""}`,
    `Task: ${s.task || s.done || s.name}`,
    s.done ? `Done when: ${s.done}` : "",
    `You may change only: ${s.owns.join(", ")}. Edits anywhere else are refused or reverted.`,
    s.uses.length ? `Shared interfaces you build against (frozen: read them, don't edit them): ${s.uses.join(", ")}.` : "",
    regen.length ? `Generated files (${regen.flatMap((r) => r.paths).join(", ")}) are rebuilt after merging; you may run the generator to test, but your changes to them are discarded.` : "",
    test ? `Run \`${test}\` before you finish.` : "",
    "Don't commit: your work is committed for you. Read only the files you need.",
    note,
  ].filter(Boolean).join("\n");
}

const log = (...a) => console.log("fanout:", ...a);

// The planner gets the plan rules and the repo's file list up front instead of reading the whole skill
// and exploring (it took 17 turns that way on the library benchmark). It reads only the code it needs
// to write the contracts.
export function plannerPrompt({ goal, base, root, extra = "" }) {
  const files = git(root, "ls-files").out.split("\n").filter(Boolean);
  const list = files.slice(0, 300).join("\n") + (files.length > 300 ? `\n… and ${files.length - 300} more` : "");
  return `Plan a parallel fan-out for the goal below, then stop. The fanout script is ${SCRIPT} (run it with node).

1. Write .fanout/plan.md in exactly this shape:

test: <the project's full test command>
regen: <generated paths> via <command>      (one line per set of generated files several sessions would touch; omit if none)

## <session-name>
owns: <paths or globs only this session may change>
task: <one line: what this session builds>
done: <how to tell it is finished>
exposes: <files of its own that other sessions build against>   (optional)
uses: <exposed files from other sessions it builds against>      (optional)

Rules: every file has at most one owner. Keep sessions few, substantial and independent; if the goal is small, use one session. Anything several sessions need (shared types, function signatures, changes to a shared module) belongs to one owner and is listed under its exposes and the others' uses.

2. Run \`node "${SCRIPT}" check\` and fix the plan until it reports no problems and no NOTE.
3. If anything is exposed, write those files on ${base} now as working interfaces or stubs the other sessions can build against, run the tests, and commit ("fanout: contracts"). Don't implement the rest of the tasks, create worktrees or start sessions: that happens next. Treat the plan as approved.
${extra}
Files in the repository:
${list}

Goal: ${goal}`;
}

export async function cli(argv) {
  const flag = (f) => argv.includes(f);
  const opt = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };
  const goal = argv[0] && !argv[0].startsWith("--") ? argv[0] : null;
  const defaultAgent = opt("--agent", "claude"), model = opt("--model"), budget = opt("--budget");
  const maxFixes = Number(opt("--fixes", "2"));
  const root = mainRoot(process.cwd());
  const base = git(root, "branch", "--show-current").out.trim();
  if (!base) { console.error("fanout run: check out the branch to build on first (e.g. main)."); return 2; }
  if (git(root, "status", "--porcelain").out.split("\n").some((l) => l && !l.slice(3).startsWith(".fanout/"))) {
    console.error("fanout run: commit or stash your changes first; the run builds on a clean " + base + ".");
    return 2;
  }
  mkdirSync(join(root, ".fanout"), { recursive: true });
  const exclude = join(root, ".git", "info", "exclude");
  if (!(existsSync(exclude) && readFileSync(exclude, "utf8").includes(".fanout/"))) appendFileSync(exclude, "\n.fanout/\n");
  const planPath = join(root, ".fanout", "plan.md");
  const start = git(root, "rev-parse", "HEAD").out.trim();
  const agents = [], fixes = {}, phases = {}, t0 = Date.now();
  let testRuns = 0, phaseStart = t0, sessions = [];
  const phase = (name) => { const now = Date.now(); phases[name] = Math.round((now - phaseStart) / 1000); phaseStart = now; };
  const track = (role, session, r) => { agents.push({ role, session, ...r }); return r; };
  const totals = () => {
    const known = agents.filter((a) => a.costUsd != null);
    return { costUsd: known.reduce((a, x) => a + x.costUsd, 0), costUnknown: known.length < agents.length,
      tokens: agents.reduce((a, x) => a + x.inTokens + x.outTokens, 0), fixes: Object.values(fixes).reduce((a, b) => a + b, 0) };
  };
  // Every path that got past the preconditions ends here, so each run leaves one line in .fanout/log.jsonl.
  const finish = (code, result) => {
    appendLog(root, { kind: "run", sessions: sessions.length, seconds: Math.round((Date.now() - t0) / 1000), phases, testRuns, ...totals(), result,
      agents: agents.map((a) => ({ role: a.role, session: a.session, agent: a.agent.split(" ")[0], seconds: a.seconds, costUsd: a.costUsd, tokens: a.inTokens + a.outTokens, error: a.error })) });
    return code;
  };

  // 1. Plan
  if (!existsSync(planPath)) {
    if (!goal) { console.error('fanout run: no .fanout/plan.md. Pass a goal: fanout run "add coupons and tax"'); return 2; }
    log("planning…");
    const prompt = plannerPrompt({ goal, base, root });
    for (let i = 0; i < 2; i++) {
      track("plan", null, await runAgent({ agent: "claude", cwd: root, prompt: i ? `${prompt}\n\nThe plan you wrote fails the check:\n${tail(sh(`node "${SCRIPT}" check`, root).out)}\nFix it.` : prompt, model, budget, plugin: true, allowGit: true }));
      if (existsSync(planPath) && sh(`node "${SCRIPT}" check`, root).ok) break;
    }
  }
  if (!existsSync(planPath)) { console.error("fanout run: no plan was written."); return finish(1, "no plan"); }
  const text = readFileSync(planPath, "utf8"), regen = parseRegen(text), test = planSetting(text, "test");
  sessions = parsePlan(text);
  phase("plan");
  const { problems, order } = check(sessions, root, regen);
  if (problems.length) { problems.forEach((p) => console.log(p)); console.error("fanout run: fix the plan, then run again."); return finish(1, "plan invalid"); }

  // 2. Approve
  console.log(`\n${text.trim()}\n\nMerge order: ${order.join(" -> ")}`);
  if (!flag("--yes")) {
    if (!process.stdin.isTTY) { console.log("\nRun again with --yes to start these sessions."); return agents.length ? finish(0, "planned") : 0; }
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const ok = /^y/i.test(await rl.question("\nStart these sessions? [y/N] "));
    rl.close();
    if (!ok) { log(`not started. Plan kept at .fanout/plan.md; anything committed since ${start.slice(0, 7)} is still on ${base}.`); return finish(0, "not started"); }
  }
  phaseStart = Date.now(); // time spent waiting for approval isn't the tool's

  // 3. Lanes
  sh(`node "${SCRIPT}" install-git-hook`, root);
  const wt = Object.fromEntries(sessions.map((s) => [s.name, join(root, ".fanout", "lanes", s.name)]));
  for (const s of sessions) {
    if (!existsSync(wt[s.name])) {
      const exists = git(root, "rev-parse", "--verify", "--quiet", `fanout/${s.name}`).ok;
      const r = exists ? git(root, "worktree", "add", "-q", wt[s.name], `fanout/${s.name}`) : git(root, "worktree", "add", "-q", "-b", `fanout/${s.name}`, wt[s.name], base);
      if (!r.ok) { console.error(`fanout run: can't create the worktree for ${s.name}:\n${r.out}`); return finish(1, "worktree failed"); }
    }
  }
  const agentFor = (s) => s.agent || defaultAgent;
  log(`starting ${sessions.length} sessions: ${sessions.map((s) => `${s.name} (${agentFor(s)})`).join(", ")}`);
  const lanes = await staggered(sessions, (s) => runAgent({ agent: agentFor(s), cwd: wt[s.name], prompt: brief(s, sessions, regen, test), model, budget }));
  sessions.forEach((s, i) => track("lane", s.name, lanes[i]));
  const session = Object.fromEntries(sessions.map((s, i) => [s.name, lanes[i].sessionId]));
  sessions.forEach((s, i) => {
    const { reverted } = commitLane(wt[s.name], sessions, s, regen, `fanout: ${s.name}`);
    log(`${s.name}: done in ${lanes[i].seconds}s${lanes[i].error ? `, agent error: ${lanes[i].error}` : ""}${reverted.length ? `, reverted out-of-lane: ${reverted.join(", ")}` : ""}`);
  });

  phase("sessions");

  // 4. Rehearse, and send each break back to the lane that caused it
  for (;;) {
    const r = rehearse(order, { cwd: root, base, test, regen });
    testRuns += r.testRuns;
    if (r.ok) { log("rehearse: all branches merge and pass together"); break; }
    const head = r.log.find((l) => /^(BROKE after|CONFLICT merging|REGEN FAILED after) /.test(l)) ?? "";
    const name = head.match(/(?:after|merging) ([^\s:]+)/)?.[1];
    const s = sessions.find((x) => x.name === name);
    if (!s) {
      // FLAKY or BASE FAILS: no lane caused it, so no agent is sent to fix it.
      console.log(r.log.join("\n"));
      log("stopped: rehearse found a problem no session caused (above). Fix it on " + base + ", then run again.");
      return finish(1, r.log.some((l) => l.startsWith("FLAKY")) ? "stopped: flaky test" : "stopped: tests fail on base");
    }
    log(`rehearse: ${head.split(":")[0]}`);
    if ((fixes[name] = (fixes[name] ?? 0) + 1) > maxFixes) {
      console.log(r.log.join("\n"));
      log(`stopped: ${name ?? "a lane"} still breaks after ${maxFixes} fixes. Its work is in .fanout/lanes/${name}; fix it there, then run again.`);
      return finish(1, `stopped: ${name} still breaks`);
    }
    const report = `Your branch was merged with the others in plan order and it broke:\n${r.log.join("\n")}\n\nFix it within the files you may change.`;
    // Resume the lane's own session with just the break report; if that fails, send the full brief again.
    const fix = await runAgent({ agent: agentFor(s), cwd: wt[name], model, budget, resume: session[name], prompt: report,
      fallbackPrompt: brief(s, sessions, regen, test, `\n${report}`) });
    session[name] = fix.sessionId ?? session[name];
    track("fix", name, fix);
    commitLane(wt[name], sessions, s, regen, `fanout: fix ${name}`);
  }

  // 5. Merge
  phase("rehearse");
  const stats = () => {
    const t = totals();
    return `${agents.length} agent runs, ${t.fixes} fixes, $${t.costUsd.toFixed(2)}${t.costUnknown ? " + unknown" : ""} agent cost, ${Math.round(t.tokens / 1000)}k tokens, ${Math.round((Date.now() - t0) / 1000)}s`;
  };
  if (flag("--no-merge")) { log(`ready to merge in order ${order.join(" -> ")} (${stats()})`); return finish(0, "ready to merge"); }
  for (const name of order) {
    const m = git(root, "merge", "--no-ff", "--no-edit", "-m", `fanout: merge ${name}`, `fanout/${name}`);
    if (!m.ok) { git(root, "merge", "--abort"); console.error(`fanout run: merging ${name} into ${base} conflicted, though rehearse passed. Is ${base} changed?\n${tail(m.out)}`); return finish(1, "merge conflict"); }
  }
  for (const g of regen) if (g.cmd) sh(g.cmd, root);
  git(root, "add", "-A"); git(root, "commit", "-qm", "fanout: regenerate");
  const final = test ? sh(test, root) : { ok: true };
  if (test) testRuns++;
  for (const s of sessions) { git(root, "worktree", "remove", "--force", wt[s.name]); git(root, "branch", "-D", `fanout/${s.name}`); }
  phase("merge");
  log(`${final.ok ? "merged" : "merged, but tests fail"} into ${base}: ${order.join(" -> ")} (${stats()})`);
  if (!final.ok) console.log(tail(final.out));
  return finish(final.ok ? 0 : 1, final.ok ? "merged" : "merged, tests fail");
}
