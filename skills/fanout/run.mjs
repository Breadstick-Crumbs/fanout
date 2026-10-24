// fanout run: the whole fan-out as one command.
//   fanout run ["goal"] [--yes] [--agent claude|codex|"<cmd>"] [--model m] [--budget usd] [--fixes 2] [--no-merge]
//
// 1. Plan: uses .fanout/plan.md if it exists; otherwise a coordinator agent writes it from the goal,
//    following SKILL.md, and commits the contract files.
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
import { readFileSync, existsSync, appendFileSync, mkdirSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parsePlan, parseRegen, planSetting, check, rehearse, blockReason, mainRoot } from "./fanout.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SKILL = join(HERE, "SKILL.md"), SCRIPT = join(HERE, "fanout.mjs");
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

// Runs one agent with the prompt on stdin. Never throws; returns cost, tokens, seconds and any error.
export function runAgent({ agent = "claude", cwd, prompt, model, budget, plugin = false, allowGit = false }) {
  const rec = { agent, seconds: 0, costUsd: 0, inTokens: 0, outTokens: 0, error: null };
  const t0 = Date.now();
  let cmd;
  if (agent === "claude") {
    const tools = ["Read", "Edit", "Write", "Glob", "Grep", "Bash(node:*)", "Bash(npm:*)", "Bash(npx:*)", ...(allowGit ? ["Bash(git:*)"] : [])];
    cmd = ["claude", "-p", "--permission-mode", "acceptEdits", "--allowedTools", q(tools.join(",")), "--output-format", "json",
      "--strict-mcp-config", ...(model ? ["--model", model] : []), ...(budget ? ["--max-budget-usd", budget] : []),
      ...(plugin ? ["--plugin-dir", q(PLUGIN_ROOT)] : [])].join(" ");
  } else if (agent === "codex") {
    cmd = ["codex", "exec", "--json", "-s", "workspace-write", "--skip-git-repo-check", "-C", q(cwd), ...(model ? ["-m", model] : [])].join(" ");
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
          const j = JSON.parse(out.slice(out.indexOf("{")));
          const u = j.usage ?? {};
          rec.costUsd = j.total_cost_usd ?? 0;
          rec.inTokens = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
          rec.outTokens = u.output_tokens ?? 0;
          if (j.is_error) rec.error = String(j.result ?? j.subtype).slice(0, 200);
        } else if (agent === "codex") {
          for (const line of out.split("\n")) {
            if (!line.startsWith("{")) continue;
            const e = JSON.parse(line);
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
  const agents = [];

  // 1. Plan
  if (!existsSync(planPath)) {
    if (!goal) { console.error('fanout run: no .fanout/plan.md. Pass a goal: fanout run "add coupons and tax"'); return 2; }
    log("planning…");
    const prompt = `Follow the fanout skill at ${SKILL} (read it first; its script is ${SCRIPT}, run it with node). Do only steps 1 to 3 for this goal: write .fanout/plan.md, give every session a one-line "task:" saying exactly what it builds, run check until it passes with no NOTE, then write and commit the contract files on ${base}. Don't create worktrees or start sessions: that happens next. Treat the plan as approved.\n\nGoal: ${goal}`;
    for (let i = 0; i < 2; i++) {
      agents.push(await runAgent({ agent: "claude", cwd: root, prompt: i ? `${prompt}\n\nThe plan you wrote fails the check:\n${tail(sh(`node "${SCRIPT}" check`, root).out)}\nFix it.` : prompt, model, budget, plugin: true, allowGit: true }));
      if (existsSync(planPath) && sh(`node "${SCRIPT}" check`, root).ok) break;
    }
  }
  if (!existsSync(planPath)) { console.error("fanout run: no plan was written."); return 1; }
  const text = readFileSync(planPath, "utf8"), sessions = parsePlan(text), regen = parseRegen(text), test = planSetting(text, "test");
  const { problems, order } = check(sessions, root, regen);
  if (problems.length) { problems.forEach((p) => console.log(p)); console.error("fanout run: fix the plan, then run again."); return 1; }

  // 2. Approve
  console.log(`\n${text.trim()}\n\nMerge order: ${order.join(" -> ")}`);
  if (!flag("--yes")) {
    if (!process.stdin.isTTY) { console.log("\nRun again with --yes to start these sessions."); return 0; }
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const ok = /^y/i.test(await rl.question("\nStart these sessions? [y/N] "));
    rl.close();
    if (!ok) { log(`not started. Plan kept at .fanout/plan.md; anything committed since ${start.slice(0, 7)} is still on ${base}.`); return 0; }
  }

  // 3. Lanes
  sh(`node "${SCRIPT}" install-git-hook`, root);
  const wt = Object.fromEntries(sessions.map((s) => [s.name, join(root, ".fanout", "lanes", s.name)]));
  for (const s of sessions) {
    if (!existsSync(wt[s.name])) {
      const exists = git(root, "rev-parse", "--verify", "--quiet", `fanout/${s.name}`).ok;
      const r = exists ? git(root, "worktree", "add", "-q", wt[s.name], `fanout/${s.name}`) : git(root, "worktree", "add", "-q", "-b", `fanout/${s.name}`, wt[s.name], base);
      if (!r.ok) { console.error(`fanout run: can't create the worktree for ${s.name}:\n${r.out}`); return 1; }
    }
  }
  const agentFor = (s) => s.agent || defaultAgent;
  log(`starting ${sessions.length} sessions: ${sessions.map((s) => `${s.name} (${agentFor(s)})`).join(", ")}`);
  const lanes = await Promise.all(sessions.map((s) => runAgent({ agent: agentFor(s), cwd: wt[s.name], prompt: brief(s, sessions, regen, test), model, budget })));
  agents.push(...lanes);
  sessions.forEach((s, i) => {
    const { reverted } = commitLane(wt[s.name], sessions, s, regen, `fanout: ${s.name}`);
    log(`${s.name}: done in ${lanes[i].seconds}s${lanes[i].error ? `, agent error: ${lanes[i].error}` : ""}${reverted.length ? `, reverted out-of-lane: ${reverted.join(", ")}` : ""}`);
  });

  // 4. Rehearse, and send each break back to the lane that caused it
  const fixes = {};
  for (;;) {
    const r = rehearse(order, { cwd: root, base, test, regen });
    if (r.ok) { log("rehearse: all branches merge and pass together"); break; }
    const head = r.log.find((l) => /^(BROKE after|CONFLICT merging|REGEN FAILED after) /.test(l)) ?? "";
    const name = head.match(/(?:after|merging) ([^\s:]+)/)?.[1];
    const s = sessions.find((x) => x.name === name);
    log(`rehearse: ${head.split(":")[0]}`);
    if (!s || (fixes[name] = (fixes[name] ?? 0) + 1) > maxFixes) {
      console.log(r.log.join("\n"));
      log(`stopped: ${name ?? "a lane"} still breaks after ${maxFixes} fixes. Its work is in .fanout/lanes/${name}; fix it there, then run again.`);
      return 1;
    }
    const fix = await runAgent({ agent: agentFor(s), cwd: wt[name], model, budget,
      prompt: brief(s, sessions, regen, test, `\nYour branch was merged with the others in plan order and it broke:\n${r.log.join("\n")}\n\nFix it within the files you may change.`) });
    agents.push(fix);
    commitLane(wt[name], sessions, s, regen, `fanout: fix ${name}`);
  }

  // 5. Merge
  const cost = agents.reduce((a, x) => a + x.costUsd, 0), tokens = agents.reduce((a, x) => a + x.inTokens + x.outTokens, 0);
  const stats = `${agents.length} agent runs, ${Object.values(fixes).reduce((a, b) => a + b, 0)} fixes, $${cost.toFixed(2)} Claude, ${Math.round(tokens / 1000)}k tokens`;
  if (flag("--no-merge")) { log(`ready to merge in order ${order.join(" -> ")} (${stats})`); return 0; }
  for (const name of order) {
    const m = git(root, "merge", "--no-ff", "--no-edit", "-m", `fanout: merge ${name}`, `fanout/${name}`);
    if (!m.ok) { git(root, "merge", "--abort"); console.error(`fanout run: merging ${name} into ${base} conflicted, though rehearse passed. Is ${base} changed?\n${tail(m.out)}`); return 1; }
  }
  for (const g of regen) if (g.cmd) sh(g.cmd, root);
  git(root, "add", "-A"); git(root, "commit", "-qm", "fanout: regenerate");
  const final = test ? sh(test, root) : { ok: true };
  for (const s of sessions) { git(root, "worktree", "remove", "--force", wt[s.name]); git(root, "branch", "-D", `fanout/${s.name}`); }
  log(`${final.ok ? "merged" : "merged, but tests fail"} into ${base}: ${order.join(" -> ")} (${stats})`);
  if (!final.ok) console.log(tail(final.out));
  return final.ok ? 0 : 1;
}
