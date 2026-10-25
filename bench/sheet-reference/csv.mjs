// Reference solution for the csv task.
import { createSheet, setCell } from "./sheet.mjs";
import { parseAddr, toAddr } from "./addr.mjs";

const text = (v) => (v == null ? "" : typeof v === "boolean" ? (v ? "TRUE" : "FALSE") : String(v));
const quote = (s) => (/[,"\n\r]|^ | $/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

export function toCSV(sheet, values) {
  let rows = 0, cols = 0;
  for (const a of sheet.cells.keys()) { const p = parseAddr(a); rows = Math.max(rows, p.row + 1); cols = Math.max(cols, p.col + 1); }
  let out = "";
  for (let r = 0; r < rows; r++) {
    const f = [];
    for (let c = 0; c < cols; c++) {
      const a = toAddr(c, r);
      f.push(quote(values ? text(values.has(a) ? values.get(a) : null) : sheet.cells.get(a) ?? ""));
    }
    out += f.join(",") + "\n";
  }
  return out;
}

function detect(text) {
  const counts = { ",": 0, ";": 0, "\t": 0 };
  let q = false;
  for (const ch of text) {
    if (ch === '"') q = !q;
    else if (!q && (ch === "\n" || ch === "\r")) break;
    else if (!q && ch in counts) counts[ch]++;
  }
  return counts[";"] > counts[","] && counts[";"] >= counts["\t"] ? ";" : counts["\t"] > counts[","] && counts["\t"] > counts[";"] ? "\t" : ",";
}

export function fromCSV(text, options = {}) {
  const d = options.delimiter ?? detect(text), sheet = createSheet();
  const rows = [];
  let row = [], field = "", i = 0, line = 1;
  const endField = () => { row.push(field); field = ""; };
  const endRow = () => { endField(); rows.push(row); row = []; };
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"' && field === "") {
      const start = line;
      i++;
      for (;;) {
        if (i >= text.length) throw new Error(`unclosed quote at line ${start}`);
        if (text[i] === '"') { if (text[i + 1] === '"') { field += '"'; i += 2; continue; } i++; break; }
        if (text[i] === "\n") line++;
        field += text[i++];
      }
      continue;
    }
    if (ch === d) { endField(); i++; continue; }
    if (ch === "\r" && text[i + 1] === "\n") { endRow(); i += 2; line++; continue; }
    if (ch === "\n") { endRow(); i++; line++; continue; }
    field += ch; i++;
  }
  if (field !== "" || row.length) endRow();
  rows.forEach((r, ri) => r.forEach((f, ci) => {
    if (f === "") return;
    setCell(sheet, toAddr(ci, ri), f.startsWith("=") && !options.formulas ? "'" + f : f);
  }));
  return sheet;
}
