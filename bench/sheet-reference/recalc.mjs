// Reference solution for the recalc task.
import { parseFormula, refsOf, evaluate } from "./formula.mjs";
import { compareAddr } from "./addr.mjs";

export function valueOf(raw) {
  if (raw === "" || raw == null) return null;
  if (raw.startsWith("'")) return raw.slice(1);
  const t = raw.trim();
  if (t !== "" && Number.isFinite(Number(t))) return Number(t);
  const u = t.toUpperCase();
  if (u === "TRUE" || u === "FALSE") return u === "TRUE";
  return raw;
}

// Parses every formula once: addr -> { ast, refs } (ast null when it doesn't parse).
function graph(sheet) {
  const g = new Map();
  for (const [addr, raw] of sheet.cells) {
    if (!raw.startsWith("=")) continue;
    try { const ast = parseFormula(raw.slice(1)); g.set(addr, { ast, refs: refsOf(ast) }); }
    catch { g.set(addr, { ast: null, refs: [] }); }
  }
  return g;
}

// Kahn's algorithm over formula cells; whatever never becomes ready is on, or behind, a cycle.
function order(g) {
  const indeg = new Map(), users = new Map();
  for (const [a, { refs }] of g) {
    indeg.set(a, 0);
    for (const r of refs) if (g.has(r)) { indeg.set(a, indeg.get(a) + 1); (users.get(r) ?? users.set(r, []).get(r)).push(a); }
  }
  const ready = [...indeg].filter(([, d]) => d === 0).map(([a]) => a), out = [];
  while (ready.length) {
    const a = ready.pop();
    out.push(a);
    for (const u of users.get(a) ?? []) if (indeg.set(u, indeg.get(u) - 1).get(u) === 0) ready.push(u);
  }
  return out;
}

// Cells on a cycle: formula cells that can reach themselves (iterative Tarjan).
function cycleCells(g) {
  const idx = new Map(), low = new Map(), on = new Set(), stack = [], res = new Set();
  let n = 0;
  for (const start of g.keys()) {
    if (idx.has(start)) continue;
    const work = [[start, 0]];
    idx.set(start, n); low.set(start, n++); stack.push(start); on.add(start);
    while (work.length) {
      const top = work[work.length - 1], [v] = top, refs = g.get(v).refs.filter((r) => g.has(r));
      if (top[1] < refs.length) {
        const w = refs[top[1]++];
        if (!idx.has(w)) { idx.set(w, n); low.set(w, n++); stack.push(w); on.add(w); work.push([w, 0]); }
        else if (on.has(w)) low.set(v, Math.min(low.get(v), idx.get(w)));
      } else {
        work.pop();
        if (work.length) { const u = work[work.length - 1][0]; low.set(u, Math.min(low.get(u), low.get(v))); }
        if (low.get(v) === idx.get(v)) {
          const comp = [];
          let w;
          do { w = stack.pop(); on.delete(w); comp.push(w); } while (w !== v);
          if (comp.length > 1 || refs.includes(v)) comp.forEach((c) => res.add(c));
        }
      }
    }
  }
  return res;
}

export function computeAll(sheet) {
  const g = graph(sheet), vals = new Map();
  for (const [addr, raw] of sheet.cells) if (!g.has(addr)) vals.set(addr, valueOf(raw));
  const cyc = cycleCells(g);
  for (const a of cyc) vals.set(a, "#CYCLE!");
  const lookup = (a) => (vals.has(a) ? vals.get(a) : null);
  const evalCell = (a) => { const { ast } = g.get(a); vals.set(a, ast ? evaluate(ast, lookup) : "#ERROR!"); };
  for (const a of order(g)) evalCell(a);
  // Cells behind a cycle: evaluate in dependency order, treating cycle cells as done.
  const rest = [...g.keys()].filter((a) => !vals.has(a));
  const done = (a) => vals.has(a) || !g.has(a);
  while (rest.length) {
    const i = rest.findIndex((a) => g.get(a).refs.every(done));
    evalCell(rest.splice(i < 0 ? 0 : i, 1)[0]);
  }
  return vals;
}

export function dependents(sheet, addr) {
  const g = graph(sheet), cyc = cycleCells(g), users = new Map();
  for (const [a, { refs }] of g) for (const r of refs) (users.get(r) ?? users.set(r, []).get(r)).push(a);
  const reach = new Set(), todo = [addr];
  while (todo.length) for (const u of users.get(todo.pop()) ?? []) if (!reach.has(u) && u !== addr && !cyc.has(u)) { reach.add(u); todo.push(u); }
  const indeg = new Map([...reach].map((a) => [a, g.get(a).refs.filter((r) => reach.has(r)).length]));
  const out = [];
  while (indeg.size) {
    const ready = [...indeg].filter(([, d]) => d === 0).map(([a]) => a).sort(compareAddr);
    const a = ready[0];
    indeg.delete(a); out.push(a);
    for (const u of users.get(a) ?? []) if (indeg.has(u)) indeg.set(u, indeg.get(u) - 1);
  }
  return out;
}
