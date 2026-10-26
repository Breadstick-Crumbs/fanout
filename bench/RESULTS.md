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
- **Early signals, not conclusions:** Haiku sessions matching Sonnet, and Opus planning adding cost without changing results, rest on one or two runs. On a vague goal (planner picks the split), a Sonnet planner also matched Opus at half the planning cost ([below](#vague-goal-opus-vs-sonnet-planner-v016)).

Six-module [sheet](sheet/) task (minutes per module), scored on 34 hidden tests, v0.21 defaults (plan drafted from the goal's sections, at most 4 sessions, short tests):

| Setup | Wall time (median, range) | Agent cost | Hidden tests | Runs |
|---|---|---|---|---|
| One agent, Sonnet | 5m 44s (4m 05s – 6m 44s) | $0.58 – $0.71 | 33–34/34 | 3 |
| fanout, Sonnet sessions | 3m 59s (3m 16s – 4m 40s) | $0.68 – $0.74 | 33–34/34 | 3 |
| fanout, Haiku sessions | 5m 07s (5m 05s – 5m 41s) | $0.15 – $0.16 | 32–33/34 | 3 |

- **On the large task fanout is now faster than one agent, at about 15% more cost** (medians). The ranges overlap, so it's a median result over three runs each, not a guarantee per run ([details](#repeats-with-the-new-defaults-v021)).

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

## Vague goal: Opus vs Sonnet planner (v0.16)

The planner got only "Add the features described in TASKS.md to this library. Split the work however you think best." No session names, no inline spec. Sessions on Sonnet read TASKS.md themselves. One run each, 25 October 2026 ([00:09](results/2026-10-25-00-09.md), [00:16](results/2026-10-25-00-16.md)).

| Planner | Sessions it chose | Planner cost | Total cost | Wall time | Hidden tests | Conflicts / repairs | Reverted |
|---|---|---|---|---|---|---|---|
| Opus | 4 (search+api, csv+reports merged) | $0.20 | $0.83 | 8m 27s | 21/21 | 0 / 0 | 1 file (`src/index.mjs`, generated) |
| Sonnet | 5 (csv+reports merged) | $0.10 | $0.56 | 7m 11s | 21/21 | 0 / 0 | none |

- Both planners found the real dependencies on their own: one owner for `src/store.mjs` (holds), `src/index.mjs` as a generated file, and `fines` exposed to the API.
- Opus cost twice as much to plan and gave no better result. Its bigger lanes (search+api) were the slowest, so the run took longer.
- Wall times are slower than the summary table. Sessions read the spec from the repo, and another fanout run was using the machine at the same time.
- One run each, so this is a signal, not a rule: Sonnet is enough to plan a vague goal of this size.

## Real project: four theme pages (v0.16)

A client's WordPress theme: move About, Contact, the quote cart and search results to the new design. `fanout run "<one paragraph>" --model sonnet --no-merge`, with PHP lint over SSH as the test. 25 October 2026.

| Run | Planner | Sessions | Wall time | Cost | Conflicts / fixes | Result |
|---|---|---|---|---|---|---|
| 1 (v0.15) | $0.23 | 4 × $0.18–0.34 | 4m 42s | $1.18 | 0 / 0 | passed, but **wrong**: the planner left the shared switch-on change uncommitted, so no lane had it |
| 2 (v0.16) | $0.17 | 4 × $0.15–0.41 | 7m 08s | $1.16 | 0 / 0 | passed; contract committed by fanout, all four lanes built on it |

- Run 1 found a real gap: the planner prompt says to commit the contracts, but nothing checked. Since v0.16, `fanout run` commits whatever the planner leaves (the tree was clean before planning).
- Without being told, the planner gave each page its own `inc/f-<page>.php` and `f-<page>.css`, with the shared file loading each part only if it exists. So no two lanes touched one file.
- The cart lane removed 323 lines (inline styles moved to its CSS file) and kept every form field name and id. A static lint can't show how a page looks, so the branches still need a look on staging before merging.
- On staging (after merging by hand): all four pages worked, and a real quote submit went through. One bug the lint couldn't see: the About lane hard-coded a link to `/quotation-inquiry/`, which doesn't exist (the RFQ page is `/cart/`). v0.17 adds per-session `check:` commands for this.

**Same job, one agent** (Sonnet, same goal, same commit, same tool limits as a fanout lane):

| | Wall time | Cost | Lint | Dead links | Quote form fields |
|---|---|---|---|---|---|
| fanout, 4 sessions (run 2) | 7m 08s | $1.16 | ok | 1 | unchanged |
| One agent | 4m 02s | $0.64 | ok | 0 | unchanged |

One agent was faster and cheaper and made no link mistake. It put all four pages in one new file (`inc/f-pages.php`, 554 lines). This matches the benchmark: four pages of 2–3 minutes each is too small for parallel to pay. fanout's planning (about 1.5 minutes) plus the slowest lane is longer than one agent doing all of it. Parallel needs parts that each take much longer than planning does. One run each; looks were not compared.

## Large task: a spreadsheet engine (v0.18)

The [sheet](sheet/) fixture was built to be big enough for parallel work to win: six heavy modules ([TASKS.md](sheet/TASKS.md)): a formula parser and evaluator, recalculation with cycle detection, number formats, CSV, row/column insert and delete with reference rewriting, and sort/pivot. recalc builds on formula, and table builds on recalc. Scored on 34 hidden tests ([sheet-acceptance/](sheet-acceptance/)), checked against a reference solution ([sheet-reference/](sheet-reference/)). One run each, Sonnet, 25 October 2026 ([09:21](results/2026-10-25-09-21.md), [09:29](results/2026-10-25-09-29.md)).

| Setup | Wall time | Agent cost | Output tokens | Hidden tests | Conflicts / repairs on `main` |
|---|---|---|---|---|---|
| One agent | 4m 05s | $0.58 | 37k | 33/34 | 0 / 0 |
| Six agents, fanout | 7m 32s | $0.99 | 53k | 34/34 | 0 / 0 (1 lane fix before merging) |

- **One agent still won on time and cost,** by about 1.8× and 1.7×. The task was meant to take minutes per module, and the single agent did all six in 4 minutes.
- **The lanes alone barely beat one agent.** The slowest lane (recalc) took 211s, against 241s for one agent doing everything. Planning (81s), rehearse, one fix (43s) and merging added about 4 minutes on top.
- **Parallel agents wrote at about half the speed.** The single agent produced about 170 output tokens per second of model time; the six lanes running at once averaged about 80. They also wrote more: 48k tokens across the lanes against 37k for the whole job in one session, since each lane re-reads the code and writes its own tests. So six agents in parallel did not give six times the throughput.
- **fanout did its job on quality:** rehearse caught a break after the formula lane, that lane fixed it before anything reached `main`, and the result passed all 34 hidden tests. The single agent missed one (column delete with reversed range corners).
- **What this means:** making the task bigger doesn't move the break-even much on its own, because one agent gets faster per task as it goes and parallel agents slow each other down. Parallel pays off when parts are long *and* the run isn't throughput-bound. The per-lane overhead (planning, re-reading, per-lane tests, rehearse) is the cost to cut.

### Why the lanes were slow: running at the same time, not the brief

The formula lane was run again alone, from the same base commit, once with fanout's lane brief and once with a plain prompt (the task spec plus "run npm test"). One run each:

| Formula lane | Wall time | Model time | Output tokens | Tokens per second | Cost |
|---|---|---|---|---|---|
| In the parallel run (six at once) | 176s | 122s | 10k | ~83 | $0.18 |
| Alone, fanout brief | 129s | 88s | 15k | ~172 | $0.27 |
| Alone, plain prompt | 157s | 120s | 17k | ~140 | $0.27 |

- **Alone, the lane writes at the single agent's speed** (~170 tokens/s). Running six at once halved it. So the slowdown comes from running agents together, on one account; the brief doesn't cause it.
- **fanout's brief is not the problem:** it was a little faster and leaner than the plain prompt.
- **Six lanes gave about 3× the throughput of one agent, not 6×** (six at ~83 tokens/s against one at ~170). With the planning step and rehearse on top, that wasn't enough here.
- **A lane writes much more per task than one agent does:** 10–17k tokens for the formula module alone, against 37k for all six modules in one session. Likely because an agent with one module writes fuller code and tests (not checked).
- **What to try:** fewer, bigger lanes (three lanes would likely run near full speed each), Haiku sessions (cheaper and less contended), and asking lanes to write fewer of their own tests, since rehearse and the hidden tests check the result anyway.

### Where the time goes, call by call

Each agent's transcript records when every API call starts and ends, and how many tokens it wrote. Speeds below are for the big calls that write code (over 1,500 output tokens), measured the same way for every agent (the transcripts count more output tokens than the results above, so the absolute numbers differ):

| Agent | Writing speed (big calls) | Time running commands |
|---|---|---|
| One agent, whole job | ~305 tokens/s | 18s |
| Formula lane alone | ~290 tokens/s | 28s |
| Six lanes at once | ~70–110 tokens/s (table 170) | 27–54s each |
| Three Sonnet lanes at once | ~250–490 tokens/s | 43–54s each |

- **No errors or retries, just slower streaming.** With six agents on one account, each call took 50–60 seconds to write 2–6k tokens. With three, calls ran at full speed. The limit sits somewhere between three and six agents writing at once.
- **The six lanes all wrote their code in the same two minutes** (09:24:15 to 09:26:10): they start 1.5 seconds apart and spend the first 15 seconds reading, so their heavy calls line up.
- **Running commands is slower in parallel too:** `npm test` and shell calls in several worktrees at once on Windows took 1.5–2× longer than alone.

### Three bigger lanes, Sonnet or Haiku (v0.18)

`--groups formula+csv,recalc+table,numfmt+structure` runs three lanes of two modules each. recalc and table share a lane; recalc still builds on formula's contract from another lane. One run each, 25 October 2026 ([09:56](results/2026-10-25-09-56.md), [10:04](results/2026-10-25-10-04.md)), against the one-agent run above:

| Setup | Wall time | Agent cost | Hidden tests | Lane fixes | Conflicts / repairs on `main` |
|---|---|---|---|---|---|
| One agent, Sonnet | 4m 05s | $0.58 | 33/34 | - | 0 / 0 |
| fanout, 6 Sonnet lanes | 7m 32s | $0.99 | 34/34 | 1 | 0 / 0 |
| fanout, 3 Sonnet lanes | 4m 41s | $0.97 | 34/34 | 0 | 0 / 0 |
| fanout, 3 Haiku lanes (Sonnet plans) | 7m 40s | $0.25 | 34/34 | 0 | 0 / 0 |

- **Three lanes nearly caught up:** 4m 41s against 4m 05s, from 7m 32s with six. Lanes ran at full speed; the gap is planning (56s), merging, and lanes spending about twice as long on commands.
- **Haiku sessions were the cheapest way to a full score:** $0.25, under half of one Sonnet agent, with all 34 hidden tests passing. They were slow, though: Haiku wrote about three times as many tokens as the Sonnet lanes, with more edit-and-retest rounds.
- **One agent is still fastest on this task.** To beat it, fanout needs to save the planning step or the extra command time; the lanes themselves are now about as fast as they can be.
- **Default to three or four lanes, not one per task:** above that, agents on one account slow each other down.

### Why lanes cost more, and lean lanes (v0.18)

Output tokens are most of the bill: on Sonnet, output costs about 5× input, and output alone was about $0.55 of the one agent's $0.58. The three Sonnet lanes wrote about the same amount of code as one agent (839 lines against 853) but almost 3× the tests (313 lines, 31 tests, against 118 lines, 8 tests), and each lane loads its own prompt and reads the code (830k input tokens against 291k, mostly cheap cached reads). The planner adds about $0.10.

`--lean` tells each lane to write at most 3 short tests, since rehearse tests the merged branches. Same three lanes, one run each ([10:18](results/2026-10-25-10-18.md), [10:24](results/2026-10-25-10-24.md)):

| Setup | Wall time | Agent cost | Lanes' cost | Test lines | Hidden tests |
|---|---|---|---|---|---|
| One agent, Sonnet | 4m 05s | $0.58 | - | 118 | 33/34 |
| 3 Sonnet lanes | 4m 41s | $0.97 | $0.88 | 313 | 34/34 |
| 3 Sonnet lanes, lean | 4m 51s | $0.78 | $0.69 | 135 | 33/34 |
| 3 Haiku lanes | 7m 40s | $0.25 | $0.15 | - | 34/34 |
| 3 Haiku lanes, lean | 6m 21s | $0.21 | $0.10 | 170 | 34/34 |

- **Lean lanes cut the lanes' cost by about a fifth on Sonnet and a third on Haiku.** Test code dropped by more than half, but output only fell from about 55k tokens to 46k: most of a lane's output is its code, and a planner plus three agents' start-up don't shrink.
- **Sonnet fanout still costs more than one Sonnet agent** ($0.78 against $0.58). Lean lanes close half the gap.
- **The lean Sonnet run missed one hidden test** (the order `dependents` returns). Fewer tests of its own may have let that slip, or it's run-to-run noise; one run can't tell.
- **Haiku lanes with lean tests are the cheapest full score yet:** $0.21, about a third of one Sonnet agent, all 34 hidden tests, and faster than full Haiku lanes (fewer edit-and-retest rounds).
- **So for cost:** cheap session models are the big lever; lean tests are a smaller one on top. Haiku plus lean is the setup to try as a default, checked on more runs and a vaguer task first.

### `fanout run`'s new defaults on a vague goal

`fanout run` now tells the planner to use at most 4 sessions (`--max-sessions`) and asks sessions to keep their own tests short (`--full-tests` turns it off). Checked with the planner given only "add the features in TASKS.md, split it however you think best", Sonnet throughout, one run ([11:09](results/2026-10-25-11-09.md)):

- **The planner kept to the cap on its own:** 4 sessions (formula; recalc+table; numfmt+csv; structure), the same grouping by dependency as the hand-picked three lanes.
- **34/34 hidden tests, 5m 55s, $1.01.** The four sessions ran at full speed (61–122s each), but rehearse found that recalc+table broke the build once merged. It had also tried to edit formula's file, which was reverted. Its fix took another 117s and $0.11, so the run was slower and dearer than the three hand-picked lanes (4m 41s, $0.97).
- **Tests stayed short:** 240 lines, between full (313) and the benchmark's own lean note (135).
- One run: it shows the defaults work, not that they beat the hand-picked split.

### Drafting the plan without AI, with a mandatory review (v0.20)

The planner spent its minute reading the code (about 5s), deciding the split (10–15s of thinking), writing the plan and the contract file, and running gen and the tests (10–12s), then committing. `fanout run` now drafts the plan itself from a goal written as `## name` sections ([skills/fanout/draft.mjs](../skills/fanout/draft.mjs)): owners from the files each section names, contracts where one section builds on another's file, regen and test lines, per-session checks, and sections merged down to 4 sessions. An agent then reviews the draft and writes the contracts; fanout runs the tests and commits. Sessions also get their own sections of the goal in full. `--draft` runs this in the benchmark. One run each, Sonnet, short tests:

| Run | Planning | Wall time | Cost | Hidden tests | Fix rounds |
|---|---|---|---|---|---|
| sheet, AI plans from scratch (3 hand-picked lanes) | 80s, $0.09 | 4m 51s | $0.78 | 33/34 | 0 |
| sheet, draft, agent only writes contracts ([11:39](results/2026-10-25-11-39.md)) | 26s, $0.05 | 4m 40s | $0.72 | 34/34 | 0 |
| sheet, same with Haiku sessions ([11:44](results/2026-10-25-11-44.md)) | 30s, $0.05 | 5m 05s | $0.16 | 33/34 | 0 |
| sheet, draft + mandatory review ([12:04](results/2026-10-25-12-04.md)) | 76s, $0.06 | 7m 21s | $0.97 | 34/34 | 1 |
| library, draft + mandatory review ([12:08](results/2026-10-25-12-08.md)) | 41s, $0.06 | 3m 19s | $0.40 | 21/21 | 0 |
| sheet, one agent, same day ([11:51](results/2026-10-25-11-51.md)) | - | 6m 44s | $0.71 | 34/34 | - |

- **Drafting alone cut planning from about 80s to 26s.** But a draft only sees the files the goal names. On the library task it gave `src/store.mjs` to holds alone, though fines also needs `createStore` changed and never names the file. So the review is mandatory: an agent always checks the draft for what it can't see.
- **The review caught it.** On the library task the reviewer added `payments` and `holds` to `createStore` on main as a shared change before the sessions started, and all 21 hidden tests passed with no fix round, in 3m 19s for $0.40 (earlier fanout runs on the same task with six one-task sessions took 2m 44s–2m 51s for $0.61–$0.66).
- **On the sheet task the review gave back most of the time:** 76s, close to planning from scratch, though at about two-thirds of the cost. The review prompt asks it to look through the code for hidden dependencies, and it did.
- **The 7m 21s sheet run is mostly a fix round, not the review:** recalc+table broke once merged with formula and took 165s to fix, as in the earlier vague-goal run. recalc builds against formula's stub, so its own tests can't catch a mismatch with the real formula; that is the next thing to look at.
- **One agent varies a lot between runs:** 4m 05s and $0.58 earlier, 6m 44s and $0.71 today, both scoring full or nearly full marks. Single runs of any setup are signals, not results.

### Repeats with the new defaults (v0.21)

Two changes since v0.20, both scripted steps rather than extra agent work:
- **A drafted plan is reviewed only where it needs it.** The draft flags names a session uses from a file another session owns, and the agent checks just those.
- **A broken session fixes against the real code.** It gets the branches merged ahead of it merged into its own branch, plus the failing tests instead of the last 20 lines of output.

Same day, Sonnet planner, short tests, `--draft`:

| Run | Planning | Wall time | Cost | Hidden tests | Fix rounds |
|---|---|---|---|---|---|
| sheet, Sonnet sessions ([13:39](results/2026-10-25-13-39.md)) | 22s | 3m 16s | $0.68 | 34/34 | 0 |
| sheet, Sonnet sessions ([13:43](results/2026-10-25-13-43.md)) | 24s | 3m 59s | $0.74 | 33/34 | 0 |
| sheet, Haiku sessions ([13:48](results/2026-10-25-13-48.md)) | 38s | 5m 07s | $0.15 | 32/34 | 0 |
| sheet, Haiku sessions ([13:54](results/2026-10-25-13-54.md)) | 31s | 5m 41s | $0.15 | 33/34 | 0 |
| sheet, one Sonnet agent ([13:59](results/2026-10-25-13-59.md)) | - | 5m 44s | $0.62 | 34/34 | - |
| library, Sonnet sessions ([14:04](results/2026-10-25-14-04.md)) | 42s | 4m 06s | $0.43 | 21/21 | 0 |

- **Planning on the sheet task is back to about 25s** (from 76s with the full review). The draft flagged nothing there, so the agent only wrote the formula contract.
- **The flags caught the library task's hidden dependency.** They named fines → `createStore` (and two plain calls), and the agent added `payments` to `createStore` on main before the sessions started, the same shared change the full review made. All 21 hidden tests passed with no fix round, but planning took 42s, about as long as the full review (41s), since this agent had real work to do.
- **One agent on the sheet task, three runs:** 4m 05s / $0.58 / 33 of 34; 6m 44s / $0.71 / 34; 5m 44s / $0.62 / 34. Median 5m 44s and $0.62.
- **fanout with Sonnet sessions, drafted plan, three runs** (with 11:39, the same setup bar the flags): 3m 16s / $0.68 / 34; 3m 59s / $0.74 / 33; 4m 40s / $0.72 / 34. Median 3m 59s and $0.72.
- **So on this task fanout is now faster than one agent, at slightly higher cost:** each fanout run beat the median one-agent run, and the median is about 1.4× faster for about 15% more. The ranges overlap at the edges (one agent's best run, 4m 05s, beat fanout's slowest, 4m 40s), so this holds for the median, not every run.
- **Haiku sessions with a drafted plan cost a quarter as much but lose hidden tests:** 32, 33 and 33 of 34 over three runs ($0.15–0.16), against 34/34 for Haiku with the hand-picked three-session split. The cheap setup is good for cost, not yet for a full score.
- **No run broke after merging,** so these runs don't measure the new fix step. The two saved breaks were replayed instead (below).

### Replaying the two fix rounds

The two runs where recalc+table broke (11:09 and 12:04) still had their branches on disk. Each was replayed on the new code from the same state: the recalc+table branch reset to its commit before the fix, rehearsed against main as it was before merging, then fanout's fix step. That step merges formula's branch into recalc+table and gives a fresh Sonnet agent the brief and the failing test. Same bug, same break, one replay each:

| Break | Before: fix round | After: fix round | Shell commands | Rehearse after |
|---|---|---|---|---|
| 12:04: `dependents` ignored plain value cells | 165s, $0.17 | 49s, $0.09 | 18 → 2 | passes |
| 11:09: own test expected the wrong `dependents` order | 117s, $0.11 | 39s, $0.07 | 17 → 4 | passes |

- **Fix rounds now take about a third of the time and half the cost.** The report now shows the failing assertion (expected against actual), and the real formula code is in the session's checkout. The agent no longer rebuilds a merged copy by hand: it reads the failure, makes the one edit both earlier fixes made, and reruns the tests.
- **Still a cost when it happens:** about 40–50s and $0.07–0.09 per break. Preventing the break (testing a session that builds on another against that session's real code before it finishes) would save that too; not tried yet.

### Claude and Codex sessions together (v0.21.1)

Six sessions on the sheet task, one per module, three in Claude (formula, recalc, table: the chain that builds on each other) and three in Codex (numfmt, csv, structure), with a drafted plan and short tests. `--codex-lane` now takes several names. One run ([16:46](results/2026-10-25-16-46.md)), Codex CLI 0.164 with its default model:

| Setup | Wall time | Claude cost | Hidden tests | Slowest session |
|---|---|---|---|---|
| 6 Claude sessions (09:29) | 7m 32s | $0.99 | 34/34 | recalc 211s |
| 4 Claude sessions (median of 3) | 3m 59s | $0.72 | 33–34/34 | - |
| 3 Claude + 3 Codex | 11m 29s | $0.49 + Codex quota | 34/34 | structure (Codex) 611s |

- **Codex does sidestep the Claude account's limit:** the three Claude sessions wrote at about 133–145 tokens/s, near one agent alone (~170), against ~83 when six Claude sessions ran at once. They finished in 86–135s.
- **But the Codex sessions were the bottleneck:** 287s, 413s and 611s for modules Claude sessions did in 1.5–3.5 minutes. So the run took 11m 29s, slower than six Claude sessions and nearly three times four.
- **The result was right:** 34/34 hidden tests, rehearse passed first time, no fix round. Codex's change to the generated `src/index.mjs` was reverted when its work was committed, as designed (Codex sessions are guarded at commit time only).
- **What it's good for:** Claude cost fell to $0.49, since Codex sessions use your ChatGPT plan's quota instead. Mixing in Codex saves Claude spend and quota, not time. For speed, keep to at most four Claude sessions; give Codex parts that nothing else waits on. A faster Codex setting (lower reasoning effort) wasn't tried.

**Codex on low reasoning effort** (`FANOUT_CODEX_EFFORT=low`, passed to `codex exec` as `-c model_reasoning_effort=low`). Same six sessions, one run ([21:26](results/2026-10-25-21-26.md)):

| Setup | Wall time | Claude cost | Hidden tests | Codex sessions | Fix rounds |
|---|---|---|---|---|---|
| 3 Claude + 3 Codex, default effort | 11m 29s | $0.49 | 34/34 | 287s, 413s, 611s | 0 |
| 3 Claude + 3 Codex, low effort | 5m 09s | $0.57 | 34/34 | 165s, 196s, 201s | 1 (21s, $0.05) |
| 4 Claude sessions (median of 3) | 3m 59s | $0.72 | 33–34/34 | - | 0 |

- **Low effort made the Codex sessions 2–3× faster** (165–201s), with all 34 hidden tests still passing. The whole run took 5m 09s against 11m 29s.
- **Against four Claude sessions it's about a minute slower and $0.15 cheaper in Claude spend,** with six sessions instead of four. The Codex sessions are still the slowest ones, so the run waits on them.
- **The run had one break** (recalc against formula, both Claude). Its fix round took 21s and $0.05: the first in-run measurement of v0.21's fix step.
- **So for mixed runs, run Codex on low effort.** One run; whether low effort holds up on harder parts is untested.

**Where a Codex session's time goes.** One module (numfmt) with fanout's brief, `codex exec` started directly with each JSON event timed, scored on the 6 hidden numfmt tests. One run per row, low effort throughout, Codex CLI 0.164:

| Setup | Time | Hidden tests |
|---|---|---|
| gpt-6.1-sol (your default model), alone | 205s | 6/6 |
| gpt-6.1-sol, three sessions at once | 211s, 231s, 284s | 6/6 each |
| gpt-6.1-sol, Fast tier (`-c service_tier=priority`, uses more quota) | 168s | 6/6 |
| gpt-6-luna (the fast model) | 152s | 5/6 |
| (Claude Sonnet sessions on numfmt, earlier runs) | 80–171s | - |

- **Running commands is a small part:** 13–20s per session. Most of the time is the model deciding its next step, 5–28s per step over about ten steps; some file edits also took 8–23s to apply.
- **Codex sessions slow each other a little:** three at once took 1.0–1.4× as long as one alone, much less than six Claude sessions on one account (about 2×).
- **The Fast tier cut about a fifth** with no loss; gpt-6-luna cut about a quarter but missed a hidden test.
- **Every Codex call carries about 18.7k tokens of instructions** before the task (Codex's own instructions, the skill list from installed plugins, tool definitions, your AGENTS.md), mostly served from cache after the first call. Turning plugins off with `-c` overrides didn't change it.

### Early tests and `--mix` (v0.22)

Two changes, both scripted:
- **Early test:** when a session that builds on others is done and so are they, their branches are merged into its branch and the plan's test runs there while the other sessions still work. A failure goes straight back to that session; a pass undoes the merge and runs no agent.
- **`--mix`:** sessions others build on run in Claude (at most three), the rest in Codex.

Sheet task, drafted plan (four sessions: formula, recalc-table, numfmt, csv-structure), Sonnet, short tests, one run each:

| Run | Wall time | Claude cost | Hidden tests | Early test | Fix rounds | Slowest session |
|---|---|---|---|---|---|---|
| 4 Claude sessions ([23:02](results/2026-10-25-23-02.md)) | 3m 37s | $0.88 | 34/34 | recalc-table vs formula: **failed**, fixed in 23s ($0.05) | 1 (early), rehearse passed first time | numfmt 178s |
| `--mix`: 1 Claude + 3 Codex ([23:07](results/2026-10-25-23-07.md)) | 5m 04s | $0.28 + Codex quota | 34/34 | recalc-table vs formula: passed, no agent | 0 | recalc-table (Codex) 268s |
| (4 Claude sessions, median of 3, v0.21) | 3m 59s | $0.72 | 33–34/34 | - | 0 | - |

- **The early test caught the recalc-against-formula break** (the one rehearse found in about 3 of 10 earlier runs) 2m 32s into the run, while numfmt was still working. The fix took 23s and $0.05, and finished before numfmt did, so it added nothing to the wall time; rehearse then passed first time. Before, the same break cost a rehearse, a fix round after every session finished (21–49s) and a second rehearse.
- **The run's cost ($0.88) is above the v0.21 median ($0.72)**: its four session agents cost $0.78 this time; the early fix itself was $0.05. One run, so this says the early test works, not that it changes the median.
- **`--mix` with the four-session draft puts only formula in Claude:** nothing builds on recalc-table, numfmt or csv-structure. The three Codex sessions (low effort, now the default) took 229–268s, so the run took 5m 04s, about as long as the six-session 3 Claude + 3 Codex run (5m 09s), for $0.28 of Claude spend: 40% of the four-Claude median. The early test ran on a Codex session and passed.
- **So:** `--mix` is for saving Claude spend and quota, at about a minute more than the four-Claude median on this task; for speed, run four Claude sessions. One run each.

**`--mix` filling the free Claude slots (v0.22.1).** Three sessions now go to Claude: those others build on first, then the rest in plan order. On the four-session draft that's formula, recalc-table and numfmt in Claude, csv-structure in Codex. One run ([23:24](results/2026-10-25-23-24.md)):

| Setup | Wall time | Claude cost | Hidden tests | Slowest session |
|---|---|---|---|---|
| 1 Claude + 3 Codex (v0.22.0, 23:07) | 5m 04s | $0.28 | 34/34 | recalc-table (Codex) 268s |
| 3 Claude + 1 Codex (v0.22.1, 23:24) | 4m 47s | $0.58 | **30/34** | csv-structure (Codex) 235s |
| 4 Claude sessions (median of 3, v0.21) | 3m 59s | $0.72 | 33–34/34 | - |

- **Only 17s faster:** the one Codex session (235s) was still the slowest, so the run waited on it just as before. With Codex at 2–3× Claude's time, any Codex session sets the wall time unless its part is small.
- **The four lost hidden tests weren't Codex's:** all four were recalc's (every formula came out `#ERROR!`). The recalc-table session, in Claude, passed the formula text with its leading `=` to `parseFormula`, which the spec says takes the text without it. That line is in formula's section of the goal, and the contract stub fanout pasted into recalc-table's brief had only the signature. recalc-table's own short tests checked only plain values, so its early test and rehearse both passed. Earlier runs lost one hidden test at most; this is a contract gap, not a mix effect. One way to close it: have the contracts agent copy each function's documented behaviour from the spec into the stub as a comment.
- **So for speed, `--mix` doesn't help on this task:** it saves Claude spend ($0.28–0.58 against $0.72) and costs about a minute. One run per setup.

### Claims: telling the same task from different work (v0.23)

`fanout claim` checks a new task against every live claim and refuses it when another session is doing the same work. Measured with `node bench/task-overlap.mjs` on two sets of 40 labelled task pairs (20 same, 20 different), each written by a separate agent that didn't know how they'd be judged: [task-pairs.json](task-pairs.json), and [task-pairs-heldout.json](task-pairs-heldout.json), which was written after the judge's prompt was fixed and used unchanged. Each new task is compared with four live claims at once, the right one among three from other pairs. One run per row:

| Check | First set | Held-out set | Cost per claim |
|---|---|---|---|
| Shared words (best threshold) | 17/40 | 20/40 | free |
| Haiku, first prompt (decide, then explain) | 30/40: 18 of 20 duplicates caught, 8 false alarms | - | $0.0005 |
| Haiku, reason before deciding | 36/40, no false alarms | 33/40: 13 of 20 caught, no false alarms | $0.0007 |
| Sonnet, reason before deciding | **40/40** | **40/40** | $0.012 |

- **Word overlap is no better than chance:** duplicates are often written in different words ("dark mode toggle" against "a night theme"), and different work often shares them ("add tax to checkout" against "add discount codes to checkout").
- **Asking for the reason first removed the false alarms.** With the first prompt, five of Haiku's eight false alarms came with a reason that called the tasks different.
- **Haiku misses symptom-against-fix duplicates** ("password reset links still work after a password change" against "invalidate reset tokens on password change"). Sonnet caught all of them, so the check runs on Sonnet: about $0.012 once per session.
- **The prompt was tuned on the first set**, so its 40/40 there flatters it; the held-out 40/40 is the fair number. 80 pairs, one run each.

**With real agents:** three headless Sonnet sessions in one repo with claims on, each told to follow the `fanout init` instructions in `CLAUDE.md`. A had "add a dark mode toggle to the settings page", B "users have asked for a night theme they can turn on themselves", C "add a CSV export to the reports page"; B and C started once A had claimed.

| Run | A | B (same work, other words) | C (different work) |
|---|---|---|---|
| B follows the instructions | claimed, built it (35s, $0.04) | listed the claims, saw dark mode, stopped with no changes (19s, $0.01) | claimed, built it (60s, $0.03) |
| B told to skip the list and claim at once | claimed, built it (45s, $0.04) | its claim was refused as the same work as A's; stopped with no changes (33s, $0.02) | - |

One run each. Both ways B didn't duplicate A's work, and C wasn't held up.

**With no setup at all (v0.24).** Same tasks, but nothing about fanout anywhere: no `CLAUDE.md` block, no `fanout init`, no fanout commands in the briefs. Only the plugin's two hooks (session start and edit guard), in a repo with three worktrees, so claims switched on by themselves. Each session's task was claimed on its first edit from the user's request.

| Run | A (dark mode) | B (night theme: same work) | C (CSV export) |
|---|---|---|---|
| B starts after A's first edit | claimed on first edit, built it (30s, $0.03) | told at start that session a has dark mode; stopped with no changes (22s, $0.02) | claimed on first edit, built it (50s, $0.02) |
| A and B start at the same moment | claimed first, built it (33s, $0.03) | neither saw the other at start; B's first edit was checked against A's claim and refused; B changed nothing, didn't try to get round it, and told the user (58s, $0.04) | - |

One run each.

### Claims on Codex (v0.25)

**The same-work check on Codex** (`codex exec`, your default model, low reasoning effort, read-only, nothing saved), for setups with no Claude account. Same held-out pairs (`--agent codex`), two runs:

| Run | Answered | Right | Calls that didn't answer |
|---|---|---|---|
| 1 | 31 of 40 | 31 of 31: all 15 duplicates caught, no false alarms | 9, ran into the 180s timeout |
| 2 | 21 of 40 | 21 of 21: all 10 caught, no false alarms | 19 |

- **Every answer Codex gave was right** (52 of 52), as good as Sonnet's 40/40.
- **The calls that didn't answer were rate limiting.** After a day of heavy Codex use, calls came back with `429 Too Many Requests` and Codex kept reconnecting, often without printing anything. Answered calls took 12–22s (one at a time, not rate-limited).
- **So a Codex check now gets one 45s try.** A 429 event, or silence past 40s, ends it at once (with Codex's process tree), and the agent is shown the other sessions' tasks to compare itself. Claude, when it's signed in, is used first.

**Two real Codex sessions** (`codex exec`, workspace-write sandbox, low effort), told only what `fanout init` writes to `AGENTS.md`. A: dark mode; B: a night theme (the same work). Inside Codex's sandbox there's no network (`CODEX_SANDBOX_NETWORK_DISABLED=1`), so `fanout start` lists the other sessions' tasks there instead of calling a model:

| Run | A | B |
|---|---|---|
| Before the fixes, B starts after A claimed | claimed, built it | built it first, ran `fanout start` last; it hung on a model call from the sandbox: **duplicate** |
| Before the fixes, both start at once | claimed, built it | claimed before A's claim existed, built it: **duplicate** |
| After, B starts after A claimed | ran `start` first, built it | ran `start` first, read the list, released its claim, stopped with no changes |
| After, both start at once | ran `start`, then again before its first edit, built it | ran `start`, saw A, released, stopped with no changes |

- **The fixes:** no model call from a sandbox without network (the agent compares instead); `AGENTS.md` says to run `start` before reading any code and again before the first edit; after `fanout init` the git hook refuses commits from a session that never ran `start`; and at every checkpoint a claim is compared once with older claims it hasn't met, so two that started at once find each other (in the last run B's first `start` already saw A, so that step is covered by the fake-agent test, not this run).
- **Codex couldn't commit from its worktree in any run:** its sandbox won't write the worktree's git index, which lives in the main repository's `.git`. That's Codex's sandbox, not fanout; the commit-time rule only applies where Codex can commit.

One run per row.

### Notices between sessions (v0.26)

A session is now told when another session (or the base branch) commits changes to a file it has read or edited, with the diff, by a `PostToolUse` hook. The test was built so that a break is certain unless the session hears of the other's change: two headless Sonnet sessions in one repo with the plugin's hooks and nothing about fanout in their tasks. b changes `formatPrice(cents)` to `formatPrice(cents, currency)`, which throws without a currency, and commits after about 20–35s. a builds a receipt on `formatPrice` (60–90s) and commits. Then both branches are merged on main and a hidden check renders a EUR receipt. One run per row:

| Arm | Runs | b committed before a finished | Notice reached a | a acted on it | Hidden check passed | Cost per run |
|---|---|---|---|---|---|---|
| No notices | 3 | 1 | - | - | 0 | $0.07 |
| Notice as added context | 3 | 3 | 3 | 0 | 0 | $0.08–0.10 |
| Same, sessions edit only through the shell | 2 | 1 | 1 | 0 | 0 | $0.08–0.14 |
| Notice as hook feedback (`decision: block`) | 3 | 3 | 3 | 3 | 2 | $0.08–0.09 |

- **Sent as added context, the notice was delivered every time and ignored every time.** a never mentioned it, and committed code calling the old `formatPrice`.
- **Sent as hook feedback, a acted on it every time.** Twice it wrote the receipt to pass the cart's currency, and the merged code passed. Once it didn't commit and told the user its code would break against the other branch's pending change, which counts as a fail here but is the right call. So notices go out as feedback.
- **Notices only help when the other session commits first.** With no notices, a finished before b committed in 2 of 3 runs, so no notice could have reached it. Claims and `fanout done` cover that order.
- Small and constructed (one pair of tasks, 11 runs), like the paper's constructed tier: it shows the mechanism works, not how often real sessions need it.

**Agents without hooks: `fanout inbox` (v0.27).** The same receipt task in a real Codex session (`codex exec`, workspace-write sandbox, low effort), told only what `fanout init` writes to `AGENTS.md`, which now asks for `fanout inbox` before committing and before finishing. b was scripted: it claimed its task, then committed the `formatPrice` change 25s in. Codex can't commit from its worktree in its sandbox, so a's files were copied onto main after merging b, then the hidden check ran. One run per row:

| b's claim says | `inbox` in AGENTS.md | Runs | a ran inbox and saw the change | Hidden check passed |
|---|---|---|---|---|
| "prices need a currency: formatPrice(cents, currency)" | yes | 2 | 2 | 2 |
| the same | no | 2 | - | 2 |
| "rework money formatting in money.js" | yes | 1 | 1 | 1 |
| the same | no | 1 | - | 0 |

- **With a claim that spells out the change, `fanout start`'s list of the other sessions was enough:** Codex read b's task there and passed the currency without any notice.
- **With a vague claim, only the inbox carried it:** without it Codex built on the old `formatPrice` and the merged code failed; with it Codex saw the diff, tested against b's version, and passed. One run each, so this shows the mechanism, not a rate.
- Codex ran `start` and `inbox` four times each in every run that had them: before reading, before the first edit, before committing and before finishing.
- Without hooks fanout can't see what an agent read, so `inbox` shows every file other sessions committed, with the ones this session also changed named first.

**Why it couldn't have worked on slgtme before:** in the desktop app's auto mode, sessions edit through the shell (Python, heredocs, `cat >>`), and the guard only watched Edit and Write. slgtme had five active checkouts and no claim was ever written. Shell edits now go through the same rules after each shell command (`git status` and the branch's commits): the first change claims the task, and a duplicate task or a locked file is reported back as feedback, telling the agent to undo. The shell-only arm above was claimed this way. The hook costs about 140–250ms per tool call on Windows when nothing has changed (it reads git's files directly rather than calling git), and about 300ms after a shell command.

**A Windows bug the same project found:** `fanout run` ran `check:` and `test:` lines through `cmd.exe`, so a check starting `! grep` failed whatever the code did. On slgtme that stopped a two-session run after two fix rounds that changed nothing ($1.19 and $1.22, $4.26 in all). Plan commands now run in Git's bash on Windows, and a fix round that changes nothing stops the run instead of trying again.

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
node bench/run.mjs fanout --fixture library --vague --planner-model opus   # one-line goal: the planner picks the split
node bench/run.mjs single --fixture sheet --single-budget 8 && node bench/run.mjs fanout --fixture sheet --budget 2   # the large task
```
