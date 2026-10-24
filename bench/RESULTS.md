# Benchmark results

## Summary (latest numbers, v0.14)

Six-feature [library](library/) task, scored on 21 hidden tests no agent sees:

| Setup | Wall time | Agent cost | Hidden tests | Conflicts / repairs on `main` | Runs |
|---|---|---|---|---|---|
| One agent, Sonnet | ~1m 40s | ~$0.25 | 21/21 | 0 / 0 | 2 |
| One agent, Haiku | 4m 09s | $0.03 | 21/21 | 0 / 0 | 1 |
| Six agents, plain worktrees (Sonnet) | 2m 52s – 3m 14s | ~$0.62 | 21/21 | 4 / 8 every run | 2 |
| Six agents, fanout (Sonnet) | 2m 44s – 2m 51s | $0.61 – $0.66 | 20–21/21 | 0 / 0 | 2 |
| Six agents, fanout (Sonnet plans, Haiku sessions) | 3m 12s – 3m 36s | $0.14 – $0.15 | 21/21 | 0 / 0 | 2 |

- **Without fanout, parallel agents collided every time.** With fanout, never.
- **One agent is still fastest at this size.** Parallel pays off when each part takes several minutes.
- **Early signals, not conclusions:** Haiku sessions matching Sonnet, and Opus planning adding cost without changing results, rest on one or two runs of precisely specified tasks.

The sections below are the history, in the order things were measured. Numbers from before v0.13's overhead fixes are slower than today's.

## Small task: four agents

Four agents work in parallel on the same small codebase ([shop/](shop/)), with the same four tasks ([shop/TASKS.md](shop/TASKS.md)) that deliberately touch each other:

- **currency** changes how prices are stored (dollars to integer cents plus a currency code);
- **discounts** changes the cart total;
- **receipt** and **tax** each add a module and need it exported from a shared generated file (`src/index.mjs`).

The harness ([run.mjs](run.mjs)) runs it two ways:

- **Baseline:** one plain git worktree per agent. The branches are merged into `main`, then one integrator agent is given whatever didn't merge or broke and told to make `main` work.
- **fanout:** a coordinator agent follows the fanout skill to write the plan and the contract files. The four agents work in guarded lanes, `rehearse` tests the combination, and any lane that breaks it gets the short report and fixes its own branch. Then everything merges into `main`.

Agents are Claude Code (Sonnet), run headless and capped at $1 each. In the last pair of runs, the receipt lane ran in Codex (CLI 0.164) instead. Runs on 24 October 2026.

## Results

| Run | Conflicts merging into `main` | Clean merges that broke tests | Repair commits on `main` | Final tests pass | Cost |
|---|---|---|---|---|---|
| baseline 1 | 2 (discounts, tax) | 1 (receipt) | 4 | yes, after integrator | $0.63 |
| baseline 2 | 2 (discounts, tax) | 1 (receipt) | 4 | yes, after integrator | $0.62 |
| baseline 3 | 2 (discounts, tax) | 1 (receipt) | 4 | yes, after integrator | $0.61 |
| fanout 1 | 0 | 0 | 0 | yes | $0.92 |
| fanout 2 | 0 | 0 | 0 | yes | $0.55 |
| baseline 4 (Codex on receipt) | 2 (discounts, tax) | 1 (receipt) | 4 | yes, after integrator | $0.59 + Codex |
| fanout 3 (Codex on receipt) | 0 | 0 | 0 | yes | $0.50 + Codex |

- **Baseline** hit the same problems every time: two textual conflicts, and one branch that merged cleanly but broke the tests. `main` needed four repair commits from the integrator agent before it worked.
- **fanout 1:** `rehearse` found that receipt and tax broke once combined with the other branches. Each lane got a short report and fixed its own branch: two fix commits on the lane branches, two extra agent runs. `main` was never broken.
- **fanout 2:** the plan was clean first time and rehearse passed on the first try.
- **Mixed Claude and Codex:** same pattern. Without fanout, 2 conflicts, 1 broken merge and 4 repairs. With fanout, none. The Codex agent's edit to the generated index was discarded by the plan, like the Claude agents' edits.
- In every fanout run, the receipt and tax agents ran the index generator locally. Those edits were discarded, as the plan says, and the file was regenerated once after merging.

