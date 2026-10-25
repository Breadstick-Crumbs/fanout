// Reference solution for the structure task.
import { parseAddr, toAddr, colIndex, colName } from "./addr.mjs";

const REF = /\$?[A-Za-z]{1,3}\$?[1-9]\d*/y;

// Maps a 0-based index through the change: a new index, or null if it was deleted.
const mover = (at, count, insert) => (i) => (insert ? (i >= at ? i + count : i) : i < at ? i : i < at + count ? null : i - count);

function rewriteRef(tok, axis, move) {
  const a = parseAddr(tok), i = move(a[axis]);
  if (i == null) return null;
  const b = { ...a, [axis]: i };
  return `${b.colAbs ? "$" : ""}${colName(b.col)}${b.rowAbs ? "$" : ""}${b.row + 1}`;
}

function rewriteRange(x, y, axis, at, count, insert, move) {
  const a = parseAddr(x), b = parseAddr(y);
  let lo = Math.min(a[axis], b[axis]), hi = Math.max(a[axis], b[axis]);
  if (insert) { if (at <= lo) { lo += count; hi += count; } else if (at <= hi) hi += count; }
  else {
    const keep = [];
    for (let i = lo; i <= hi; i++) if (move(i) != null) keep.push(move(i));
    if (!keep.length) return null;
    lo = keep[0]; hi = keep[keep.length - 1];
  }
  const [p, q] = a[axis] <= b[axis] ? [a, b] : [b, a];
  const fmt = (c, v) => `${c.colAbs ? "$" : ""}${colName(axis === "col" ? v : c.col)}${c.rowAbs ? "$" : ""}${(axis === "row" ? v : c.row) + 1}`;
  const s = fmt(p, lo), e = fmt(q, hi);
  return a[axis] <= b[axis] ? `${s}:${e}` : `${e}:${s}`;
}

function rewrite(formula, axis, at, count, insert) {
  const move = mover(at, count, insert);
  let out = "", i = 0;
  const isWord = (c) => c != null && /[A-Za-z0-9_.$]/.test(c);
  const refAt = (j) => {
    if (isWord(formula[j - 1])) return null;
    REF.lastIndex = j;
    const m = REF.exec(formula);
    if (!m) return null;
    const end = j + m[0].length;
    if (isWord(formula[end]) || formula[end] === "(") return null;
    return m[0];
  };
  while (i < formula.length) {
    if (formula[i] === '"') {
      let j = i + 1;
      while (j < formula.length && !(formula[j] === '"' && formula[j + 1] !== '"')) j += formula[j] === '"' ? 2 : 1;
      out += formula.slice(i, j + 1); i = j + 1; continue;
    }
    const r = refAt(i);
    if (!r) { out += formula[i++]; continue; }
    const r2 = formula[i + r.length] === ":" ? refAt(i + r.length + 1) : null;
    if (r2) {
      out += rewriteRange(r, r2, axis, at, count, insert, move) ?? "#REF!";
      i += r.length + 1 + r2.length;
    } else {
      out += rewriteRef(r, axis, move) ?? "#REF!";
      i += r.length;
    }
  }
  return out;
}

function change(sheet, axis, at, count, insert) {
  const move = mover(at, count, insert), next = new Map();
  for (const [addr, raw] of sheet.cells) {
    const a = parseAddr(addr), i = move(a[axis]);
    if (i == null) continue;
    const b = { ...a, [axis]: i };
    next.set(toAddr(b.col, b.row), raw.startsWith("=") ? rewrite(raw, axis, at, count, insert) : raw);
  }
  sheet.cells = next;
}

export const insertRows = (sheet, at, count = 1) => change(sheet, "row", at - 1, count, true);
export const deleteRows = (sheet, at, count = 1) => change(sheet, "row", at - 1, count, false);
export const insertCols = (sheet, at, count = 1) => change(sheet, "col", colIndex(at), count, true);
export const deleteCols = (sheet, at, count = 1) => change(sheet, "col", colIndex(at), count, false);
