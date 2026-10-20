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

test("guard blocks edits outside owns, allows inside, no-op without a session", () => {
  const d = dir();
  execFileSync("git", ["init", "-q"], { cwd: d });
  const plan = join(d, "plan.md");
  writeFileSync(plan, "## s\nowns: mine/**\n");
  const call = (file, env) => run(["guard", plan], {
    cwd: d,
    env: { ...process.env, ...env },
    input: JSON.stringify({ tool_name: "Edit", cwd: d, tool_input: { file_path: file } }),
  });
  assert.equal(call(join(d, "mine/a.ts"), { FANOUT_SESSION: "s" }).status, 0);
  const bad = call(join(d, "other/a.ts"), { FANOUT_SESSION: "s" });
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /does not own other\/a\.ts/);
  assert.equal(call(join(d, "other/a.ts"), { FANOUT_SESSION: "" }).status, 0);
  assert.equal(call(join(tmpdir(), "elsewhere.txt"), { FANOUT_SESSION: "s" }).status, 0);
});
