// Reference solution for the numfmt task. Literal text is supported before and after the digits.

// A non-negative number as decimal digits: value = 0.<digits> x 10^pos, digits without leading zeros.
function decimal(x) {
  let [m, e = "0"] = x.toString().split("e");
  let [i, f = ""] = m.split(".");
  let digits = (i + f).replace(/^0+/, ""), pos = i.replace(/^0+/, "").length + Number(e);
  if (!i.replace(/^0+/, "")) pos = -(f.length - f.replace(/^0+/, "").length) + Number(e);
  return { digits, pos };
}

// Rounds half away from zero to d decimals.
function round({ digits, pos }, d) {
  const k = pos + d;
  if (k < 0 || !digits) return { digits: "", pos: 0 };
  if (k >= digits.length) return { digits, pos };
  let keep = digits.slice(0, k);
  if (digits[k] >= "5") {
    const n = (BigInt(keep || "0") + 1n).toString();
    if (n.length > keep.length) pos++;
    keep = n;
  }
  keep = keep.replace(/0+$/, "");
  return { digits: keep, pos: keep ? pos : 0 };
}

const parts = ({ digits, pos }, d) => ({
  int: pos > 0 ? digits.slice(0, pos).padEnd(pos, "0") : "",
  frac: (pos >= 0 ? digits.slice(pos) : "0".repeat(-pos) + digits).padEnd(d, "0").slice(0, d),
});

function splitSections(p) {
  const out = [""];
  for (let i = 0; i < p.length; i++) {
    if (p[i] === '"') { const j = p.indexOf('"', i + 1); out[out.length - 1] += p.slice(i, j + 1); i = j; }
    else if (p[i] === "\\") { out[out.length - 1] += p.slice(i, i + 2); i++; }
    else if (p[i] === ";") out.push("");
    else out[out.length - 1] += p[i];
  }
  return out;
}

// Splits a section into literal prefix, number pattern and literal suffix; literals unescaped.
function tokens(sec) {
  const t = [];
  for (let i = 0; i < sec.length; i++) {
    if (sec[i] === '"') { const j = sec.indexOf('"', i + 1); t.push({ lit: sec.slice(i + 1, j) }); i = j; }
    else if (sec[i] === "\\") t.push({ lit: sec[++i] });
    else if (/[0#.,]/.test(sec[i])) t.push({ num: sec[i] });
    else if (/[eE]/.test(sec[i]) && /[+-]/.test(sec[i + 1])) { let j = i + 2; while (sec[j] === "0") j++; t.push({ exp: sec.slice(i, j) }); i = j - 1; }
    else t.push({ lit: sec[i] });
  }
  return t;
}

function formatSection(x, sec) {
  const t = tokens(sec);
  const numStr = t.filter((k) => k.num).map((k) => k.num).join("");
  const exp = t.find((k) => k.exp)?.exp;
  const [ip, fp = ""] = numStr.split(".");
  const hasPoint = numStr.includes("."), group = /[0#],+[0#]/.test(ip);
  const minInt = (ip.match(/0/g) ?? []).length, dec = (fp.match(/[0#]/g) ?? []).length, optDec = (fp.match(/#/g) ?? []).length;
  let n = decimal(x);
  if (t.some((k) => k.lit === "%")) n = { ...n, pos: n.pos + 2 };
  let expText = "";
  if (exp) {
    let e = n.digits ? n.pos - 1 : 0;
    let r = round({ digits: n.digits, pos: 1 }, dec);
    if (r.pos > 1) { e++; r = { ...r, pos: 1 }; }
    n = r;
    const sign = e < 0 ? "-" : exp[1] === "+" ? "+" : "";
    expText = exp[0] + sign + String(Math.abs(e)).padStart(exp.length - 2, "0");
  } else n = round(n, dec);
  let { int, frac } = parts(n, dec);
  for (let i = 0; i < optDec && frac.endsWith("0"); i++) frac = frac.slice(0, -1);
  int = int.padStart(minInt, "0");
  if (group) int = int.replace(/\B(?=(\d{3})+$)/g, ",");
  const body = int + (hasPoint ? "." + frac : "") + expText;
  const first = t.findIndex((k) => k.num || k.exp);
  let last = -1;
  t.forEach((k, i) => { if (k.num || k.exp) last = i; });
  const lit = (a) => a.map((k) => k.lit).join("");
  return { text: first < 0 ? lit(t) : lit(t.slice(0, first)) + body + lit(t.slice(last + 1)), zero: !/[1-9]/.test(body) };
}

export function formatNumber(value, pattern) {
  if (typeof value !== "number") return value == null ? "" : typeof value === "boolean" ? (value ? "TRUE" : "FALSE") : String(value);
  if (pattern === "General") return String(value);
  const secs = splitSections(pattern);
  if (value < 0 && secs.length >= 2) return formatSection(-value, secs[1]).text;
  if (value === 0 && secs.length >= 3) return formatSection(0, secs[2]).text;
  const r = formatSection(Math.abs(value), secs[0]);
  return value < 0 && !r.zero ? "-" + r.text : r.text;
}
