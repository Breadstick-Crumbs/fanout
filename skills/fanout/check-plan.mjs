// Usage: node check-plan.mjs plan.md
import { readFileSync } from "node:fs";
const text = readFileSync(process.argv[2], "utf8");
const sessions = [];
for (const block of text.split(/^## /m).slice(1)) {
  const [name, ...rest] = block.split("\n");
  const get = (k) => (rest.find((l) => l.startsWith(k + ":")) ?? "").slice(k.length + 1).trim();
  const owns = get("owns").split(",").map((s) => s.trim()).filter(Boolean);
  sessions.push({ name: name.trim(), owns, after: get("after").split(",").map((s) => s.trim()).filter(Boolean) });
}
const prefix = (g) => g.replaceAll("\\", "/").split(/[*?{]/)[0].replace(/\/$/, "");
let bad = 0;
for (let i = 0; i < sessions.length; i++)
  for (let j = i + 1; j < sessions.length; j++)
    for (const a of sessions[i].owns) for (const b of sessions[j].owns) {
      const pa = prefix(a), pb = prefix(b);
      const wild = (s) => /[*?{]/.test(s);
      const clash = pa === pb || (wild(a) && (pb + "/").startsWith(pa + "/")) || (wild(b) && (pa + "/").startsWith(pb + "/")) || (!wild(a) && !wild(b) && pa === pb);
      if (clash) { bad++; console.log(`CLASH ${sessions[i].name} (${a}) <-> ${sessions[j].name} (${b})`); }
    }
const order = [], seen = new Set();
const visit = (s, stack = []) => {
  if (seen.has(s.name)) return;
  if (stack.includes(s.name)) { console.log("CYCLE in after:", [...stack, s.name].join(" -> ")); bad++; return; }
  for (const d of s.after) { const t = sessions.find((x) => x.name === d); if (t) visit(t, [...stack, s.name]); else { console.log(`UNKNOWN after: ${d} (in ${s.name})`); bad++; } }
  seen.add(s.name); order.push(s.name);
};
sessions.forEach((s) => visit(s));
console.log("Merge order:", order.join(" -> "));
process.exit(bad ? 1 : 0);
