---
name: usage-review
description: The weekly usage review, once per limit week, after the plan's weekly limit resets (the workspace's usage.weekStart). Measures where the week's usage went from every Claude Code transcript on this machine, by task and step, compares it with the previous review, answers the workspace's own standing questions, and proposes the next changes that cut usage without lowering quality. Use when the owner asks for the usage review, types /usage-review, or shares a ccusage export.
---

# usage-review: where the week's usage went

The limit week starts where the workspace's `usage.weekStart` says (kirunak's default: Sunday 00:00 UTC); the review
covers the one that just ended. Run it in a fresh session and keep its context small: read the summaries, never
`calls.jsonl`.

1. **Measure.** `k usage` writes the last finished week to `<KIRUNAK_HOME>/usage/<date>/` (`--from`, `--to` and
   `--out` for another window) and prints the summary, each task's and step's weight, and, last, the line
   `reviews: <folder>`: the workspace's `usage.reviews`, where every review is kept. If it says `none named`, ask the
   owner for a folder to name there, and until then give the review in the reply only. Read the summary,
   `report.txt` and `tasks.txt`; open `carry.txt`, `ttl.txt`, `escalations.txt`, `quality.txt`, `compact.txt` or
   `replay.txt` only for the item a question is about.
2. **Compare.** Read the newest review in the folder (the files are named by date) and set this week beside it: the
   weight, cache read : output, the average context per call (main sessions and agents), when the weekly limit
   reached 100% (the summary's `weekly limit` line, from the rate-limit log), the heaviest tasks and steps, and
   whether each change the last review proposed or started held (its "Started this week" section says what to
   measure).
3. **Standing questions.** Read `standing.md` in the folder, if there is one: the workspace's own questions, asked
   every week (a baseline to compare with, a prediction to check, a decision waiting on a number). Answer each with
   the numbers it names. The owner edits that file; this session only reads it.
4. **ccusage.** If the owner shares a ccusage export, compare its weekly totals with the transcripts. Its dollars use
   its own price table, so compare weeks with each other and never with an invoice. What it cannot see, and how to
   check: claude.ai chats, cloud sessions and another machine show up as points the limit rose with no local call
   (the summary); the auto-mode classifier writes no transcript at all.
5. **Write** `<date>.md` in the folder: the numbers beside last week's, what moved and why, the three largest levers
   with their measured share of the week, each with its quality risk; the escalations per trigger from
   `escalations.txt` and whether each step then passed; the answers to the standing questions; and a "Started this
   week" section naming what next week's review measures.
6. **Changes.** What costs no quality (a measurement, a tool list, a cache setting the replay proves) goes to the owner
   as a one-line question with its measured saving. A change to the owner's rules or to Claude Code's settings is the
   owner's decision, never this session's. Anything larger is a kirunak draft (the k-draft skill).

## How to read the numbers

- Weight is in Opus base-input tokens: input 1, cache read 0.1, 1h write 2, 5m write 1.25, output 5; Fable 2.5x,
  Sonnet 0.6x, Haiku 0.2x. `tasks.txt` and `tasks.tsv` weigh each task and step this way, a task's agents with it,
  heaviest first and "no task" last.
- Almost all usage is re-reading context. It grows with calls times context size, so what counts is how long a
  session or agent lives and how large it starts, much more than how big one file read is.
- `ttl.txt` replays the week under a 5-minute and a 1-hour cache, for main sessions and agents apart, and the whole
  week under each: the evidence for `promptCacheTtl` and `subagentPromptCacheTtl`, which k doctor checks against the
  workspace's `cache` block.
- `replay.txt` replays kirunak's handover at each size from 100k to 300k; its `measured:` line is what the handover
  saved this week against no handover.
- `transcripts skipped` counts transcripts cut short or unreadable, left out whole: a large number means the week's
  numbers are low.
