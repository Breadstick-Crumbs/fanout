import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAgent, brief, plannerPrompt, staggered, allowCommands, mixAgents, readyTracker, dependencies } from "../skills/fanout/run.mjs";
import { parsePlan } from "../skills/fanout/fanout.mjs";
import { scrub } from "../bench/scrub.mjs";
import { execFileSync, spawnSync } from "node:child_process";

// Claims' same-work check calls a real CLI; no test here may reach one.
process.env.FANOUT_CLAIM_JUDGE = "off";

// A fake claude/codex: logs its args and stdin as one JSON line, then answers like the real CLI would.
const dir = mkdtempSync(join(tmpdir(), "fanout-run-"));
const logFile = join(dir, "calls.jsonl");
const fake = join(dir, "fake.mjs");
writeFileSync(fake, `
import { appendFileSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
const args = process.argv.slice(2);
// Sign-in checks (claude auth status / codex login status) aren't agent calls, so they aren't logged.
if (args[0] === "auth") { console.log(JSON.stringify({ loggedIn: process.env.FAKE_SIGNED_OUT !== "claude" })); process.exit(0); }
if (args[0] === "login") { console.log(process.env.FAKE_SIGNED_OUT === "codex" ? "Not logged in" : "Logged in"); process.exit(process.env.FAKE_SIGNED_OUT === "codex" ? 1 : 0); }
const stdin = readFileSync(0, "utf8");
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
// Another session writing in the main checkout while fanout runs.
if (process.env.FAKE_STRAY && (who || stdin.startsWith("Plan a parallel fan-out"))) writeFileSync(process.env.FAKE_STRAY, "someone else's");
const resuming = args.includes("--resume") || args.includes("resume");
// An early-test failure report: the session fixes its file.
if (resuming && process.env.FAKE_FIX_FILE && stdin.includes("fails there")) writeFileSync(process.env.FAKE_FIX_FILE, "fixed");
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
  delete process.env.FAKE_SIGNED_OUT;
  process.env.FAKE_WRITE = "1"; // session agents write <name>.txt, so they leave a change to commit
};
const mkRepo = (plan, files = {}) => {
  const repo = mkdtempSync(join(tmpdir(), "fanout-rr-"));
  const g = (...a) => execFileSync("git", a, { cwd: repo, stdio: "ignore" });
  g("init", "-q", "-b", "main"); g("config", "user.email", "t@t"); g("config", "user.name", "t");
  writeFileSync(join(repo, "x.txt"), "1");
  for (const [f, body] of Object.entries(files)) writeFileSync(join(repo, f), body);
  g("add", "-A"); g("commit", "-qm", "init");
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
  // Low reasoning effort by default, no tier; FANOUT_CODEX_EFFORT overrides, "default" leaves Codex's own.
  assert.ok(calls()[0].args.includes("model_reasoning_effort=low"));
  assert.ok(!calls()[0].args.some((a) => a.includes("service_tier")));
  process.env.FANOUT_CODEX_EFFORT = "high"; process.env.FANOUT_CODEX_TIER = "fast";
  await runAgent({ agent: "codex", cwd: dir, prompt: "brief" });
  process.env.FANOUT_CODEX_EFFORT = "default"; delete process.env.FANOUT_CODEX_TIER;
  await runAgent({ agent: "codex", cwd: dir, prompt: "brief" });
  delete process.env.FANOUT_CODEX_EFFORT;
  assert.ok(calls()[2].args.includes("model_reasoning_effort=high"));
  assert.ok(calls()[2].args.includes("service_tier=priority"));
  assert.ok(!calls()[3].args.some((a) => a.includes("model_reasoning_effort")));
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

test("contracts the planner leaves uncommitted are committed before the lanes branch; others' files are not", () => {
  useFake();
  const repo = mkRepo(PLAN_A);
  rmSync(join(repo, ".fanout/plan.md")); // no plan yet: the (fake) planner writes it, plus a contract it doesn't commit
  // While it plans, another session writes stray.txt in the same checkout: no session owns it, so it stays out.
  const r = spawnSync(process.execPath, [join(import.meta.dirname, "../skills/fanout/fanout.mjs"), "run", "add a", "--yes", "--no-merge"],
    { cwd: repo, encoding: "utf8", env: { ...process.env, FANOUT_STAGGER_MS: "0", FAKE_PLAN: "## a\nowns: a.txt, contract.txt\ntask: a\n", FAKE_STRAY: join(repo, "stray.txt") } });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /committed 1 file\(s\) the planner left uncommitted/);
  assert.match(r.stdout, /left 1 uncommitted file\(s\) outside the plan alone: stray\.txt/);
  const g = (...a) => execFileSync("git", a, { cwd: repo, encoding: "utf8" }).trim();
  assert.equal(g("log", "-1", "--format=%s", "main"), "fanout: contracts");
  assert.equal(g("show", "--name-only", "--format=", "main"), "contract.txt");
  assert.equal(g("show", "fanout/a:contract.txt"), "shared"); // the lane branched with it
  assert.match(g("status", "--porcelain"), /^\?\? stray\.txt$/m);
});

test("after merging, only the generated files are committed, not others' work in the checkout", () => {
  useFake();
  const repo = mkRepo("test: node -e \"\"\nregen: gen.txt via node gen.mjs\n\n" + PLAN_AB, { "gen.mjs": `import { writeFileSync } from "node:fs"; writeFileSync("gen.txt", "generated");` });
  const r = spawnSync(process.execPath, [join(import.meta.dirname, "../skills/fanout/fanout.mjs"), "run", "--yes"],
    { cwd: repo, encoding: "utf8", env: { ...process.env, FANOUT_STAGGER_MS: "0", FAKE_STRAY: join(repo, "stray.txt") } });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const g = (...a) => execFileSync("git", a, { cwd: repo, encoding: "utf8" }).trim();
  assert.equal(g("log", "-1", "--format=%s"), "fanout: regenerate");
  assert.equal(g("show", "--name-only", "--format=", "HEAD"), "gen.txt");
  assert.match(g("status", "--porcelain"), /^\?\? stray\.txt$/m);
});

test("a signed-out CLI stops the run before any agent starts", () => {
  useFake();
  const r = runCli(mkRepo(PLAN_AB), { FAKE_SIGNED_OUT: "claude" });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /claude is not signed in/);
  assert.equal(calls().length, 0);
  const codex = runCli(mkRepo(PLAN_A + "agent: codex\n\n## b\nowns: b.txt\ntask: b\n"), { FAKE_SIGNED_OUT: "codex" });
  assert.equal(codex.status, 1, codex.stdout + codex.stderr);
  assert.match(codex.stderr, /codex is not signed in/);
  assert.equal(calls().length, 0);
  // Signed out of Codex doesn't matter when no session uses it.
  assert.equal(runCli(mkRepo(PLAN_AB), { FAKE_SIGNED_OUT: "codex" }).status, 0);
});

test("--mix: 3 sessions in Claude, those others build on first, then the rest in plan order; Codex for the others", () => {
  const [core, mid, top, side] = parsePlan("## core\nowns: core.txt\nexposes: core.txt\n## mid\nowns: mid.txt\nexposes: mid.txt\nuses: core.txt\n## top\nowns: top.txt\nuses: mid.txt\n## side\nowns: side.txt\nagent: claude\n");
  assert.deepEqual(mixAgents([core, mid, top, side]), { core: "claude", mid: "claude", top: "codex", side: "claude" });
  // A chain of five: the four built on compete for three Claude slots, most dependents first.
  const chain = parsePlan([1, 2, 3, 4, 5].map((i) => `## s${i}\nowns: s${i}.txt\n${i < 5 ? `exposes: s${i}.txt\n` : ""}${i > 1 ? `uses: s${i - 1}.txt\n` : ""}`).join("\n"));
  assert.deepEqual(mixAgents(chain), { s1: "claude", s2: "claude", s3: "claude", s4: "codex", s5: "codex" });
  // Three sessions or fewer all fit in Claude.
  assert.deepEqual(mixAgents([core, mid, top]), { core: "claude", mid: "claude", top: "claude" });
  useFake();
  // core is built on, so it gets a Claude slot first although it comes third; docs and notes fill the other two.
  const plan = "## docs\nowns: docs.txt\ntask: docs\n\n## notes\nowns: notes.txt\ntask: notes\n\n## core\nowns: core.txt\nexposes: core.txt\ntask: core\n\n## ui\nowns: ui.txt\nuses: core.txt\ntask: ui\n";
  const r = spawnSync(process.execPath, [join(import.meta.dirname, "../skills/fanout/fanout.mjs"), "run", "--yes", "--no-merge", "--mix"],
    { cwd: mkRepo(plan, { "core.txt": "stub" }), encoding: "utf8", env: { ...process.env, FANOUT_STAGGER_MS: "0" } });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /Agents \(--mix.*\): docs claude, notes claude, core claude, ui codex/);
  const kinds = Object.fromEntries(calls().map((c) => [c.stdin.match(/session "(\w+)"/)?.[1], c.args[0] === "exec" ? "codex" : "claude"]));
  assert.deepEqual(kinds, { docs: "claude", notes: "claude", core: "claude", ui: "codex" });
});

