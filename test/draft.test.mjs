import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { draftPlan } from "../skills/fanout/draft.mjs";
import { parsePlan, parseRegen, planSetting } from "../skills/fanout/fanout.mjs";

const repoWith = (files) => {
  const root = mkdtempSync(join(tmpdir(), "fanout-draft-"));
  for (const [f, body] of Object.entries(files)) { mkdirSync(join(root, f, ".."), { recursive: true }); writeFileSync(join(root, f), body); }
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["add", "-A"], { cwd: root });
  return root;
};
const project = () => repoWith({ "package.json": JSON.stringify({ scripts: { test: 'node --test "test/*.test.mjs"', gen: "node gen.mjs" } }), "src/core.mjs": "", "src/index.mjs": "", "test/core.test.mjs": "" });

const GOAL = `# Tasks
Every module is exported from \`src/index.mjs\`, which is generated: run \`npm run gen\` after adding one.

## parser
Add \`src/parser.mjs\` with \`parse(text)\`. Long spec ${"x".repeat(400)}.

## eval
Add \`src/eval.mjs\`, built on \`parse\` from \`src/parser.mjs\`.

## format
Add \`src/format.mjs\` with \`format(n)\`.

## io
Add \`read()\` in \`src/io.mjs\` and change \`src/core.mjs\`.
`;

test("draft: owners, contracts, regen, test and checks from a goal's sections", () => {
  const root = project();
  const d = draftPlan({ goal: GOAL, root });
  const sessions = parsePlan(d.text), by = Object.fromEntries(sessions.map((s) => [s.name, s]));
  assert.deepEqual(sessions.map((s) => s.name), ["parser", "eval", "format", "io"]);
  assert.deepEqual(by.parser.owns, ["src/parser.mjs", "test/parser.test.mjs"]);
  assert.deepEqual(by.parser.exposes, ["src/parser.mjs"]);
  assert.deepEqual(by.eval.uses, ["src/parser.mjs"]);
  assert.deepEqual(by.io.owns, ["src/io.mjs", "src/core.mjs", "test/io.test.mjs"]);
  assert.equal(by.parser.check, "node --test test/parser.test.mjs");
  assert.equal(by.eval.task, "Add `src/eval.mjs`, built on `parse` from `src/parser.mjs`");
  assert.deepEqual(parseRegen(d.text), [{ paths: ["src/index.mjs"], cmd: "npm run gen" }]);
  assert.equal(planSetting(d.text, "test"), "npm test");
  assert.equal(d.contracts, true);
  assert.match(d.specs.eval, /generated: run `npm run gen`[\s\S]*## eval\nAdd `src\/eval.mjs`/);
  assert.doesNotMatch(d.specs.eval, /## format/);
});

test("draft: merges the smallest sections first, a dependent pair sooner", () => {
  const d = draftPlan({ goal: GOAL, root: project(), maxSessions: 3 });
  const names = parsePlan(d.text).map((s) => s.name);
  assert.equal(names.length, 3);
  assert.ok(names.includes("parser"), names.join()); // the big section stays alone
  const two = draftPlan({ goal: GOAL, root: project(), maxSessions: 2 });
  assert.deepEqual(parsePlan(two.text).map((s) => s.name).sort(), ["eval-format-io", "parser"]);
});

test("draft: no draft for prose, one section, or a new file nobody adds", () => {
  const root = project();
  assert.equal(draftPlan({ goal: "add coupons and tax to the cart", root }), null);
  assert.equal(draftPlan({ goal: "## one\nAdd `src/one.mjs`.", root }), null);
  assert.equal(draftPlan({ goal: "## a\nUse `src/new.mjs`.\n## b\nRead `src/new.mjs`.", root }), null);
  assert.equal(draftPlan({ goal: "## a\nTidy things.\n## b\nAdd `src/b.mjs`.", root }), null); // a owns nothing
});
