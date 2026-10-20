# fanout

**Run many Claude Code sessions at once without merge chaos.**

Git worktrees keep parallel sessions from overwriting each other's files. They don't stop two sessions from editing the same file, building on different assumptions, or passing alone and failing together. fanout fixes that: every session gets its own files, edits outside them are blocked or flagged, the merge order is fixed, and the full test suite runs once on the merged result.

Today the usual answer is "list the files in scope in each agent's prompt and review by hand". fanout makes that list machine-checked.

## How it works

**1. Write a plan.** One block per session:

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

**2. Check it.** Globs are matched against your repo's real files.

```bash
node skills/fanout/fanout.mjs check plan.md
```

```
CLASH api (src/server/**) <-> schema (src/server/db/schema.ts)
Merge order: foundations -> money -> landing
```

Exit code `1` on a clash, an unknown `after`, or a cycle. Exit `0` prints the order to merge in. Use it in CI or a pre-flight hook.

**3. Start the sessions, with a guard.** Each gets a brief with its owned paths, its done-when, and what not to touch. A hook blocks any edit outside the session's `owns` as it happens (see below).

**4. Verify each branch.**

```bash
node skills/fanout/fanout.mjs verify plan.md --session money --base main
```

```
OUT OF LANE money: src/lib/types.ts
money: 5 changed, 1 outside its owns
```

**5. Merge.** One branch at a time in the printed order, updating the rest after each, then the full suite once.

## Install

```bash
git clone https://github.com/Breadstick-Crumbs/fanout
mkdir -p ~/.claude/skills
cp -r fanout/skills/fanout ~/.claude/skills/fanout
```

Then tell Claude Code to "split this into parallel sessions", or run `/fanout`. The checker needs Node 18+.

## Guard hook

Block out-of-lane edits while the session works. Add once to `~/.claude/settings.json`:

```json
{ "hooks": { "PreToolUse": [ { "matcher": "Write|Edit|NotebookEdit",
  "hooks": [ { "type": "command", "command": "node ~/.claude/skills/fanout/fanout.mjs guard" } ] } ] } }
```

Start each session with its name and the plan path:

```bash
FANOUT_SESSION=money FANOUT_PLAN=/abs/path/plan.md claude
```

An edit outside `owns` is denied with a message telling the session to ask the coordinator. With `FANOUT_SESSION` unset the hook does nothing, so it is safe to leave installed. Paths outside the repo are ignored.

## Plan format

| Field | Required | Meaning |
|---|---|---|
| `owns` | yes | Comma-separated paths or globs this session may edit |
| `done` | recommended | One or two checkable sentences |
| `after` | no | Sessions that must merge first |
| `model` | no | Free text for you |

Rules in the skill:

1. A path is owned by exactly one session. Shared files go to one owner.
2. Each session runs typecheck and only its own tests. No session deploys.
3. Merge one branch at a time, in order.
4. Run the full suite once, after the last merge.

## Works with

Claude Code `--worktree`, subagents, Agent Teams, [claude-squad](https://github.com/smtg-ai/claude-squad), or sessions you start by hand. fanout is the plan and the merge routine; use whatever launches the sessions.

## Development

```bash
npm test
```

Node's built-in test runner, no dependencies. CI also runs the checker on `examples/plan.md` (passes) and `examples/plan-with-clash.md` (fails).

## Licence

MIT. See [LICENSE](LICENSE).
