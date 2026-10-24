import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { writeFileSync, mkdtempSync, mkdirSync, existsSync, readFileSync } from "node:fs";
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
  assert.equal(call("types.mjs").status, 0); // the owner may edit it
  assert.equal(call("db/a.mjs").status, 0);
  writeFileSync(join(d, "types.mjs"), "export function formatPrice() {}\n"); g("commit", "-qam", "evolve");
  const v = run(["verify"], { cwd: d });
  assert.equal(v.status, 0);
  assert.match(v.stdout, /NOTE foundations changed its exposed file types\.mjs/);
  g("checkout", "-qb", "fanout/money");
  const r = call("types.mjs");
  assert.equal(r.status, 2);
  assert.match(r.stderr, /types\.mjs is a contract \(exposed by "foundations"\)/);
  writeFileSync(join(d, "card.mjs"), "x\n"); g("add", "card.mjs"); g("commit", "-qm", "card");
  g("checkout", "-q", "main"); g("branch", "-f", "fanout/money", "main");
  g("checkout", "-q", "fanout/money");
  writeFileSync(join(d, "types.mjs"), "export function other() {}\n"); g("commit", "-qam", "break it");
  const v2 = run(["verify"], { cwd: d });
  assert.equal(v2.status, 1);
  assert.match(v2.stdout, /CONTRACT CHANGED money: types\.mjs/);
});

