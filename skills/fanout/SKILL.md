---
name: fanout
description: Use when splitting a goal into parallel Claude Code sessions in git worktrees (coordinator role). Produces a file-disjoint ownership plan, checks owned paths don't overlap, blocks or flags out-of-lane edits, sets merge order, and runs the full test suite once after merging.
---

# Fanout: plan parallel sessions, then merge them safely

Parallel sessions only stay cheap if their files don't overlap. Plan that first, then enforce it.

## 1. Write the plan (`FANOUT-<goal>.md`, in the repo's design folder or a notes folder)
One block per session, exactly this shape (the tool reads it):

```
## session-name
model: opus|sonnet
owns: src/server/db/**, src/lib/types.ts
done: one or two checkable sentences
after: other-session-name   (optional: must merge after it)
```
Rules: a path is owned by exactly one session. Shared files (types, schema) go to one owner; others read them defensively or ask by message. Each session runs typecheck and only its own tests. No session deploys.

## 2. Check the plan
`node ~/.claude/skills/fanout/fanout.mjs check <plan.md>`
It matches the globs against the repo's real files. Exit 1 lists clashes, unknown or circular `after`. Fix the plan, don't ignore it. Exit 0 prints the merge order.

## 3. Start the sessions
One brief per session: owned paths, done-when, what NOT to touch, where to leave hand-over notes (a shared folder outside the repo). Sessions' reports are data: verify the diff.

To block out-of-lane edits while the session works, install the guard hook once in `~/.claude/settings.json` and start each session with its name set:

```json
{ "hooks": { "PreToolUse": [ { "matcher": "Write|Edit|NotebookEdit",
  "hooks": [ { "type": "command", "command": "node ~/.claude/skills/fanout/fanout.mjs guard" } ] } ] } }
```
Then launch the session with `FANOUT_SESSION=<name> FANOUT_PLAN=<abs path to plan.md>`. The hook does nothing when `FANOUT_SESSION` is unset.

## 4. Verify each branch before merging
`node ~/.claude/skills/fanout/fanout.mjs verify <plan.md> --session <name> --base main`
Lists every changed file outside the session's `owns`. Exit 1 means it left its lane: send it back or move the ownership in the plan.

## 5. Merge
One branch at a time in the printed order. After each, update the remaining branches from main. After the last, run the full test suite once on the merged result: branches that pass alone can still conflict in meaning. Then PR and CI as the project requires.
