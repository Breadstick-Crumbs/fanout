// Benchmark results are committed, and agents' commands contain local paths. Replace the temp and home
// folders, in every spelling (C:\..., C:/..., /c/..., and JSON-escaped), with placeholders.
import { tmpdir, homedir } from "node:os";

export function scrub(text, dirs = [[tmpdir(), "<tmp>"], [homedir(), "~"]]) {
  const spellings = (p) => {
    const fwd = p.replaceAll("\\", "/"), drive = fwd.match(/^([A-Za-z]):\//);
    return [p.replaceAll("\\", "\\\\"), p, fwd, ...(drive ? [`/${drive[1].toLowerCase()}/${fwd.slice(3)}`] : [])];
  };
  let s = text;
  for (const [dir, label] of dirs)
    for (const from of spellings(dir)) s = s.replace(new RegExp(from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), label);
  return s;
}
