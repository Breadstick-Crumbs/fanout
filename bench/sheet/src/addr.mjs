// Cell addresses: "A1" is column 0, row 0. Columns go A..Z, AA..ZZ, AAA..
export function colName(i) {
  let s = "";
  for (i += 1; i > 0; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + ((i - 1) % 26)) + s;
  return s;
}

export function colIndex(name) {
  let n = 0;
  for (const ch of name.toUpperCase()) n = n * 26 + ch.charCodeAt(0) - 64;
  return n - 1;
}

// "B12" -> { col: 1, row: 11, colAbs: false, rowAbs: false }. "$B$12" sets colAbs and rowAbs.
export function parseAddr(text) {
  const m = /^(\$?)([A-Za-z]{1,3})(\$?)([1-9]\d*)$/.exec(text);
  if (!m) throw new Error(`bad address: ${text}`);
  return { col: colIndex(m[2]), row: Number(m[4]) - 1, colAbs: m[1] === "$", rowAbs: m[3] === "$" };
}

export const toAddr = (col, row) => `${colName(col)}${row + 1}`;

// Orders addresses by row, then column.
export function compareAddr(a, b) {
  const x = parseAddr(a), y = parseAddr(b);
  return x.row - y.row || x.col - y.col;
}
