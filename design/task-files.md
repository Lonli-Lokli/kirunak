# The task files, their states and the queue

Design, from REQUIREMENTS.md (D4, D6, R4, R5, R6, R7, R16, R20). Each choice is marked **evidence** (with its source)
or **judgement**. Index: `README.md`. The examples use an invented repo, `weather`, and an invented task,
`weather/offline-forecast`.

## 1. Layout in a repo

A repo that runs on kirunak has one folder, `kirunak/`, at its root, beside any frozen `openspec/`:

```
kirunak/
  tasks/<slug>/task.md            the task: frozen on approval (R5)
  tasks/<slug>/intake.md          the interview log: every question, the owner's answer verbatim, dated (R4)
  tasks/<slug>/plan.md            steps mapped to AC and E; free to change (R8)
  tasks/<slug>/progress.md        a step log, appended by the k commands (R6)
  tasks/<slug>/notes.md           free notes, pointers to research (R6)
  tasks/<slug>/review.md          the reviewer's record (R13, R14)
  tasks/<slug>/checklist.md       the owner's checklist, generated from the review (R15)
  tasks/<slug>/handoff.md         the closing session's handoff, when the workspace keeps it here (review.md §4)
  tasks/<slug>/amendments/A-<n>.md a proposed change to the frozen task (R7)
  tasks/<slug>/steps/<step>/      a step's brief, inputs, outputs and token records (R9, R12)
  tasks/<slug>/evidence/          what steps produce for the reviewer: reports, measurements, screenshots (R14)
  tasks/<slug>/done.json          the owner's acceptance record (R15)
  approvals/<slug>.json           the approval record: the task's hash, the date, who, how (D7)
```

- `evidence/` is committed by `k step finish`: the files the step wrote there that are new or changed, and nothing
  else that is staged, in one commit `<id> <step>: the step's evidence` through the repo's own hooks; a commit git
  refuses fails the finish. So a review's `measure` or `screenshot` row cites a path that stands at `head`
  (`review.md` §2). Judgement: the other task files are the session's to commit with its work.
- Judgement: one folder per task, every file named for one reader, so a `git log kirunak/tasks/x/task.md` is the
  task's whole history and `progress.md` can churn without touching it (R6).
- Judgement: `approvals/` sits beside `tasks/`, not inside the task folder, so one hook rule covers every record
  ("nothing under `kirunak/approvals/` is written by an agent") and a `git log kirunak/approvals/` lists every
  approval in the repo.
- Judgement, from REQUIREMENTS.md (Why): a layout that keeps proposal, tasks and design in one folder, with the task
  list as checkboxes, lets agents rewrite the task as they work. The split above is what stops that: the frozen file
  holds only what approval covers.
- A task's id is `<repo>/<slug>`: `weather/offline-forecast`. The repo part is the repo's name as the workspace config
  lists it (`plugins.md` §3); the slug is lower-case letters, digits and hyphens, at most 40 characters. Judgement:
  ids must be unique across the one queue (D4), and `<repo>/<slug>` is unique and readable in a queue line, a commit
  message and a board.

## 2. The task file, `task.md`

```markdown
---
id: weather/offline-forecast
title: The last forecast stays readable offline
created: 2026-11-02
from: openspec/changes/add-offline-mode
---

## Goal
One paragraph. [owner 2026-11-02 Q-1]

## Acceptance criteria
- AC-1 With no network, the app opens on the last forecast it fetched, with the time it was fetched. [research docs/offline.md §2]
- AC-2 ... [owner 2026-11-02 Q-4]

## Edge cases
- E-1 A forecast older than a day shows its age in words, not only a time. [owner 2026-11-02 Q-6]

## Out of scope
- O-1 Weather alerts while offline. [owner 2026-11-02 Q-9] [from openspec/changes/add-offline-mode/tasks.md 3.2]

## Decisions
- D-1 Keep the last three days of forecasts, no more. [owner 2026-11-02 Q-7]

## Aspects
- platforms: in (AC-3) [owner 2026-11-02 Q-10]
- large-text: n/a, no screen changes [owner 2026-11-02 Q-10]
- offline: in (AC-1, E-1) [default 2026-11-02]

## Open questions
```

