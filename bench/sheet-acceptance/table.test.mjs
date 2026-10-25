import { test } from "node:test";
import assert from "node:assert/strict";
import { createSheet, setCell, getCell, sortRange, pivot } from "../src/index.mjs";

const people = () => {
  const s = createSheet();
  const rows = [["name", "score"], ["bob", "10"], ["Amy", "9"], ["cara", ""], ["dan", "x"], ["eve", "TRUE"], ["fay", "9"]];
  rows.forEach(([a, b], i) => { setCell(s, `A${i + 1}`, a); setCell(s, `B${i + 1}`, b); });
  setCell(s, "C2", "keep");
  return s;
};
const col = (s, c) => [2, 3, 4, 5, 6, 7].map((r) => getCell(s, `${c}${r}`));

test("table: sort by value type, stable, empty last, header kept", () => {
  const s = people();
  sortRange(s, "A1:B7", [{ col: "B" }], { header: true });
  assert.equal(getCell(s, "A1"), "name");
  assert.deepEqual(col(s, "A"), ["Amy", "fay", "bob", "dan", "eve", "cara"]);
  assert.deepEqual(col(s, "B"), ["9", "9", "10", "x", "TRUE", ""]);
  assert.equal(getCell(s, "C2"), "keep");
});

test("table: descending keeps empty cells last", () => {
  const s = people();
  sortRange(s, "A2:B7", [{ col: "B", desc: true }]);
  assert.deepEqual(col(s, "A"), ["eve", "dan", "bob", "Amy", "fay", "cara"]);
});

test("table: several keys, text case-insensitive", () => {
  const s = people();
  sortRange(s, "A2:B7", [{ col: "B" }, { col: "A", desc: true }]);
  assert.deepEqual(col(s, "A"), ["fay", "Amy", "bob", "dan", "eve", "cara"]);
  sortRange(s, "A2:B7", [{ col: "A" }]);
  assert.deepEqual(col(s, "A"), ["Amy", "bob", "cara", "dan", "eve", "fay"]);
});

const sales = new Map(Object.entries({
  A1: "region", B1: "sales", A2: "east", B2: 10, A3: "West", B3: 5, A4: "east", B4: "n/a", B5: 7, A6: 2, B6: 1, A7: "north", B7: "x", A8: "east", B8: 4,
}));

test("table: pivot sums and orders keys", () => {
  assert.deepEqual(pivot(sales, "A1:B8", { rows: "region", value: "sales", agg: "sum" }),
    [{ key: 2, value: 1 }, { key: "east", value: 14 }, { key: "north", value: 0 }, { key: "West", value: 5 }, { key: "(blank)", value: 7 }]);
});

test("table: pivot count, avg, min, max", () => {
  const by = (agg) => Object.fromEntries(pivot(sales, "A1:B8", { rows: "region", value: "sales", agg }).map((r) => [r.key, r.value]));
  assert.deepEqual(by("count"), { 2: 1, east: 3, north: 1, West: 1, "(blank)": 1 });
  assert.equal(by("avg").east, 7);
  assert.equal(by("avg").north, null);
  assert.equal(by("min").east, 4);
  assert.equal(by("max").east, 10);
  assert.throws(() => pivot(sales, "A1:B8", { rows: "zone", value: "sales", agg: "sum" }), /zone/);
});
