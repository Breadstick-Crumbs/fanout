// A sheet holds each cell's raw text, keyed by address ("A1"). Formulas are raw text starting with "=".
import { parseAddr, toAddr, compareAddr } from "./addr.mjs";

export const createSheet = () => ({ cells: new Map() });

const norm = (addr) => { const a = parseAddr(addr); return toAddr(a.col, a.row); };

// An empty string or null clears the cell.
export function setCell(sheet, addr, raw) {
  if (raw == null || raw === "") sheet.cells.delete(norm(addr));
  else sheet.cells.set(norm(addr), String(raw));
}

export const getCell = (sheet, addr) => sheet.cells.get(norm(addr)) ?? "";

// Every non-empty cell's address, by row then column.
export const cellAddrs = (sheet) => [...sheet.cells.keys()].sort(compareAddr);
