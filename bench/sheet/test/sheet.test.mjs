import { test } from "node:test";
import assert from "node:assert/strict";
import { createSheet, setCell, getCell, cellAddrs, parseAddr, toAddr, colName, colIndex } from "../src/index.mjs";

test("addresses", () => {
  assert.deepEqual(parseAddr("$B$12"), { col: 1, row: 11, colAbs: true, rowAbs: true });
  assert.equal(toAddr(27, 0), "AB1");
  assert.equal(colIndex(colName(702)), 702);
  assert.throws(() => parseAddr("A0"));
});

test("cells", () => {
  const s = createSheet();
  setCell(s, "b2", "x");
  setCell(s, "A3", "=B2");
  setCell(s, "A1", "1");
  assert.equal(getCell(s, "B2"), "x");
  assert.deepEqual(cellAddrs(s), ["A1", "B2", "A3"]);
  setCell(s, "B2", "");
  assert.equal(getCell(s, "B2"), "");
});
