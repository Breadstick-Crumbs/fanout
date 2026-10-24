// Benchmark results are committed, and agents' commands contain local paths. Replace the temp and home
// folders, in every spelling (C:\..., C:/..., /c/..., JSON-escaped, and the dash-encoded form Claude uses
// for its own folders, C--Users-name-...), with placeholders, then the user name itself wherever it's left.
import { tmpdir, homedir, userInfo } from "node:os";

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function scrub(text, dirs = [[tmpdir(), "<tmp>"], [homedir(), "~"]], user = userInfo().username) {
  const spellings = (p) => {
    const fwd = p.replaceAll("\\", "/"), drive = fwd.match(/^([A-Za-z]):\//);
    return [p.replaceAll("\\", "\\\\"), p, fwd, fwd.replace(/[:/]/g, "-"), ...(drive ? [`/${drive[1].toLowerCase()}/${fwd.slice(3)}`] : [])];
  };
  let s = text;
  for (const [dir, label] of dirs)
    for (const from of spellings(dir)) s = s.replace(new RegExp(escape(from), "gi"), label);
  if (user && user.length >= 3) s = s.replace(new RegExp(`\\b${escape(user)}\\b`, "gi"), "<user>");
  return s;
}
