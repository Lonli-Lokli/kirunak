---
name: usage-review
description: The weekly usage review, once per limit week, after the plan's weekly limit resets (the workspace's usage.weekStart). Measures where the week's usage went from every Claude Code transcript on this machine, by task and step, compares it with the previous review, answers the workspace's own standing questions, and ends in one improvement task, holding every change it proposes, for the owner to run first that week. Use when the owner asks for the usage review, types /usage-review, or shares a ccusage export.
---

# usage-review: where the week's usage went

The limit week starts at the workspace's `usage.weekStart` (kirunak's default: Sunday 00:00 UTC); the review covers
the one that just ended. Run it in a fresh session and keep its context small: read the summaries, never `calls.jsonl`.

1. **Measure.** `k usage` writes the last finished week to `<KIRUNAK_HOME>/usage/<date>/` (`--from`, `--to` and
   `--out` for another window) and prints the summary, each task's and step's weight, and, last, the line
   `reviews: <folder>`: the workspace's `usage.reviews`, where every review is kept. If it says `none named`, ask the
   owner for a folder to name there, and until then give the review in the reply only. Read the summary, `report.txt`
   and `tasks.txt`, and every week `report.txt`'s `agents past 100 calls`, `tasks.txt`'s no-step split, `fable.txt`
   and `escalations.txt`'s `stops for the owner` (by reason and by task); open `carry.txt`, `ttl.txt`, `quality.txt`,
   `compact.txt`, `replay.txt` or the rest of `escalations.txt` only for the item a question is about. If it printed
   `heavy jobs: <command>` (`usage.heavyReport`, the week filled in), run it: its slowest jobs and suites per repo,
   the jobs of 50 minutes or more, the failed minutes per task and step and their share of the week, and each
   `checks over 3 minutes` line go into the review as it prints.
2. **Compare.** Read the newest review in the folder (named by date) and set this week beside it: the weight, cache
   read : output, the average context per call (main sessions and agents), when the weekly limit reached 100% (the
   summary's `weekly limit` line, from the rate-limit log), the heaviest tasks and steps, whether each change the last
   review proposed or started held (its "Started this week" section says what to measure), and the newest review's
   levers table: each row's share this week and where its work stands (`k bugs`, `k drafts`, `k list`).
3. **Standing questions.** Answer each question in the folder's `standing.md`, if there is one (a baseline, a
   prediction to check, a decision waiting on a number), with the numbers it names; the owner edits it, you only read.
4. **ccusage.** A shared ccusage export's weekly totals go beside the transcripts', weeks against weeks (its dollars
   are its own price table, never an invoice). claude.ai, cloud sessions and another machine show as points the limit
   rose with no local call (the summary); the auto-mode classifier writes no transcript at all.
5. **Write** `<date>.md` in the folder: the numbers beside last week's, what moved and why, the levers table (below);
   the escalations per trigger from `escalations.txt` and whether each step then passed, and the stops for the owner
   by reason and by task; the Fable steps and agents by role, with the designs redone; each task's no-step split; the
   agents past 100 calls with their task and step; the answers to the standing questions; under "Slowest suites and
   jobs", the heavy-job report's table beside last week's totals, the failed minutes per task and step, their share
   and the `checks over 3 minutes` lines; and a "Started this week" section naming what next week's review measures.
6. **Changes.** What costs no quality (a measurement, a tool list, a cache setting the replay proves) goes to the owner
   as a one-line question with its measured saving. A change to the owner's rules or to Claude Code's settings is the
   owner's decision, never this session's. Anything larger goes into the week's improvement task.

## The levers table and the improvement task

The table has a row for every lever (a measured share of the week) any review named, carried from the newest review:
first named, share this week, quality risk, and its work: the improvement task that holds it, or the owner's no with
its date. A row leaves only once its work is done and measured. **Every review ends in one improvement task**, never
drafts: each change it proposes, every lever with no work among them, through the intake (the k-intake skill) right
after the review, for the owner to approve and run first, so the week runs on the improved code.

## How to read the numbers

- Weight is in Opus base-input tokens: input 1, cache read 0.1, 1h write 2, 5m write 1.25, output 5; Fable 2.5x,
  Sonnet 0.6x, Haiku 0.2x. `tasks.txt` and `tasks.tsv` weigh each task and step this way, a task's agents with it,
  heaviest first and "no task" last, a task's "no step" split by what the session was doing (the work to move into steps).
- Almost all usage is re-reading context. It grows with calls times context size, so what counts is how long a
  session or agent lives and how large it starts, much more than how big one file read is.
- `ttl.txt` replays the week under a 5-minute and a 1-hour cache, main sessions and agents apart: the evidence for
  `promptCacheTtl` and `subagentPromptCacheTtl`, which k doctor checks against the workspace's `cache` block.
- `replay.txt` replays the handover at each size from 100k to 300k; `measured:` is what it saved this week.
- `transcripts skipped` counts transcripts cut short or unreadable, left out whole: many means the numbers are low.
