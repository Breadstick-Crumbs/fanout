# Design: claims, shared state and messages

Status: step 1 (claims, with the task check) built in v0.23; the rest is a draft for review.

## Goal

Several sessions (any agent: Claude Code, Codex, others) work on one repo at once:
- no two of them do the same work;
- nothing breaks when their branches merge;
- they tell each other what the others need to know, at the lowest cost that works.

First for one developer running many agents. Later for a team, so the state must be shareable over the git remote from the start.

## The shift

Today `fanout run` is the centre: it plans everything up front, starts the agents, and holds the state. That only works when fanout launches every session. In practice sessions start whenever someone opens one, in whatever tool they use.

So fanout's state moves into git, and each session reads and writes it through a few commands. Then any agent that can run a shell command takes part, and `fanout run` becomes one client of that state among several (it writes all of a plan's claims at once).

## 1. Claims: who is doing what

A claim says: this session is doing this task and owns these files.

```bash
fanout claim currency "format prices in the user's currency" src/money.mjs test/money.test.mjs
fanout claims                  # every live claim: session, task, files, branch, age
fanout release currency        # or: fanout release currency --to receipt (hand over)
```

- **Files and tasks are both enforced.** The edit guard (Claude Code) and the git pre-commit hook (any agent) refuse an edit or commit of a file another live claim covers, and say who has it. A new task is compared with every live one by a Sonnet call and refused when it's the same work (`--distinct "<how it differs>"` overrides). Validated before it was relied on (bench/RESULTS.md, "Claims"): on 40 held-out labelled pairs Sonnet got 40/40, Haiku 33/40, shared words 20/40.
- **Claim before the first edit, then as you go.** In a repo where claims are on (`fanout init`), a session with no claim is stopped at its first edit (guard) or commit (hook) and told to claim its task, so no session gets past the task check. After that, each new file it edits is added to its claim. This is the plan, built incrementally instead of up front.
- **A session is its checkout.** The claimant is the worktree's branch (as today: the guard finds the session from the edited file's checkout), plus an optional label. Not only `fanout/*` branches: any branch in a repo where claims are on.
- **Claims end on their own:** when the branch merges into the base, when its worktree is removed, or after 24 hours with no commits (the same rule `overlap` uses). `fanout release` ends one by hand.
- **Contracts stay as they are:** a claim can `expose` files, which are then frozen for everyone else, as in the plan today.

The plan file keeps working: `fanout run` writes its sessions as claims, and `check` validates claims the same way it validates a plan (no file claimed twice).

## 2. Where the state lives

On a git ref, not in the working tree: `refs/fanout/state`, a commit whose tree holds one small JSON file per claim (`claims/<name>.json`) and one per message (`inbox/<session>/<id>.json`). Written with git plumbing (`hash-object`, `mktree`, `commit-tree`, `update-ref`), so no checkout, no files in anyone's diff.

- **Solo:** every worktree of a repo shares its refs, so all local sessions see a claim the moment it is written, with no syncing.
- **Team, later:** `git push origin refs/fanout/state` and fetch. One file per claim means two developers' changes merge as a union; the only real conflict is two claims on the same file, which `fanout claims` reports after a fetch. Git syncs only on push and fetch, so a teammate's claim shows up within minutes, not seconds. If that turns out too slow in practice, a small server is the next step, not before.
- **Concurrency:** writes go through `update-ref` with the old value (compare-and-swap), retried on a race, so two sessions claiming at once can't lose one.

## 3. Messages between agents: what's worth it

### What the evidence says

Every break on the sheet benchmark so far (the one with recorded causes) was a session misreading what another session's function does: recalc against formula's `dependents` order (twice), plain value cells, and the leading `=` that `parseFormula` doesn't take. None was two sessions doing the same thing, and none needed a conversation. Each needed a fact the other side had:
- what the function must do: now pasted into the brief from the owner's spec lines (v0.22.2), at no runtime cost;
- what the real code does: the early test (v0.22) merges the owner's finished branch and runs the tests, and caught the one break it met, fixed in 23s for $0.05 while other sessions still worked.

