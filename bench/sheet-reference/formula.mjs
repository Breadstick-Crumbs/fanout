// Reference solution for the formula task. Only used to check the hidden tests.
import { parseAddr, toAddr } from "./addr.mjs";

const isErr = (v) => typeof v === "string" && v.startsWith("#");

function tokenize(src) {
  const t = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    let m;
    const rest = src.slice(i);
    if ((m = /^(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/.exec(rest))) { t.push({ k: "num", v: Number(m[0]) }); i += m[0].length; continue; }
    if (c === '"') {
      let s = "", j = i + 1;
      for (;;) {
        if (j >= src.length) throw new SyntaxError("unclosed string");
        if (src[j] === '"') { if (src[j + 1] === '"') { s += '"'; j += 2; continue; } break; }
        s += src[j++];
      }
      t.push({ k: "str", v: s }); i = j + 1; continue;
    }
    if ((m = /^\$?[A-Za-z]{1,3}\$?[1-9]\d*(?![A-Za-z0-9_(])/.exec(rest))) { t.push({ k: "ref", v: m[0] }); i += m[0].length; continue; }
    if ((m = /^[A-Za-z_][A-Za-z0-9_.]*/.exec(rest))) { t.push({ k: "name", v: m[0] }); i += m[0].length; continue; }
    if ((m = /^(<>|<=|>=|[-+*/^&=<>(),:])/.exec(rest))) { t.push({ k: "op", v: m[0] }); i += m[0].length; continue; }
    throw new SyntaxError(`unexpected ${c}`);
  }
  return t;
}

export function parseFormula(text) {
  const t = tokenize(text);
  let p = 0;
  const peek = () => t[p], isOp = (...v) => t[p]?.k === "op" && v.includes(t[p].v);
  const expect = (v) => { if (!isOp(v)) throw new SyntaxError(`expected ${v}`); p++; };
  const levels = [["=", "<>", "<", ">", "<=", ">="], ["&"], ["+", "-"], ["*", "/"], ["^"]];
  const bin = (lvl) => {
    if (lvl === levels.length) return unary();
    let left = bin(lvl + 1);
    while (isOp(...levels[lvl])) { const op = t[p++].v; left = { type: "bin", op, left, right: bin(lvl + 1) }; }
    return left;
  };
  const unary = () => (isOp("-", "+") ? { type: "neg", op: t[p++].v, arg: unary() } : primary());
  const primary = () => {
    const x = peek();
    if (!x) throw new SyntaxError("unexpected end");
    p++;
    if (x.k === "num") return { type: "lit", v: x.v };
    if (x.k === "str") return { type: "lit", v: x.v };
    if (x.k === "ref") {
      if (isOp(":")) { p++; const y = t[p++]; if (y?.k !== "ref") throw new SyntaxError("bad range"); return { type: "range", a: x.v, b: y.v }; }
      return { type: "ref", addr: norm(x.v) };
    }
    if (x.k === "name") {
      if (isOp("(")) {
        p++;
        const args = [];
        if (!isOp(")")) { do args.push(bin(0)); while (isOp(",") && ++p); }
        expect(")");
        return { type: "call", name: x.v.toUpperCase(), args };
      }
      const u = x.v.toUpperCase();
      if (u === "TRUE" || u === "FALSE") return { type: "lit", v: u === "TRUE" };
      throw new SyntaxError(`unknown name ${x.v}`);
    }
    if (x.k === "op" && x.v === "(") { const e = bin(0); expect(")"); return e; }
    throw new SyntaxError(`unexpected ${x.v}`);
  };
  const ast = bin(0);
  if (p !== t.length) throw new SyntaxError("trailing input");
  return ast;
}

const norm = (r) => { const a = parseAddr(r); return toAddr(a.col, a.row); };
function cellsOf(n) {
  const a = parseAddr(n.a), b = parseAddr(n.b), out = [];
  for (let r = Math.min(a.row, b.row); r <= Math.max(a.row, b.row); r++)
    for (let c = Math.min(a.col, b.col); c <= Math.max(a.col, b.col); c++) out.push(toAddr(c, r));
  return out;
}

export function refsOf(ast) {
  const seen = new Set();
  const walk = (n) => {
    if (n.type === "ref") seen.add(n.addr);
    else if (n.type === "range") cellsOf(n).forEach((a) => seen.add(a));
    else if (n.type === "bin") { walk(n.left); walk(n.right); }
    else if (n.type === "neg") walk(n.arg);
    else if (n.type === "call") n.args.forEach(walk);
  };
  walk(ast);
  return [...seen];
}

const toNum = (v) => {
  if (isErr(v)) return v;
  if (v == null) return 0;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "number") return v;
  const s = v.trim();
  return s !== "" && Number.isFinite(Number(s)) ? Number(s) : "#VALUE!";
};
const toText = (v) => (v == null ? "" : typeof v === "boolean" ? (v ? "TRUE" : "FALSE") : String(v));
const toBool = (v) => {
  if (isErr(v)) return v;
  if (v == null) return false;
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  const u = v.toUpperCase();
  return u === "TRUE" ? true : u === "FALSE" ? false : "#VALUE!";
};
const fin = (x) => (Number.isFinite(x) ? x : "#NUM!");
const rank = (v) => (typeof v === "number" ? 0 : typeof v === "string" ? 1 : 2);
function compare(a, b) {
  if (a == null) a = typeof b === "string" ? "" : typeof b === "boolean" ? false : 0;
  if (b == null) b = typeof a === "string" ? "" : typeof a === "boolean" ? false : 0;
  if (rank(a) !== rank(b)) return rank(a) - rank(b);
  if (typeof a === "string") { a = a.toLowerCase(); b = b.toLowerCase(); }
  return a < b ? -1 : a > b ? 1 : 0;
}
const roundHalf = (x, d) => { const f = 10 ** d; return Math.sign(x) * Math.round(Math.abs(x) * f + 1e-9) / f; };

