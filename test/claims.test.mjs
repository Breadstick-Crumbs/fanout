import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync, spawn } from "node:child_process";
import { readState, writeState, liveClaims, isLive, judgePrompt, REF, activeCheckouts, claimsActive, taskFromTranscript } from "../skills/fanout/claims.mjs";

const FANOUT = join(import.meta.dirname, "../skills/fanout/fanout.mjs");
// A fake claude for the task judge: a session is the same work when its task and the new one share the word
// in FAKE_SAME_IF. FAKE_JUDGE_FAIL makes it fail like a signed-out CLI. Each call is logged.
const dir = mkdtempSync(join(tmpdir(), "fanout-claims-"));
const judgeLog = join(dir, "judge.jsonl"), fake = join(dir, "judge.mjs");
writeFileSync(fake, `
import { readFileSync, appendFileSync } from "node:fs";
if (process.argv[2] === "auth") { console.log(JSON.stringify({ loggedIn: true })); process.exit(0); }
const p = readFileSync(0, "utf8");
appendFileSync(${JSON.stringify(judgeLog)}, JSON.stringify({ args: process.argv.slice(2), p }) + "\\n");
if (process.env.FAKE_JUDGE_FAIL) { console.log(JSON.stringify({ is_error: true, result: "Not logged in" })); process.exit(1); }
if (process.env.FAKE_JUDGE_DELAY_MS) { const end = Date.now() + Number(process.env.FAKE_JUDGE_DELAY_MS); while (Date.now() < end); }
const task = p.match(/^New task: (.*)$/m)[1], w = process.env.FAKE_SAME_IF;
const sessions = [...p.matchAll(/^- ([\\w.-]+): (.*)$/gm)].map(([, name, t]) => ({ name, reason: "r", same: !!w && task.includes(w) && t.includes(w) }));
console.log(JSON.stringify({ result: JSON.stringify({ sessions }), total_cost_usd: 0.01 }));
`);
// Codex is a fake that is signed out, so no test can reach the real CLI when Claude's fake fails.
const noCodex = join(dir, "no-codex.mjs");
writeFileSync(noCodex, `process.exit(1);`);
const env = (extra = {}) => ({ ...process.env, FANOUT_CLAUDE_BIN: `node "${fake}"`, FANOUT_CODEX_BIN: `node "${noCodex}"`, FAKE_SAME_IF: "", FAKE_JUDGE_FAIL: "", ...extra });
const judgeCalls = () => (existsSync(judgeLog) ? readFileSync(judgeLog, "utf8").trim().split("\n").filter(Boolean).length : 0);

// A repo with claims on and two more worktrees (branches a and b), like three parallel sessions.
function repo() {
  const r = mkdtempSync(join(tmpdir(), "fanout-cr-"));
  const g = (...a) => execFileSync("git", a, { cwd: r, stdio: "ignore" });
  g("init", "-q", "-b", "main"); g("config", "user.email", "t@t"); g("config", "user.name", "t");
  writeFileSync(join(r, "x.txt"), "1"); writeFileSync(join(r, ".gitignore"), "build/\n"); g("add", "-A"); g("commit", "-qm", "init");
  g("worktree", "add", "-q", "-b", "a", join(r, "..", `${r.split(/[\\/]/).pop()}-a`));
  g("worktree", "add", "-q", "-b", "b", join(r, "..", `${r.split(/[\\/]/).pop()}-b`));
  return { root: r, a: join(r, "..", `${r.split(/[\\/]/).pop()}-a`), b: join(r, "..", `${r.split(/[\\/]/).pop()}-b`) };
}
const fan = (cwd, args, extra) => spawnSync(process.execPath, [FANOUT, ...args], { cwd, encoding: "utf8", env: env(extra) });
const guard = (cwd, file, extra) => spawnSync(process.execPath, [FANOUT, "guard"], { cwd, encoding: "utf8", env: env(extra), input: JSON.stringify({ cwd, tool_input: { file_path: join(cwd, file) } }) });

test("a claim lives on refs/fanout/state, not in anyone's files, and every worktree sees it at once", () => {
  const { root, a, b } = repo();
  const r = fan(a, ["claim", "currency", "format prices in the user's currency", "src/money.mjs"]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /claimed currency for a/);
  assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: a, encoding: "utf8" }), ""); // nothing in the diff
  const seen = fan(b, ["claims"]);
  assert.match(seen.stdout, /^currency {2}a {2}\d+m ago {2}format prices/m);
  assert.match(seen.stdout, /files: src\/money\.mjs/);
  assert.ok(readState(root).claims.currency);
  assert.equal(fan(b, ["release", "currency"]).status, 0);
  assert.match(fan(root, ["claims"]).stdout, /No live claims/);
});

