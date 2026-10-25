// Reference solution for the table task.
import { parseAddr, toAddr, colIndex } from "./addr.mjs";
import { valueOf } from "./recalc.mjs";

const box = (range) => {
  const [x, y] = range.split(":").map(parseAddr);
  return { c0: Math.min(x.col, y.col), c1: Math.max(x.col, y.col), r0: Math.min(x.row, y.row), r1: Math.max(x.row, y.row) };
};
const rank = (v) => (typeof v === "number" ? 0 : typeof v === "string" ? 1 : 2);
function cmp(a, b) {
  if (rank(a) !== rank(b)) return rank(a) - rank(b);
  if (typeof a === "string") { a = a.toLowerCase(); b = b.toLowerCase(); }
  return a < b ? -1 : a > b ? 1 : 0;
}

export function sortRange(sheet, range, keys, options = {}) {
  const { c0, c1, r1 } = box(range);
  let { r0 } = box(range);
  if (options.header) r0++;
  const rows = [];
  for (let r = r0; r <= r1; r++) {
    const cells = [];
    for (let c = c0; c <= c1; c++) cells.push(sheet.cells.get(toAddr(c, r)));
    rows.push(cells);
  }
  const at = (row, col) => valueOf(row[colIndex(col) - c0] ?? "");
  rows.sort((p, q) => {
    for (const k of keys) {
      const a = at(p, k.col), b = at(q, k.col);
      if (a == null || b == null) { if (a == null && b == null) continue; return a == null ? 1 : -1; }
      const d = cmp(a, b) * (k.desc ? -1 : 1);
      if (d) return d;
    }
    return 0;
  });
  rows.forEach((cells, i) => cells.forEach((raw, j) => {
    const a = toAddr(c0 + j, r0 + i);
    if (raw == null) sheet.cells.delete(a); else sheet.cells.set(a, raw);
  }));
}

export function pivot(values, range, { rows, value, agg }) {
  const { c0, c1, r0, r1 } = box(range);
  const get = (c, r) => (values.has(toAddr(c, r)) ? values.get(toAddr(c, r)) : null);
  const colOf = (name) => {
    for (let c = c0; c <= c1; c++) if (get(c, r0) === name) return c;
    throw new Error(`no column ${name}`);
  };
  const kc = colOf(rows), vc = colOf(value), groups = new Map();
  for (let r = r0 + 1; r <= r1; r++) {
    const k = get(kc, r) ?? "(blank)";
    (groups.get(k) ?? groups.set(k, []).get(k)).push(get(vc, r));
  }
  const keys = [...groups.keys()].sort((a, b) => (a === "(blank)") - (b === "(blank)") || cmp(a, b));
  return keys.map((key) => {
    const vs = groups.get(key), nums = vs.filter((v) => typeof v === "number");
    const value = agg === "count" ? vs.filter((v) => v != null).length
      : agg === "sum" ? nums.reduce((s, x) => s + x, 0)
      : !nums.length ? null
      : agg === "avg" ? nums.reduce((s, x) => s + x, 0) / nums.length
      : Math[agg](...nums);
    return { key, value };
  });
}