Rules, each checked by `k check <id>` (the tests are in `build-order.md` §slice 1):

1. **Every line names its source** (R4). A line is a list item or a paragraph. It ends with one or more tags:
   `[owner YYYY-MM-DD Q-n]` (the owner's answer, dated, `Q-n` pointing at the entry in `intake.md`),
   `[research <path or URL>[ §x]]` (a file in the repo or in another workspace repo, or a link), or
   `[default YYYY-MM-DD]` (a default the intake proposed and the owner accepted that day; the proposal and the
   acceptance are an entry in `intake.md` too). `[from <path>]` may follow as background (an openspec change, R20),
   never alone: a line that comes from openspec is still the owner's to confirm (D6).
2. **Numbered items**: `AC-n`, `E-n`, `O-n`, `D-n`, `Q-n`, each numbered from 1 with no gap, so a plan, a review and
   an amendment can point at one line. Numbers are never reused: an amendment that removes `E-3` leaves the number
   out, and a new edge case takes the next free number.
3. **Sections** in this order: Goal, Acceptance criteria (at least one), Edge cases, Out of scope, Decisions,
   Aspects, Open questions. Front matter: `id`, `title`, `created`; `from` when the task started from an openspec
   change or another file.
4. **Aspects** (R2, R3): one line per aspect of the checklist plugin, ruled `in (<the AC, E or D lines it became>)`,
   `out (<the O line>)` or `n/a: <why>`, with a source. `k check` refuses a task whose Aspects section misses an
   aspect the loaded checklist has, names one it does not have, or rules `in` without naming a line that exists.
5. **Ready** means: `k check` passes and Open questions is empty. A `Q-n` line anywhere fails `check` (R4).
6. Short sentences (judgement: the task is read by people and by the review). A workspace's own text rules are its
   own; the core checks none of them.

Judgement on the shape: Markdown with a tiny front matter rather than JSON or YAML, because the owner reads and
approves it as text (R16), `git diff` shows an amendment line by line, and the grammar above is small enough for a
parser of about a hundred lines with no dependency.

## 3. The other files

- `intake.md`: appended by the intake, never rewritten. One entry per question: `### Q-n <aspect or topic>`, the
  question, the owner's answer verbatim, the date, and the ruling it produced (`→ AC-2`, `→ O-1`, `→ default
  accepted`). The `[owner ... Q-n]` tags point here. An entry is never edited; a changed mind is a new entry.
- `plan.md`: `orchestrator.md` §1.
- `progress.md`: one line per event, appended by `k step start|finish|fail`, `k heavy`, `k review`: `2026-11-03
  14:02 S-2 started (opus, session 7c1…)`. A review step's `finished` line carries its file's hash, `2026-11-07
  10:40 S-4 finished (review.md sha256:…)` (`review.md` §2). Readable, and the board's source for "where is it".
- `notes.md`: free text for whoever works on the task; pointers to research, dead ends. Never read by the reviewer.
- `review.md`, `checklist.md`: `review.md` in this folder.
- `handoff.md`: written at closing when the workspace's `handoff` seam points there (the core's default does,
  `plugins.md` §2).
- `amendments/A-n.md`: §5 below.
- `done.json`: `{ "task": id, "accepted": ISO date, "by": "owner", "via": "shell"|"mod", "commit": sha }`,
  written only by `k accept` (the owner's command, `approval.md` §4).

## 4. States and who moves a task

The state is **derived from the records**; there is no state field to go stale. Judgement: checkboxes in a task list
are a state field agents rewrite; a state read from files that only named commands write cannot drift from them.
`k list` computes it; the tests in `build-order.md` cover every row.

| State | Derived from | Entered by |
| --- | --- | --- |
| draft | `task.md` exists, no approval record, `k check` fails or Open questions not empty | the intake (`k intake start`) |
| proposed | no approval record, `k check` passes, Open questions empty | the intake, when the last question closes |
| ready | approval record with a matching hash; no step started in `progress.md` | the owner: `k approve` |
| blocked | ready or in progress, and `plan.md` names `blocked-by:` a task not done, or a step waits on an input no step produces | the plan |
| in progress | a step started in `progress.md`; no `review.md` verdict | `k step start` (the orchestrator or a session) |
| in review | the latest review exists, and fails the grammar (`review.md` §2, what reads git aside) or no finished review step of `plan.md` wrote it as it stands (the hash on the step's `finished` line) | `k review start` |
| reviewed | the latest review passes the grammar and its review step finished in `progress.md` with the file's hash; no `done.json` | the review step |
| awaiting owner | `checklist.md` has an unticked item, or reviewed | `k checklist` |
| done | `done.json` exists | the owner: `k accept` (through `/k-done`) |
| on hold | `hold.md` exists (why, date) and no `done.json` | the owner: `k hold` / `k resume` |
| stale | approval record whose hash does not match `task.md` | never on purpose: the git hook refuses it; `k list` shows it red |

Only the owner's commands move a task to ready, done or on hold (D7). The intake moves draft to proposed by closing
questions. Steps and reviews move the middle states by appending records.

## 5. Amendments (R7)

An amendment is a file anyone may write, `amendments/A-n.md`:

```markdown
---
task: weather/offline-forecast
proposed: 2026-11-04
by: session 7c1 (step S-3)
---

## Why
The forecast provider now returns hourly data (commit 9ab1c2d). [research docs/provider-api.md §hourly]

## Changes
- replace D-1: Keep the last three days of forecasts, hourly for the first day. [research docs/offline.md §3]
- add E-7: An hourly forecast cut off mid-download shows the hours it has and says the rest are missing. [owner 2026-11-04 Q-14]
- remove O-2
```

- `Changes` holds operations only: `replace <id>: <new line>`, `add <section id>: <new line>`, `remove <id>`.
  Each new line carries its own source tag (rule 1 above). Judgement: operations, not a rewritten task, so the owner
  reads exactly what changes and the command applies it without a merge.
- `k amend check A-n` verifies the operations against the current `task.md` (ids exist, numbers free, sources
  present). `k approve <id> --amendment A-n` (owner only, `approval.md`) applies them, re-hashes, appends the old
  hash and the amendment id to the approval record's `history`, stamps the amendment file `applied: <date>` and
  commits the three files. An amendment the owner declines is stamped `declined: <date> <why>` by `k amend decline`
  (owner only). Both stamps are the only writes to an amendment file after it is proposed.

## 6. The one queue (D4)

- The queue is one file whose path the workspace config names (`queue`, `plugins.md` §3), committed in the repo that
  holds it. One task id per line, in order; `#` lines are comments. Judgement for the place: D2 keeps it out of
  kirunak's repo (the queue is a workspace's, not the tool's), and D4 keeps it out of any one task repo (one queue
  across repos); the natural home is the repo that holds the workspace's config.
- `k queue add <id> [--before <id>|--after <id>|--first|--last]`, `k queue move`, `k queue remove`: each edits the
  file and commits it in the queue's repo with the message `kirunak: queue <verb> <id>`. `k approve` adds the task
  last unless told otherwise; `k accept` removes it.
- The queue orders; it never holds state. `k list` joins the queue with each task's derived state and prints ready
  and blocked tasks in queue order, then the others.
- A task not in the queue is visible (`k list --all`) and runs nowhere: `k run` and `k step start` refuse a task
  that is not queued (judgement: the queue is the owner's statement of order, R1 says nothing enters it but through
  the intake and approval).

## 7. Requirements this file satisfies

R4 (§2 rule 1, §3 `intake.md`), R5 (§2), R6 (§1, §3), R7 (§5), R16 (§1, §2, §4), R20 (`from:` and `[from ...]`),
D4 (§6), D6 (§2 rule 1).
