import { test } from "node:test";
import assert from "node:assert/strict";
import { createSheet, setCell, getCell, insertRows, deleteRows, insertCols, deleteCols } from "../src/index.mjs";

const sheetOf = (obj) => { const s = createSheet(); for (const [a, r] of Object.entries(obj)) setCell(s, a, r); return s; };

test("structure: insert rows moves cells and references", () => {
  const s = sheetOf({ A1: "1", A2: "2", A3: "3", B1: "=A1+A2+$A$3", C5: "=SUM(A1:A3)" });
  insertRows(s, 2, 2);
  assert.equal(getCell(s, "A1"), "1");
  assert.equal(getCell(s, "A2"), "");
  assert.equal(getCell(s, "A4"), "2");
  assert.equal(getCell(s, "A5"), "3");
  assert.equal(getCell(s, "B1"), "=A1+A4+$A$5");
  assert.equal(getCell(s, "C7"), "=SUM(A1:A5)");
});

test("structure: inserting at a range's first row moves the whole range", () => {
  const s = sheetOf({ A2: "1", A3: "2", B1: "=SUM(A2:A3)" });
  insertRows(s, 2);
  assert.equal(getCell(s, "B1"), "=SUM(A3:A4)");
  insertRows(s, 5);
  assert.equal(getCell(s, "B1"), "=SUM(A3:A4)");
});

test("structure: delete rows gives #REF! and shrinks ranges", () => {
  const s = sheetOf({ A1: "1", A2: "2", A3: "3", A4: "4", B1: "=A2*2", B5: "=SUM(A1:A4)+A4", C1: "=SUM(A2:A3)" });
  deleteRows(s, 2, 2);
  assert.equal(getCell(s, "A2"), "4");
  assert.equal(getCell(s, "B1"), "=#REF!*2");
  assert.equal(getCell(s, "B3"), "=SUM(A1:A2)+A2");
  assert.equal(getCell(s, "C1"), "=SUM(#REF!)");
  assert.equal(getCell(s, "B5"), "");
});

test("structure: columns, $ signs and corners in any order", () => {
  const s = sheetOf({ A1: "=$B1+C$1+SUM(D1:B1)", D1: "x" });
  insertCols(s, "B");
  assert.equal(getCell(s, "A1"), "=$C1+D$1+SUM(E1:C1)");
  assert.equal(getCell(s, "E1"), "x");
  deleteCols(s, "C", 2);
  assert.equal(getCell(s, "A1"), "=#REF!+#REF!+SUM(C1:C1)");
  assert.equal(getCell(s, "C1"), "x");
});

test("structure: strings and function names are left alone", () => {
  const s = sheetOf({ A1: '=CONCAT("A2 stays",A2,"x""B3")&LOG10(A2)', B1: "=A2.5+_A2" });
  insertRows(s, 1);
  assert.equal(getCell(s, "A2"), '=CONCAT("A2 stays",A3,"x""B3")&LOG10(A3)');
  assert.equal(getCell(s, "B2"), "=A2.5+_A2");
});
