---
name: usage-review
description: The weekly usage review, once per limit week, after the plan's weekly limit resets (the workspace's usage.weekStart). Measures where the week's usage went from every Claude Code transcript on this machine, by task and step, compares it with the previous review, answers the workspace's own standing questions, and ends in one improvement task, holding every change it proposes, for the owner to run first that week. Use when the owner asks for the usage review, types /usage-review, or shares a ccusage export.
---

# usage-review: where the week's usage went

The limit week starts where the workspace's `usage.weekStart` says (kirunak's default: Sunday 00:00 UTC); the review
covers the one that just ended. Run it in a fresh session and keep its context small: read the summaries, never
`calls.jsonl`.

1. **Measure.** `k usage` writes the last finished week to `<KIRUNAK_HOME>/usage/<date>/` (`--from`, `--to` and
   `--out` for another window) and prints the summary, each task's and step's weight, and, last, the line
   `reviews: <folder>`: the workspace's `usage.reviews`, where every review is kept. If it says `none named`, ask the
   owner for a folder to name there, and until then give the review in the reply only. Read the summary,
   `report.txt` and `tasks.txt`; open `carry.txt`, `ttl.txt`, `escalations.txt`, `quality.txt`, `compact.txt`,
   `replay.txt` or `fable.txt` only for the item a question is about. If it also printed `heavy jobs: <command>` (the workspace's
   `usage.heavyReport`, the week filled in), run that command: its table of the week's slowest jobs and suites per
   repo, the jobs of 50 minutes or more and the minutes lost to failed jobs goes into the review as it prints.
2. **Compare.** Read the newest review in the folder (the files are named by date) and set this week beside it: the
   weight, cache read : output, the average context per call (main sessions and agents), when the weekly limit
   reached 100% (the summary's `weekly limit` line, from the rate-limit log), the heaviest tasks and steps, whether
   each change the last review proposed or started held (its "Started this week" section says what to measure), and
   the newest review's levers table: each row's share this week and where its work stands (`k bugs`, `k drafts`,
   `k list`).
3. **Standing questions.** Read `standing.md` in the folder, if there is one: the workspace's own questions, asked
   every week (a baseline to compare with, a prediction to check, a decision waiting on a number). Answer each with
   the numbers it names. The owner edits that file; this session only reads it.
4. **ccusage.** A shared ccusage export's weekly totals go beside the transcripts', weeks against weeks (its dollars
   are its own price table, never an invoice). claude.ai, cloud sessions and another machine show as points the limit
   rose with no local call (the summary); the auto-mode classifier writes no transcript at all.
5. **Write** `<date>.md` in the folder: the numbers beside last week's, what moved and why, the levers table (below);
   the escalations per trigger from
   `escalations.txt` and whether each step then passed; the answers to the standing questions; under "Slowest suites
   and jobs", the heavy-job report's table when step 1 ran one, beside last week's totals; and a "Started this week"
   section naming what next week's review measures.
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
