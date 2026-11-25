import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

const entry = join(import.meta.dirname, "../skills/fanout/fanout.mjs");
const workerSource = `
import { appendFileSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";

const { id, items } = JSON.parse(readFileSync(process.env.FANOUT_JOB_PARTITION_FILE, "utf8"));
const config = JSON.parse(process.env.JOB_TEST_CONFIG)[id];
const input = createInterface({ input: process.stdin });
const replies = input[Symbol.asyncIterator]();
const send = (event) => new Promise((resolve) => process.stdout.write(JSON.stringify(event) + "\\n", resolve));
const reply = async () => {
  const line = await replies.next();
  return line.done ? null : JSON.parse(line.value);
};
const trace = (state) => appendFileSync("trace", JSON.stringify({ id, items, state }) + "\\n");
trace("start");
console.error("diagnostic for", id);
await send({ type: "reserve", id, maxMicros: config.max });
const permit = await reply();
if (permit?.type === "permit") {
  trace("permit");
  if (config.waitForDisconnect) {
    await reply();
  } else if (!config.crash) {
    if (config.delay) await delay(config.delay);
    await send({ type: "settle", id, actualMicros: config.actual });
    if ((await reply())?.type === "settled") {
      trace("done");
      await send({ type: "complete" });
    }
  }
} else if (permit?.type === "denied") {
  trace("denied");
}
input.close();
process.stdin.pause();
`;

