import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync, spawn } from "node:child_process";
import { readState, writeState, liveClaims, isLive, judgePrompt, REF } from "../skills/fanout/claims.mjs";

const FANOUT = join(import.meta.dirname, "../skills/fanout/fanout.mjs");
// A fake claude for the task judge: a session is the same work when its task and the new one share the word
// in FAKE_SAME_IF. FAKE_JUDGE_FAIL makes it fail like a signed-out CLI. Each call is logged.
const dir = mkdtempSync(join(tmpdir(), "fanout-claims-"));
const judgeLog = join(dir, "judge.jsonl"), fake = join(dir, "judge.mjs");
writeFileSync(fake, `
import { readFileSync, appendFileSync } from "node:fs";
const p = readFileSync(0, "utf8");
appendFileSync(${JSON.stringify(judgeLog)}, JSON.stringify({ args: process.argv.slice(2), p }) + "\\n");
if (process.env.FAKE_JUDGE_FAIL) { console.log(JSON.stringify({ is_error: true, result: "Not logged in" })); process.exit(1); }
const task = p.match(/^New task: (.*)$/m)[1], w = process.env.FAKE_SAME_IF;
const sessions = [...p.matchAll(/^- ([\\w.-]+): (.*)$/gm)].map(([, name, t]) => ({ name, reason: "r", same: !!w && task.includes(w) && t.includes(w) }));
console.log(JSON.stringify({ result: JSON.stringify({ sessions }), total_cost_usd: 0.01 }));
`);
const env = (extra = {}) => ({ ...process.env, FANOUT_CLAUDE_BIN: `node "${fake}"`, FAKE_SAME_IF: "", FAKE_JUDGE_FAIL: "", ...extra });
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
  assert.match(r.stdout, /couldn't check for duplicate work[\s\S]*tax: add tax calculation to checkout/);
});

test("no judge call when no other session has a claim", () => {
  const { a } = repo();
  const before = judgeCalls();
  assert.equal(fan(a, ["claim", "solo", "do the only thing"]).status, 0);
  assert.equal(judgeCalls(), before);
});

test("with claims on, the edit guard makes a session claim first, refuses others' files, and records new ones", () => {
  const { root, a, b } = repo();
  assert.equal(guard(a, "src/money.mjs").status, 0, "claims off: the guard does nothing");
  assert.equal(fan(root, ["init"]).status, 0);
  const first = guard(a, "src/money.mjs");
  assert.equal(first.status, 2);
  assert.match(first.stderr, /hasn't claimed its task yet[\s\S]*claim <short-name>/);
  fan(a, ["claim", "currency", "format prices", "src/money.mjs"]);
  assert.equal(guard(a, "src/money.mjs").status, 0);
  assert.equal(guard(a, "src/format.mjs").status, 0);
  assert.deepEqual(readState(root).claims.currency.files, ["src/money.mjs", "src/format.mjs"]); // added on first edit
  fan(b, ["claim", "receipt", "print receipts", "src/receipt.mjs"]);
  const taken = guard(b, "src/format.mjs");
  assert.equal(taken.status, 2);
  assert.match(taken.stderr, /src\/format\.mjs is claimed by session "currency" \(branch a: format prices\)/);
  assert.equal(guard(b, "build/out.js").status, 0, "ignored files are left alone");
});

test("with claims on, the git hook holds any agent to them at commit time", () => {
  const { root, a, b } = repo();
  fan(root, ["init"]);
  fan(a, ["claim", "currency", "format prices", "money.txt"]);
  writeFileSync(join(b, "money.txt"), "mine");
  execFileSync("git", ["add", "-A"], { cwd: b });
  const c = spawnSync("git", ["commit", "-qm", "b"], { cwd: b, encoding: "utf8", env: env() });
  assert.notEqual(c.status, 0);
  assert.match(c.stderr, /money\.txt is claimed by session "currency"/);
  // An unclaimed session can't commit either until it claims its task.
  assert.match(spawnSync("git", ["commit", "-qm", "b"], { cwd: b, encoding: "utf8", env: env() }).stderr, /claimed by session "currency"/);
  execFileSync("git", ["reset", "-q"], { cwd: b });
  writeFileSync(join(b, "other.txt"), "x"); execFileSync("git", ["add", "other.txt"], { cwd: b });
  assert.match(spawnSync("git", ["commit", "-qm", "b"], { cwd: b, encoding: "utf8", env: env() }).stderr, /hasn't claimed its task yet/);
  fan(b, ["claim", "other", "the other thing"]);
  assert.equal(spawnSync("git", ["commit", "-qm", "b"], { cwd: b, encoding: "utf8", env: env() }).status, 0);
  assert.deepEqual(readState(root).claims.other.files, ["other.txt"]);
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

test("the judge is asked to reason before it decides, about every live session", () => {
  const p = judgePrompt("fix login loop", [{ name: "auth", task: "stop redirecting to /login on /login", files: ["middleware/auth.ts"] }, { name: "ui", task: "" }]);
  assert.match(p, /^- auth: stop redirecting to \/login on \/login \[files: middleware\/auth\.ts\]$/m);
  assert.match(p, /^- ui: \(no task given\)$/m);
  assert.match(p, /"reason": .*"same": true\|false/);
});