So the cheapest communication is facts fanout already has, delivered by a script. Agents writing to each other comes last, and only if measured to help.

### Kinds of message, cheapest first

| Kind | Example | Who writes it | Cost |
|---|---|---|---|
| Shared facts, before starting | the owner's spec lines for a contract | fanout, from the goal | none at runtime |
| Notices, from events | "formula changed `src/formula.mjs` (contract you use)"; "formula is done: its branch can be merged into yours"; "your branch breaks recalc's tests: ..." | fanout, from git and test results | tokens only when one fires; no agent turn to write |
| Notes, from agents | "I need `formatDate` to take a timezone" | an agent: `fanout note <session> "..."` | the writer's turn, the reader's tokens |
| Requests that wait for an answer | "which order should `dependents` use?" | an agent, blocking | an idle agent and a risk of deadlock: not planned |

### How a message reaches an agent

- **Claude Code, mid-run (verified):** a `PostToolUse` hook may return `{"hookSpecificOutput": {"hookEventName": "PostToolUse", "additionalContext": "..."}}`, and the text goes into the model's context next to the tool result. Tested with headless `claude -p`, project-only settings and the hook in a `--settings` file, as fanout runs its sessions: the agent read the injected line and used it ($0.001 call). fanout's settings file would add a `PostToolUse` hook that prints the session's unread messages, if any, and marks them read. With nothing unread it prints nothing, so it costs nothing.
- **Codex:** no documented way to reach a running `codex exec`. Messages wait for a checkpoint: fanout's commit of the session's work (shown in the next resumed turn, as fix rounds are today), or `fanout inbox`, which the session's instructions say to run before finishing.
- **Any other agent:** the same `fanout inbox` instruction, plus messages printed by the git pre-commit hook when it runs.

### Is agent-written messaging worth it?

Unknown, and breaks are rare (about 3 in 10 four-session sheet runs), so it needs a deliberate test:
1. Build notices first: they are scripted and need no agent changes.
2. Measure on a fixture made to produce cross-session mistakes (vaguer contracts than the sheet task), 5 runs with notices against 5 without: breaks, fix rounds, hidden tests, cost, wall time. About $3.50 per side.
3. Add agent-written notes only if notices leave a gap that a note would have filled, judged from those runs' transcripts.

## 4. Getting any agent to take part

- One short block for `AGENTS.md` / `CLAUDE.md` (`fanout init` writes it): claim before you start, run `fanout inbox` before you finish, don't edit files claimed by others.
- The git pre-commit hook enforces claims for every agent, so one that ignores the instructions is still stopped at commit.
- The Claude Code plugin adds the edit guard and the message hook. The Codex plugin gives the skill; enforcement there stays at commit time.
- Tested per agent we can actually run (Claude Code and Codex now); others are documented as "should work with any agent that runs shell commands" until someone tries them.

## Build order

1. (Done, v0.23.) Claims on `refs/fanout/state`: `init`, `claim`, `claims`, `release`; the task check; guard and git hook enforcement; claim before the first edit, files added as edited; expiry. `overlap` and `status` show claims. Fake-agent tests (test/claims.test.mjs) and two real three-session runs.
2. `fanout run` writes its plan as claims (one code path for the plan and the claims).
3. Notices, written by fanout, delivered by the `PostToolUse` hook (Claude Code) and `fanout inbox` (others).
4. The notices experiment above, before anything else on messaging.
5. Push and fetch of the state ref, tried with two clones standing in for two developers.

## Open questions

- Two sessions in the same checkout (both on the main branch, say) count as one session, since a claim belongs to a branch. Claude Code's hook input carries a session id that could tell them apart; the CLI commands an agent runs don't yet.
- A claim that blocks a legitimate edit: is "ask the owner, or `fanout release`" enough, or should a session be able to take over a stale claim itself?
- How much of `fanout run` stays once claims exist: the drafted plan and the merge order still need it, the session launching may not.
