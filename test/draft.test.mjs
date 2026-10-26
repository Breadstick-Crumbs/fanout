import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { draftPlan } from "../skills/fanout/draft.mjs";
import { parsePlan, parseRegen, planSetting } from "../skills/fanout/fanout.mjs";

// Claims' same-work check calls a real CLI; no test here may reach one.
process.env.FANOUT_CLAIM_JUDGE = "off";

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

test("draft: flags a name a session uses from a file another session owns, not one it builds on", () => {
  const root = repoWith({ "package.json": "{}", "src/store.mjs": "export function createStore() {}\nexport const addBook = () => {};\n", "src/lib.mjs": "export { helper as help };\n" });
  const goal = "## holds\nChange `src/store.mjs` to keep holds.\n\n## fines\nAdd `src/fines.mjs`. `createStore` must start with `payments: []`; use `help()` and `Map`.\n\n## csv\nAdd `src/csv.mjs`, built on `src/store.mjs`: calls `addBook`.\n";
  const d = draftPlan({ goal, root });
  assert.deepEqual(d.flags, [{ session: "fines", name: "createStore", file: "src/store.mjs", owner: "holds" }]);
});

test("draft: a glob of generated files and a test command from the goal; PHP functions are flagged too", () => {
  const root = repoWith({ "theme/inc/header.php": "<?php\nfunction sgt_header() {}\n", "theme/inc/about.php": "<?php\n", "theme/css/about.css": "", "theme/css/about-rtl.css": "" });
  const goal = "The copies `theme/css/*-rtl.css` are generated: run `bash tools/rtl.sh`.\nTest with `bash tools/check.sh`.\n\n## header\nChange `theme/inc/header.php`: add a switch.\n\n## about\nChange `theme/inc/about.php` and `theme/css/about.css`, using `sgt_header()`; leave `theme/css/about-rtl.css` to the generator.\n";
  const d = draftPlan({ goal, root });
  assert.equal(planSetting(d.text, "test"), "bash tools/check.sh");
  assert.deepEqual(parseRegen(d.text), [{ paths: ["theme/css/*-rtl.css"], cmd: "bash tools/rtl.sh" }]);
  assert.deepEqual(parsePlan(d.text).find((s) => s.name === "about").owns, ["theme/inc/about.php", "theme/css/about.css"]);
  assert.deepEqual(d.flags, [{ session: "about", name: "sgt_header", file: "theme/inc/header.php", owner: "header" }]);
});
