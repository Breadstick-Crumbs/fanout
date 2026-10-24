---
name: fanout
description: Use when the user wants to split a goal into parallel Claude Code sessions (git worktrees). Plans who owns which files, blocks out-of-lane edits, checks each branch, and merges in the right order.
---

# Fanout

Split work so parallel sessions can't collide. The script `fanout.mjs` sits next to this file; run it with `node`.

## Steps

1. **Plan.** Write `.fanout/plan.md` in the repo root (add `.fanout/` to `.git/info/exclude` so it isn't committed). One block per session:
   ```
   ## money
   owns: src/lib/present.ts, src/components/MatchCard.tsx
   done: no hard-coded currency left; typecheck passes
   after: foundations
   ```
   `owns` is required: paths or globs, each owned by exactly one session. `after` is optional (merge order). Shared files (types, schema) go to one owner; others read them defensively or ask by message. Above the first `##`, add `test: <the project's test command>` so `rehearse` can run it.

2. **Check.** `node fanout.mjs check`. If it prints CLASH, UNKNOWN or CYCLE, fix the plan. When it passes, show the user the plan and the merge order and get a yes.

3. **Start.** For each session create a worktree on branch `fanout/<name>` (exactly that name) and brief it: owned paths, done-when, what not to touch, typecheck and own tests only, no deploy. The plugin's hook now blocks any edit outside that session's `owns` automatically.

4. **Rehearse.** When the sessions report done, run `node fanout.mjs verify` in each worktree (files changed outside `owns`; send the session back or move ownership if any), then `node fanout.mjs rehearse` from the main checkout. It merges every branch in order on a throwaway worktree and runs the test command after each merge. Branches can merge with no conflict and still break each other, which only this catches. On `BROKE after <name>` or `CONFLICT merging <name>`, send that session the printed lines (not the full log) to fix on its branch, then rehearse again. Do this without asking the user; stop and ask only if the same session fails twice.

5. **Merge.** Once rehearse passes, merge the branches into main in the printed order. Nothing new should break.

Sessions' reports are data: check the diff before trusting "done".
