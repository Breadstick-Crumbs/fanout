import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../skills/fanout/check-plan.mjs", import.meta.url));
const run = (plan) => {
  const f = join(mkdtempSync(join(tmpdir(), "fanout-")), "plan.md");
  writeFileSync(f, plan);
  const r = spawnSync(process.execPath, [script, f], { encoding: "utf8" });
  return { code: r.status, out: r.stdout };
};

test("disjoint plan passes and prints merge order", () => {
  const r = run("## a\nowns: src/a/**\n## b\nowns: src/b.ts\nafter: a\n");
  assert.equal(r.code, 0);
  assert.match(r.out, /Merge order: a -> b/);
});

test("glob versus file inside it is a clash", () => {
  const r = run("## a\nowns: src/db/**\n## b\nowns: src/db/schema.ts\n");
  assert.equal(r.code, 1);
  assert.match(r.out, /CLASH a .* b /);
});

test("same file in two sessions is a clash", () => {
  assert.equal(run("## a\nowns: x.ts\n## b\nowns: x.ts\n").code, 1);
});

test("sibling directories with a shared name prefix do not clash", () => {
  assert.equal(run("## a\nowns: src/app/**\n## b\nowns: src/application/**\n").code, 0);
});

test("unknown and circular after are reported", () => {
  assert.equal(run("## a\nowns: a.ts\nafter: zz\n").code, 1);
  const r = run("## a\nowns: a.ts\nafter: b\n## b\nowns: b.ts\nafter: a\n");
  assert.equal(r.code, 1);
  assert.match(r.out, /CYCLE/);
});

test("merge order follows after even when listed later", () => {
  const r = run("## b\nowns: b.ts\nafter: a\n## a\nowns: a.ts\n");
  assert.match(r.out, /Merge order: a -> b/);
});
