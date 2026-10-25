import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAgent, brief, plannerPrompt, staggered, allowCommands } from "../skills/fanout/run.mjs";
import { parsePlan } from "../skills/fanout/fanout.mjs";
import { scrub } from "../bench/scrub.mjs";
import { execFileSync, spawnSync } from "node:child_process";

// A fake claude/codex: logs its args and stdin as one JSON line, then answers like the real CLI would.
const dir = mkdtempSync(join(tmpdir(), "fanout-run-"));
const logFile = join(dir, "calls.jsonl");
const fake = join(dir, "fake.mjs");
writeFileSync(fake, `
import { appendFileSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
const args = process.argv.slice(2), stdin = readFileSync(0, "utf8");
appendFileSync(${JSON.stringify(logFile)}, JSON.stringify({ args, stdin }) + "\\n");
const who = stdin.match(/session "(\\w+)"/)?.[1];
if (who && process.env.FAKE_FAIL_SESSION === who) { console.log(JSON.stringify({ is_error: true, result: "crashed", num_turns: 3 })); process.exit(1); }
if (who && process.env.FAKE_WRITE && process.env.FAKE_NOWRITE !== who) writeFileSync((process.env.FAKE_WRITE_DIR ?? "") + who + ".txt", "x");
// The contracts agent for a drafted plan: writes the contract; with FAKE_BAD it breaks the test until told.
if (stdin.startsWith("fanout drafted")) {
  const [f, body] = (process.env.FAKE_CONTRACT ?? "").split("=");
  if (f) writeFileSync(f, body);
  if (process.env.FAKE_BAD && !stdin.includes("the tests fail")) writeFileSync("BAD", "");
  else if (process.env.FAKE_BAD) unlinkSync("BAD");
}
if (process.env.FAKE_PLAN && stdin.startsWith("Plan a parallel fan-out")) { writeFileSync(".fanout/plan.md", process.env.FAKE_PLAN); writeFileSync("contract.txt", "shared"); }
const resuming = args.includes("--resume") || args.includes("resume");
if (resuming && process.env.FAKE_FAIL_RESUME) { console.log(JSON.stringify({ is_error: true, result: "no such session" })); process.exit(1); }
if (process.env.FAKE_FAIL_LEAN && args.includes("--setting-sources")) { console.log(JSON.stringify({ is_error: true, result: "auth failed", num_turns: Number(process.env.FAKE_FAIL_LEAN) - 1 || undefined })); process.exit(1); }
if (args[0] === "exec") {
  console.log(JSON.stringify({ type: "thread.started", thread_id: "thread-7" }));
  console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 5, output_tokens: 2 } }));
} else {
  console.log(JSON.stringify({ session_id: resuming ? "sess-2" : "sess-1", total_cost_usd: 0.5, usage: { input_tokens: 1, output_tokens: 2 } }));
}
`);
const calls = () => readFileSync(logFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
const useFake = () => {
  writeFileSync(logFile, "");
  process.env.FANOUT_CLAUDE_BIN = process.env.FANOUT_CODEX_BIN = `node "${fake}"`;
  delete process.env.FAKE_FAIL_RESUME;
  delete process.env.FAKE_FAIL_LEAN;
  delete process.env.FANOUT_USER_SETTINGS;
  delete process.env.FAKE_FAIL_SESSION;
  delete process.env.FAKE_NOWRITE;
  process.env.FAKE_WRITE = "1"; // session agents write <name>.txt, so they leave a change to commit
};
const mkRepo = (plan) => {
  const repo = mkdtempSync(join(tmpdir(), "fanout-rr-"));
  const g = (...a) => execFileSync("git", a, { cwd: repo, stdio: "ignore" });
  g("init", "-q", "-b", "main"); g("config", "user.email", "t@t"); g("config", "user.name", "t");
  writeFileSync(join(repo, "x.txt"), "1"); g("add", "-A"); g("commit", "-qm", "init");
  mkdirSync(join(repo, ".fanout"));
  writeFileSync(join(repo, ".fanout/plan.md"), plan);
  return repo;
};
const runCli = (repo, env = {}) => spawnSync(process.execPath, [join(import.meta.dirname, "../skills/fanout/fanout.mjs"), "run", "--yes", "--no-merge"],
  { cwd: repo, encoding: "utf8", env: { ...process.env, FANOUT_STAGGER_MS: "0", ...env } });
const PLAN_A = "## a\nowns: a.txt\ntask: a\n", PLAN_AB = PLAN_A + "\n## b\nowns: b.txt\ntask: b\n";
const callsFor = (n) => calls().filter((c) => c.stdin.includes(`session "${n}"`)).length;
const runLog = (repo) => readFileSync(join(repo, ".fanout/log.jsonl"), "utf8");

test("claude run records session id and uses the slim tool set", async () => {
  useFake();
  const r = await runAgent({ agent: "claude", cwd: dir, prompt: "full brief" });
  assert.equal(r.error, null);
  assert.equal(r.sessionId, "sess-1");
  assert.equal(r.costUsd, 0.5);
  const [c] = calls();
  assert.ok(!c.args.includes("--resume"));
  assert.equal(c.args[c.args.indexOf("--tools") + 1], "Read,Edit,Write,Glob,Grep,Bash");
  assert.equal(c.stdin, "full brief");
});

test("claude resume sends only the break report", async () => {
  useFake();
  const r = await runAgent({ agent: "claude", cwd: dir, prompt: "just the break", fallbackPrompt: "full brief + break", resume: "sess-1" });
  assert.equal(r.error, null);
  assert.equal(r.sessionId, "sess-2");
  const cs = calls();
  assert.equal(cs.length, 1);
  assert.equal(cs[0].args[cs[0].args.indexOf("--resume") + 1], "sess-1");
  assert.equal(cs[0].stdin, "just the break");
});

test("a failed resume falls back to a fresh full brief", async () => {
  useFake();
  process.env.FAKE_FAIL_RESUME = "1";
  const r = await runAgent({ agent: "claude", cwd: dir, prompt: "just the break", fallbackPrompt: "full brief + break", resume: "gone" });
  delete process.env.FAKE_FAIL_RESUME;
  assert.equal(r.error, null);
  assert.equal(r.sessionId, "sess-1");
  const cs = calls();
  assert.equal(cs.length, 2);
  assert.ok(cs[0].args.includes("--resume"));
  assert.ok(!cs[1].args.includes("--resume"));
  assert.equal(cs[1].stdin, "full brief + break");
});

test("codex run records thread id and resumes it", async () => {
  useFake();
  const first = await runAgent({ agent: "codex", cwd: dir, prompt: "full brief" });
  assert.equal(first.sessionId, "thread-7");
  assert.equal(first.inTokens, 5);
  await runAgent({ agent: "codex", cwd: dir, prompt: "just the break", resume: first.sessionId });
  const c = calls()[1];
  assert.deepEqual(c.args.slice(-2), ["resume", "thread-7"]);
  assert.equal(c.stdin, "just the break");
});

test("shell-command agents have no session to resume", async () => {
  useFake();
  const r = await runAgent({ agent: `node -e "process.stdin.resume()"`, cwd: dir, prompt: "x" });
  assert.equal(r.sessionId, null);
  assert.equal(r.error, null);
});

test("claude agents start lean: project settings only, fanout's guard loaded directly", async () => {
  useFake();
  await runAgent({ agent: "claude", cwd: dir, prompt: "x" });
  const [lean] = calls();
  assert.equal(lean.args[lean.args.indexOf("--setting-sources") + 1], "project,local");
  // The guard comes from a settings file with a plain hook, not --plugin-dir (which would make Claude Code
  // protect fanout's own files from edits).
  assert.ok(!lean.args.includes("--plugin-dir"));
  const settings = JSON.parse(readFileSync(lean.args[lean.args.indexOf("--settings") + 1], "utf8"));
  const [hook] = settings.hooks.PreToolUse;
  assert.match(hook.matcher, /Edit/);
  assert.match(hook.hooks[0].command, /fanout\.mjs" guard$/);
  assert.ok(lean.args[lean.args.indexOf("--allowedTools") + 1].includes("Bash(tail:*)"));
  useFake();
  process.env.FANOUT_USER_SETTINGS = "1";
  await runAgent({ agent: "claude", cwd: dir, prompt: "x" });
  assert.ok(!calls()[0].args.includes("--setting-sources"));
  delete process.env.FANOUT_USER_SETTINGS;
});

test("a lean start that fails before doing anything retries with the user's settings", async () => {
  useFake();
  process.env.FAKE_FAIL_LEAN = "1"; // fails with no turns, like a missing login or provider setting
  const r = await runAgent({ agent: "claude", cwd: dir, prompt: "brief" });
  assert.equal(r.error, null);
  assert.equal(r.fellBack, true);
  const [first, second] = calls();
  assert.ok(first.args.includes("--setting-sources"));
  assert.ok(!second.args.includes("--setting-sources"));
  assert.ok(second.args.includes("--settings"), "the guard still loads on the fallback");
  assert.equal(second.stdin, "brief");
});

test("a lean run that failed after doing work is not retried", async () => {
  useFake();
  process.env.FAKE_FAIL_LEAN = "4"; // failed after 3 turns: a real failure, not a setup problem
  const r = await runAgent({ agent: "claude", cwd: dir, prompt: "brief" });
  assert.match(r.error, /auth failed/);
  assert.equal(calls().length, 1);
});

test("brief pastes small contracts, names large ones, skips globs", () => {
  const root = mkdtempSync(join(tmpdir(), "fanout-brief-"));
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src/types.mjs"), "export const Money = 1;\n");
  writeFileSync(join(root, "src/big.mjs"), "x".repeat(9000));
  const [a, b] = parsePlan("## a\nowns: src/types.mjs\nexposes: src/types.mjs\n## b\nowns: src/b.mjs\nuses: src/types.mjs, src/gen/**\ntask: build b\n");
  const small = brief(b, [a, b], [], "npm test", "", root);
  assert.match(small, /--- src\/types\.mjs\nexport const Money = 1;/);
  assert.match(small, /Task: build b/);
  b.uses = ["src/big.mjs"];
  const large = brief(b, [a, b], [], "npm test", "", root);
  assert.match(large, /src\/big\.mjs/);
  assert.doesNotMatch(large, /xxxxxxxx/);
  assert.doesNotMatch(brief(b, [a, b], [], "npm test"), /---/); // no root: nothing pasted
});

test("brief asks for short tests only when told to", () => {
  const [a, b] = parsePlan("## a\nowns: a.mjs\n## b\nowns: b.mjs\n");
  assert.match(brief(b, [a, b], [], "npm test", "", null, { shortTests: true }), /at most 3/);
  assert.doesNotMatch(brief(b, [a, b], [], "npm test"), /at most 3/);
});

test("planner prompt carries the plan rules, the file list and the goal", () => {
  const root = mkdtempSync(join(tmpdir(), "fanout-plan-"));
  execFileSync("git", ["init", "-q"], { cwd: root });
  writeFileSync(join(root, "app.js"), "");
  execFileSync("git", ["add", "-A"], { cwd: root });
  const p = plannerPrompt({ goal: "add coupons", base: "main", root, extra: "Use two sessions." });
  for (const want of ["owns:", "exposes:", "fanout.mjs", "app.js", "Goal: add coupons", "Use two sessions.", "commit (\"fanout: contracts\")"])
    assert.ok(p.includes(want), want);
  assert.match(p, /at most 4 sessions/);
  assert.match(plannerPrompt({ goal: "g", base: "main", root, maxSessions: 2 }), /at most 2 sessions/);
});

test("staggered starts agents a gap apart, in order, and keeps results in order", async () => {
  const started = [];
  const t0 = Date.now();
  const out = await staggered(["a", "b", "c"], async (x) => { started.push([x, Date.now() - t0]); return x.toUpperCase(); }, 40);
  assert.deepEqual(out, ["A", "B", "C"]);
  assert.deepEqual(started.map(([x]) => x), ["a", "b", "c"]);
  assert.ok(started[2][1] >= 70, `third started at ${started[2][1]}ms`);
});

test("scrub replaces temp and home folders in every spelling", () => {
  const dirs = [["C:\\Users\\pat\\AppData\\Local\\Temp", "<tmp>"], ["C:\\Users\\pat", "~"]];
  const text = String.raw`cd C:\Users\pat\AppData\Local\Temp\x; cat C:/Users/pat/notes; ls /c/Users/pat; "C:\\Users\\pat\\AppData\\Local\\Temp\\y"`;
  const s = scrub(text, dirs, "pat");
  assert.doesNotMatch(s, /pat/);
  assert.match(s, /<tmp>\\x/);
  assert.match(s, /~\/notes/);
  // Claude's own folder names encode paths with dashes; the user name is caught even in odd spellings.
  const encoded = scrub("<tmp>/claude/C--Users-pat-AppData-Local-Temp-run/x and /home/pat-old/y", dirs, "pat");
  assert.doesNotMatch(encoded, /pat/);
  assert.equal(scrub("compatible pattern", dirs, "pat"), "compatible pattern"); // whole words only
});

test("fanout run uses each session's model, then --session-model, for session agents", () => {
  useFake();
  const repo = mkdtempSync(join(tmpdir(), "fanout-models-"));
  const g = (...a) => execFileSync("git", a, { cwd: repo, stdio: "ignore" });
  g("init", "-q", "-b", "main"); g("config", "user.email", "t@t"); g("config", "user.name", "t");
  writeFileSync(join(repo, "x.txt"), "1"); g("add", "-A"); g("commit", "-qm", "init");
  mkdirSync(join(repo, ".fanout"));
  writeFileSync(join(repo, ".fanout/plan.md"), "## a\nowns: a.txt\ntask: a\nmodel: haiku\n\n## b\nowns: b.txt\ntask: b\n");
  const r = spawnSync(process.execPath, [join(import.meta.dirname, "../skills/fanout/fanout.mjs"), "run", "--yes", "--model", "opus", "--session-model", "sonnet"],
    { cwd: repo, encoding: "utf8", env: { ...process.env, FANOUT_STAGGER_MS: "0" } });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const models = Object.fromEntries(calls().map((c) => [c.stdin.match(/session "(\w+)"/)?.[1], c.args[c.args.indexOf("--model") + 1]]));
  assert.deepEqual(models, { a: "haiku", b: "sonnet" });
});

test("a session agent that errors is retried once, then the run stops", () => {
  useFake();
  const repo = mkRepo(PLAN_AB);
  const r = runCli(repo, { FAKE_FAIL_SESSION: "b" });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.equal(callsFor("b"), 2);
  assert.equal(callsFor("a"), 1);
  assert.match(runLog(repo), /stopped: b agent failed/);
  assert.equal(execFileSync("git", ["rev-list", "--count", "main..fanout/b"], { cwd: repo, encoding: "utf8" }).trim(), "0");
});

test("a session with nothing to change is flagged, not retried, and the run goes on", () => {
  useFake();
  const repo = mkRepo(PLAN_AB);
  const r = runCli(repo, { FAKE_NOWRITE: "a" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(callsFor("a"), 1);
  assert.match(r.stdout, /a: done in \d+s, made no changes/);
});

test("if no session changed anything, the run stops instead of reporting success", () => {
  useFake();
  const repo = mkRepo(PLAN_A);
  const r = runCli(repo, { FAKE_NOWRITE: "a" });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.equal(callsFor("a"), 1);
  assert.match(r.stdout, /stopped: no session changed anything/);
  assert.match(runLog(repo), /stopped: no changes/);
});

test("session agents may not run npx", async () => {
  useFake();
  await runAgent({ agent: "claude", cwd: dir, prompt: "x" });
  const [c] = calls();
  const allowed = c.args[c.args.indexOf("--allowedTools") + 1];
  assert.ok(allowed.includes("Bash(npm:*)"));
  assert.ok(!allowed.includes("npx"));
});

test("planner prompt summarises a repo of more than 300 files by folder", () => {
  const root = mkdtempSync(join(tmpdir(), "fanout-big-"));
  execFileSync("git", ["init", "-q"], { cwd: root });
  for (const d of ["zeta", "alpha/sub"]) mkdirSync(join(root, d), { recursive: true });
  for (let i = 0; i < 200; i++) writeFileSync(join(root, "zeta", `f${i}.js`), "");
  for (let i = 0; i < 150; i++) writeFileSync(join(root, "alpha/sub", `g${i}.js`), "");
  writeFileSync(join(root, "README.md"), "");
  execFileSync("git", ["add", "-A"], { cwd: root });
  const p = plannerPrompt({ goal: "g", base: "main", root });
  assert.ok(!p.includes("f17.js"));
  assert.match(p, /alpha\/sub\/ \(150 files\)/);
  assert.match(p, /zeta\/ \(200 files\)/);
  assert.ok(p.indexOf("alpha/sub/") < p.indexOf("zeta/"));
  assert.match(p, /Top-level files:\nREADME\.md/);
});

test("running again after a stop reuses branches and skips finished sessions", () => {
  useFake();
  const repo = mkRepo(PLAN_AB);
  assert.equal(runCli(repo, { FAKE_FAIL_SESSION: "b" }).status, 1);
  writeFileSync(logFile, "");
  const r = runCli(repo);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(callsFor("a"), 0);
  assert.equal(callsFor("b"), 1);
  assert.match(r.stdout, /a: already has commits/);
});

test("status shows each session's agent state and cost from the run's live.json", () => {
  useFake();
  const repo = mkRepo(PLAN_AB);
  assert.equal(runCli(repo, { FAKE_FAIL_SESSION: "b" }).status, 1);
  const live = JSON.parse(readFileSync(join(repo, ".fanout/live.json"), "utf8"));
  assert.equal(live.phase, "finished");
  assert.equal(live.sessions.a.state, "done");
  assert.equal(live.sessions.a.costUsd, 0.5);
  assert.equal(live.sessions.b.state, "failed");
  const st = spawnSync(process.execPath, [join(import.meta.dirname, "../skills/fanout/fanout.mjs"), "status"], { cwd: repo, encoding: "utf8" });
  assert.match(st.stdout, /agent\s+cost/);
  assert.match(st.stdout, /^a .*done\s+\$0\.50$/m);
  assert.match(st.stdout, /^b .*failed\s+\$0\.00$/m);
  assert.doesNotMatch(st.stdout, /run in progress/);
});

test("contracts the planner leaves uncommitted are committed before the lanes branch", () => {
  useFake();
  const repo = mkRepo(PLAN_A);
  rmSync(join(repo, ".fanout/plan.md")); // no plan yet: the (fake) planner writes it, plus a contract it doesn't commit
  const r = spawnSync(process.execPath, [join(import.meta.dirname, "../skills/fanout/fanout.mjs"), "run", "add a", "--yes", "--no-merge"],
    { cwd: repo, encoding: "utf8", env: { ...process.env, FANOUT_STAGGER_MS: "0", FAKE_PLAN: PLAN_A } });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /committed 1 file\(s\) the planner left uncommitted/);
  const g = (...a) => execFileSync("git", a, { cwd: repo, encoding: "utf8" }).trim();
  assert.equal(g("log", "-1", "--format=%s", "main"), "fanout: contracts");
  assert.equal(g("show", "fanout/a:contract.txt"), "shared"); // the lane branched with it
});

// A repo for drafted plans: src/ exists, and the test fails while a file named BAD exists.
const draftRepo = (goal) => {
  const repo = mkdtempSync(join(tmpdir(), "fanout-dr-"));
  const g = (...a) => execFileSync("git", a, { cwd: repo, stdio: "ignore" });
  g("init", "-q", "-b", "main"); g("config", "user.email", "t@t"); g("config", "user.name", "t");
  mkdirSync(join(repo, "src"));
  writeFileSync(join(repo, "src/keep.txt"), "");
  writeFileSync(join(repo, "package.json"), JSON.stringify({ scripts: { test: `node -e "process.exit(require('fs').existsSync('BAD')?1:0)"` } }));
  writeFileSync(join(repo, "GOAL.md"), goal);
  g("add", "-A"); g("commit", "-qm", "init");
  return repo;
};
const runDraft = (repo, env = {}) => spawnSync(process.execPath, [join(import.meta.dirname, "../skills/fanout/fanout.mjs"), "run", "--goal-file", "GOAL.md", "--yes", "--no-merge"],
  { cwd: repo, encoding: "utf8", env: { ...process.env, FANOUT_STAGGER_MS: "0", FAKE_WRITE_DIR: "src/", ...env } });

test("a drafted plan is always reviewed by an agent, even when nothing is shared", () => {
  useFake();
  const repo = draftRepo("## a\nAdd `src/a.txt`, all of it.\n\n## b\nAdd `src/b.txt`.\n");
  const r = runDraft(repo);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const review = calls().filter((c) => c.stdin.startsWith("fanout drafted"));
  assert.equal(review.length, 1);
  assert.match(review[0].stdin, /without naming the file/);
  assert.equal(calls().length, 3); // the review and the two sessions
  assert.match(calls().find((c) => c.stdin.includes('session "a"')).stdin, /Full spec for this session:\n## a\nAdd `src\/a.txt`, all of it\./);
});

test("with shared files, an agent only writes the contracts; fanout tests and commits them", () => {
  useFake();
  const repo = draftRepo("## a\nAdd `src/a.txt`.\n\n## b\nAdd `src/b.txt`, built on `src/a.txt`.\n");
  const r = runDraft(repo, { FAKE_CONTRACT: "src/a.txt=stub" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const planner = calls().filter((c) => c.stdin.startsWith("fanout drafted"));
  assert.equal(planner.length, 1);
  assert.match(planner[0].stdin, /exposes: src\/a.txt/);
  assert.ok(!planner[0].args.join(" ").includes("Bash(git:*)")); // fanout commits, not the agent
  const g = (...a) => execFileSync("git", a, { cwd: repo, encoding: "utf8" }).trim();
  assert.equal(g("log", "-1", "--format=%s", "main"), "fanout: contracts");
  assert.equal(g("show", "fanout/b:src/a.txt"), "stub");
});

test("contracts that break the tests go back to the agent once, with the failure", () => {
  useFake();
  const repo = draftRepo("## a\nAdd `src/a.txt`.\n\n## b\nAdd `src/b.txt`, built on `src/a.txt`.\n");
  const r = runDraft(repo, { FAKE_CONTRACT: "src/a.txt=stub", FAKE_BAD: "1" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const planner = calls().filter((c) => c.stdin.startsWith("fanout drafted"));
  assert.equal(planner.length, 2);
  assert.match(planner[1].stdin, /the tests fail on main/);
});

test("the plan's test and check commands are allowed for session agents, as written", () => {
  assert.deepEqual(allowCommands(["bash tools/check-theme.sh", "", undefined, `node -e "x"`, "a, b"]), ["Bash(bash tools/check-theme.sh)"]);
});
