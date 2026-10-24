import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { writeFileSync, mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parsePlan, parseRegen, matches, check, verify, editTargets } from "../skills/fanout/fanout.mjs";

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

test("contracts: uses implies merge order; bad exposes and uses are reported", () => {
  const ok = check(parsePlan("## money\nowns: card.mjs\nuses: types.mjs\n## foundations\nowns: types.mjs, db/**\nexposes: types.mjs\n"), null);
  assert.deepEqual(ok.problems, []);
  assert.deepEqual(ok.order, ["foundations", "money"]);
  const bad = check(parsePlan("## a\nowns: a/**\nexposes: b/x.ts\nuses: a/y.ts\n## b\nowns: b/**\nuses: nope.ts\n"), null).problems.join("\n");
  assert.match(bad, /EXPOSES b\/x\.ts \(in a\): not in its owns/);
  assert.match(bad, /USES nope\.ts \(in b\): no other session exposes it/);
  assert.match(bad, /USES a\/y\.ts \(in a\)/); // can't use your own file as a contract
  assert.match(check(parsePlan("## a\nowns: a\nexposes: a\nuses: b\n## b\nowns: b\nexposes: b\nuses: a\n"), null).problems.join(), /CYCLE/);
});

test("contracts: frozen in the guard (owner included) and flagged by verify", () => {
  const d = dir();
  const g = (...a) => execFileSync("git", a, { cwd: d, stdio: "ignore" });
  g("init", "-q", "-b", "main"); g("config", "user.email", "t@t"); g("config", "user.name", "t");
  writeFileSync(join(d, "types.mjs"), "export function price() {}\n"); g("add", "-A"); g("commit", "-qm", "contract");
  mkdirSync(join(d, ".fanout"));
  writeFileSync(join(d, ".fanout/plan.md"), "## foundations\nowns: types.mjs, db/**\nexposes: types.mjs\n## money\nowns: card.mjs\nuses: types.mjs\n");
  g("checkout", "-qb", "fanout/foundations");
  const call = (file) => run(["guard"], { cwd: d, input: JSON.stringify({ tool_name: "Edit", cwd: d, tool_input: { file_path: join(d, file) } }) });
  const r = call("types.mjs");
  assert.equal(r.status, 2);
  assert.match(r.stderr, /types\.mjs is a contract \(exposed by "foundations"\)/);
  assert.equal(call("db/a.mjs").status, 0);
  writeFileSync(join(d, "types.mjs"), "export function formatPrice() {}\n"); g("commit", "-qam", "rename anyway");
  const v = run(["verify"], { cwd: d });
  assert.equal(v.status, 1);
  assert.match(v.stdout, /CONTRACT CHANGED foundations: types\.mjs/);
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

test("guard reads Codex apply_patch edits", () => {
  assert.deepEqual(editTargets({ command: "*** Begin Patch\n*** Update File: a.ts\n@@\n-x\n+y\n*** Add File: b/c.ts\n+z\n*** Delete File: d.ts\n*** End Patch\n" }), ["a.ts", "b/c.ts", "d.ts"]);
  assert.deepEqual(editTargets({ command: ["ls", "-la"] }), []);
  const d = dir();
  const g = (...a) => execFileSync("git", a, { cwd: d, stdio: "ignore" });
  g("init", "-q", "-b", "main"); g("config", "user.email", "t@t"); g("config", "user.name", "t");
  writeFileSync(join(d, "x.txt"), "1"); g("add", "-A"); g("commit", "-qm", "init");
  mkdirSync(join(d, ".fanout"));
  writeFileSync(join(d, ".fanout/plan.md"), "## s\nowns: mine/**\n");
  g("checkout", "-qb", "fanout/s");
  const patch = (files) => run(["guard"], { cwd: d, input: JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "apply_patch", cwd: d,
    tool_input: { command: "*** Begin Patch\n" + files.map((f) => `*** Add File: ${f}\n+hi\n`).join("") + "*** End Patch\n" } }) });
  assert.equal(patch(["mine/a.ts"]).status, 0);
  const bad = patch(["mine/a.ts", "other.ts"]);
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /does not own other\.ts/);
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

test("regen: parsed, no session may own it, guard blocks it, rehearse rebuilds it", () => {
  assert.deepEqual(parseRegen("regen: gen/**, api.d.ts via npm run codegen\n## a\nowns: a\n"), [{ paths: ["gen/**", "api.d.ts"], cmd: "npm run codegen" }]);
  const bad = check(parsePlan("## a\nowns: gen/**\n"), null, parseRegen("regen: gen/x.ts\nregen: gen/** via x\n")).problems.join("\n");
  assert.match(bad, /REGEN gen\/x\.ts: no command/);
  assert.match(bad, /REGEN gen\/\*\* is generated but a owns gen\/\*\*/);

  const d = dir();
  const g = (...a) => execFileSync("git", a, { cwd: d, stdio: "ignore" });
  g("init", "-q", "-b", "main"); g("config", "user.email", "t@t"); g("config", "user.name", "t");
  writeFileSync(join(d, "src.txt"), "1");
  writeFileSync(join(d, "gen.txt"), "1");
  writeFileSync(join(d, "build.mjs"), 'import fs from "node:fs"; fs.writeFileSync("gen.txt", fs.readFileSync("src.txt"))\n');
  writeFileSync(join(d, "test.mjs"), 'import fs from "node:fs"; if (String(fs.readFileSync("gen.txt")) !== String(fs.readFileSync("src.txt"))) process.exit(1)\n');
  g("add", "-A"); g("commit", "-qm", "base");
  mkdirSync(join(d, ".fanout"));
  writeFileSync(join(d, ".fanout/plan.md"), "test: node test.mjs\nregen: gen.txt via node build.mjs\n\n## a\nowns: src.txt\n");
  g("checkout", "-qb", "fanout/a");
  const r = run(["guard"], { cwd: d, input: JSON.stringify({ tool_name: "Edit", cwd: d, tool_input: { file_path: join(d, "gen.txt") } }) });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /gen\.txt is generated \(`node build\.mjs` rebuilds it/);
  writeFileSync(join(d, "src.txt"), "2"); g("commit", "-qam", "change source only");
  g("checkout", "-q", "main");
  const rh = run(["rehearse"], { cwd: d });
  assert.equal(rh.status, 0, rh.stdout);
  assert.match(rh.stdout, /OK after a/);
});

test("git hook: staged out-of-lane, contract and generated files are refused on fanout branches only", () => {
  const d = dir();
  const g = (...a) => execFileSync("git", a, { cwd: d, stdio: "ignore" });
  const commit = (file) => { writeFileSync(join(d, file), String(Math.random())); g("add", file); return spawnSync("git", ["commit", "-qm", file], { cwd: d, encoding: "utf8" }); };
  g("init", "-q", "-b", "main"); g("config", "user.email", "t@t"); g("config", "user.name", "t");
  writeFileSync(join(d, "x.txt"), "1"); g("add", "-A"); g("commit", "-qm", "init");
  mkdirSync(join(d, ".fanout"));
  writeFileSync(join(d, ".fanout/plan.md"), "regen: gen.txt via true\n## s\nowns: mine.txt, types.txt\nexposes: types.txt\n");
  writeFileSync(join(d, ".git/info/exclude"), ".fanout/\n");
  assert.equal(run(["install-git-hook"], { cwd: d }).status, 0);
  assert.equal(run(["install-git-hook"], { cwd: d }).status, 0); // reinstalling over our own hook is fine
  assert.equal(commit("other.txt").status, 0); // main: untouched
  g("checkout", "-qb", "fanout/s");
  assert.equal(commit("mine.txt").status, 0);
  for (const [file, msg] of [["other.txt", /does not own other\.txt/], ["types.txt", /types\.txt is a contract/], ["gen.txt", /gen\.txt is generated/]]) {
    const r = commit(file);
    assert.notEqual(r.status, 0, file);
    assert.match(r.stderr, msg);
    g("reset", "-q");
  }
  writeFileSync(join(d, ".git/hooks/pre-commit"), "#!/bin/sh\nexit 0\n");
  assert.equal(run(["install-git-hook"], { cwd: d }).status, 1); // someone else's hook: left alone
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
