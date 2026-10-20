# fanout

A Claude Code skill and a small checker for running **several Claude Code sessions in parallel git worktrees without them stepping on each other**.

It does not launch or supervise sessions. It gives the coordinating session (or you) a plan format, a check that no two sessions own the same files, a merge order, and a merge routine. Worktrees stop agents overwriting each other's files; they do not stop two plans that cannot both be true, or two branches that pass alone and fail together. This is the small amount of discipline that catches those.

## The idea in one screen

Write a plan, one block per session:

```md
## foundations
model: opus
owns: src/lib/types.ts, src/server/db/**
done: per-country visibility works; typecheck passes

## money
model: sonnet
owns: src/lib/present.ts, src/components/MatchCard.tsx
done: no hard-coded currency left
after: foundations
```

Check it:

```bash
node skills/fanout/check-plan.mjs plan.md
```

```
CLASH api (src/server/**) <-> schema (src/server/db/schema.ts)
Merge order: foundations -> money -> landing
```

Exit code `1` on any clash, unknown or circular `after`, so it works in CI or a pre-flight hook. Exit `0` prints the order to merge in.

## Install the skill

```bash
git clone https://github.com/Breadstick-Crumbs/fanout
mkdir -p ~/.claude/skills
cp -r fanout/skills/fanout ~/.claude/skills/fanout
```

Then ask Claude Code to "split this into parallel sessions" or invoke `/fanout`. Needs Node 18+ for the checker; the skill itself is plain markdown.

## Plan format

One `## name` block per session. Fields (`key: value`, one per line):

| Field | Required | Meaning |
|---|---|---|
| `owns` | yes | Comma-separated paths or globs this session may edit. |
| `done` | recommended | One or two checkable sentences. Used in the session brief. |
| `after` | no | Sessions that must merge first. Comma-separated. |
| `model` | no | Free text for you. Not read by the checker. |

Rules the skill asks Claude to follow:

1. A path is owned by exactly one session. Shared files (types, schema) go to one owner; others read them defensively or ask by message.
2. Each session runs typecheck and only its own tests. No session deploys.
3. Merge one branch at a time in the printed order, updating the remaining branches after each.
4. After the last merge, run the **full** test suite once on the merged result.

## What the checker does and does not do

- Compares the literal part of each path or glob before the first `*`, `?` or `{`. A glob clashes with anything under its prefix; two literal paths clash if equal. `src/app/**` and `src/application/**` do not clash.
- Does not expand globs against your files or understand `**` versus `*` precisely, so it can over-report (it will never under-report a prefix overlap).
- Does not detect semantic conflicts (two sessions changing a function's meaning in different files). That is what the final full-suite run is for.
- Does not touch git.

## How it relates to other tools

| Tool | What it is | How fanout differs |
|---|---|---|
| Claude Code `--worktree`, subagents with `isolation: worktree`, Agent Teams | Built-in ways to run work in isolated worktrees | fanout is the plan and merge discipline you apply on top; it works with these or with sessions you start by hand |
| [claude-squad](https://github.com/smtg-ai/claude-squad) and other orchestrators | Launch and manage many agent sessions (TUI, tmux) | They run sessions; fanout decides what each may touch and in what order to merge |
| [Google Scion](https://github.com/GoogleCloudPlatform/scion) | Open-source agent orchestration testbed | Same: runtime versus planning contract |

Anthropic may add some of this to Claude Code itself. If it does, the plan format here still works as a one-page convention.

## Development

```bash
npm test
```

Tests use Node's built-in runner, no dependencies. CI also runs the checker on `examples/plan.md` (must pass) and `examples/plan-with-clash.md` (must fail).

## Status

v0.1. Extracted from a real multi-session workflow where it replaced a hand-maintained table. Issues and pull requests welcome, especially: real glob matching, a `--json` output, and a merge helper that runs the update-then-suite loop.

## Licence

MIT. See [LICENSE](LICENSE).
