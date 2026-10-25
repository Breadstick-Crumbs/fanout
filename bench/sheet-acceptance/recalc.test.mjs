import { test } from "node:test";
import assert from "node:assert/strict";
import { createSheet, setCell, valueOf, computeAll, dependents } from "../src/index.mjs";

const sheetOf = (obj) => { const s = createSheet(); for (const [a, r] of Object.entries(obj)) setCell(s, a, r); return s; };

test("recalc: valueOf", () => {
  assert.equal(valueOf(""), null);
  assert.equal(valueOf(" 42 "), 42);
  assert.equal(valueOf("1e3"), 1000);
  assert.equal(valueOf("true"), true);
  assert.equal(valueOf("'123"), "123");
  assert.equal(valueOf("hello"), "hello");
});

test("recalc: formulas read other cells, in any order", () => {
  const v = computeAll(sheetOf({ A1: "=B1*2", B1: "=C1+1", C1: "4", D1: "=A1&\"!\"", E1: "=Z9+1", F1: "=1+" }));
  assert.equal(v.get("A1"), 10);
  assert.equal(v.get("B1"), 5);
  assert.equal(v.get("C1"), 4);
  assert.equal(v.get("D1"), "10!");
  assert.equal(v.get("E1"), 1);
  assert.equal(v.get("F1"), "#ERROR!");
  assert.equal(v.has("Z9"), false);
  assert.equal(v.size, 6);
});

test("recalc: cycles", () => {
  const v = computeAll(sheetOf({ A1: "=B1", B1: "=A1+1", C1: "=C1", D1: "=A1+1", E1: "=IF(TRUE,5,A1)", F1: "7" }));
  assert.equal(v.get("A1"), "#CYCLE!");
  assert.equal(v.get("B1"), "#CYCLE!");
  assert.equal(v.get("C1"), "#CYCLE!");
  assert.equal(v.get("D1"), "#CYCLE!");
  assert.equal(v.get("E1"), 5);
  assert.equal(v.get("F1"), 7);
});

test("recalc: a 10,000-cell chain", () => {
  const s = createSheet();
  setCell(s, "A1", "1");
  for (let r = 2; r <= 10000; r++) setCell(s, `A${r}`, `=A${r - 1}+1`);
  assert.equal(computeAll(s).get("A10000"), 10000);
  assert.equal(dependents(s, "A9998").join(), "A9999,A10000");
});

test("recalc: dependents in dependency order", () => {
  const s = sheetOf({ A1: "1", C1: "=A1", B2: "=A1*2", A3: "=C1+B2", D1: "=A3", E1: "=E1+A1", F1: "5" });
  assert.deepEqual(dependents(s, "A1"), ["C1", "B2", "A3", "D1"]);
  assert.deepEqual(dependents(s, "B2"), ["A3", "D1"]);
  assert.deepEqual(dependents(s, "F1"), []);
});
