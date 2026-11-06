# Privacy

fanout runs on your machine. It has no server, collects no telemetry, and sends nothing to its authors.

## What leaves your machine

Only the same-work check, which asks a model whether a new session's task is work another session already has. It runs through the `claude` or `codex` CLI you're already signed in to, so it's handled by Anthropic or OpenAI under your own account and their terms. It sends:

- your latest request to the session (up to 600 characters),
- the other live sessions' tasks and the files they claimed.

It runs once per session. `FANOUT_CLAIM_JUDGE=off` turns it off; sessions then get the list of tasks and compare them themselves.

`fanout run` and `fanout demo` start agents through the same CLIs, with the prompts you give them.

## What it stores

All of it stays in your repository:

- claims (each session's task, branch, locked files and changed files) on the git ref `refs/fanout/state`, which `git push` doesn't send unless you push that ref yourself;
- an event log and per-checkout state in `.git/`;
- `fanout run`'s plan and session folders in `.fanout/` (git-ignored), with copies of the files `.worktreeinclude` lists.

It reads no credentials. To find which CLI is signed in, it runs `claude auth status` or `codex login status` and checks whether `ANTHROPIC_API_KEY` is set, without reading or sending its value. Each CLI keeps its own login.

## Personal data

fanout doesn't collect names, emails or addresses. A request you type may contain anything you write in it, and the first 600 characters go to the check above.

## Contact

Questions: open an issue at https://github.com/Breadstick-Crumbs/fanout/issues.