## Is parallel worth it at all?

Later runs (16:59 and 17:07 in [results/](results/)) added a third setup: one agent doing all four tasks, one after another. By then fanout's headless agents started about 8× cheaper (v0.10), so these costs are lower than the ones above.

| Setup (2 runs each) | Wall time | Agent cost | Conflicts | Repairs on `main` | Final tests pass |
|---|---|---|---|---|---|
| One agent, all four tasks | 0m 56s – 1m 00s | $0.09 – $0.10 | 0 | 0 | yes |
| Four agents, plain worktrees | 2m 30s – 2m 59s | $0.35 – $0.36 | 2 | 4 | yes, after integrator |
| Four agents, fanout | 3m 19s – 3m 27s | $0.32 – $0.35 | 0 | 0 | yes |

- **On a task this small, one agent wins outright:** about 3× faster and 3× cheaper than either parallel setup. Splitting four small changes costs more in setup (worktrees, briefs, merging, planning) than the parallel work saves.
- **Within parallel work, fanout still does its job:** no conflicts and no repairs, at the same cost as plain worktrees. It's slower here because of its planning step (about 1.5 minutes and $0.13–$0.15, the largest single cost of a fanout run).
- **So fanout is for work that's big enough to split.**

### A bigger task: six features, 21 hidden tests

The [library](library/) fixture has six features ([TASKS.md](library/TASKS.md)) with real dependencies: the API needs search and fines, and fines and holds both change the core store. Each setup is scored on 21 hidden acceptance tests ([library-acceptance/](library-acceptance/)) that no agent sees. One run (18:13 in [results/](results/)):

| Setup | Wall time | Agent cost | Hidden tests | Conflicts | Repairs on `main` |
|---|---|---|---|---|---|
| One agent, all six tasks | 2m 07s | $0.24 | 21/21 | 0 | 0 |
| Six agents, plain worktrees | 3m 58s | $0.65 | 21/21 | 4 | 8 |
| Six agents, fanout | 5m 49s | $0.57 | 21/21 | 0 | 0 |

- **One agent still won:** about 2.5× faster and 2.5× cheaper, with the same quality. Sonnet did each feature in about 20 seconds when working through them in one session.
- **Each parallel agent carries a fixed overhead** of roughly 100 seconds and about $0.05: loading the project, reading the code it needs, running the tests. One agent pays that once; six agents pay it six times. fanout adds its planning step on top (about 100 seconds and $0.11 here).
- **Without fanout,** parallel work hit 4 conflicts and needed 8 repair commits. **With fanout,** none, and rehearse passed first time.
- **Rough break-even:** parallel only wins on time when each part would take one agent noticeably longer than that fixed overhead, a few minutes per part rather than seconds. On cost, parallel never wins at this size, because the overhead is paid per agent.

### Cutting the overhead

Tracing every agent's tool calls (the "Turns" and "Model time" columns in [results/](results/)) showed that more than half of each parallel agent's time wasn't the model:
- **Personal Claude settings loaded into every agent.** The user's own hooks and plugins ran on every start and on every file read. A trivial headless call took 15s (9s without them) and twice the tokens.
- **Refused commands.** Agents piped test output through `tail` or `grep`, which weren't allowed, and lost a turn retrying each time.
- **A start-up race.** Starting several agents in the same instant sometimes left their shells unable to find `npm` or `node`.
- **A slow planner.** It read the whole skill and explored the code: 17 turns, about 100 seconds.

The fixes: agents start with the project's settings only (fanout's guard is loaded directly), read-only shell tools are allowed, agents start 1.5 seconds apart, and the planner gets the plan rules and the file list up front. Plain parallel gets the same agent fixes, so the comparison stays fair. Two rounds after the fixes (18:47 and 18:54):

| Setup | Wall time | Agent cost | Hidden tests | Conflicts | Repairs on `main` |
|---|---|---|---|---|---|
| One agent | 1m 37s – 1m 38s | $0.25 – $0.26 | 21/21, 21/21 | 0 | 0 |
| Six agents, plain worktrees | 2m 52s – 3m 14s | $0.61 – $0.62 | 21/21, 21/21 | 4 | 8 |
| Six agents, fanout | 2m 44s – 2m 51s | $0.61 – $0.66 | 20/21, 21/21 | 0 | 0 |

