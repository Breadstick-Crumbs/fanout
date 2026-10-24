import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { writeFileSync, mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parsePlan, matches, check, verify } from "../skills/fanout/fanout.mjs";

const script = fileURLToPath(new URL("../skills/fanout/fanout.mjs", import.meta.url));
const dir = () => mkdtempSync(join(tmpdir(), "fanout-"));
const run = (args, opts = {}) => spawnSync(process.execPath, [script, ...args], { encoding: "utf8", ...opts });

test("glob matching", () => {
  assert.ok(matches("src/db/**", "src/db/a/b.ts"));
  assert.ok(matches("src/*.ts", "src/a.ts"));
  assert.ok(!matches("src/*.ts", "src/a/b.ts"));
  assert.ok(matches("src/{a,b}.ts", "src/b.ts"));
  assert.ok(matches("docs/", "docs/x/y.md"));
  assert.ok(!matches("src/app/**", "src/application/x.ts"));
  assert.ok(matches("**/*.test.ts", "a/b/c.test.ts"));
});

test("prefix check without a repo: clash and no clash", () => {
  const p = parsePlan("## a\nowns: src/db/**\n## b\nowns: src/db/schema.ts\n## c\nowns: src/app/**\n## d\nowns: src/application/**\n");
  const { problems } = check(p, null);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /CLASH a .* b /);
});

test("merge order, unknown and cycle", () => {
  assert.deepEqual(check(parsePlan("## b\nowns: b\nafter: a\n## a\nowns: a\n"), null).order, ["a", "b"]);
  assert.match(check(parsePlan("## a\nowns: a\nafter: zz\n"), null).problems[0], /UNKNOWN/);
  assert.match(check(parsePlan("## a\nowns: a\nafter: b\n## b\nowns: b\nafter: a\n"), null).problems.join(), /CYCLE/);
});

test("repo-aware check: globs that share no real file do not clash", () => {
  const d = dir();
  execFileSync("git", ["init", "-q"], { cwd: d });
  mkdirSync(join(d, "src/app/start"), { recursive: true });
  mkdirSync(join(d, "src/app/other"), { recursive: true });
  writeFileSync(join(d, "src/app/start/a.ts"), "");
  writeFileSync(join(d, "src/app/other/b.ts"), "");
  const plan = join(d, "plan.md");
  writeFileSync(plan, "## a\nowns: src/app/start/**\n## b\nowns: src/app/other/**\n");
  assert.equal(run(["check", plan, "--cwd", d]).status, 0);
  writeFileSync(plan, "## a\nowns: src/app/**\n## b\nowns: src/app/other/*.ts\n");
  const r = run(["check", plan, "--cwd", d]);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /src\/app\/other\/b\.ts/);
});

test("verify finds out-of-lane files in a branch", () => {
  const d = dir();
  const g = (...a) => execFileSync("git", a, { cwd: d, stdio: "ignore" });
  g("init", "-q", "-b", "main"); g("config", "user.email", "t@t"); g("config", "user.name", "t");
  writeFileSync(join(d, "x.txt"), "1"); g("add", "-A"); g("commit", "-qm", "init");
  g("checkout", "-qb", "feat");
  mkdirSync(join(d, "mine")); writeFileSync(join(d, "mine/a.ts"), ""); writeFileSync(join(d, "x.txt"), "2");
  g("add", "-A"); g("commit", "-qm", "work");
  const plan = join(d, "plan.md");
  writeFileSync(plan, "## s\nowns: mine/**\n");
  const r = run(["verify", plan, "--session", "s", "--base", "main", "--cwd", d]);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /OUT OF LANE s: x\.txt/);
  assert.doesNotMatch(r.stdout, /mine\/a\.ts/);
  assert.deepEqual(verify({ owns: ["mine/**"] }, ["mine/a.ts"]), []);
});

test("guard: blocks out-of-lane edits on a fanout/<name> branch, silent elsewhere", () => {
  const d = dir();
  const g = (...a) => execFileSync("git", a, { cwd: d, stdio: "ignore" });
  g("init", "-q", "-b", "main"); g("config", "user.email", "t@t"); g("config", "user.name", "t");
  writeFileSync(join(d, "x.txt"), "1"); g("add", "-A"); g("commit", "-qm", "init");
  mkdirSync(join(d, ".fanout"));
  writeFileSync(join(d, ".fanout/plan.md"), "## s\nowns: mine/**\n");
  const call = (file) => run(["guard"], { cwd: d, input: JSON.stringify({ tool_name: "Edit", cwd: d, tool_input: { file_path: file } }) });
  assert.equal(call(join(d, "other/a.ts")).status, 0); // on main: no-op
  g("checkout", "-qb", "fanout/s");
  assert.equal(call(join(d, "mine/a.ts")).status, 0);
  const bad = call(join(d, "other/a.ts"));
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /does not own other\/a\.ts/);
  assert.equal(call(join(tmpdir(), "elsewhere.txt")).status, 0);
});

