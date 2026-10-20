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
- Branches merge in dependency order, then the full test suite runs once.

That's it. No config, no environment variables.

## What the plan looks like

Claude writes this to `.fanout/plan.md`; you only read and approve it.

```md
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
