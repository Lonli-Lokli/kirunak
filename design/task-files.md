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
  tasks/<slug>/repos.md           written by hand: another repo or range of the task's work (review.md §1, R32)
  tasks/<slug>/steps/<step>/      a step's brief, inputs, outputs and token records (R9, R12); its .gitignore
                                  keeps kirunak's own files out of git (in/, diff.patch, the run records)
  tasks/<slug>/evidence/          what steps produce for the reviewer: reports, measurements, screenshots (R14)
  tasks/<slug>/done.json          the owner's acceptance record (R15)
  tasks/<slug>/cost.md            the task's cost at acceptance, generated from done.json (R12, orchestrator.md §6)
  approvals/<slug>.json           the approval record: the task's hash, the date, who, how (D7)
  drafts/<slug>.md                a draft: an intake prepared ahead, for a task that does not exist yet (R24), or
                                  a bug of a task already accepted (R29)
```

`tasks/<slug>/draft.md` is the draft once an intake has started from it (R26).

- A **draft** sits in `kirunak/drafts/`, beside `tasks/`, in the repo its task is for. Its id is `<repo>/<slug>`
  from the start and the task keeps it (R24). It has front matter (`id`, `title`, `written`) and four sections once
  each, in order: `## Who raised it`, `## Why`, `## What was found` (each item ends with its source) and
  `## Questions` (numbered from 1, so they never clash with the intake's Q-n). `k draft check` holds that shape
  (R26). A draft is not a task: it has no state, no approval record and no queue place, nothing in it is a ruling,
  and the freeze hooks leave it alone (R25, R27). Judgement: any session writes one unasked, so it must freeze
  nothing and cost the owner nothing until the owner starts it.
- A **bug** (R29) is a draft whose front matter adds `bug-of: <task id>`, the accepted task it was found in: a task
  whose folder holds `done.json`, in any repo of the workspace. The bug sits in the repo its fix belongs to, which
  may be another than the task's. `k draft new <id> --title "..." --bug-of <task>` writes `templates/bug.md`, the
  draft's skeleton with `bug-of` after `written` and a section `## Fix written` between What was found and
  Questions. It refuses, a dry run too, a task that does not exist or is not accepted (a bug found while a task is
  open goes into that task, through its review or an amendment), and only reads the task, so its folder stays byte
  for byte as it was. Fix written holds a fix that exists already, a `- ` line each ending with
  `[commit <sha>]` or `[file <patch path>]`, or is deleted when none does: `k draft check` refuses its placeholder,
  an empty section, and the section in a draft with no `bug-of`. Beyond the shape, `k draft check` refuses a bug
  whose task is gone or not accepted, and a Fix written commit that `git cat-file -e` finds in neither the bug's
  repo nor the task's; a `[file ...]` is checked for its shape only. No draft has a `state` field, and the check
  refuses one: a bug is parked while it waits here, taken once an intake moves it, and closed by `k draft drop`.
  `k drafts` names its task, and its `--json` row carries `bugOf` (null for a plain draft). Evidence: the owner's
  ruling (R29): no new kind of file, so a bug waits, shows and goes as any draft does.
- **The drafts' order** (owner, 2026-10-27: the drafts that need a longer intake wait at the end) is one file,
  `drafts-order.md`, beside the queue in the repo that holds it (`ws.draftOrder`), one draft id a line, first first,
  `#` lines comments, a record like the queue (`approval.md` §3). `k drafts`, the board, `k waiting` and `/k-drafts`
  list the drafts it names first, as it names them, then the others by the date written, then by id, an undated one
  last; an id that is no longer a draft is passed over. `k drafts move <id>... [--first|--last|--before
  <id>|--after <id>]` (no flag: last) puts the drafts named, in the order named, in that place, writes the file whole
  (every draft in its place, no id that is gone) and commits it alone, `kirunak: drafts move <id>` (or `<n> drafts`,
  the ids in the body); it refuses no draft, an unknown one, one named twice, an unknown target or one being moved,
  commits nothing when the order is already so, and puts the file back when the commit is refused. Judgement: any
  session runs it, since a draft is not the owner's (R25); a new draft waits after the drafts the file names until a
  move places it.
- `k intake start <id> --from kirunak/drafts/<slug>.md` moves the draft with `git mv` to `tasks/<slug>/draft.md`, so
  it is never in two places and git follows its history (`intake.md` §1); a bug moves only while its task is still
  accepted, and its `notes.md` holds that task's lines. `k draft drop <id> --why "..."` removes it in a commit of
  that file alone, with the reason in the message (R27).

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
- `repos.md` (gulnya/kirunak-review-base AC-9, E-6): written by hand when the task's work is in a repo kirunak does
  not find by itself, or in a range it does not reach (`review.md` §1); read when a review is briefed, when it starts,
  and by `k accept` once a review has `given.json` (`approval.md` §4). Each line starting `- ` is `- <repo>
  <branch>` or `- <repo> <from>..<to>`, such as `- ~/sources/forecast-api offline-cache`; any other line is prose.
  The repo is a workspace repo's name or a path (`/…` or `~/…`) to a git repository's top, and a path that is a
  workspace repo's root is that repo. A branch adds its commits since it left the repo's default branch, as a branch
  named after the task does; a range adds the commits `git log <from>..<to>` lists. A line naming the task's own repo
  adds its commits' files to the review's `diff.patch`. A line naming a repo that is neither, a branch or range git
  cannot read, a branch whose start kirunak cannot tell (the default branch itself, one merged with no reflog, or one
  in a repo with no default branch of its own: such a line takes a range instead), or a line that is not those two
  words stops the review's brief and its start, and `k accept` too, and kirunak names each such line by its number
  and its text, saying which of them it stops.
- `done.json`: `{ "task": id, "accepted": ISO date, "by": "owner", "via": "shell"|"mod", "commit": sha, "review":
  "review-2.md", "verdict": "needs owner (E-3)", "head": sha, "reviewHash": "sha256:…" }`, written only by `k accept`
  (the owner's command, `approval.md` §4). `review`, `verdict` and `head` are the review it took as that file states
  them, `reviewHash` its bytes' hash (the one its step finished with, `review.md` §2). With `--checklist-open "<why>"`
  it adds `"checklistOpen": "<why>"` and `"openItems": [text]`, the items left open: those unticked in
  `checklist.md` and the review's rows with no item there, each as `k checklist` words it. `k accept` adds `"cost"`,
  the task's numbers (`orchestrator.md` §6).
- `cost.md`: generated, never written by hand: the rendering of `done.json`'s `cost` as a table per step and in
  total, with the baseline's comparisons, committed with `done.json` by `k accept` and written again by `k cost <id>
  --write`; the git hook refuses any other text (`approval.md` §3). The run records the numbers are read from stay
  on disk and out of git: the step folder's `.gitignore` names `in/`, `diff.patch`, `run-<k>.json`, `keep-<k>.json`
  and a heavy job's `heavy-<k>.json` and log; the brief and the step's outputs are the session's to commit, and so
  is a review step's `given.json`, what kirunak gave the review (`review.md` §1).

## 4. States and who moves a task

The state is **derived from the records**; there is no state field to go stale. Judgement: checkboxes in a task list
are a state field agents rewrite; a state read from files that only named commands write cannot drift from them.
`k list` computes it; the tests in `build-order.md` cover every row.

| State | Derived from | Entered by |
| --- | --- | --- |
| draft | `task.md` exists, no approval record, `k check` fails or Open questions not empty | the intake (`k intake start`) |
| proposed | no approval record, `k check` passes, Open questions empty | the intake, when the last question closes |
| queued | approval record with a matching hash; no step started in `progress.md`; the task is in the queue | the owner: `k approve` (which queues it), or `k queue add` |
| parked | the same, and the task is not in the queue | the owner: `k approve --no-queue`, or `k queue remove` |
| blocked | queued, parked or in progress, and `plan.md` names `blocked-by:` a task not done, or a step waits on an input no step produces, or the plan has steps and none of kind `review` | the plan |
| in progress | a step started in `progress.md`; no `review.md` verdict | `k step start` (the orchestrator or a session) |
| in review | the latest review exists, and fails the grammar (`review.md` §2, what reads git aside) or no finished review step of `plan.md` wrote it as it stands (the hash on the step's `finished` line) | `k review start` |
| reviewed | the latest review passes the grammar and its review step finished in `progress.md` with the file's hash; no `done.json` | the review step |
| awaiting owner | `checklist.md` has an unticked item, or reviewed | `k checklist` |
| done | `done.json` exists | the owner: `k accept` (through `/k-done`) |
| on hold | `hold.md` exists (why, date) and no `done.json` | the owner: `k hold` / `k resume` |
| stale | approval record whose hash does not match `task.md` | never on purpose: the git hook refuses it; `k list` shows it red |

Only the owner's commands move a task to queued or parked, done or on hold (D7). The intake moves draft to proposed by
closing questions. Steps and reviews move the middle states by appending records.

Twelve states, with queued and parked told apart since 2026-10-21 (kirunak-phone AC-15, the owner's answer of that day,
Q-29 and Q-30, in place of one state "ready"). **Queued** means the owner has approved the task and put it in the one
queue (§6): it waits its turn. **Parked** means approved and out of the queue: it waits for nothing, and nothing starts
it until the owner puts it back. The word "ready" now names only a step's own state (`orchestrator.md` §1, every input
met), never a task's. The queue is read when the state is derived, so a task that is queued and put on hold reads "on
hold" and keeps its place in the queue (tested), and a blocked task reads "blocked" whichever it is. Every surface
shows the two words: `k list`, `k waiting` ("can approve" and "can accept" in place of "ready"), the board's page and
its markdown, and the mod's pane and lists. Evidence:
`lib/state.mjs` (`STATES`, `stateOf`), `test/state.test.mjs`, and `test/list.test.mjs`, which takes one task through
`--no-queue`, `queue add`, `hold`, `resume` and `queue remove` and reads it in `k list`, `k waiting` and the board
each time.

## 5. Amendments (R7)

An amendment is a file anyone may write, `amendments/A-n.md`:

```markdown
---
task: weather/offline-forecast
proposed: 2026-11-04
title: Hourly data for the first day
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
- `title:` is the few words the amendment goes by in every list (kirunak-phone A-8): `k amend new <id> --title
  "<title>"` writes it between `proposed:` and `by:` and refuses without it, and `k amend check` refuses an amendment
  neither applied nor declined that has none, so it cannot be approved until it gets one; a stamped amendment is
  history and never refused for it. `k waiting` names an untitled one by the lines it changes ("replaces AC-2, AC-3;
  adds AC-17").
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
- The queue orders; it never holds state of its own, but whether a task is in it is part of what its state is read
  from (§4: queued or parked). `k list` joins the queue with each task's derived state and prints the tasks in the
  queue in queue order, then the others.
- A task not in the queue is visible (`k list --all`) and runs nowhere: `k run` and `k step start` refuse a task
  that is not queued (judgement: the queue is the owner's statement of order, R1 says nothing enters it but through
  the intake and approval). The refusal is "<id> is parked, not in the queue: k queue add <id> puts it back", and a
  task parked while `k run --watch` is going starts no further step (kirunak-phone AC-16, built 2026-10-21; `k run`
  reads the queue again before each step).
- The three owner verbs that change the queue, `k queue add`, `k queue move` and `k queue remove`, are the ones the
  mod's `/k-queue` runs from the phone (`boards.md` §4). `add` takes `--first`, `--last`, `--before <id>` or `--after
  <id>` (no flag: last) and refuses an unknown task, one already queued, or a target that is not queued; `move` takes
  the same flags and refuses a task or target that is not queued, or a task moved before itself; **`remove` parks the
  task** and refuses one that is not queued. A held task is not parked: `k hold` leaves its place. Each verb makes one
  commit, `kirunak: queue <verb> <id>`; they take no `--via` (it is parsed and ignored: nothing records who moved a
  task), and `--dry-run` checks nothing for them.

## 7. Requirements this file satisfies

R24 to R27 (§1: drafts), R29 (§1: a bug), R4 (§2 rule 1, §3 `intake.md`), R5 (§2), R6 (§1, §3), R7 (§5), R16 (§1, §2, §4), R20 (`from:` and `[from ...]`),
R32 (§3 `repos.md`), D4 (§6), D6 (§2 rule 1).
