import { test } from "node:test";
import assert from "node:assert/strict";
import { createSheet, setCell, getCell, cellAddrs, toCSV, fromCSV } from "../src/index.mjs";

test("csv: export raw text with quoting and a full rectangle", () => {
  const s = createSheet();
  setCell(s, "A1", "name");
  setCell(s, "B1", "note");
  setCell(s, "A2", 'Smith, "J"');
  setCell(s, "C3", " pad");
  setCell(s, "B2", "two\nlines");
  assert.equal(toCSV(s, null), 'name,note,\n"Smith, ""J""","two\nlines",\n,," pad"\n');
  assert.equal(toCSV(createSheet(), null), "");
});

test("csv: export values", () => {
  const s = createSheet();
  setCell(s, "A1", "=1+1");
  setCell(s, "B1", "=TRUE");
  setCell(s, "A2", "x");
  const values = new Map([["A1", 2], ["B1", true], ["A2", "x"]]);
  assert.equal(toCSV(s, values), "2,TRUE\nx,\n");
});

test("csv: import quoted fields, CRLF and empty fields", () => {
  const s = fromCSV('a,"b,c",\r\n"say ""hi""",,"multi\nline"\r\nlast');
  assert.equal(getCell(s, "A1"), "a");
  assert.equal(getCell(s, "B1"), "b,c");
  assert.equal(getCell(s, "A2"), 'say "hi"');
  assert.equal(getCell(s, "C2"), "multi\nline");
  assert.equal(getCell(s, "A3"), "last");
  assert.deepEqual(cellAddrs(s), ["A1", "B1", "A2", "C2", "A3"]);
});

test("csv: delimiter detection and option", () => {
  assert.equal(getCell(fromCSV("a;b;c\n1;2;3\n"), "C2"), "3");
  assert.equal(getCell(fromCSV("a\tb\n1\t2\n"), "B2"), "2");
  assert.equal(getCell(fromCSV('"x;y",z\n'), "B1"), "z");
  assert.equal(getCell(fromCSV("a;b,c\n"), "B1"), "c");
  assert.equal(getCell(fromCSV("a|b\n", { delimiter: "|" }), "B1"), "b");
  assert.equal(cellAddrs(fromCSV("a,b\n\n")).length, 2);
});

test("csv: formulas are escaped unless asked for", () => {
  assert.equal(getCell(fromCSV("=1+1,x\n"), "A1"), "'=1+1");
  assert.equal(getCell(fromCSV("=1+1,x\n", { formulas: true }), "A1"), "=1+1");
});

test("csv: unclosed quote names its line", () => {
  assert.throws(() => fromCSV('a,b\nc,"d\ne,f\n'), { message: "unclosed quote at line 2" });
});

test("csv: round trip", () => {
  const s = createSheet();
  setCell(s, "A1", 'a "b", c');
  setCell(s, "B2", "line\r\nbreak");
  const back = fromCSV(toCSV(s, null));
  assert.equal(getCell(back, "A1"), 'a "b", c');
  assert.equal(getCell(back, "B2"), "line\r\nbreak");
});