test("guard finds the plan from a linked worktree", () => {
  const d = dir();
  const g = (cwd, ...a) => execFileSync("git", a, { cwd, stdio: "ignore" });
  g(d, "init", "-q", "-b", "main"); g(d, "config", "user.email", "t@t"); g(d, "config", "user.name", "t");
  writeFileSync(join(d, "x.txt"), "1"); g(d, "add", "-A"); g(d, "commit", "-qm", "init");
  mkdirSync(join(d, ".fanout"));
  writeFileSync(join(d, ".fanout/plan.md"), "## s\nowns: mine/**\n");
  const wt = join(dir(), "wt");
  g(d, "worktree", "add", "-q", "-b", "fanout/s", wt);
  const r = run(["guard"], { cwd: wt, input: JSON.stringify({ tool_name: "Write", cwd: wt, tool_input: { file_path: join(wt, "nope.ts") } }) });
  assert.equal(r.status, 2);
});

test("rehearse: clean-merging lanes that break together are pinned to the second branch", () => {
  const d = dir();
  const g = (...a) => execFileSync("git", a, { cwd: d, stdio: "ignore" });
  g("init", "-q", "-b", "main"); g("config", "user.email", "t@t"); g("config", "user.name", "t");
  writeFileSync(join(d, "types.mjs"), "export function price(m) { return m.cents / 100 }\n");
  writeFileSync(join(d, "card.mjs"), "\n"); // nothing calls price() on main yet
  g("add", "-A"); g("commit", "-qm", "base");
  mkdirSync(join(d, ".fanout"));
  writeFileSync(join(d, ".fanout/plan.md"), "test: node card.mjs\n\n## foundations\nowns: types.mjs\n\n## money\nowns: card.mjs\nafter: foundations\n");
  assert.equal(run(["rehearse"], { cwd: d }).status, 0); // no branches yet: all skipped
  g("checkout", "-qb", "fanout/foundations");
  writeFileSync(join(d, "types.mjs"), "export function formatPrice(m) { return m.cents / 100 }\n");
  g("commit", "-qam", "rename");
  g("checkout", "-q", "main"); g("checkout", "-qb", "fanout/money");
  writeFileSync(join(d, "card.mjs"), 'import { price } from "./types.mjs"\nprice({ cents: 5 }) + " USD"\n');
  g("commit", "-qam", "currency");
  g("checkout", "-q", "main");
  const r = run(["rehearse"], { cwd: d });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /OK after foundations/);
  assert.match(r.stdout, /BROKE after money/);
  assert.match(r.stdout, /does not provide an export named 'price'/);
  assert.equal(execFileSync("git", ["worktree", "list"], { cwd: d, encoding: "utf8" }).trim().split("\n").length, 1);
  assert.equal(execFileSync("git", ["rev-parse", "HEAD"], { cwd: d, encoding: "utf8" }), execFileSync("git", ["rev-parse", "main"], { cwd: d, encoding: "utf8" }));
});

test("rehearse: reports a textual conflict and the files", () => {
  const d = dir();
  const g = (...a) => execFileSync("git", a, { cwd: d, stdio: "ignore" });
  g("init", "-q", "-b", "main"); g("config", "user.email", "t@t"); g("config", "user.name", "t");
  writeFileSync(join(d, "x.txt"), "1"); g("add", "-A"); g("commit", "-qm", "init");
  mkdirSync(join(d, ".fanout"));
  writeFileSync(join(d, ".fanout/plan.md"), "## a\nowns: a/**\n## b\nowns: b/**\n");
  for (const b of ["a", "b"]) {
    g("checkout", "-q", "main"); g("checkout", "-qb", "fanout/" + b);
    writeFileSync(join(d, "x.txt"), b); g("commit", "-qam", b);
  }
  g("checkout", "-q", "main");
  const r = run(["rehearse"], { cwd: d });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /MERGED a/);
  assert.match(r.stdout, /CONFLICT merging b: x\.txt/);
});

test("verify uses the branch name and the default plan", () => {
  const d = dir();
  const g = (...a) => execFileSync("git", a, { cwd: d, stdio: "ignore" });
  g("init", "-q", "-b", "main"); g("config", "user.email", "t@t"); g("config", "user.name", "t");
  writeFileSync(join(d, "x.txt"), "1"); g("add", "-A"); g("commit", "-qm", "init");
  mkdirSync(join(d, ".fanout"));
  writeFileSync(join(d, ".fanout/plan.md"), "## s\nowns: mine/**\n");
  g("checkout", "-qb", "fanout/s");
  writeFileSync(join(d, "x.txt"), "2"); g("add", "-A"); g("commit", "-qm", "w");
  const r = run(["verify"], { cwd: d });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /OUT OF LANE s: x\.txt/);
});