export function evaluate(ast, lookup) {
  const ev = (n) => {
    switch (n.type) {
      case "lit": return n.v;
      case "ref": return lookup(n.addr);
      case "range": return "#VALUE!";
      case "neg": { const x = toNum(ev(n.arg)); return isErr(x) ? x : n.op === "-" ? -x : x; }
      case "bin": {
        const l = ev(n.left), r = ev(n.right);
        if (isErr(l)) return l;
        if (isErr(r)) return r;
        if (n.op === "&") return toText(l) + toText(r);
        if (["=", "<>", "<", ">", "<=", ">="].includes(n.op)) {
          const c = compare(l, r);
          return { "=": c === 0, "<>": c !== 0, "<": c < 0, ">": c > 0, "<=": c <= 0, ">=": c >= 0 }[n.op];
        }
        const a = toNum(l), b = toNum(r);
        if (isErr(a)) return a;
        if (isErr(b)) return b;
        if (n.op === "+") return fin(a + b);
        if (n.op === "-") return fin(a - b);
        if (n.op === "*") return fin(a * b);
        if (n.op === "/") return b === 0 ? "#DIV/0!" : fin(a / b);
        return fin(a ** b);
      }
      case "call": return call(n);
    }
  };
  // Values of an argument: a range gives its cells, anything else one value. `range` says which.
  const argVals = (a) => (a.type === "range" ? { range: true, vals: cellsOf(a).map(lookup) } : { range: false, vals: [ev(a)] });
  const numbers = (args) => {
    const out = [];
    for (const a of args) {
      const { range, vals } = argVals(a);
      for (const v of vals) {
        if (isErr(v)) return v;
        if (range) { if (typeof v === "number") out.push(v); }
        else { const x = toNum(v); if (isErr(x)) return x; out.push(x); }
      }
    }
    return out;
  };
  const call = (n) => {
    const { name, args } = n, k = args.length;
    const need = (lo, hi = lo) => k >= lo && k <= hi;
    switch (name) {
      case "SUM": case "AVERAGE": case "MIN": case "MAX": {
        const xs = numbers(args);
        if (isErr(xs)) return xs;
        if (name === "SUM") return fin(xs.reduce((s, x) => s + x, 0));
        if (name === "AVERAGE") return xs.length ? fin(xs.reduce((s, x) => s + x, 0) / xs.length) : "#DIV/0!";
        return xs.length ? Math[name === "MIN" ? "min" : "max"](...xs) : 0;
      }
      case "COUNT": {
        let c = 0;
        for (const a of args) for (const v of argVals(a).vals) if (typeof v === "number") c++;
        return c;
      }
      case "IF": {
        if (!need(2, 3)) return "#VALUE!";
        const c = toBool(ev(args[0]));
        if (isErr(c)) return c;
        return c ? ev(args[1]) : k === 3 ? ev(args[2]) : false;
      }
      case "AND": case "OR": {
        if (k < 1) return "#VALUE!";
        const bs = [];
        for (const a of args) {
          const { range, vals } = argVals(a);
          for (const v of vals) {
            if (isErr(v)) return v;
            if (range && typeof v !== "number" && typeof v !== "boolean") continue;
            const b = toBool(v);
            if (isErr(b)) return b;
            bs.push(b);
          }
        }
        return name === "AND" ? bs.every(Boolean) : bs.some(Boolean);
      }
      case "NOT": { if (!need(1)) return "#VALUE!"; const b = toBool(ev(args[0])); return isErr(b) ? b : !b; }
      case "ROUND": {
        if (!need(2)) return "#VALUE!";
        const x = toNum(ev(args[0])), d = toNum(ev(args[1]));
        if (isErr(x)) return x;
        if (isErr(d)) return d;
        return roundHalf(x, Math.trunc(d));
      }
      case "ABS": { if (!need(1)) return "#VALUE!"; const x = toNum(ev(args[0])); return isErr(x) ? x : Math.abs(x); }
      case "LEN": case "UPPER": case "LOWER": {
        if (!need(1)) return "#VALUE!";
        const v = ev(args[0]);
        if (isErr(v)) return v;
        const s = toText(v);
        return name === "LEN" ? s.length : name === "UPPER" ? s.toUpperCase() : s.toLowerCase();
      }
      case "CONCAT": {
        let s = "";
        for (const a of args) for (const v of argVals(a).vals) { if (isErr(v)) return v; s += toText(v); }
        return s;
      }
      default: return "#NAME?";
    }
  };
  return ev(ast);
}
