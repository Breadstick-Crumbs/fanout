# Benchmark results

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
node bench/run.mjs both                      # baseline and fanout
node bench/run.mjs fanout --model sonnet --budget 1
node bench/run.mjs both --dry                # plumbing only, no agents
node bench/run.mjs both --codex-lane receipt # run the receipt lane in Codex
```
