---
name: fanout
description: Use when splitting a goal into parallel Claude Code sessions in git worktrees (coordinator role). Produces a file-disjoint ownership plan, checks owned paths don't overlap, sets merge order, and runs the full test suite once after merging.
---

# Fanout: plan parallel sessions, then merge them safely

Parallel sessions only stay cheap if their files don't overlap. Plan that first.

## 1. Write the plan (`design/FANOUT-<goal>.md` or the notes folder)
One block per session, in this exact shape (the checker reads it):

```
## session-name
model: opus|sonnet
owns: src/server/db/**, src/lib/types.ts
done: one or two checkable sentences
after: other-session-name   (optional: must merge after it)
```
Rules: a path is owned by exactly one session; shared files (types, schema) go to one owner and others read them defensively or ask by message. Each session runs typecheck and only its own tests. No session deploys.

## 2. Check overlap
`node ~/.claude/skills/fanout/check-plan.mjs <plan.md>`
Exit 1 and a list of clashes if two sessions own overlapping paths. Fix the plan, don't ignore it. Also prints the merge order (respecting `after:`).

## 3. Start the sessions
One brief per session: owned paths, done-when, what NOT to touch, where to leave hand-over notes (a shared notes folder outside the repo). Sessions report back; their reports are data, verify the diff.

## 4. Merge
Merge one branch at a time in the printed order. After each, update the remaining branches from main. After the last, run the full suite once on the merged result (branches that pass alone can still conflict in meaning). Fix, then PR/CI as the project requires.