- **fanout got about a third faster** (from 4m 11s in the traced run before the fixes) and is now faster than plain parallel, while still preventing every conflict and repair.
- **The planner dropped from about 100 seconds to under 60.** Each session agent dropped from 74–111 seconds to 46–84.
- **Cost didn't change.** Each parallel agent still costs about $0.07–$0.12, against roughly $0.04 per feature for one agent working through them in a single session. That gap is the price of starting separate agents.
- **One agent is still fastest and cheapest at this size.** The one hidden-test miss for fanout was a CSV parsing detail in one round; the next round passed all 21.

### Which model plans, which models build

`fanout run` can plan with one model and run the sessions on another (`--model` and `--session-model`, or `model:` per session in the plan). Small contracts are now pasted into each session's brief. One round each on the library task (19:07 to 19:22), all scored on the 21 hidden tests:

| Setup | Wall time | Agent cost | Hidden tests |
|---|---|---|---|
| One agent, Sonnet | 1m 37s – 1m 38s | $0.25 – $0.26 | 21/21 |
| One agent, Haiku | 4m 09s | $0.03 | 21/21 |
| fanout: Sonnet plans, Sonnet sessions | 2m 44s – 2m 51s | $0.61 – $0.66 | 20/21, 21/21 |
| fanout: Opus plans, Sonnet sessions | 3m 00s | $0.82 | 21/21 |
| fanout: Opus plans, Haiku sessions | 3m 31s | $0.25 | 21/21 |
| fanout: Sonnet plans, Haiku sessions | 3m 12s – 3m 36s | $0.14 – $0.15 | 21/21, 21/21 |

- **Haiku sessions cut the cost of a fan-out by about 4×** ($0.14–$0.15 against $0.61–$0.66) with no loss on the hidden tests. Each Haiku session cost about $0.01.
- **Same model, parallel now wins on time:** six Haiku sessions finished in 3m 12s–3m 36s, against 4m 09s for one Haiku agent doing everything.
- **Opus as planner** used fewer turns (10–11 against 12–16) but cost about twice as much to plan ($0.20–$0.22 against $0.09–$0.11). On this task the outcome was the same: all 21 tests passed either way. The specs here are precise; on vaguer goals, where the split and the interfaces need more judgment, a stronger planner is more likely to matter, but this benchmark doesn't show it.
- **Fastest is still one Sonnet agent; cheapest is one Haiku agent.** fanout with a cheap session model sits between them, and is the option that keeps `main` safe once work is split.
- **The tasks are well specified,** which suits cheaper models. On fuzzier real work, check a run's results before making Haiku sessions your default.

## What this does and doesn't show

- **It shows** that on overlapping work, fanout kept `main` free of conflicts and breakage, with no integration step afterwards, at about the same Claude cost: $0.50–$0.92 against $0.59–$0.63.
- **It doesn't show** a cost saving. On a task this small, an integrator agent cleans up cheaply. The difference should grow with more agents and bigger changes, because the integrator has to understand every branch at once, but this benchmark doesn't measure that yet.
- **The sample is small:** 4 baseline runs and 3 fanout runs.

## What the benchmark found in fanout itself

The first three fanout runs (12:30, 12:37 and 12:40 in [results/](results/)) aren't counted. In those, the coordinator used an outdated copy of the skill and wrote `test:` and `regen:` inside each session. fanout's `check` accepted that, so rehearse ran no tests. Fixed in v0.8:

- `check` now rejects misplaced or unknown plan fields;
- `check` warns when there's no `test:` line;
- the skill shows the exact plan shape.

## Run it yourself

```bash
node bench/run.mjs all                       # one agent, plain parallel, and fanout
node bench/run.mjs both                      # plain parallel and fanout
node bench/run.mjs all --fixture library --budget 2 --single-budget 5   # the bigger task, scored on hidden tests
node bench/run.mjs both --dry                # plumbing only, no agents
node bench/run.mjs both --codex-lane receipt # run the receipt lane in Codex
```