test("a claim on files another session claimed is refused", () => {
  const { a, b } = repo();
  fan(a, ["claim", "currency", "format prices", "src/money.mjs"]);
  const r = fan(b, ["claim", "tax", "add tax", "src/**"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /src\/\*\* \(claimed by currency on a\)/);
});

test("the same task under other words is refused; --distinct lets a different one through", () => {
  const { a, b } = repo();
  fan(a, ["claim", "dark", "add a dark mode toggle to settings"]);
  const same = fan(b, ["claim", "night", "let users pick a dark theme"], { FAKE_SAME_IF: "dark" });
  assert.equal(same.status, 1, same.stdout + same.stderr);
  assert.match(same.stderr, /looks like the same work as:\n {2}dark \(branch a, \d+m ago\): add a dark mode toggle/);
  const p = readFileSync(judgeLog, "utf8").trim().split("\n").map((l) => JSON.parse(l)).at(-1);
  assert.match(p.p, /^New task: let users pick a dark theme$/m);
  assert.match(p.p, /^- dark: add a dark mode toggle to settings$/m);
  assert.ok(p.args.includes("sonnet"), "the judge runs on Sonnet by default");
  assert.equal(fan(b, ["claim", "night", "let users pick a dark theme", "--distinct", "only the colour tokens"], { FAKE_SAME_IF: "dark" }).status, 0);
});

test("different work goes through; with no judge the claim goes ahead with the others listed", () => {
  const { a, b } = repo();
  fan(a, ["claim", "tax", "add tax calculation to checkout"]);
  assert.equal(fan(b, ["claim", "discounts", "add discount codes to checkout"], { FAKE_SAME_IF: "dark" }).status, 0);
  const { root } = repo();
  fan(root, ["claim", "tax", "add tax calculation to checkout"]);
  const r = fan(join(root, "..", `${root.split(/[\\/]/).pop()}-a`), ["claim", "discounts", "add discount codes"], { FAKE_JUDGE_FAIL: "1" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /Other sessions are working here right now:\n {2}tax \(branch main\): add tax calculation to checkout[\s\S]*couldn't compare them with your task/);
});

test("no judge call when no other session has a claim", () => {
  const { a } = repo();
  const before = judgeCalls();
  assert.equal(fan(a, ["claim", "solo", "do the only thing"]).status, 0);
  assert.equal(judgeCalls(), before);
});

// A Claude Code transcript with the user's request, as hooks get it.
const transcript = (request) => {
  const f = join(mkdtempSync(join(tmpdir(), "fanout-tr-")), "t.jsonl");
  writeFileSync(f, [{ type: "user", message: { role: "user", content: `<system-reminder>ignore me</system-reminder>${request}` } },
    { type: "assistant", message: { content: [{ type: "text", text: "on it" }] } },
    { type: "user", message: { content: [{ type: "tool_result", content: "ok" }] } }].map((x) => JSON.stringify(x)).join("\n") + "\n");
  return f;
};
const guardT = (cwd, file, request, extra) => spawnSync(process.execPath, [FANOUT, "guard"], { cwd, encoding: "utf8", env: env(extra),
  input: JSON.stringify({ cwd, transcript_path: request ? transcript(request) : undefined, tool_input: { file_path: join(cwd, file) } }) });

test("claims switch on by themselves with two or more active checkouts; git config forces them either way", () => {
  const { root, a } = repo();
  assert.equal(activeCheckouts(root), 3);
  assert.ok(claimsActive(root));
  execFileSync("git", ["config", "fanout.claims", "false"], { cwd: root });
  assert.ok(!claimsActive(a));
  assert.equal(guardT(a, "x.txt", "add a dark mode toggle").status, 0);
  assert.equal(readState(root).head, null, "off: nothing is written");
  const solo = mkdtempSync(join(tmpdir(), "fanout-solo-"));
  execFileSync("git", ["init", "-q"], { cwd: solo });
  assert.ok(!claimsActive(solo), "one checkout: off");
  assert.ok(activeCheckouts(root, Date.now() + 25 * 3600e3) === 0, "a day later nothing counts as active");
});

test("a Claude Code session's first edit claims its task from the user's request; the same work elsewhere is stopped", () => {
  const { root, a, b } = repo();
  assert.equal(guardT(a, "settings.js", "add a dark mode toggle to the settings page").status, 0);
  const c = readState(root).claims.a;
  assert.equal(c.task, "add a dark mode toggle to the settings page"); // tags and tool results left out
  assert.deepEqual(c.edits, ["settings.js"]);
  const before = judgeCalls();
  const dup = guardT(b, "theme.css", "users want a dark theme they can switch on", { FAKE_SAME_IF: "dark" });
  assert.equal(dup.status, 2, dup.stdout + dup.stderr);
  assert.match(dup.stderr, /same work as another session's:\n {2}a \(branch a\): add a dark mode toggle/);
  assert.match(dup.stderr, /--distinct/);
  assert.equal(judgeCalls(), before + 1);
  // It stays stopped, without asking the judge again.
  assert.equal(guardT(b, "theme.css", "users want a dark theme they can switch on", { FAKE_SAME_IF: "dark" }).status, 2);
  assert.equal(judgeCalls(), before + 1);
  assert.match(fan(root, ["claims"]).stdout, /^b \(stopped: same work as a\)/m);
  // Told it's different, it goes ahead.
  assert.equal(fan(b, ["start", "only the colour tokens for a theme", "--distinct", "tokens, not the toggle"]).status, 0);
  assert.equal(guardT(b, "theme.css").status, 0);
});

test("files claimed by name are locked; a file another session is also editing is allowed with a note, once", () => {
  const { root, a, b } = repo();
  fan(a, ["claim", "currency", "format prices", "src/money.mjs"]);
  assert.equal(guardT(a, "package.json").status, 0);
  fan(b, ["start", "print receipts"]);
  const locked = guardT(b, "src/money.mjs");
  assert.equal(locked.status, 2);
  assert.match(locked.stderr, /src\/money\.mjs is claimed by session "currency" \(branch a: format prices\)/);
  const shared = guardT(b, "package.json");
  assert.equal(shared.status, 0, shared.stderr);
  const ctx = JSON.parse(shared.stdout).hookSpecificOutput;
  assert.equal(ctx.hookEventName, "PreToolUse");
  assert.match(ctx.additionalContext, /package\.json is also being changed by session "currency" \(branch a: format prices\)/);
  assert.match(ctx.additionalContext, /git log HEAD\.\.a -- "package\.json"/, "the path is quoted, so a name with spaces still works pasted");
  assert.equal(guardT(b, "package.json").stdout, "", "told once");
  assert.equal(guardT(b, "build/out.js").status, 0, "ignored files are left alone");
  assert.deepEqual(readState(root).claims.b.edits, ["package.json"]);
});

test("the git hook holds any agent to claims at commit time: locked files refused, shared ones noted", () => {
  const { root, a, b } = repo();
  fan(root, ["init"]);
  fan(a, ["claim", "currency", "format prices", "money.txt"]);
  writeFileSync(join(b, "money.txt"), "mine"); execFileSync("git", ["add", "-A"], { cwd: b });
  const c = spawnSync("git", ["commit", "-qm", "b"], { cwd: b, encoding: "utf8", env: env() });
  assert.notEqual(c.status, 0);
  assert.match(c.stderr, /money\.txt is claimed by session "currency"/);
  execFileSync("git", ["reset", "-q"], { cwd: b }); execFileSync("git", ["checkout", "--", "."], { cwd: b }); execFileSync("git", ["clean", "-fq"], { cwd: b });
  // After fanout init, a session that never ran fanout start (Codex, no hooks) can't commit until it does.
  writeFileSync(join(b, "other.txt"), "x"); execFileSync("git", ["add", "other.txt"], { cwd: b });
  const noClaim = spawnSync("git", ["commit", "-qm", "b"], { cwd: b, encoding: "utf8", env: env() });
  assert.notEqual(noClaim.status, 0);
  assert.match(noClaim.stderr, /hasn't claimed its task\. Run first: node ".*fanout\.mjs" start/);
  fan(b, ["start", "the other thing"]);
  assert.equal(spawnSync("git", ["commit", "-qm", "b"], { cwd: b, encoding: "utf8", env: env() }).status, 0);
  assert.deepEqual(readState(root).claims.b.edits, ["other.txt"]);
  // Without init (claims on only because two sessions are active), a commit gets a claim with no task instead.
  execFileSync("git", ["config", "--unset", "fanout.claims"], { cwd: root });
  const { a: a2, b: b2 } = repo();
  execFileSync(process.execPath, [FANOUT, "install-git-hook"], { cwd: a2 });
  writeFileSync(join(b2, "z.txt"), "x"); execFileSync("git", ["add", "z.txt"], { cwd: b2 });
  assert.equal(spawnSync("git", ["commit", "-qm", "z"], { cwd: b2, encoding: "utf8", env: env() }).status, 0);
});

test("a new session is told at start what the others are doing", () => {
  const { a, b } = repo();
  const start = (cwd) => spawnSync(process.execPath, [FANOUT, "session-start"], { cwd, encoding: "utf8", env: env(), input: JSON.stringify({ cwd }) });
  assert.equal(start(b).stdout, "", "nobody else yet: nothing said");
  fan(a, ["claim", "currency", "format prices", "src/money.mjs"]);
  const ctx = JSON.parse(start(b).stdout).hookSpecificOutput;
  assert.equal(ctx.hookEventName, "SessionStart");
  assert.match(ctx.additionalContext, /- currency \(branch a\): format prices \[claimed files: src\/money\.mjs\]/);
  assert.equal(start(a).stdout, "", "its own claim isn't news");
  const hooks = JSON.parse(readFileSync(join(import.meta.dirname, "../hooks/hooks.json"), "utf8")).hooks;
  assert.match(hooks.SessionStart[0].hooks[0].command, /fanout\.mjs" session-start$/);
});

test("fanout done tests this branch merged with the other sessions' commits, and says whose merge broke it", () => {
  const { root, a, b } = repo();
  const g = (cwd, ...x) => execFileSync("git", x, { cwd, stdio: "ignore" });
  // The test fails when both a.txt and b.txt say "x".
  writeFileSync(join(root, "t.mjs"), `import { existsSync, readFileSync } from "node:fs"; const r = (f) => existsSync(f) && readFileSync(f, "utf8"); if (r("a.txt") === "x" && r("b.txt") === "x") process.exit(1);`);
  g(root, "add", "-A"); g(root, "commit", "-qm", "test"); g(root, "config", "fanout.test", "node t.mjs");
  for (const w of [a, b]) g(w, "merge", "-q", "main");
  fan(a, ["start", "write a"]); fan(b, ["start", "write b"]);
  writeFileSync(join(a, "a.txt"), "x"); g(a, "add", "-A"); g(a, "commit", "-qm", "a");
  assert.match(fan(a, ["done"]).stdout, /fanout done: a works with nothing else yet/);
  writeFileSync(join(b, "b.txt"), "y"); g(b, "add", "-A"); g(b, "commit", "-qm", "b");
  const ok = fan(b, ["done"]);
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.match(ok.stdout, /fanout done: b works with a on main \(`node t\.mjs` passes\)/);
  writeFileSync(join(b, "b.txt"), "x"); g(b, "commit", "-qam", "b2");
  const broke = fan(b, ["done"]);
  assert.equal(broke.status, 1);
  assert.match(broke.stdout, /BROKE after b/);
  assert.match(broke.stdout, /merging b after a breaks/);
});

test("fanout init writes the two commands into AGENTS.md, replacing its own block on a rerun", () => {
  const { root } = repo();
  writeFileSync(join(root, "AGENTS.md"), "# Project\n\nUse tabs.\n");
  fan(root, ["init"]); fan(root, ["init"]);
  const text = readFileSync(join(root, "AGENTS.md"), "utf8");
  assert.match(text, /^# Project\n\nUse tabs\.\n\n<!-- fanout -->/);
  assert.equal(text.split("<!-- fanout -->").length, 2, "one block");
  // Through npx: AGENTS.md is shared, so no machine's own path to the script.
  assert.match(text, /`npx -y github:Breadstick-Crumbs\/fanout start "<your task in one line>"`/);
  assert.match(text, /`npx -y github:Breadstick-Crumbs\/fanout done`/);
  assert.match(text, /`npx -y github:Breadstick-Crumbs\/fanout inbox`/);
  assert.doesNotMatch(text, /fanout\.mjs/);
  assert.equal(execFileSync("git", ["config", "fanout.claims"], { cwd: root, encoding: "utf8" }).trim(), "true");
});

test("bare fanout shows every session, its claim and its changes", () => {
  const { root, a } = repo();
  fan(a, ["start", "format prices"]);
  writeFileSync(join(a, "y.txt"), "1");
  const r = spawnSync(process.execPath, [FANOUT], { cwd: root, encoding: "utf8", env: env() });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^a: 1 file\(s\) changed \(1 uncommitted\) \[claimed: a, format prices\]/m);
});

test("taskFromTranscript takes the latest real request, not tool results or short replies", () => {
  const f = join(mkdtempSync(join(tmpdir(), "fanout-tr-")), "t.jsonl");
  writeFileSync(f, [{ type: "user", message: { content: "fix the login redirect loop on /login" } }, { type: "user", message: { content: [{ type: "tool_result", content: "x" }] } },
    { type: "user", isMeta: true, message: { content: "Caveat: the messages below were generated by the user" } }, { type: "user", message: { content: [{ type: "text", text: "yes" }] } }].map((x) => JSON.stringify(x)).join("\n"));
  assert.equal(taskFromTranscript(f), "fix the login redirect loop on /login");
  assert.equal(taskFromTranscript(join(tmpdir(), "missing.jsonl")), "");
});

test("a claim ends when its branch is deleted, merged, or idle for a day", () => {
  const { root, a } = repo();
  const g = (cwd, ...x) => execFileSync("git", x, { cwd, stdio: "ignore" });
  fan(a, ["claim", "currency", "format prices"]);
  const c = readState(root).claims.currency;
  assert.ok(isLive(root, c, "main"));
  // Merged: a commit on the branch, merged into main.
  writeFileSync(join(a, "m.txt"), "1"); g(a, "add", "-A"); g(a, "commit", "-qm", "m"); g(root, "merge", "-q", "--no-edit", "a");
  assert.ok(!isLive(root, c, "main"));
  // Commit times are whole seconds: a claim updated later in the same second as the merge is still quiet.
  const merged = Number(execFileSync("git", ["log", "-1", "--format=%ct", "main"], { cwd: root, encoding: "utf8" })) * 1000;
  assert.ok(!isLive(root, { ...c, at: new Date(merged + 999).toISOString(), updated: undefined }, "main", merged + 999), "same second as the merge");
  // Idle: no commit and no update for over a day.
  const old = new Date(Date.now() - 25 * 3600e3).toISOString();
  g(root, "branch", "idle");
  assert.ok(!isLive(root, { ...c, branch: "idle", path: null, start: "x", at: old, updated: old }, null, Date.now() + 25 * 3600e3));
  assert.ok(!isLive(root, { ...c, branch: "gone" }, "main"));
  assert.deepEqual(liveClaims(root, "main"), []);
});

test("claims written at the same moment from several sessions are all kept", async () => {
  const { root } = repo();
  const names = ["p1", "p2", "p3", "p4", "p5", "p6"];
  await Promise.all(names.map((n) => new Promise((done) => {
    const w = spawn(process.execPath, ["--input-type=module", "-e", `import { writeState } from ${JSON.stringify(new URL("../skills/fanout/claims.mjs", import.meta.url).href)};
const r = writeState(process.cwd(), (c) => { c["${n}"] = { name: "${n}", task: "t", branch: "main", files: [], at: new Date().toISOString() }; });
if (!r.ok) process.exit(1);`], { cwd: root });
    w.on("close", done);
  })));
  assert.deepEqual(Object.keys(readState(root).claims).sort(), names);
  assert.ok(execFileSync("git", ["rev-list", "--count", REF], { cwd: root, encoding: "utf8" }).trim() >= 6);
});

test("overlap and status show claims, and overlap marks an active checkout with none", () => {
  const { root, a, b } = repo();
  fan(root, ["init"]);
  fan(a, ["claim", "currency", "format prices"]);
  writeFileSync(join(b, "y.txt"), "1");
  const o = fan(root, ["overlap"]);
  assert.match(o.stdout, /^b: 1 file\(s\) changed \(1 uncommitted\) \[no claim\]/m);
  assert.match(o.stdout, /^a: claimed currency, format prices \(no changes yet\)/m);
  assert.match(fan(root, ["status"]).stdout, /claims:\n {2}currency {2}a {2}format prices/);
});

test("with Claude signed out, the same-work check runs on Codex (a Codex-only setup gets it too)", () => {
  // Fake CLIs: claude reports signed out; codex is signed in and answers in the file -o names.
  const d = mkdtempSync(join(tmpdir(), "fanout-cx-")), log = join(d, "codex.jsonl");
  writeFileSync(join(d, "claude.mjs"), `if (process.argv[2] === "auth") console.log(JSON.stringify({ loggedIn: false })); else process.exit(1);`);
  writeFileSync(join(d, "codex.mjs"), `
import { readFileSync, writeFileSync, appendFileSync } from "node:fs";
const a = process.argv.slice(2);
if (a[0] === "login") process.exit(0);
const p = readFileSync(0, "utf8"); appendFileSync(${JSON.stringify(log)}, JSON.stringify(a) + "\\n");
const task = p.match(/^New task: (.*)$/m)[1];
const sessions = [...p.matchAll(/^- ([\\w.-]+): (.*)$/gm)].map(([, name, t]) => ({ name, reason: "r", same: task.includes("dark") && t.includes("dark") }));
writeFileSync(a[a.indexOf("-o") + 1], "codex\\n" + JSON.stringify({ sessions }));`);
  const cx = { FANOUT_CLAUDE_BIN: `node "${join(d, "claude.mjs")}"`, FANOUT_CODEX_BIN: `node "${join(d, "codex.mjs")}"` };
  const { a, b } = repo();
  assert.equal(fan(a, ["start", "add a dark mode toggle"], cx).status, 0);
  const r = fan(b, ["start", "let users pick a dark theme"], cx);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /looks like the same work as:\n {2}a \(branch a/);
  const args = JSON.parse(readFileSync(log, "utf8").trim().split("\n")[0]);
  for (const want of ["exec", "--ephemeral", "read-only", "model_reasoning_effort=low"]) assert.ok(args.includes(want), want);
  assert.equal(fan(b, ["start", "add discount codes"], cx).status, 0, "different work goes through");
});

test("a rate-limited Codex (429) ends the check at once, and the agent gets the list to compare itself", async () => {
  const { judge } = await import("../skills/fanout/claims.mjs");
  const d = mkdtempSync(join(tmpdir(), "fanout-429-"));
  writeFileSync(join(d, "codex.mjs"), `console.log(JSON.stringify({ type: "thread.started" })); console.log(JSON.stringify({ type: "error", message: "Reconnecting... 2/5 (last status: 429 Too Many Requests)" })); setTimeout(() => {}, 600000);`);
  const keep = { ...process.env };
  Object.assign(process.env, { FANOUT_CLAIM_JUDGE_AGENT: "codex", FANOUT_CODEX_BIN: `node "${join(d, "codex.mjs")}"`, FANOUT_CLAIM_JUDGE: "" });
  const t0 = Date.now(), j = judge("a task", [{ name: "x", task: "another" }], d);
  process.env = keep;
  assert.equal(j, null);
  assert.ok(Date.now() - t0 < 20000, `took ${Date.now() - t0}ms`);
});

test("inside a sandbox with no network (Codex), no model is called: the agent is given the list to compare itself", () => {
  const { root, a, b } = repo();
  fan(a, ["start", "add a dark mode toggle"]);
  const before = judgeCalls();
  const r = fan(b, ["start", "let users pick a dark theme"], { FAKE_SAME_IF: "dark", CODEX_SANDBOX_NETWORK_DISABLED: "1" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(judgeCalls(), before, "no model call from the sandbox");
  assert.match(r.stdout, /Other sessions are working here right now:\n {2}a \(branch a\): add a dark mode toggle/);
  assert.match(r.stdout, /can't reach a model from this sandbox[\s\S]*don't do it\. Run node ".*fanout\.mjs" release b/);
  assert.equal(readState(root).claims.b.unchecked, true);
});

test("two sessions that claimed at the same moment find each other at the next checkpoint; the newer one yields", () => {
  const { root, a, b } = repo();
  // Both claims written as if neither saw the other (as when two sessions run fanout start together).
  const at = Date.now(), head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  writeState(root, (c) => {
    c.a = { name: "a", task: "add a dark mode toggle", branch: "a", path: a, files: [], edits: [], start: head, at: new Date(at).toISOString(), updated: new Date(at).toISOString(), comparedWith: [] };
    c.b = { name: "b", task: "let users pick a dark theme", branch: "b", path: b, files: [], edits: [], start: head, at: new Date(at + 1000).toISOString(), updated: new Date(at + 1000).toISOString(), comparedWith: [] };
  });
  const before = judgeCalls();
  assert.equal(guardT(a, "settings.js", null, { FAKE_SAME_IF: "dark" }).status, 0, "the older one goes on");
  assert.equal(judgeCalls(), before, "and doesn't ask: the newer one compares itself with it");
  const again = fan(b, ["start", "let users pick a dark theme"], { FAKE_SAME_IF: "dark" });
  assert.equal(again.status, 1, again.stdout + again.stderr);
  assert.match(again.stderr, /same work as:\n {2}a \(branch a, claimed earlier\): add a dark mode toggle/);
  assert.equal(guardT(b, "theme.css", null, { FAKE_SAME_IF: "dark" }).status, 2, "and stays stopped");
  assert.equal(judgeCalls(), before + 1, "one comparison for the pair");
  assert.deepEqual(readState(root).claims.b.refusedAs, ["a"]);
});

test("the guard takes camelCase hook input too (Grok Build sends toolInput)", () => {
  const { a, b } = repo();
  fan(a, ["claim", "currency", "format prices", "src/money.mjs"]);
  fan(b, ["start", "print receipts"]);
  const r = spawnSync(process.execPath, [FANOUT, "guard"], { cwd: b, encoding: "utf8", env: env(), input: JSON.stringify({ cwd: b, toolName: "Edit", toolInput: { file_path: join(b, "src/money.mjs") } }) });
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /src\/money\.mjs is claimed by session "currency"/);
});

test("the judge is asked to reason before it decides, about every live session", () => {
  const p = judgePrompt("fix login loop", [{ name: "auth", task: "stop redirecting to /login on /login", files: ["middleware/auth.ts"] }, { name: "ui", task: "" }]);
  assert.match(p, /^- auth: stop redirecting to \/login on \/login \[files: middleware\/auth\.ts\]$/m);
  assert.match(p, /^- ui: \(no task given\)$/m);
  assert.match(p, /"reason": .*"same": true\|false/);
});

const noticeT = (cwd, tool, file, extra) => spawnSync(process.execPath, [FANOUT, "notice"], { cwd, encoding: "utf8", env: env(extra), input: JSON.stringify({ cwd, tool_name: tool, tool_input: file ? { file_path: join(cwd, file) } : { command: "ls" } }) });
const noticeText = (r) => (r.stdout ? JSON.parse(r.stdout).reason : "");

test("a session is told, once, when another commits changes to a file it has read; work merged into the base counts too", () => {
  const { root, a, b } = repo();
  const g = (cwd, ...x) => execFileSync("git", x, { cwd, stdio: "ignore" });
  fan(a, ["start", "print receipts"]); fan(b, ["start", "prices in cents"]);
  assert.equal(noticeT(a, "Read", "x.txt").stdout, "", "nothing changed elsewhere yet");
  writeFileSync(join(b, "x.txt"), "2"); writeFileSync(join(b, "y.txt"), "new"); g(b, "add", "-A"); g(b, "commit", "-qm", "b work");
  const t = noticeText(noticeT(a, "Bash"));
  assert.match(t, /Session "b" \(branch b: prices in cents\) committed change x\.txt, which this session has read or edited/);
  assert.match(t, /^\+2$/m, "with the diff");
  assert.doesNotMatch(t, /y\.txt/, "only files this session uses");
  assert.match(t, /git merge b/);
  assert.match(t, /If your work depends on this code/, "only read here, so no conflict to warn about");
  assert.equal(noticeT(a, "Bash").stdout, "", "told once");
  assert.equal(noticeT(a, "Read", "y.txt").stdout !== "", true, "a file read later that the other changed is news");
  writeFileSync(join(b, "x.txt"), "3"); g(b, "commit", "-qam", "more");
  assert.match(noticeText(noticeT(a, "Bash")), /^\+3$/m, "a newer commit to the same file is news again");
  assert.equal(noticeT(b, "Bash").stdout, "", "a session isn't told about its own commits");
  // Merged into main (b's claim ends): main's new commits are noticed by a session that branched before.
  const { root: r2, a: a2, b: b2 } = repo();
  fan(a2, ["start", "print receipts"]);
  noticeT(a2, "Read", "x.txt");
  writeFileSync(join(r2, "x.txt"), "9"); g(r2, "commit", "-qam", "merged work");
  assert.match(noticeText(noticeT(a2, "Bash")), /New commits on main \(work merged since this session started\) change x\.txt/);
  assert.equal(noticeT(a2, "Bash", null, { FANOUT_NOTICES: "off" }).stdout, "", "FANOUT_NOTICES=off silences it");
  void root; void b2;
});

test("a session that changed the same file is told the branches will conflict, not only if its work depends on it", () => {
  const { a, b } = repo();
  const g = (cwd, ...x) => execFileSync("git", x, { cwd, stdio: "ignore" });
  fan(a, ["start", "add a contact page"]); fan(b, ["start", "add an faq page"]);
  writeFileSync(join(a, "x.txt"), "contact"); noticeT(a, "Edit", "x.txt");
  writeFileSync(join(b, "x.txt"), "faq"); g(b, "commit", "-qam", "faq");
  const t = noticeText(noticeT(a, "Bash"));
  assert.match(t, /You changed x\.txt too, so your branches will conflict there when merged/);
  assert.match(t, /Before you commit, merge their branch \(git merge b\)/);
  assert.doesNotMatch(t, /If your work depends on this code/);
});

test("a claim ends when its branch is squash-merged into the base, and its locked files are free again", () => {
  const { root, a, b } = repo();
  const g = (cwd, ...x) => execFileSync("git", x, { cwd, stdio: "ignore" });
  fan(b, ["claim", "currency", "format prices", "src/money.mjs"]);
  mkdirSync(join(b, "src")); writeFileSync(join(b, "src/money.mjs"), "export const m = 1;\n"); g(b, "add", "-A"); g(b, "commit", "-qm", "money");
  assert.match(fan(a, ["claims"]).stdout, /currency/, "live while unmerged");
  g(root, "merge", "--squash", "b"); g(root, "commit", "-qm", "money (squashed)");
  assert.doesNotMatch(fan(a, ["claims"]).stdout, /currency/, "ended: merging b would change nothing on main");
  fan(a, ["start", "print receipts"]);
  assert.equal(guard(a, "src/money.mjs").status, 0, "the file it locked can be edited");
  writeFileSync(join(b, "src/money.mjs"), "export const m = 2;\n"); g(b, "commit", "-qam", "more money");
  fan(b, ["claim", "currency", "format prices", "src/money.mjs"]);
  assert.match(fan(a, ["claims"]).stdout, /currency/, "a branch with changes main doesn't have is live");
});

test("a session that merged another's branch keeps its claim when that branch reaches the base, while it still works", () => {
  const { root, a, b } = repo();
  const g = (cwd, ...x) => execFileSync("git", x, { cwd, stdio: "ignore" });
  fan(a, ["start", "print receipts"]); fan(b, ["start", "prices in cents"]);
  writeFileSync(join(b, "x.txt"), "2"); g(b, "commit", "-qam", "cents");
  g(a, "merge", "-q", "--no-edit", "b"); // as the notice tells it to; a's branch now holds only b's work
  writeFileSync(join(a, "receipt.txt"), "wip"); // a's own work, not committed yet
  g(root, "merge", "-q", "--no-ff", "--no-edit", "b");
  assert.match(fan(root, ["claims"]).stdout, /print receipts/, "uncommitted work in its checkout: still live");
  g(a, "add", "-A"); g(a, "commit", "-qm", "receipt");
  assert.match(fan(root, ["claims"]).stdout, /print receipts/, "its own commit isn't in the base: still live");
  // Its work merged too and the checkout clean: now it ends.
  g(root, "merge", "--squash", "a"); g(root, "commit", "-qm", "receipt (squashed)");
  assert.doesNotMatch(fan(root, ["claims"]).stdout, /print receipts/);
});

test("a notice skips changes this checkout already has, as after a squash merge", () => {
  const { root, a, b } = repo();
  const g = (cwd, ...x) => execFileSync("git", x, { cwd, stdio: "ignore" });
  fan(a, ["start", "print receipts"]); fan(b, ["start", "prices in cents"]);
  noticeT(a, "Read", "x.txt");
  writeFileSync(join(b, "x.txt"), "2"); g(b, "commit", "-qam", "cents");
  g(root, "merge", "--squash", "b"); g(root, "commit", "-qm", "cents (squashed)");
  g(a, "merge", "-q", "--no-edit", "main");
  writeFileSync(join(b, "y.txt"), "new"); g(b, "add", "-A"); g(b, "commit", "-qm", "more"); // b stays live
  assert.equal(noticeT(a, "Bash").stdout, "", "a already has b's change to x.txt");
  writeFileSync(join(b, "x.txt"), "3"); g(b, "commit", "-qam", "dollars");
  assert.match(noticeText(noticeT(a, "Bash")), /change x\.txt[\s\S]*^\+3$/m, "a change it doesn't have is still news");
});

test("notices stay silent where claims are off", () => {
  const { a, b } = repo();
  const g = (cwd, ...x) => execFileSync("git", x, { cwd, stdio: "ignore" });
  g(a, "config", "fanout.claims", "false");
  noticeT(a, "Read", "x.txt");
  writeFileSync(join(b, "x.txt"), "2"); g(b, "commit", "-qam", "b");
  assert.equal(noticeT(a, "Bash").stdout, "");
});

test("edits made through the shell are claimed after the fact: the task, a duplicate, a locked file", () => {
  const { root, a, b } = repo();
  const transcript = (t) => { const f = join(dir, `t-${Math.random()}.jsonl`); writeFileSync(f, JSON.stringify({ type: "user", message: { content: t } }) + "\n"); return f; };
  const bashT = (cwd, task, extra) => spawnSync(process.execPath, [FANOUT, "notice"], { cwd, encoding: "utf8", env: env(extra), input: JSON.stringify({ cwd, tool_name: "Bash", tool_input: { command: "python edit.py" }, transcript_path: transcript(task) }) });
  assert.equal(bashT(a, "add a dark mode toggle to the settings page").stdout, "", "no change, no claim");
  assert.equal(readState(root).claims.a, undefined);
  writeFileSync(join(a, "settings.js"), "dark");
  assert.equal(bashT(a, "add a dark mode toggle to the settings page").status, 0);
  assert.equal(readState(root).claims.a.task, "add a dark mode toggle to the settings page");
  assert.deepEqual(readState(root).claims.a.edits, ["settings.js"]);
  writeFileSync(join(b, "theme.css"), "night");
  const dup = bashT(b, "users want a dark theme they can switch on", { FAKE_SAME_IF: "dark" });
  const out = JSON.parse(dup.stdout);
  assert.equal(out.decision, "block");
  assert.match(out.reason, /that command changed files, and this session's task looks like the same work as another session's:\n {2}a \(branch a\)/);
  assert.match(out.reason, /Undo your change/);
  // A file claimed by name, changed from the shell in another session.
  fan(a, ["claim", "money", "format prices", "money.txt"]);
  const { root: r2, a: a2, b: b2 } = repo();
  fan(a2, ["claim", "money", "format prices", "money.txt"]);
  writeFileSync(join(b2, "money.txt"), "mine");
  const locked = JSON.parse(bashT(b2, "print receipts for orders").stdout);
  assert.match(locked.reason, /money\.txt is claimed by session "money"/);
  assert.equal(bashT(b2, "print receipts for orders").stdout, "", "reported once");
  void r2;
});

test("fanout inbox gives agents without hooks the same notices: every file another session committed, once; done and the git hook print them too", () => {
  const { root, a, b } = repo();
  const g = (cwd, ...x) => execFileSync("git", x, { cwd, stdio: "ignore" });
  fan(a, ["start", "print receipts"]); fan(b, ["start", "prices in cents"]);
  writeFileSync(join(a, "receipt.txt"), "r");
  assert.match(fan(a, ["inbox"]).stdout, /nothing new/);
  writeFileSync(join(b, "x.txt"), "2"); writeFileSync(join(b, "receipt.txt"), "theirs"); g(b, "add", "-A"); g(b, "commit", "-qm", "b work");
  const t = fan(a, ["inbox"]).stdout;
  assert.match(t, /Session "b" \(branch b: prices in cents\) committed change (receipt\.txt, x\.txt|x\.txt, receipt\.txt), and you changed receipt\.txt too/, "every file, not only this session's");
  assert.match(t, /^\+2$/m);
  assert.match(fan(a, ["inbox"]).stdout, /nothing new/, "once");
  // A newer commit shows up when a commits (git hook) and in done.
  fan(root, ["init"]); // the git hook acts once fanout init has run
  writeFileSync(join(b, "x.txt"), "3"); g(b, "commit", "-qam", "more");
  g(a, "add", "-A");
  const c = spawnSync("git", ["commit", "-qm", "a"], { cwd: a, encoding: "utf8", env: env() });
  assert.equal(c.status, 0, c.stderr);
  assert.match(c.stderr, /^\+3$/m);
  writeFileSync(join(b, "x.txt"), "4"); g(b, "commit", "-qam", "again");
  assert.match(fan(a, ["done"]).stdout, /^\+4$/m);
});

test("fanout log lists every claim decision and notice in real use, and what the hook cost", () => {
  const { root, a, b } = repo();
  const g = (cwd, ...x) => execFileSync("git", x, { cwd, stdio: "ignore" });
  assert.equal(guardT(a, "settings.js", "add a dark mode toggle to the settings page").status, 0);
  assert.equal(guardT(b, "theme.css", "users want a dark theme they can switch on", { FAKE_SAME_IF: "dark" }).status, 2);
  const { root: r2, a: a2, b: b2 } = repo();
  fan(a2, ["start", "print receipts"]); fan(b2, ["start", "prices in cents"]);
  noticeT(a2, "Read", "x.txt");
  writeFileSync(join(b2, "x.txt"), "2"); g(b2, "commit", "-qam", "b");
  noticeT(a2, "Bash");
  const log = fan(root, ["log"]).stdout;
  assert.match(log, /Claims, last 7 days: 1 claimed, 1 refused as the same work/);
  assert.match(log, /Refused \(check each: was it really the same work\?\):\n {2}\S+ \S+ {2}b \(edit\): users want a dark theme they can switch on\n {4}same as a: add a dark mode toggle to the settings page/);
  const log2 = fan(r2, ["log"]).stdout;
  assert.match(log2, /2 claimed, 0 refused/);
  assert.match(log2, /a told of b's change to x\.txt \[hook\]/);
  assert.match(log2, /The after-each-tool-call hook: 2 call\(s\), \d+ms on average/);
  assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: r2, encoding: "utf8" }), "", "nothing in anyone's status");
  void a; void b2;
});

test("a claim is visible while its check runs: a session claiming the same work meanwhile yields, and the first session's other edits wait for the check", async () => {
  const { root, a, b } = repo();
  fan(root, ["claim", "other", "write the docs"]); // something for a's check to compare with, so it calls the (slow) judge
  const guardAsync = (cwd, file, request, extra) => new Promise((done) => {
    const p = spawn(process.execPath, [FANOUT, "guard"], { cwd, env: env(extra) });
    let err = ""; p.stderr.on("data", (d) => (err += d)); p.on("close", (status) => done({ status, err }));
    p.stdin.end(JSON.stringify({ cwd, transcript_path: transcript(request), tool_input: { file_path: join(cwd, file) } }));
  });
  const slow = { FAKE_SAME_IF: "dark", FAKE_JUDGE_DELAY_MS: "6000" };
  const first = guardAsync(a, "settings.js", "add a dark mode toggle to the settings page", slow);
  for (let i = 0; i < 60 && !readState(root).claims.a; i++) await new Promise((r) => setTimeout(r, 100)); // a's claim is written, its check still running
  assert.equal(readState(root).claims.a.checking, true);
  const second = guardAsync(a, "styles.css", "add a dark mode toggle to the settings page", slow); // a's other edit, at the same moment
  const dup = guardT(b, "theme.css", "users want a dark theme they can switch on", { FAKE_SAME_IF: "dark" });
  assert.equal(dup.status, 2, "b sees a's claim, though a's check isn't done, and yields to it");
  assert.match(dup.stderr, /same work as another session's:\n {2}a \(branch a\)/);
  const [r1, r2] = await Promise.all([first, second]);
  assert.equal(r1.status, 0, r1.err);
  assert.equal(r2.status, 0, "a's other edit waited for the check, then went ahead");
  const c = readState(root).claims;
  assert.equal(c.a.checking, undefined);
  assert.equal(c.a.refusedAs, undefined, "a, the older claim, isn't refused because of b");
  assert.deepEqual(c.b.refusedAs, ["a"]);
});
