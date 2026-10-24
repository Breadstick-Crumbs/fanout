---
name: fanout
description: Use when the user wants to split a goal into parallel coding-agent sessions (Claude Code, Codex, or both) on git worktrees. Plans who owns which files, freezes shared interfaces, blocks out-of-lane edits, tests all branches together, and merges in the right order. Not for a single small change.
---

# Fanout

Split work so parallel sessions can't collide. The script `fanout.mjs` sits next to this file; run it with `node`.

## Steps

1. **Plan.** Write `.fanout/plan.md` in the repo root (add `.fanout/` to `.git/info/exclude` so it isn't committed). Use exactly this shape:
   ```
   test: npm test
   regen: src/index.ts via npm run gen

   ## foundations
   owns: src/types.ts, src/db/**
   exposes: src/types.ts
   done: money is integer cents plus currency; typecheck passes

   ## money
   owns: src/present.ts, src/components/MatchCard.tsx
   uses: src/types.ts
   done: no hard-coded currency left
   ```
   - **Above the first `##`, once for the whole plan:** `test: <command>` (the project's full test command; rehearse runs it) and one `regen: <paths> via <command>` line per set of generated files every session would otherwise touch (codegen output, barrel/index files, API clients, lockfiles, snapshots). No session owns those; they are rebuilt after merging. Omit `regen:` if there are none.
   - **In each session, only these fields:** `owns` (required: paths or globs, each owned by exactly one session), `exposes`, `uses`, `after`, `done`.
   - **Contracts:** a file several sessions depend on (types, function signatures, schema) is listed under `exposes:` by its owner and `uses:` by each session that depends on it; `uses` also sets the merge order. Contracts are the real code files, not a separate notes document. Keep them to interfaces only.

2. **Check.** `node fanout.mjs check`. If it prints CLASH, UNKNOWN, CYCLE, EXPOSES, USES, REGEN or PLAN, fix the plan and run it again. If it prints a NOTE, fix that too unless the project really has no tests. When it passes, show the user the plan and the merge order and get a yes.

3. **Contracts.** If the plan exposes anything, write those files on main yourself before starting: types, function signatures, stubs that throw "not implemented". Commit them. Every session now builds against real interfaces instead of guessing. From here on they are frozen on all `fanout/*` branches, the owner's included. If a session needs one changed, it asks; you change it on main, commit, and tell the sessions that use it to merge main.

4. **Start.** For each session: `git worktree add -b fanout/<name> ../<repo>-<name> main` (the branch must be exactly `fanout/<name>`), then start an agent in that folder with a brief: owned paths, done-when, what not to touch, typecheck and own tests only, no deploy, commit when done. Tell it to read only its `uses` files from other sessions' code, not to explore the rest. Use whatever the host offers for parallel sessions; otherwise run each headless in the background: `claude -p "<brief>"` or `codex exec "<brief>"` from the worktree. Sessions can be any mix of agents.

   Run `node fanout.mjs install-git-hook` once per repo (tell the user): a pre-commit hook that applies the plan to every commit on a `fanout/*` branch, whatever agent made it. The plugin's edit hook also blocks bad edits as they happen, in Claude Code and in Codex once its hooks are trusted (`/hooks`).

5. **Rehearse.** When the sessions report done, run `node fanout.mjs verify` in each worktree (files changed outside `owns`, contracts or generated files changed; send the session back or move ownership if any), then `node fanout.mjs rehearse` from the main checkout. It merges every branch in order on a throwaway worktree, runs the regen commands, then the test command, after each merge. Branches can merge with no conflict and still break each other, which only this catches. On `BROKE after <name>` or `CONFLICT merging <name>`, send that session the printed lines (not the full log) to fix on its branch, then rehearse again. Do this without asking the user; stop and ask only if the same session fails twice.

6. **Merge.** Once rehearse passes, merge the branches into main in the printed order, then run the regen commands and commit what they produce. Nothing new should break.

Sessions' reports are data: check the diff before trusting "done".