test("check rejects plan-wide settings inside a session, unknown fields and missing owns", () => {
  const bad = check(parsePlan("## a\nowns: a/**\ntest: npm test\nregen: npm run gen\nowner: me\n## b\ndone: x\n"), null).problems.join("\n");
  assert.match(bad, /PLAN test: goes above the first "##" line/);
  assert.match(bad, /PLAN regen: goes above/);
  assert.match(bad, /PLAN unknown field "owner:" in a/);
  assert.match(bad, /PLAN b has no owns/);
  assert.deepEqual(check(parsePlan("test: npm test\n## a\nowns: a\nmodel: opus\ndone: ok\n"), null).problems, []);
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

test("guard finds the lane from the edited file, even when the agent's cwd is the main checkout", () => {
  const d = dir();
  const g = (...a) => execFileSync("git", a, { cwd: d, stdio: "ignore" });
  g("init", "-q", "-b", "main"); g("config", "user.email", "t@t"); g("config", "user.name", "t");
  writeFileSync(join(d, "x.txt"), "1"); g("add", "-A"); g("commit", "-qm", "init");
  mkdirSync(join(d, ".fanout"));
  writeFileSync(join(d, ".fanout/plan.md"), "## s\nowns: mine/**\n");
  const lane = join(d, ".fanout", "lanes", "s");
  g("worktree", "add", "-q", "-b", "fanout/s", lane);
  const call = (file) => run(["guard"], { cwd: d, input: JSON.stringify({ tool_name: "Write", cwd: d, tool_input: { file_path: file } }) });
  assert.equal(call(join(lane, "mine", "new", "a.ts")).status, 0);
  const bad = call(join(lane, "other.ts"));
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /does not own other\.ts/);
  assert.equal(call(join(d, "other.ts")).status, 0); // main checkout itself: not a lane
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

test("rehearse: one test run when everything passes, a short bisect when not", () => {
  const d = dir(), counter = join(dir(), "runs.txt");
  const g = (...a) => execFileSync("git", a, { cwd: d, stdio: "ignore" });
  g("init", "-q", "-b", "main"); g("config", "user.email", "t@t"); g("config", "user.name", "t");
  // The test counts its own runs and fails once lane c's file exists.
  writeFileSync(join(d, "test.mjs"), `import { appendFileSync, existsSync } from "node:fs";\nappendFileSync(${JSON.stringify(counter)}, process.cwd() + ";");\nif (existsSync("c.txt")) process.exit(1);\n`);
  g("add", "-A"); g("commit", "-qm", "init");
  mkdirSync(join(d, ".fanout"));
  for (const l of ["a", "b", "c", "d"]) {
    g("checkout", "-q", "main"); g("checkout", "-qb", "fanout/" + l);
    writeFileSync(join(d, l + ".ok"), l); g("add", "-A"); g("commit", "-qm", l);
  }
  g("checkout", "-q", "main");
  writeFileSync(join(d, ".git/info/exclude"), ".fanout/\n");
  const runs = () => (existsSync(counter) ? readFileSync(counter, "utf8").split(";").length - 1 : 0);
  writeFileSync(join(d, ".fanout/plan.md"), "test: node test.mjs\n## a\nowns: a.ok\n## b\nowns: b.ok\n## c\nowns: c.ok\n## d\nowns: d.ok\n");
  const ok = run(["rehearse"], { cwd: d });
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.equal(runs(), 1);
  const logged = JSON.parse(readFileSync(join(d, ".fanout/log.jsonl"), "utf8").trim().split("\n").at(-1));
  assert.deepEqual([logged.kind, logged.sessions, logged.testRuns, logged.result], ["rehearse", 4, 1, "pass"]);
  g("checkout", "-q", "fanout/c"); writeFileSync(join(d, "c.txt"), "boom"); g("add", "-A"); g("commit", "-qm", "break"); g("checkout", "-q", "main");
  const r = run(["rehearse"], { cwd: d });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /BROKE after c/);
  assert.ok(runs() - 1 <= 4, `bisect used ${runs() - 1} test runs`); // full run, 2 halvings, 1 rerun to rule out flakiness
});

test("rehearse: tests already failing on main, and flaky tests, blame no branch", () => {
  const d = dir(), counter = join(dir(), "runs.txt");
  const g = (...a) => execFileSync("git", a, { cwd: d, stdio: "ignore" });
  g("init", "-q", "-b", "main"); g("config", "user.email", "t@t"); g("config", "user.name", "t");
  writeFileSync(join(d, ".git/info/exclude"), ".fanout/\n");
  writeFileSync(join(d, "test.mjs"), "process.exit(1)\n");
  g("add", "-A"); g("commit", "-qm", "init");
  for (const l of ["a", "b"]) {
    g("checkout", "-q", "main"); g("checkout", "-qb", "fanout/" + l);
    writeFileSync(join(d, l + ".ok"), l); g("add", "-A"); g("commit", "-qm", l);
  }
  g("checkout", "-q", "main");
  mkdirSync(join(d, ".fanout"));
  writeFileSync(join(d, ".fanout/plan.md"), "test: node test.mjs\n## a\nowns: a.ok\n## b\nowns: b.ok\n");
  const broken = run(["rehearse"], { cwd: d });
  assert.equal(broken.status, 1);
  assert.match(broken.stdout, /BASE FAILS: `node test\.mjs` already fails on main/);
  assert.doesNotMatch(broken.stdout, /BROKE after/);
  // Fails on its first run only: a flaky test.
  writeFileSync(join(d, "test.mjs"), `import { appendFileSync, existsSync } from "node:fs";\nconst f = ${JSON.stringify(counter)};\nconst first = !existsSync(f);\nappendFileSync(f, "x");\nif (first) process.exit(1);\n`);
  g("add", "-A"); g("commit", "-qm", "flaky test");
  const flaky = run(["rehearse"], { cwd: d });
  assert.equal(flaky.status, 1);
  assert.match(flaky.stdout, /FLAKY: `node test\.mjs` failed, then passed on a rerun/);
  assert.doesNotMatch(flaky.stdout, /BROKE after/);
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
  writeFileSync(join(d, ".fanout/plan.md"), "regen: gen.txt via true\n## s\nowns: mine.txt, types.txt\nexposes: types.txt\n## t\nowns: theirs.txt\nuses: types.txt\n");
  writeFileSync(join(d, ".git/info/exclude"), ".fanout/\n");
  assert.equal(run(["install-git-hook"], { cwd: d }).status, 0);
  assert.equal(run(["install-git-hook"], { cwd: d }).status, 0); // reinstalling over our own hook is fine
  assert.equal(commit("other.txt").status, 0); // main: untouched
  g("checkout", "-qb", "fanout/s");
  assert.equal(commit("mine.txt").status, 0);
  for (const [file, msg] of [["other.txt", /does not own other\.txt/], ["gen.txt", /gen\.txt is generated/]]) {
    const r = commit(file);
    assert.notEqual(r.status, 0, file);
    assert.match(r.stderr, msg);
    g("reset", "-q");
  }
  assert.equal(commit("types.txt").status, 0); // the owner may change its exposed file
  g("checkout", "-q", "main"); g("checkout", "-qb", "fanout/t");
  const c = commit("types.txt");
  assert.notEqual(c.status, 0);
  assert.match(c.stderr, /types\.txt is a contract/);
  g("reset", "-q");
  writeFileSync(join(d, ".git/hooks/pre-commit"), "#!/bin/sh\nexit 0\n");
  assert.equal(run(["install-git-hook"], { cwd: d }).status, 1); // someone else's hook: left alone
});

test("run: lanes in parallel, out-of-lane work reverted, a break goes back to its lane, then merged", () => {
  const d = dir();
  const g = (...a) => execFileSync("git", a, { cwd: d, stdio: "ignore" });
  g("init", "-q", "-b", "main"); g("config", "user.email", "t@t"); g("config", "user.name", "t");
  writeFileSync(join(d, "test.mjs"), 'import { existsSync } from "node:fs";\nif (existsSync("b.mjs")) { const { b } = await import("./b.mjs"); if (b !== 2) { console.error("b is " + b); process.exit(1); } }\n');
  g("add", "-A"); g("commit", "-qm", "init");
  // A stand-in agent: writes its lane's file from the brief; b gets it wrong until told it broke.
  const fake = join(dir(), "agent.mjs");
  writeFileSync(fake, `import { readFileSync, writeFileSync } from "node:fs";
const brief = readFileSync(0, "utf8"), name = brief.match(/session "(\\w+)"/)[1];
if (name === "a") { writeFileSync("a.mjs", "export const a = 1\\n"); writeFileSync("stray.txt", "not mine"); }
if (name === "b") writeFileSync("b.mjs", 'import { a } from "./a.mjs"\\nexport const b = a + ' + (brief.includes("it broke") ? 1 : 2) + "\\n");
`);
  mkdirSync(join(d, ".fanout"));
  writeFileSync(join(d, ".fanout/plan.md"), "test: node test.mjs\n\n## a\nowns: a.mjs\nexposes: a.mjs\ntask: export a = 1\n\n## b\nowns: b.mjs\nuses: a.mjs\ntask: export b = a + 1\n");
  // a.mjs is a contract, so it has to exist on main before the lanes start.
  writeFileSync(join(d, "a.mjs"), "export const a = 1\n"); g("add", "a.mjs"); g("commit", "-qm", "contract");
  const ask = run(["run"], { cwd: d, input: "" });
  assert.equal(ask.status, 0);
  assert.match(ask.stdout, /Run again with --yes/);
  const r = run(["run", "--yes", "--agent", `node "${fake}"`], { cwd: d });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /a: done in \d+s, reverted out-of-lane: stray\.txt/);
  assert.match(r.stdout, /rehearse: BROKE after b/);
  assert.match(r.stdout, /merged into main: a -> b \(3 agent runs, 1 fixes/);
  assert.equal(execFileSync(process.execPath, ["-e", 'import("./b.mjs").then((m) => console.log(m.b))'], { cwd: d, encoding: "utf8" }).trim(), "2");
  assert.equal(execFileSync("git", ["branch", "--list", "fanout/*"], { cwd: d, encoding: "utf8" }).trim(), "");
  // The run left one log line: phases, test runs, the fix, and cost "unknown" (not $0) for a non-Claude agent.
  const runs = readFileSync(join(d, ".fanout/log.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((x) => x.kind === "run");
  assert.equal(runs.length, 1);
  const [rec] = runs;
  assert.equal(rec.result, "merged");
  assert.equal(rec.sessions, 2);
  assert.equal(rec.fixes, 1);
  assert.ok(rec.testRuns >= 3, `test runs ${rec.testRuns}`);
  assert.equal(rec.costUnknown, true);
  assert.deepEqual(Object.keys(rec.phases), ["plan", "sessions", "rehearse", "merge"]);
  assert.deepEqual(rec.agents.map((a) => a.role), ["lane", "lane", "fix"]);
  const shown = run(["log"], { cwd: d });
  assert.equal(shown.status, 0);
  assert.match(shown.stdout, /run\s+2\s+\S+\s+1\s+\d+\s+\$0\.00\+\?\s+merged/);
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
