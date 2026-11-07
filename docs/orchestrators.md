# fanout with Conductor, claude-squad and Paradev

Orchestrators start your agents, give each one a worktree and branch, and show you the diffs. fanout runs underneath them and checks what they don't: two agents building the same thing, one agent's commit breaking another's code, and branches that pass alone but fail merged together.

Nothing in your orchestrator changes. fanout reads git, so it sees every worktree the orchestrator makes.

## Set up once

**1. Install the Claude Code plugin** (user scope, so every `claude` your orchestrator starts loads it):

```
/plugin marketplace add Breadstick-Crumbs/fanout
/plugin install fanout@fanout
```

**2. In each repo, run `init`:**

```bash
npx github:Breadstick-Crumbs/fanout init
```

This keeps claims on in the repo, writes the `AGENTS.md` block that Codex, Cursor Agent, OpenCode and other agents follow, and installs the git hook that checks every commit, whichever agent makes it. Commit `AGENTS.md`.

**3. Copy what your tests need.** If tests read `.env` or another gitignored file, list it in `.worktreeinclude` at the repo root so fanout's merged test run has it.

## Check it's on

Start two workspaces in the orchestrator and give each a task. After each agent's first edit:

```bash
npx github:Breadstick-Crumbs/fanout claims
```

lists both tasks. A Claude Code agent whose task is missing didn't load the plugin (some tools start Claude Code without your user settings). Add `@AGENTS.md` to the repo's `CLAUDE.md` and it follows the same commands as Codex; the git hook covers its commits either way.

## Before you merge

Your orchestrator shows one workspace's diff. fanout tests it merged with everyone else's work. In the workspace's terminal:

```bash
npx github:Breadstick-Crumbs/fanout done
```

It merges this branch with the other sessions' commits, runs your tests, and names whose merge broke them.

**From a script or an orchestrator,** add `--json`. It prints one object (`result`, `culprit`, `yours`, `mergedWith`, `failing`, `log`) and exits with a code per outcome, so the failure can go to the session that caused it:

| `result` | Exit | Meaning |
|---|---|---|
| `ok` | 0 | This branch works merged with the others |
| `broke`, `conflict` | 1 | This branch breaks the merged build, or conflicts |
| `not_ready` | 2 | Not on a session's branch, or no commits yet |
| `broke_other`, `conflict_other` | 3 | Another session's branch (`culprit`) breaks it, before this one is merged |
| `base_fails` | 4 | The tests already fail on the base branch |
| `duplicate` | 5 | This session's task is the same work as another's |
| `flaky` | 6 | The tests failed, then passed on the same code |

To see every workspace at once, with the files two of them are both changing and whether they'd conflict:

```bash
npx github:Breadstick-Crumbs/fanout
```

## Notes per tool

**Conductor.** Each workspace is a git worktree on a new branch based on your repo's base branch, so fanout counts each one as a session. Conductor runs Claude Code, Codex, Cursor and OpenCode; step 2 covers the last three. Put `npx github:Breadstick-Crumbs/fanout done` in your pre-merge routine next to Conductor's Checks tab, which shows CI for the one branch.

**claude-squad.** Each session (`cs`) gets its own worktree and branch in tmux. The default program is `claude`, which loads the plugin; sessions started with `-p codex`, `-p aider` or `-p gemini` follow `AGENTS.md`. With `--autoyes`, nobody watches each step, so the plugin's refusals and notices are what keep two sessions from doing the same work.

**Paradev.** Each agent runs in its own worktree and branch, and you merge from the app. It runs any CLI agent: Claude Code loads the plugin, the rest follow `AGENTS.md`. Run `fanout done` in the workspace before merging, since a merge that's clean in the app can still fail the tests.

## What each layer does

| | Orchestrator | fanout |
|---|---|---|
| Starts agents, one worktree and branch each | Yes | No (except `fanout run`) |
| Shows each agent's diff, opens the PR | Yes | No |
| Stops a second agent building the same thing | No | Yes, before its first edit |
| Tells an agent when another's commit changes code it uses | No | Yes, with the diff |
| Tests every branch merged together before `main` | No | Yes |
| Names whose branch broke the merged build | No | Yes |

Using another orchestrator? Anything that makes git worktrees and runs `claude`, `codex` or an agent that reads `AGENTS.md` works the same way.