// b builds on a; the test fails once both are in, until b's file says "fixed".
const PLAN_DEP = "test: node t.mjs\n\n## a\nowns: a.txt\nexposes: a.txt\ntask: a\n\n## b\nowns: b.txt\nuses: a.txt\ntask: b\n";
const T_DEP = `import { existsSync, readFileSync } from "node:fs";
if (existsSync("a.txt") && readFileSync("a.txt", "utf8") === "x" && existsSync("b.txt") && readFileSync("b.txt", "utf8") !== "fixed") { console.log("not ok 1 - b against a"); process.exit(1); }`;

test("a session that builds on another is tested against it as soon as both are done, and fixed at once", () => {
  useFake();
  const repo = mkRepo(PLAN_DEP, { "t.mjs": T_DEP, "a.txt": "stub" });
  const r = runCli(repo, { FAKE_FIX_FILE: "b.txt" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /b: tests fail with a merged in; sending it the failure now/);
  assert.match(r.stdout, /b: fixed in \d+s/);
  assert.match(r.stdout, /rehearse: all branches merge and pass together/);
  const fix = calls().find((c) => c.args.includes("--resume"));
  assert.match(fix.stdin, /a finished too and is now merged into your branch, and `node t\.mjs` fails there:\nnot ok 1 - b against a/);
  assert.equal(fix.args[fix.args.indexOf("--resume") + 1], "sess-1"); // b's own session
  const run = JSON.parse(runLog(repo).trim().split("\n").at(-1));
  assert.equal(run.earlyFixes, 1);
  assert.equal(run.fixes, 1);
});

test("the early test costs no agent when nothing breaks", () => {
  useFake();
  const repo = mkRepo(PLAN_DEP.replace("node t.mjs", "node -e \"\""), { "a.txt": "stub" });
  const r = runCli(repo);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /b: tests pass with a merged in/);
  assert.equal(calls().length, 2);
  assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: join(repo, ".fanout/lanes/b"), encoding: "utf8" }), "");
});

