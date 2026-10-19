# The review record, acceptance and closing

Design (R13, R14, R15, D12). Each choice is marked **evidence** (with its source) or **judgement**. Index:
`README.md`. The examples use the invented task of `task-files.md`.

## 1. Who reviews, with what (R13)

- The review is a `review` step in the plan (`orchestrator.md` §1), run as a **fresh headless conversation**: never
  `--resume` of any implementing step's session, a new `--session-id`, and `k step start` refuses a review step
  whose `needs:` step shares a session id. Judgement: a fresh conversation is the only separation the tool can
  prove; the same model with a different prompt is still separate in what it has read, which is the point.
- Its inputs are exactly: `task` (the frozen file), `diff` (`steps/S-review/diff.patch`, from the task's base
  commit recorded at `k approve` to HEAD, leaving out the task's own folder `kirunak/tasks/<slug>`, whose task.md
  and evidence reach the reviewer through `in/`), and `evidence/` (the files the steps produced: test reports,
  measurement tables, screenshots, logs). Not `progress.md`, not `notes.md`, not any step's `report.md`, not the
  plan (R13: "not the implementer's account"). `k step brief` for a `review` step copies the three into
  `steps/S-review/in/` and the brief names only that folder, and the runner adds `--add-dir` for nothing else.
  The repo itself is readable (the diff must be read against the code), which is why "the implementer's account"
  is defined as those files and the step reports, and the brief says so.
- The reviewer's brief: the task's AC, E and O lines verbatim; "write `review.md` in the grammar below; a row per
  AC and E; `met` only with evidence you verified yourself: a test you can name and whose assertion you read, a
  file and line, a measurement in `evidence/`, a screenshot in `evidence/`; when you cannot verify (a device, the
  owner's eye or ear), say `needs device` or `needs owner`, never guess met". Model and effort from the plan line,
  else the workspace's `models.review`, else Claude Code's default (judgement: how much a review is worth is the
  workspace's call; a plan may name a stronger model for a review where a mistake is costly).

## 2. The record, `review.md` (R14)

```markdown
---
task: weather/offline-forecast
reviewed: 2026-11-07
head: 9ab1c2d
base: 7c1d2e3
session: 3e4f…
---

| id | verdict | evidence |
| --- | --- | --- |
| AC-1 | met | test OfflineForecastTest.opens on the last forecast (test/offline-forecast.test.ts:41) |
| AC-2 | not met | file src/forecast/cache.ts:88: the cache keeps two days, the task says three |
| E-1 | met | measure evidence/S-1-cache-sizes.tsv row 12 |
| E-2 | needs device | losing the network mid-download is not testable on the desktop |
| E-3 | needs owner | the wording of the age line reads naturally (notes in evidence/S-4-wording.md) |

## Findings
- AC-2: ...

verdict: not met (AC-2)
```

- Grammar `k review check` enforces: one row per AC and E of the frozen task (none missing, none extra); verdict ∈
  `met | not met | needs device | needs owner`; a `met` row's evidence starts with `test <Name>`, `file
  <path>:<line>`, `measure <path>`, or `screenshot <path>`, and the path exists at `head` (a test name must appear
  in the file named in parentheses; a `file` line must be within the file's length; `k step finish` commits the
  evidence a step writes, `task-files.md` §1, so a path under `evidence/` is there). A `not met` row names what is
  wrong. The last line is `verdict: met` only when every row is `met`; else `verdict: not met (<ids>)` or
  `verdict: needs owner (<ids>)` when nothing is `not met`.
- The review is a file the reviewer writes (an agent step), so the freeze hook allows it; `k review check` runs as
  the step's output check (`outputs: review.md`), and a review that fails the grammar fails the step.
- A second review after fixes is a new step (`S-review-2`), a new file `review-2.md`; `k list` reads the latest.
- A review counts only while it passes the grammar and the review step whose output it is has `finished` in
  `progress.md`: a review file whose step failed, escalated or never ran, or one no review step names, is not a
  review. Until then `k list` shows the task `in review`; it checks the grammar without git (it runs no git
  command, `boards.md` §1), so a cited path missing at head shows at `k review check`, `k checklist` and `k accept`.

## 3. The owner's checklist (R15)

`k checklist <id>` generates `checklist.md` from the latest review's `needs device` and `needs owner` rows, once
that review counts (§2); it refuses one that does not and names each problem, so a row the owner should check whose
verdict is misspelt never leaves an empty checklist:

```markdown
- [ ] E-2 On a phone: turn the network off mid-download; the forecast shows the hours it has (review-2.md)
- [ ] E-3 Read: the age line reads naturally (evidence/S-4-wording.md)
```

The owner ticks items; the freeze hook refuses an agent's tick (`approval.md` §2). `k accept` refuses while an item
is unticked unless the owner passes `--checklist-open "<why>"`, which `done.json` records.

## 4. Done only through `k-done` (R15, D12)

kirunak ships the closing skill, `skills/k-done/SKILL.md`, linked into `~/.claude/skills/` by `k install`. Its
description says when it runs: only when the owner says the task is done, by typing `/k-done` or in their own words;
never on the model's judgement, never because tests are green or a build succeeded (a build can still have bugs the
owner finds on a device). Its steps:

1. **Say what is done, in a few lines**: the task, the commits (short hash and subject), the builds made. List
   anything uncommitted, unpushed or unverified and ask whether it belongs to the task; commit only if the owner
   says so.
2. **Record the acceptance**: ask the owner to type `! k accept <id>` (or `/k-accept <id>` with the mod); the task
   is done only when `done.json` exists. If `k accept` refuses (an unticked checklist item, no review verdict), say
   what it named and stop. The skill never runs `k accept` itself: the hook refuses it from the Bash tool.
3. **Write the handoff and release**: run `k handoff <id> --session <session_id> --json`. It merges every loaded
   `handoff` plugin (`plugins.md` §2): `targets` say where the handoff goes and what it must hold (the state now,
   what is open, the next step, the owner's decisions with their dates, where things are; nothing git already
   records), and `release` lets go of what the plugins can release by themselves, returning a line each. The model
   writes the handoff at each target, then stops what the session itself started and no plugin knows of (background
   commands, agents still running), or says why one keeps running.
4. **End with two lines**: where the handoff is, and "Type /clear to start the next task fresh." Evidence: Claude
   Code cannot clear its own session (no tool or hook runs `/clear`), so the session prepares everything and the
   owner types it. If the owner would rather go on in this session, that is their call.

The core's default `handoff` (`handoff-notes.mjs`) targets `kirunak/tasks/<slug>/handoff.md` and releases the
session's own kirunak state: its `sessions/<id>.json`, and with the default guard its claims and any queued job of
its own. Judgement on the split: the skill holds the steps every workspace shares; where a handoff is kept and what
a session can hold are a workspace's, so they are plugins. Judgement on names: `/k-done` stays the owner's word for
closing (D12, R15), and the record-writing command is `k accept`, because the skill needs the model (it writes the
handoff) and the record must not (D7). The owner may prefer one name for both; that is a question in `README.md`.

## 5. Requirements this file satisfies

R13 (§1), R14 (§2), R15 (§3, §4), D12 (§4).
