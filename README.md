# fanout

**Run many Claude Code sessions at once without merge chaos.**

Git worktrees stop parallel sessions overwriting each other's files. They don't stop two sessions editing the same file, or a session wandering outside its job. fanout gives every session its own files, blocks edits outside them, and merges in the right order.

## Install

```
/plugin install fanout --marketplace Breadstick-Crumbs/fanout
```

## Use

Tell Claude Code:

> Split this into parallel sessions: add Arabic support, fix the currency bug, and redo the landing page.

Claude writes the plan, checks it, shows you who owns what, and starts the sessions. From then on:

- A session that tries to edit a file it doesn't own is stopped, with a message telling it to ask.
- Before each merge, fanout lists any file a branch changed outside its lane.
- Before anything merges, fanout rehearses: it merges every branch in order on a scratch worktree and runs your tests after each one. Branches that merge with no conflict but break each other are caught and pinned to the branch that broke things.
- The failing session gets the short report and fixes its branch; only then do branches merge into main.

That's it. No config, no environment variables.

## What the plan looks like

Claude writes this to `.fanout/plan.md`; you only read and approve it.

```md
test: npm test

## foundations
owns: src/lib/types.ts, src/server/db/**
done: per-country visibility works; typecheck passes

## money
owns: src/lib/present.ts, src/components/MatchCard.tsx
done: no hard-coded currency left
after: foundations
```

## Commands (Claude runs these; you can too)

```bash
node skills/fanout/fanout.mjs check              # plan vs your repo: clashes, order
node skills/fanout/fanout.mjs verify             # from a fanout/<name> worktree: files outside its lane
node skills/fanout/fanout.mjs rehearse           # merge all branches on a scratch worktree, test after each
```

## How it works

- Sessions run on branches named `fanout/<name>`. The plan sits in the main checkout, so every worktree finds it.
- Globs are matched against your real files, so `src/app/start/**` and `src/app/other/**` don't clash.
- The guard is a plugin `PreToolUse` hook. It only acts on `fanout/*` branches, so normal work is untouched.

## Development

```bash
npm test
```

Node's built-in test runner, no dependencies.

## Licence

MIT. See [LICENSE](LICENSE).
