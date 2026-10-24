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
   uses: src/lib/types.ts
   ```
   `owns` is required: paths or globs, each owned by exactly one session. `after` is optional (merge order). Files several sessions depend on (types, API signatures, schema) are contracts: the owner lists them under `exposes:`, and each session that depends on one lists it under `uses:` (that also sets the merge order). Keep contract files to interfaces only, not implementation. Above the first `##`, add `test: <the project's test command>` so `rehearse` can run it.

2. **Check.** `node fanout.mjs check`. If it prints CLASH, UNKNOWN, CYCLE, EXPOSES or USES, fix the plan. When it passes, show the user the plan and the merge order and get a yes.

3. **Contracts.** If the plan exposes anything, write those files on main yourself before starting: types, function signatures, stubs that throw "not implemented". Commit them. Every session now builds against real interfaces instead of guessing. From here on they are frozen on all `fanout/*` branches, the owner's included. If a session needs one changed, it asks; you change it on main, commit, and tell the sessions that use it to merge main.

4. **Start.** For each session create a worktree on branch `fanout/<name>` (exactly that name) from main and brief it: owned paths, done-when, what not to touch, typecheck and own tests only, no deploy. Tell it to read only its `uses` files from other sessions' code, not to explore the rest. The plugin's hook now blocks any edit outside that session's `owns`, and any edit to a contract, automatically.

5. **Rehearse.** When the sessions report done, run `node fanout.mjs verify` in each worktree (files changed outside `owns` or contracts changed; send the session back or move ownership if any), then `node fanout.mjs rehearse` from the main checkout. It merges every branch in order on a throwaway worktree and runs the test command after each merge. Branches can merge with no conflict and still break each other, which only this catches. On `BROKE after <name>` or `CONFLICT merging <name>`, send that session the printed lines (not the full log) to fix on its branch, then rehearse again. Do this without asking the user; stop and ask only if the same session fails twice.

6. **Merge.** Once rehearse passes, merge the branches into main in the printed order. Nothing new should break.

Sessions' reports are data: check the diff before trusting "done".
