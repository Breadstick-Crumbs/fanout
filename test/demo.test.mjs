import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync, execFileSync } from "node:child_process";
import { describe, svgRecording, demoRepo } from "../skills/fanout/demo.mjs";
import { claimsActive } from "../skills/fanout/claims.mjs";

const FANOUT = join(import.meta.dirname, "../skills/fanout/fanout.mjs");

test("fanout demo says what it will spend and starts nothing without --yes", () => {
  const d = mkdtempSync(join(tmpdir(), "fanout-demo-t-")), log = join(d, "calls.txt");
  writeFileSync(join(d, "claude.mjs"), `require("node:fs").appendFileSync(${JSON.stringify(log)}, "call\\n");`);
  const r = spawnSync(process.execPath, [FANOUT, "demo"], { encoding: "utf8", input: "", env: { ...process.env, FANOUT_CLAUDE_BIN: `node "${join(d, "claude.mjs")}"` } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /three real Claude Code sessions \(Sonnet\).*\n.*About two minutes and \$0\.10/);
  assert.match(r.stdout, /Run again with --yes to start\./);
  assert.equal(existsSync(log), false, "no agent started");
  rmSync(d, { recursive: true, force: true });
});

test("the demo repo has a worktree per session, claims on by themselves, and fanout's hooks", (t) => {
  const { dir, repo, wt, settings } = demoRepo();
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5 }));
  assert.ok(Object.values(wt).every((w) => w.startsWith(dir)) && settings.startsWith(dir), "everything in one folder, removed in one go");
  assert.deepEqual(Object.keys(wt), ["dark-mode", "night-theme", "receipt", "prices"]);
  assert.equal(claimsActive(repo), true);
  assert.equal(execFileSync("git", ["branch", "--show-current"], { cwd: wt.receipt, encoding: "utf8" }).trim(), "receipt");
  const hooks = JSON.parse(readFileSync(settings, "utf8")).hooks;
  assert.match(hooks.PreToolUse[0].hooks[0].command, /fanout\.mjs" guard$/);
  assert.match(hooks.PostToolUse[0].hooks[0].command, /fanout\.mjs" notice$/);
  assert.match(hooks.SessionStart[0].hooks[0].command, /fanout\.mjs" session-start$/);
});

test("narration: one line per claim, refusal and notice", () => {
  assert.match(describe({ kind: "claim", branch: "dark-mode", via: "edit", task: "Add a dark mode toggle" }).text, /^dark-mode: claimed on its first edit: "Add a dark mode toggle"$/);
  assert.match(describe({ kind: "refused", branch: "night-theme", as: ["dark-mode"] }).text, /night-theme: STOPPED at its first edit: same work as dark-mode/);
  assert.match(describe({ kind: "notice", session: "receipt", from: "prices", files: ["money.js"] }).text, /receipt: told prices committed a change to money\.js, with the diff/);
  assert.equal(describe({ kind: "other" }), null);
});

test("the recording is an SVG whose lines appear in order and loop, with text escaped", () => {
  const svg = svgRecording([{ t: 0, text: "$ fanout demo", tone: "dim" }, { t: 12, text: "a <b> & c", tone: "stop" }, { t: 30, text: "done", tone: "done" }]);
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  assert.match(svg, /a &lt;b&gt; &amp; c/);
  const starts = [...svg.matchAll(/@keyframes l\d\{0%,([\d.]+)%/g)].map((m) => Number(m[1]));
  assert.equal(starts.length, 3);
  assert.ok(starts[0] < starts[1] && starts[1] < starts[2], "in order");
  assert.match(svg, /infinite/);
});
