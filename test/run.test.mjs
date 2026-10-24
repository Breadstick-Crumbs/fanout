import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAgent } from "../skills/fanout/run.mjs";

// A fake claude/codex: logs its args and stdin as one JSON line, then answers like the real CLI would.
const dir = mkdtempSync(join(tmpdir(), "fanout-run-"));
const logFile = join(dir, "calls.jsonl");
const fake = join(dir, "fake.mjs");
writeFileSync(fake, `
import { appendFileSync, readFileSync } from "node:fs";
const args = process.argv.slice(2), stdin = readFileSync(0, "utf8");
appendFileSync(${JSON.stringify(logFile)}, JSON.stringify({ args, stdin }) + "\\n");
const resuming = args.includes("--resume") || args.includes("resume");
if (resuming && process.env.FAKE_FAIL_RESUME) { console.log(JSON.stringify({ is_error: true, result: "no such session" })); process.exit(1); }
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
};

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