function fixture(t, { cap, config, partitions, concurrency = 1, rate = 60 }) {
  const cwd = mkdtempSync(join(tmpdir(), "fanout-jobs-test-")), base = join(cwd, "state");
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const plan = {
    worker: { command: process.execPath, args: ["worker.mjs"] },
    budgetMicros: cap, requestsPerMinute: rate, concurrency,
    partitions: partitions ?? Object.keys(config).map((id) => ({ id, items: [`site-${id}`] })),
  };
  writeFileSync(join(cwd, "worker.mjs"), workerSource);
  writeFileSync(join(cwd, "plan.json"), JSON.stringify(plan));
  const env = { ...process.env, FANOUT_JOBS_DIR: base, JOB_TEST_CONFIG: JSON.stringify(config) };
  const cli = (...args) => spawnSync(process.execPath, [entry, "jobs", ...args], { cwd, env, timeout: 25000, encoding: "utf8" });
  const start = (...args) => spawn(process.execPath, [entry, "jobs", ...args], { cwd, env, stdio: "ignore" });
  const id = () => readdirSync(base)[0];
  const state = () => JSON.parse(readFileSync(join(base, id(), "state.json"), "utf8"));
  const log = (name) => readFileSync(join(base, id(), name), "utf8");
  const trace = () => readFileSync(join(cwd, "trace"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  return { base, cli, start, id, state, log, trace };
}

const result = (r, code) => assert.equal(r.status, code, String(r.error ?? "") + r.stdout + r.stderr);

test("rejects overlapping partition items before launching workers", (t) => {
  const f = fixture(t, {
    cap: 5, config: {}, partitions: [{ id: "a", items: ["site-1"] }, { id: "b", items: ["site-1"] }],
  });
  const r = f.cli("run", "plan.json");
  result(r, 1);
  assert.match(r.stderr, /item "site-1" occurs more than once/);
  assert.equal(existsSync(f.base), false);
});

test("runs partitions concurrently and releases unused reservations for waiting workers", (t) => {
  const worker = { max: 8, actual: 2, delay: 1000 };
  const f = fixture(t, { cap: 10, concurrency: 2, config: { a: worker, b: worker } });
  result(f.cli("run", "plan.json"), 0);
  const state = f.state(), events = f.trace();
  assert.equal(state.phase, "completed");
  assert.equal(state.spentMicros, 4);
  assert.equal(state.heldMicros, 0);
  assert.equal(state.permits.length, 2);
  assert.ok(events.findIndex((x) => x.state === "done") > events.findLastIndex((x) => x.state === "start"));
  assert.deepEqual(events.filter((x) => x.state === "done").flatMap((x) => x.items).sort(), ["site-a", "site-b"]);
  assert.match(f.log("partition-1-attempt-1.stderr.log"), /diagnostic for a/);
  assert.match(f.log("partition-2-attempt-1.stdout.log"), /"type":"complete"/);
});

test("a shared budget denial checkpoints completed work and resume reruns only unfinished partitions", (t) => {
  const f = fixture(t, { cap: 8, config: { a: { max: 8, actual: 6 }, b: { max: 8, actual: 7 } } });
  result(f.cli("run", "plan.json"), 1);
  assert.deepEqual(f.state().partitions.map((part) => part.status), ["completed", "blocked"]);
  assert.match(f.cli("status", f.id()).stdout, /6 charged .*8 total/);
  result(f.cli("resume", f.id(), "--budget-micros", "7"), 1);
  result(f.cli("resume", f.id(), "--budget-micros", "14"), 0);
  assert.equal(f.state().spentMicros, 13);
  assert.deepEqual(f.state().partitions.map((part) => part.attempts), [1, 2]);
  assert.deepEqual(f.trace().filter((event) => event.state === "permit").map((event) => event.id), ["a", "b"]);
});

test("an unsettled permit is charged at its ceiling before another partition can spend", (t) => {
  const f = fixture(t, { cap: 10, config: { a: { max: 8, crash: true }, b: { max: 4, actual: 3 } } });
  result(f.cli("run", "plan.json"), 1);
  const state = f.state();
  assert.equal(state.spentMicros, 8);
  assert.equal(state.uncertainMicros, 8);
  assert.equal(state.heldMicros, 0);
  assert.deepEqual(state.partitions.map((part) => part.status), ["failed", "blocked"]);
});

test("overspending a reservation records the reported cost and stops the job", (t) => {
  const f = fixture(t, { cap: 10, config: { a: { max: 5, actual: 6 }, b: { max: 4, actual: 3 } } });
  const r = f.cli("run", "plan.json");
  result(r, 1);
  assert.match(r.stderr, /spent more than it reserved/);
  assert.equal(f.state().spentMicros, 6);
  assert.equal(f.state().phase, "failed");
  assert.equal(f.state().partitions[1].attempts, 0);
});

test("resume charges a durable reservation after the supervisor is killed", { timeout: 30000 }, async (t) => {
  const f = fixture(t, { cap: 10, config: { a: { max: 8, waitForDisconnect: true } } });
  const supervisor = f.start("run", "plan.json");
  const closed = new Promise((resolve, reject) => {
    supervisor.once("error", reject);
    supervisor.once("close", resolve);
  });
  let workerPid;
  try {
    for (let i = 0; i < 200 && supervisor.exitCode == null; i++) {
      try {
        const state = f.state();
        if (state.heldMicros === 8) { workerPid = state.partitions[0].pid; break; }
      } catch (error) { if (error.code !== "ENOENT") throw error; }
      await delay(50);
    }
    assert.ok(workerPid, "the first permit should already be persisted");
    supervisor.kill("SIGKILL");
    await closed;
    for (let i = 0; i < 200; i++) {
      try { process.kill(workerPid, 0); } catch (error) { if (error.code !== "ESRCH") throw error; break; }
      await delay(50);
    }
    assert.match(f.cli("status", f.id()).stdout, /: interrupted/);
    result(f.cli("resume", f.id()), 1);
    assert.equal(f.state().spentMicros, 8);
    assert.equal(f.state().uncertainMicros, 8);
    assert.equal(f.state().partitions[0].status, "blocked");
    assert.equal(f.state().partitions[0].attempts, 2);
  } finally {
    if (supervisor.exitCode == null && supervisor.signalCode == null) {
      supervisor.kill("SIGKILL");
      await closed;
    }
  }
});

test("abort reports surviving worker PIDs when the job supervisor is gone", async (t) => {
  const f = fixture(t, { cap: 10, config: {} });
  const dir = join(f.base, "job-orphan");
  mkdirSync(dir, { recursive: true });
  const worker = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  const closed = new Promise((resolve, reject) => { worker.once("close", resolve); worker.once("error", reject); });
  try {
    writeFileSync(join(dir, "state.json"), JSON.stringify({
      phase: "running", pid: null, budgetMicros: 10, spentMicros: 0, heldMicros: 0, uncertainMicros: 0,
      partitions: [{ id: "east", status: "running", attempts: 1, pid: worker.pid }],
    }));
    const aborted = f.cli("abort", "job-orphan");
    result(aborted, 1);
    assert.match(aborted.stdout, /: interrupted/);
    assert.match(aborted.stderr, new RegExp(`partition "east"  PID ${worker.pid}`));
    assert.doesNotThrow(() => process.kill(worker.pid, 0));
  } finally {
    worker.kill();
    await closed;
  }
  result(f.cli("abort", "job-orphan"), 0);
});

test("abort stops queued workers and resume retains the shared rate history", { timeout: 40000 }, async (t) => {
  const f = fixture(t, { cap: 10, rate: 1, config: { a: { max: 2, actual: 1 }, b: { max: 2, actual: 1 } } });
  async function abortAfterReserve(args, attempt) {
    const supervisor = f.start(...args);
    const closed = new Promise((resolve, reject) => {
      supervisor.once("error", reject);
      supervisor.once("close", resolve);
    });
    const file = `partition-2-attempt-${attempt}.stdout.log`;
    try {
      const deadline = Date.now() + 15000;
      let ready = false;
      while (Date.now() < deadline && supervisor.exitCode == null) {
        try { ready = f.log(file).includes('"type":"reserve"'); } catch (e) { if (e.code !== "ENOENT") throw e; }
        if (ready) break;
        await delay(50);
      }
      assert.ok(ready, "the second worker should be waiting for a request slot");
      assert.equal(f.state().permits.length, 1);
      assert.deepEqual(f.trace().filter((event) => event.state === "permit").map((event) => event.id), ["a"]);
      result(f.cli("abort", f.id()), 0);
      assert.equal(await closed, 130);
    } finally {
      if (supervisor.exitCode == null && supervisor.signalCode == null) {
        try { f.cli("abort", f.id()); } catch { /* reap failed test supervisor below */ }
        supervisor.kill();
        await closed;
      }
    }
  }
  await abortAfterReserve(["run", "plan.json"], 1);
  assert.deepEqual(f.state().partitions.map((part) => part.status), ["completed", "aborted"]);
  await abortAfterReserve(["resume", f.id()], 2);
  assert.equal(f.state().partitions[0].attempts, 1);
  assert.equal(f.state().partitions[1].attempts, 2);
});