test("readyTracker: a session is ready once it and everything it builds on are settled", () => {
  const sessions = parsePlan("## a\nowns: a\nexposes: a\n## b\nowns: b\nexposes: b\nuses: a\n## c\nowns: c\nuses: b\n## d\nowns: d\n");
  const t = readyTracker(sessions), names = (xs) => xs.map((s) => s.name);
  assert.deepEqual(names(t.done("c")), []);
  assert.deepEqual(names(t.done("b")), []);
  assert.deepEqual(names(t.done("a")), ["b"]); // c waits for b's own early test
  assert.deepEqual(names(t.settle("b")), ["c"]);
  assert.deepEqual(names(t.done("d")), []);
  assert.deepEqual(dependencies(sessions).c.sort(), ["a", "b"]);
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

test("a drafted plan with no flags and nothing shared needs no planning agent; --review asks for one", () => {
  useFake();
  const goal = "## a\nAdd `src/a.txt`, all of it.\n\n## b\nAdd `src/b.txt`.\n";
  const r = runDraft(draftRepo(goal));
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(calls().filter((c) => c.stdin.startsWith("fanout drafted")).length, 0);
  assert.equal(calls().length, 2); // the two sessions
  assert.match(calls().find((c) => c.stdin.includes('session "a"')).stdin, /Full spec for this session:\n## a\nAdd `src\/a.txt`, all of it\./);
  useFake();
  const full = spawnSync(process.execPath, [join(import.meta.dirname, "../skills/fanout/fanout.mjs"), "run", "--goal-file", "GOAL.md", "--yes", "--no-merge", "--review"],
    { cwd: draftRepo(goal), encoding: "utf8", env: { ...process.env, FANOUT_STAGGER_MS: "0", FAKE_WRITE_DIR: "src/" } });
  assert.equal(full.status, 0, full.stdout + full.stderr);
  const review = calls().filter((c) => c.stdin.startsWith("fanout drafted"));
  assert.equal(review.length, 1);
  assert.match(review[0].stdin, /without naming the file/);
});

test("a name one session uses from a file another owns goes to an agent, with just that to check", () => {
  useFake();
  const repo = draftRepo("## a\nChange `src/store.mjs`: add `holds` to every store.\n\n## b\nAdd `src/b.txt`; `createStore` must start every store with `fines: []`.\n");
  writeFileSync(join(repo, "src/store.mjs"), "export function createStore() { return {}; }\n");
  execFileSync("git", ["add", "-A"], { cwd: repo }); execFileSync("git", ["commit", "-qm", "store"], { cwd: repo, stdio: "ignore" });
  const r = runDraft(repo);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /checking 1 name\(s\) used across sessions/);
  const review = calls().filter((c) => c.stdin.startsWith("fanout drafted"));
  assert.equal(review.length, 1);
  assert.match(review[0].stdin, /- b: `createStore` \(src\/store\.mjs, owned by a\)/);
  assert.doesNotMatch(review[0].stdin, /without naming the file|working interface/);
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

test("a session gets what the owner's part of the goal says about the contract's exports", () => {
  useFake();
  const repo = draftRepo("Shared notes for all.\n\n## a\nAdd `src/a.mjs`.\n- `parse(text)`: takes the text without the leading `=`.\n- Unrelated detail.\n\n## b\nAdd `src/b.txt`, built on `src/a.mjs`.\n");
  const r = runDraft(repo, { FAKE_CONTRACT: "src/a.mjs=export function parse(text) { throw new Error(); }\n" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const b = calls().find((c) => c.stdin.includes('session "b"')).stdin;
  assert.match(b, /What the goal says about src\/a\.mjs \(from a's part; build against exactly this\):\n- `parse\(text\)`: takes the text without the leading `=`\./);
  assert.doesNotMatch(b.slice(b.indexOf("What the goal says")), /Unrelated detail|Shared notes/);
  assert.doesNotMatch(calls().find((c) => c.stdin.includes('session "a"')).stdin, /What the goal says/);
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

test("fanout run --help prints the options and starts nothing, even with a plan there", () => {
  useFake();
  const repo = mkRepo(PLAN_AB);
  const r = spawnSync(process.execPath, [join(import.meta.dirname, "../skills/fanout/fanout.mjs"), "run", "--help"], { cwd: repo, encoding: "utf8" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^usage: fanout run/);
  assert.match(r.stdout, /--no-merge/);
  assert.doesNotMatch(r.stdout, /## a/);
  assert.equal(calls().length, 0);
});

test("the plan's test and check commands are allowed for session agents, as written", () => {
  assert.deepEqual(allowCommands(["bash tools/check-theme.sh", "", undefined, `node -e "x"`, "a, b"]), ["Bash(bash tools/check-theme.sh)"]);
});
