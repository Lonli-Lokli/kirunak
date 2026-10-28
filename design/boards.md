# The boards: the list, the local page, the phone board, the mod

Design (D5, D10, D13, D14, R16). Each choice is marked **evidence** (with its source) or **judgement**. Index:
`README.md`. All four are front ends over the task files (`frontend` seam, `plugins.md` §2); none holds state of its
own, and none approves anything by itself: the only taps that act are the owner's, in the mod's dialog (§4,
`approval.md` §5). Revised 2026-10-21 for kirunak-phone (amendment A-9): §3 and §4 say what was built, in place of
the sync step this file first designed.

## 1. The list: `k list`

One line per task across every workspace repo, queue order first (invented rows):

```
 1  queued       weather/offline-forecast   The last forecast stays readable offline   next S-1 (sonnet)
 2  in progress  weather/hourly-chart       An hourly chart for today                  S-4 running 12 min, lock: weather unit tests
    parked       hub/sync-notes             Sync notes between devices                 approved, out of the queue
    awaiting     hub/release-notes          Release notes in every language            Q-3 open
    done         weather/settings-backup    ...                                        2026-11-01
```

The states are the twelve of `task-files.md` §4. An approved task with no step started reads **queued** while it is in
the queue and **parked** while it is not (approved with `k approve --no-queue`, or taken out with `k queue remove`); a
step's own "ready" means its inputs are met and is a different thing (kirunak-phone AC-15, the owner's answers of
2026-10-21, Q-29 and Q-30). Every surface says queued and parked: this list, `k waiting`, the page, the markdown board
and the mod. Queued tasks come first, in queue order, then the rest by id.

`--json` gives the same rows with every field (`id`, `title`, `state`, `queue`, `step`, `lock`, `approved`,
`review`, `checklist`), which the page, the artifact step and the mod read. `--repo <name>`, `--all` (done and on
hold too). Number to check: under 1 s across the workspace's repos (it reads a few files per task and runs no git
command except `git show` for a staged hash when asked).

## 2. The page: `k board` and `k board --html` (D10)

- `k board` writes `$KIRUNAK_HOME/board.html` from `k list --json` and `k status --json` (the lock, the device
  claims, the running steps, the keeper's last lines) and opens it (`open` on macOS, `xdg-open` elsewhere). No
  server: a static page, inline CSS. `k board --html <file>` writes the same page where it is told, with `--no-open`
  when nothing should open it; this is what the skill of §3 publishes.
- **One order for every surface** (`lib/board-model.mjs`, built 2026-10-21, kirunak-phone S-8; the page,
  `lib/board.mjs`, and the markdown, `lib/board-md.mjs`, only lay it out): first "Working on now", the tasks that a
  session record (`$KIRUNAK_HOME/sessions`) or a running step names; then every other task under its state, in the
  order of `lib/state.mjs` and only for the states that have a task (done only for the week after acceptance); then
  "Lock, queue and running steps": the lock, the heavy-job queue, the running steps, the device claims, the task
  queue. Judgement: what the owner is doing comes before everything, and a section that is empty takes no room on a
  small screen.
- **Drafts** (R28, built 2026-10-22, kirunak-drafts S-4): a group "Drafts" follows the last task group and comes
  before "Lock, queue and running steps", shown only when a draft waits. In the markdown board it is `## Drafts (n)`
  with a bullet a draft (`id: title, written <date>`); in the brief board a paragraph with a line a draft, and a last
  entry of `groups` in `--json`; on the page an h2 and a plain list on the card ground, no control, only the text
  pairs already held at 4.5:1 in both themes (a test holds them, and that the heading comes after the tasks and
  before the lock, in reading order). `k board --card <draft id>` answers a draft's card (title, date written, file).
  `k list` keeps listing tasks only (R28).
- **Bugs** (R29, gulnya/kirunak-bugs S-3): a group "Bugs" comes after the last task group and before Drafts, shown
  only when a bug waits, in `k bugs`' order (a fix ready first, then the oldest). Its first line is `k waiting`'s,
  exactly "N bugs wait, M with a fix ready: /k-bugs" ("1 bug waits, ..." for one), then one line a bug, `<id>:
  <title>, <its fix>, bug of <task>, written <date>` (`bugTail` in `lib/board-model.mjs`, the task left out when it
  names none; its fix one of reviewing, fix ready, fix not ready: review-n.md found <verdict>, fix not ready, no
  fix). In the markdown board it is `## Bugs (n)`, the line, then a bullet a bug, the tail always kept when a long
  title is cut; in the brief board and its `--json` a group Bugs before Drafts, its ids after the tasks' and before
  the drafts'; on the page an h2 "Bugs", the line and a plain list, its text pairs (`BUG_PAIRS`) held at 4.5:1 or
  more in both themes by the contrast test, and in reading order after the tasks and before Drafts. `k board --card
  <bug id>` answers its card: its fix, its task and date, its file, and "/k-bugs shows it whole, with [Review &
  merge, ]Start fix and Drop.", Review & merge named only when its fix is ready; in the mod's `/k-board` the group
  asks "Which bug?" and a bug tapped answers with that card. A draft's line is a plain draft's:
  bugs are no longer among the drafts (until 2026-10-27, kirunak-spikes, a bug was a draft with `bug-of`).
- **The same line elsewhere** (AC-7, E-7): `k waiting` prints it first of all, above a step stopped for the owner
  and before the drafts' line, and `--json` has a first key `bugs: { count, ready, ids }`; a new session the owner
  starts (SessionStart on `startup` or `clear`, `hooks/kirunak-bugs.mjs`, which `k install` adds and `k doctor`
  checks) gets it as `systemMessage` and `additionalContext`. None of them says anything when no bug waits, and a
  step's session (`KIRUNAK_STEP` set, or a headless session's file) and a Review & merge's session
  (`KIRUNAK_BUG_REVIEW` set) are told nothing.
- **Quad Damage's line** (R34, gulnya/quad-damage AC-12): while a run lives (its run file's pid alive, `quadDamageRun`
  in `lib/bugs.mjs`), `k waiting` prints `statusLine` of `lib/quad-damage.mjs` above the bugs' line, "Quad Damage
  runs: <bug>, <phase> since HH:MM" ("fixing (try n)" while fixing), "Quad Damage runs, between bugs, since HH:MM" or
  "Quad Damage waits for the 5-hour window until HH:MM" ("merging" once a review is clean and its merge runs, AC-17),
  and `--json` a first key `quadDamage: { run, line }`, null
  when none lives. The board's model carries it as `quadDamageLine` ('' when none), and the Bugs group shows when a
  bug waits or a run lives, the line above the bugs' one in the markdown board, the brief board and the page. The bug
  the run is on reads `Quad Damage: <phase>` as its fix (`fixLine`), before reviewing. A fixing session
  (`KIRUNAK_BUG_FIX` set) is told nothing at its start, as a Review & merge's is not.
- A task is a **brief row that opens its card in place** (kirunak-phone A-7, built 2026-10-21): a native `<details>`,
  closed at first, whose summary is the brief board's entry (§3) and whose body is the card: the title, the state,
  the queue place, the step and since when, who works on it, and every AC and E in full with its latest verdict in
  words (met, not met, needs device, needs owner, none). The tasks come in the brief board's order. No role is added
  to what details and summary are; the disclosure mark is the browser's own. The page has one h1, a "Made at <time>"
  line and an h2 per section.
- **One column at 390 px**, columns by state only when the screen is wider (evidence: headless Chrome, scrollWidth
  390 of 390 with a 40-character id and an 80-character path in the data, S-8; with the rows, 390 of 390 closed and
  with every row open, a 40-character id in a summary, 2026-10-21). A page written with `--html` has no
  `file://` links to `task.md`, `plan.md`, `review.md` or `checklist.md`: they open nothing on a phone (judgement).
  The plain `k board` keeps them.
- **Both themes** (judgement: WCAG AA in both, 4.5:1 for text, because the board is read on any screen at any hour).
  The page follows `data-theme` when the host sets it (claude.ai does), and `prefers-color-scheme` otherwise. A
  contrast test holds 17 text and ground pairs at 4.5:1 or more in both themes; the newest, "Working on now", measures
  5.57:1 to 14.60:1 in the light theme and 6.95:1 to 13.03:1 in the dark (S-8).
- A footer: the lock holder and queue, device claims, running steps against `maxAgents`, the keeper's last
  keep-alive and miss. "Made at <time>" tells how old the copy is; `k board` makes a new one.
- No control on the page: approval and acceptance are the owner's own gesture (D7). The test asserts the page contains
  no form, button or script.
- `k board --markdown` is the same board as headings and lists (`--json` gives `{ markdown }`), `k board --brief` the
  brief board and `k board --card <id>` one task's card; see §3.

## 3. The phone board: `/k-board` and `/k-board-page` (D13)

Two ways, one for speed and one for the page, both on the owner's command and nothing else (the owner's answers of
2026-10-20 and 2026-10-21, Q-8, Q-9, Q-15, Q-27: "Both"; amendment A-9).

- **`/k-board`**, the mod's command (§4), is **brief first** (amendment A-7: the owner, reading the board on the
  phone on 2026-10-21, found too many details and too much scroll, and asked for it brief with a way to look inside a
  task, Q-36, Q-37) and **in steps** (amendment A-9, Q-41). Its first dialog says when the board was made, each group
  with how many tasks it holds ("Working on now: 5") and the machine's line, the groups as its choices; a group picked
  shows its tasks, one entry each, with Back, and a task tapped answers with its card, `k board --card <id>`, as
  `/k-board <id>` typed does, while Skip or a dismissed dialog at any step answers with the brief board (all from `k
  board --brief --json`: `{ made, text, ids, groups, machine }`). No model turn, so it costs no tokens and takes about
  the time of `k`.
- **The brief board** is plain text with no markdown mark, since the dialog draws none: "Made at <time>.", then
  "Working on now (n)" and every other state as "<State> (n)" in the board's order, one line per task, `<id>: <state>,
  queue <n>, <last step>, <m> of <n> met` (the last step as "S-20 done", "S-15 running" or "S-4 failed", a done task's
  left out; then how many are not met, need you or need a device), and last one line: "No lock, no heavy jobs
  waiting, 0 of 2 steps running, no device claims." Number: 20 lines on the live workspace on 2026-10-21, against
  261 for the markdown board that `/k-board` printed before.
- **The card** is the board's markdown for one task: its id as a heading, its title, state, step, session and
  approval, then every AC and E on one line with its verdict, cut at 70 characters with "…". A task off the board
  (done more than a week ago) still has one; an id that names no task is refused with its name.
- **No hard line break** inside a paragraph or an entry, in `--brief`, `--card` and `--markdown` (the S-10 defect:
  lines broken at 70 characters broke again on a narrower phone, "No" alone on a line, a session id over four). The
  phone wraps text itself. `k board --markdown` stays the whole board, pane-sized as before (Q-28): the tasks worked
  on now with their cards, every other task one bullet, task text escaped, kirunak named once in the first heading,
  since the engine prefixes the answer with it (§4). Word-for-word fixture tests hold the three forms.
- **`/k-board-page`**, the skill (`skills/k-board-page/SKILL.md`, linked by `k install`, checked by `k doctor`): one
  model turn. It runs `k board --html <file> --no-open` (the session's scratchpad, else `$KIRUNAK_HOME`), reads the
  file, reads the link kept in `$KIRUNAK_HOME/board-artifact.json`, and publishes to that link with the Artifact tool
  (or, the first time, to a new private artifact: icon "board", no capabilities), writes the link back and answers
  "kirunak: board published at <time>: <url>". It runs only when the owner types the command, never to refresh the page
  unasked. The page is the same HTML as §2, a brief row per task that opens its card in place, and read-only by
  construction (D13: no form, no `db`, no capabilities).
- Cost (judgement, not yet measured on a long session): one model turn, about a fresh session's opening context, more
  in a long one. The owner accepted it in A-9; `/k-board` is the free way.
- Approvals never happen on a page (D13): it has no control, and the record is written only by the owner's own
  gesture (`approval.md` §5).

**Why a skill and not the mod** (evidence: `evidence/S-1-phone-probe.md` in the task `gulnya/kirunak-phone`, Claude
Code 2.1.304, a terminal session with Remote Control on, a probe mod run from the phone):

- A mod's Artifact publish goes through `$.tool.call`. The tool's own check asks on every publish (it uploads to
  claude.ai), and in auto mode that question goes to the classifier, which "gave no verdict for Artifact: the request
  that produced this action did not ask for one": a command's output is no request. It was denied in 73 to 89 ms. An
  allow rule for the tool in `~/.claude/settings.json` changed nothing. Passing the owner's typed command as the call's
  consent was refused by the classifier as a bypass of auto mode, so it was not tried.
- A file a mod sends with SendUserFile is reported "1 file delivered to user" (twice), but the owner saw nothing on
  the phone, neither inline nor as a file. A file under `$KIRUNAK_HOME` asks for the read first and is denied.
- After any `$.tool.call` other than the dialog, the engine answered the command with "registered ... but no
  command.run hook answered it", though the hook had returned its text: a command whose hook calls a tool loses its
  answer.
- So no route found puts a page on the phone from a mod without a model turn. A skill is a model turn the owner's
  command asked for, which the classifier has a request for.

There is no sync step and no trigger on `events.jsonl`: the first design (a `claude -p` step at most hourly) was
replaced by A-9, since nothing refreshes the page but the owner's command (Q-15).

## 4. The mod: the working view (D14)

A Claude Code plugin in the kirunak repo, `mods/kirunak/` (judgement: it is specific to Claude Code but to no
workspace, so it ships with kirunak, D2), installed by the owner from a folder marketplace whose entry's `source` is a
relative path, or named in `CLAUDE_CODE_PLUGIN_DIRS` (`approval.md` §5): both run the checkout's own folder. Never a
copied install (a git, npm or archive source), where K below is missing and every read and verb fails (review D-4). The shape is the one Claude Code's `plugin-authoring` skill describes
(2.1.302; built on 2.1.303): `.claude-plugin/plugin.json`, `hooks/hooks.json`, `hooks/register.tsx`,
`types/index.d.ts` for its `$.state`. Built 2026-10-19 (slice 6); the commands and dialogs for the phone added
2026-10-21 (kirunak-phone S-5, S-6, built on Claude Code 2.1.304).

What it shows and does, each from the skill's table of shapes:

| Ask | Shape | Source of the data |
| --- | --- | --- |
| the current task, its AC and E with review state, the queue, the lock | a pane: `$.ui.open({ id: 'kirunak', title })` drawn by a `ui.render` hook on `Pane` | `k status --json --session <id>` and `k list --json --all` through `$.process.run`, at the session's start, every 30 s on `$.clock`, and at once on a new line of `events.jsonl` |
| a line above the prompt | `ui.render` on `AbovePrompt`: `kirunak · task · step · lock holder · queue place`; nothing while the session has no task | the same |
| toasts: a heavy job ended, a review is ready, a cache kept warm, a step waits for the owner, an edit refused | `$.ui.toast(text)` for each new line of those kinds | `events.jsonl`, followed with `tail -n 0 -F` through `$.process.spawn` for the session's life; kinds `build-ended` (`k run`, as a heavy job's record is saved), `review-ready` (`k step finish` of a review step), `keep-alive`, `awaiting owner`, `refusal` (the freeze hook; a workspace's own hooks may append it too) |
| `/k-approve <id>`, `/k-accept <id>`, `/k-hold <id> <why>`, `/k-resume <id>`, `/k-start <id>` | `$.command.register` in `session.start`, answered by `command.run` hooks that run only on `e.origin.kind` `'composer'` or `'bridge'` (`approval.md` §5, the owner's answer of 2026-10-19) and call `$.process.run(['node', K, verb, id, ...flags, '--via', 'mod'])` (`k resume` without `--via`: it records no one), returning the state line as `{ text }` | the core verbs |
| `/k-accept <n>`, a number from the list last shown | the same hooks: `<n>` takes the n-th id of that verb's list last shown since the session started, which `/clear` and a resume forget (owner's ask, 2026-10-19: "see what I can accept instead of typing manually") | `k waiting --json`: the proposed tasks with `k approve --dry-run`'s problems, the reviewed and awaiting-owner ones with what `k accept` refuses (its `dryRun` makes every check and writes nothing) |
| `/k-list [all]`, `/k-board [<id>]`, `/k-amendments [<n>]`, `/k-approve-amendment <n>`, `/k-queue` | five more registered commands, each behind the same origin rule: `/k-list` the tasks as numbered entries (state, queue place, id, title, step; `all` adds done and on hold), `/k-board` the board's groups in a dialog, then a group's tasks, and a tapped task's card, `/k-board <id>` that card (§3), `/k-amendments` the amendments waiting, numbered, and with a number that one in full (its Why and Changes), `/k-approve-amendment <n>` runs `k approve <id> --amendment A-n` for the n-th the list last showed, `/k-queue` the queue in order then the parked tasks (below) | `k list --json --all`, `k board --brief --json` and `k board --card <id>`, `k waiting --json` (the `amendments` rows) |
| `/k-approve`, `/k-accept`, `/k-hold`, `/k-resume`, `/k-start` with no id | open the owner's dialog (below) in place of printing a list | `k waiting --json`; for `/k-resume`, the tasks on hold of `k list --json --all` |
| the ids in the typeahead | `prompt.autocomplete`: after `/k-accept `, `/k-approve `, `/k-hold `, `/k-resume ` or `/k-start `, the ids of the tasks in the states each takes, beneath the engine's own rows | the last read's rows, no spawn |
| `/k-drafts` | the drafts waiting, in the order they wait (`task-files.md` §1, the drafts' order; with no order, by the date written): a dialog with a choice a draft, its id the label and its title and date written its line (gulnya/mobile-dialogs AC-14, AC-23), three to a page with More; a draft picked is shown whole, with Start intake, Drop and Back. Start intake runs no `k` verb: it reads `k drafts --json` again, refuses a draft that is gone ("no longer a draft"), and otherwise sends a prompt, after the command has answered, that loads the `k-intake` skill and starts the intake from that draft (`k intake start <id> --from kirunak/drafts/<slug>.md`, which moves it to `kirunak/tasks/<slug>/draft.md`). Drop asks for the reason in the free-text row, shows it with "Drop <id>" to confirm, then runs `k draft drop <id> --why "<reason>"`; no reason, no run. The same owner-only rule as the commands above (R27, R28). Bugs are not among them: `/k-bugs` (R29) | `k drafts --json` |
| `/k-bugs` | every bug in every repo (R29, gulnya/kirunak-bugs S-5): a dialog with a choice a bug, a fix ready first, then the oldest, its id the label and its line the rest (title, its fix: fix ready, in review since <time>, fix not ready: review-n.md found <verdict>, fix not ready, no fix yet; bug of <task> and the date written), three to a page with More, Back last; with none, "No bugs: no repo holds one." A bug picked is shown whole, its head (title, bug of and date, where the fix is, the review file) above its file, with Review & merge (D-1) only when its fix is ready and no review runs, Start fix and Drop. While a bug marked `quad-damage: yes` waits and no run lives, the list's first row is Quad Damage (R34, gulnya/quad-damage AC-1, D-1): "fix and review the n marked bugs one at a time, unattended; nothing is pushed", and its tap runs `k bugs quad-damage --via mod`, the owner's verb; while a run lives, its line (`k bugs quad-damage --status`) heads the list instead, and the bug it is on reads "Quad Damage is on it (<phase>)", with no Review & merge, Start fix or Drop until the run moves on (E-4), and the list's first row is Stop Quad Damage (gulnya/quad-damage AC-17): one confirm with the run's line and what a stop does (the session it runs for the bug ended at once, a merge already under way let finish, then the bug waits and the bugs left are not reached; or its 5-hour wait ended; or, between bugs, no next bug taken), that nothing is pushed and the summary follows in the chat that started the run, then Stop Quad Damage, Cancel and Back; its tap runs `k bugs quad-damage --stop --via mod`, the owner's verb, and answers that the run stops and where its summary follows, with k's line under it, and no turn follows it. `k bugs quad-damage --stop` writes the stop request `$KIRUNAK_HOME/bugs/quad-damage.stop.json` naming the run's pid, sends the run SIGWINCH and waits up to two minutes for its run file to go ("Quad Damage stopped: the owner stopped it; its summary: <path>", or "still stopping"); with no run it says "Quad Damage is not running" and changes nothing. The run, hearing a request with its own pid, ends the fixing or review session (its process group killed; a killed review keeps no review file), cuts its 5-hour wait short, lets a merge that has begun finish (the bug merged), and stops as any stop does, "stopped: the owner stopped it". Review & merge runs `k bug review <id> --detach --via mod`, the owner's verb, and answers that a fresh session reviews the fix, that it merges into master only with no finding and is never pushed, and that `/k-bugs` or `k bugs` shows the result. Start fix runs no `k` verb: it reads `k bugs --json` again by id, refuses a bug gone or in review, and otherwise sends a prompt, after the command has answered, that loads the `k-intake` skill and starts the intake from the bug (`k intake start <id> --from kirunak/bugs/<slug>.md`). Drop asks for the reason in the free-text row, shows it with "Drop <id>" to confirm, saying the fix branch stays, then runs `k bug drop <id> --why "<reason>"`; no reason, no run. The same owner-only rule as the commands above | `k bugs --json` |
| `/kirunak` | a command that opens the pane, or closes it when open | |
| `/k-done` | stays the skill (it needs the model, `review.md` §4); the mod does not register the name | |

- The current task of a session is `sessions/<session_id>.json`, written by `k start <id>` (also a `k-start`
  registered command) and read through `k status --session`; `k-done` clears it (through the default `handoff`).
- `k start` is the one write a mod command makes that is not the owner's alone; it is allowed from the Bash tool
  too (a session may say which task it works on).
- **The turn after a verb** (gulnya/kirunak-bugs AC-11 to AC-14, `hooks/turns.ts`): once the command has answered,
  the mod submits a prompt of its own after Review & merge or `/k-start` k took, and after `/k-approve` (an amendment
  too), `/k-accept` or `/k-resume`, taken or refused, on this session's task (`k status --session`) or one whose
  intake it ran (its own `k intake` and `k amend` Bash calls, or `by: session <id>`, kept in the module's memory).
  The prompt says what the owner did, with kirunak's reason on a refusal, and what to do next; it runs no verb.
  After Quad Damage k took (R34, gulnya/quad-damage AC-1, AC-13, AC-16), the prompt has the session say the run
  started and run `k bugs quad-damage --progress <folder> --after 0` in the background, the folder from k's answer.
  Each time that ends, the session runs the next wait its `kirunak-next:` line names, then writes the progress lines
  it printed to the owner as they are, a short line at each change of the run's status; when the run has ended the
  wait prints the summary instead, and the session sends the text after its `kirunak-push:` line with
  PushNotification, then writes the summary's lines as they are. Each turn starts its background command first and
  ends on the owner's lines: a turn that ends on a tool call is asked by the engine for visible output, and the
  session wrote a line twice that way (gulnya/quad-damage S-11). An answer without the folder leaves the run to
  `--status` and `--summary`. Stop Quad Damage gets no turn: the turn already waiting on the run's progress writes its
  last lines and its summary.
- Tests: `claude plugin test mods/kirunak` (`npm run test:mod`, with `claude plugin validate`): the pane renders a
  task's rows from a `k list --json` fixture on the terminal and the desktop; `/k-approve` and the other four with
  origin `sdk`, `plugin`, `peer`, `unclassified`, `peer-send-message`, `task-notification`, `scheduled-trigger` or
  `auto-continuation` are refused with a line and run nothing; with `composer` or `bridge` each runs its verb and the
  state line prints; a `build-ended` event line toasts; `/k-done` is not registered; a `-p` run reads nothing.

### The phone commands and the dialog (kirunak-phone, built 2026-10-21)

The commands above whose verb needs an id take none from the phone: typed with no id, `/k-approve`, `/k-accept`,
`/k-hold`, `/k-resume` and `/k-start` open **the engine's choice dialog** (`$.ui.ask`) and the owner picks by touch;
`/k-amendments`, `/k-queue` and `/k-board` open it too (`/k-board`'s dialogs are the board's groups, then a group's tasks, and a tap only reads, §3). A command typed with its id, or with a number from a list, runs as before. The dialog is
raised only inside the `command.run` hook of a command whose origin is `composer` or `bridge`, and what a tap does is
the rule of `approval.md` §5.

**What the dialog is, as measured** (evidence: `evidence/S-1-phone-probe.md`, S-1, 2026-10-20 and 21; a mod's dialog
reached the phone and its answer came back while the command ran, 8.4 s and 16.6 s):

- It takes **labels only**, two to four: `$.ui.ask` gives a choice no description (AC-3's "a label and a description"
  was changed to this in A-1 of the task). The question's list named each row only, as plain numbered lines
  (`/k-queue`'s gave each task's title too, A-10, and was numbered by place, A-11), and a picked row's details are the
  next dialog's text (A-8). Since gulnya/mobile-dialogs each choice has its line all the same, written into the call
  by the mod's `tool.call` hook, and a list's question is its head and question alone, each row's words its choice's
  line (AC-14, AC-23; "The look" below).
- The question is **plain text**: line breaks are kept, markdown is not drawn (`**` shows as typed), and a line the mod
  logged before the dialog does not appear on the phone.
- The **app numbers the choices itself** (chips 1 to 4), so a label never starts with a number (a test holds it) and
  the question's numbers are the app's: "1. hub/sync-notes: ..." sits above the choice that opens it. A mod cannot
  hide the chips' numbers (the owner asked, A-11's Q-48): `$.ui.ask` takes labels and a header only. `/k-queue` is the
  one list whose lines carry the task's place in the queue instead ("7. gulnya/large-screens: queued. ..."), so they
  match `k list` and `k queue show` (A-11); its parked tasks, and Move's Earlier, Later and end, have no number. Since
  gulnya/mobile-dialogs the place is the first words of the task's choice line ("place 7, ...").
- Under the choices the app adds a **free-text row** ("Something else") and a **Skip** button. Skip answers the string
  `[No preference]`, which is no rejection: an answer acts only when it equals one of the dialog's own labels, so Skip,
  a dismissal and any other text run nothing. The free-text row is how a reason is typed (hold, decline, accept with
  open items); a blank reason runs nothing.

**How it is laid out** (`mods/kirunak/hooks/owner.ts`, `picks.ts`; judgement unless marked):

- A list shows **three rows and More** when there are more than four (the fourth choice is More), and one fewer above
  Back: "Waiting for you to approve (1 to 3 of 7)". A short list shows all its rows. Evidence for the limit: four
  choices at most.
- **Back** on every dialog but the first shows the dialog before it again, and is always the lowest choice, below More
  and Cancel (the owner on the phone, A-11's E-1 and E-5); Cancel stands where a reason dialog or a lone choice would
  otherwise be padded with Yes and No. Nothing is run by Back or Cancel.
- **The last choice names the verb**: "Approve <id>", "Accept <id>", "Accept <id> with open items", "Approve <id> A-n",
  "Decline <id> A-n", "Hold <id>", "Resume <id>" (A-12), "Start <id>", "Move <id> before <Y>", "Move <id> to the
  end", "Park <id>", "Put back <id>" (the owner's answer Q-17: each behind an explicit last choice), and Move's
  "Earlier" and "Later", whose lines say the place each takes the task to, under the task's text (A-11). It sits in a
  dialog that shows the item's text above it, so the owner reads what the tap will do. `k` checks the task again as it
  runs (E-2): a task changed since the list was shown is answered with k's refusal, never run on another.
- When nothing ran, the answer says why ("Nothing ran: skipped", "dismissed", "cancelled", "no reason was typed", "the
  answer was none of the choices"). `/k-approve`, `/k-accept` and `/k-amendments` then print the numbered list again, so
  a typed number keeps using the whole list; `/k-hold`, `/k-resume`, `/k-start` and `/k-queue`, which take no number,
  answer "Nothing ran: <why>." alone.
- `/k-resume` lists the tasks on hold, read from `k list --json --all` as `/k-queue` reads it (`k waiting` has no list
  for it), each line a task's id and state; the one picked shows its title and state above "Resume <id>", which runs
  `k resume <id>` (A-12's AC-18; the state rather than the hold's reason is a default A-12 proposed). With no task on
  hold it answers "No task is on hold." and opens no dialog; `/k-resume <id>` typed runs at once, as `/k-hold <id>
  <why>` does.
- `/k-queue` lists the queue in order and then the parked tasks, each line a task's id, state and title (A-10: the one
  picking list that gives titles), numbered by its place in the queue, a parked task's unnumbered (A-11). A queued task
  offers Move and Park, a parked one Put back; Move lists Earlier and Later first, a tap on either moving the task one
  place (`k queue move <id> --before` the task before it, `--after` the one after; none for the first task and none
  later for the last, A-11), then the other queued tasks, as the first list does, and last the end of the queue. Two choices the build made that
  AC-17 does not spell out: Park is offered only to a task in the state "queued" (one in progress or in review that sits
  in the queue gets Move only, because parked it would leave both lists and the phone could not put it back), and a move
  to the place the task already holds offers no verb ("It is there already"), since `k queue` would fail on an empty
  commit.
- **kirunak is named once**: the engine puts "kirunak: " before the first line of every command's answer, so no dialog
  and no answer's own text names it but inside an id or a path (a test holds it; `/kirunak` is the command that says
  it).

**`k waiting`** (the reads behind these dialogs, built in S-4): `k waiting --json` has five lists now, `approve`,
`accept`, `amendments`, `hold` and `start`. The amendments rows carry `{ id, amendment, title, name, proposed, by,
why, lines, refuse }`, where `title` is the task's, `name` the amendment's own title or, with none, the criteria it
changes ("replaces AC-2, AC-3; adds AC-17", kirunak-phone A-8), which the text shows as `<id> A-n: <name>`, and
`refuse` is one line of what `k approve --amendment` would refuse, or null; the hold and start
rows `{ id, title, state }` (hold what `k hold --dry-run` takes, start the tasks `k list` shows that are neither done
nor on hold); each accept row adds `checklistOpen`, `onlyChecklist` (true when `k accept` refuses only for open
items and passes with a reason) and `blocking`, `[{ path, commit, task }]`: each file a commit after the review
changed, with that commit and the task it names or `no task`, as `k accept`'s refusal lists them (`approval.md` §4),
taken from the dry run's own error, and empty unless that is what stops the task (gulnya/kirunak-accept-shared-repo
AC-6). `why` keeps the whole refusal. The text prints each as `<path>  <sha>  <task>` under the accept row, indented;
other refusals still print one line. `/k-accept` with no id shows the same lines under the task's row in its dialog's
list and in the numbered list it prints again when nothing ran, and the task's own view and a refusal of
`/k-accept <id>` show every line of the refusal (E-2), but for at most ten blocking lines for a task, then `and <n>
more` in place of the rest (A-1; `k accept` and `k waiting` in the terminal show them all); an older `k` that sends no
`blocking` shows none. `k approve`
and `k hold` take `--dry-run`, which makes every check and writes nothing. A row says "can approve" or "can accept"
where it said "ready". Evidence: `test/waiting.test.mjs`. Known gap:
`k start` refuses no state, so the start list is narrower than the verb, and `k approve` does not refuse an amendment
to a done task.

As built, where the build chose (each judgement unless marked):

- **`k list --all`, not `--repo`.** The session's task may be done or on hold and still be the session's until
  `k-done` clears it, and the queue spans the workspace's repos; the pane shows the queue whole.
- **`k status`** is a reading verb added for the mod (`bin/k.mjs`): `board.status` (§2), the guard queue's lines
  parsed, the home, and the session's record when `--session` names one.
- **The flags each verb passes are listed in the mod** (`hooks/commands.ts`); any other is refused, `--via` above
  all, since `k` collects a repeated flag into a list and the record's `via` must be `mod`. `/k-hold` takes the rest
  of the line as `--why`.
- **K** is the checkout's own `bin/k.mjs` (`$.plugin.root/../../bin/k.mjs`), so the mod and the CLI it runs are one
  version. An owner's verb may run 10 minutes (the most `$.process.run` allows), since its commit runs the repo's git
  hooks (`approval.md` §3); the command waits for a running turn to end (no `immediate`), so it never commits beside
  the model. A `$.process.run` child carries no `CLAUDE_CODE_SESSION_ID` of its session (measured, review N63: absent,
  or a parent process's), so the mod names the session by flag on `k start` and `k status`, and any verb it runs later
  that reads one (`k handoff`, `k keep`, `k step`) must do the same.
- **Reads.** One at a time; reads asked for while one runs make one more after it. A failed read keeps the last rows
  on screen under its reason. Only the start and the 30 s tick (re)start the tail, so a tail that ends cannot loop.
- **The pane opens** on `/k-start`, on `/kirunak`, and unasked at the start only when the session already has a task
  (a resumed session); the engine seats an unasked pane from 144 columns.
- **A `claude -p` run** (`isInteractive` false) gets the commands, which refuse its origin `sdk`, and no reads.
- **What the engine's scan holds a module to** (2.1.303, found while building; evidence: `claude plugin validate`):
  a hook is a function literal; `$` is followed only into a function declared at the top of the file, or one
  declared in a file of the module's own; a `$.state` reference is a const in the file that reads it.
- **Numbers** (2026-10-19, Claude Code 2.1.303, this Mac): a `claude -p "/k-accept <id>"` with the mod took 1.28 to
  1.53 s and printed the refusal for `sdk`, against 1.40 to 1.62 s with a ten-line mod, so the load adds nothing
  measurable; each 30 s tick runs `k list --json --all` (0.08 s, 22 KB) and `k status --json` (0.07 s).
- **Picking by number** (judgement): the number is resolved against the ids the owner was last shown, kept by the
  module, so a list that changed since cannot move a number onto another task; `session.end` forgets them, since
  `/clear` and a resume go on in the same process under another session (review G25), and a list that could not be
  read leaves none. With no list, the line asks for it first. A task awaiting the owner with no review asked a
  question in progress and is not offered for acceptance (G26). A flag's value never starts with `--`, in the mod and
  in `k`'s `parseArgs`, so `--checklist-open --dry-run` is refused rather than run (G24). The list and the pick keep the origin rule (nothing is listed for another
  origin), and `k` checks the task again as it runs. Buttons in the pane were not built: a `ui.press` carries the
  plugin, the element and the surface, never who pressed (2.1.303's `UiPressArgument`), so a press cannot be held to
  the owner-only rule a command's `origin` gives. The typeahead is the terminal's prompt box; Remote Control's input
  is not known to raise it.
- **Remote Control says so**: an answer to a command whose origin is `bridge` ends `(typed in Remote Control)`,
  since the transcript's command record does not name the origin. One `/k-accept` from the phone on 2026-10-19 was
  recorded with `args: ""` while the hook had validated an id (the mod then checked the id before k); unexplained:
  the declarations say the hook's `args` is as typed and a stored row is its door's (review N71).
- **A mod loaded through a link** (a mods folder's, while developing) runs the `k` of the folder the link names: K is
  taken from `$.plugin.root`'s real path (`$.fs.stat(..., { resolve: true })`), since the root is the link's path.
- **Not yet:** an openspec refusal toasts once the workspace's openspec hook appends a `refusal` line to
  `events.jsonl` (gulnya's does not).
- **The phone check** of `build-order.md` slice 6 passed on 2026-10-19: `/k-accept` typed in Remote Control answered
  "Nothing waits for you to accept." and "(typed in Remote Control)": origin `bridge`, past the rule, `k waiting` run.

### The look: the dialogs drawn, each choice's line, the progress rows (gulnya/mobile-dialogs, built 2026-10-28)

Since gulnya/mobile-dialogs the mod's dialogs and Quad Damage's progress lines have a look in the Desktop app, and
every choice of the mod's dialogs has a line under it on every surface, the phone included. The hooks are
`mods/kirunak/hooks/look.tsx`; what they draw is plain data in `hooks/looks.ts` (the five states, each stage's state
and icon, the row counter, the date words, the parts, the progress lines), so the tests reach every part of it
without a surface (`tests/look.test.tsx`, `sweep.test.tsx`, `rows.test.tsx`, `agree.test.ts`).

**Where it is drawn** (gulnya/mobile-dialogs D-1, D-2, O-2):

- Two `ui.render` hooks, one on `AskUserQuestion` and one on `AssistantMessage`, return a tree on `desktop`. They
  pass on `terminal` and `vscode` alone, so a `mobile` render, if the engine ever raises one, draws as `desktop`
  does. On `terminal` and `vscode` they draw no tree: `next(e)` as it came. The terminal's dialogs keep their look
  within its 12 rows, each choice's line under it, and its pane takes the five colours as theme keys (below, O-2).
- The phone draws no tree. Measured in the task's S-2 (`evidence/S-2-spike.md`): with Remote Control open,
  `$.session.surfaces()` is `["terminal"]` and the render hook on `AskUserQuestion` is raised with `surface:
  "terminal"` alone; the phone's client never attaches as a surface of its own (no `ui_attach`, no ask to draw), and
  the mods reference's render sites are Terminal, Desktop and VS Code, none on the phone. What the phone shows is
  what the `AskUserQuestion` call itself carries: the question's text, each choice's label and its line. No colour,
  no chip, no tree.
- A dialog has a look only when it is one of the mod's own. Before each `$.ui.ask`, `talk()` in `owner.ts` writes the
  dialog to `$.state` (`kirunak.dialog`: the question exactly as asked, its last line, each choice's line by its
  label, and its look) and clears it once the ask settles; a draft's first question is `kirunak.intake` (below). The
  hooks match a question by its exact text against these two; any other (a dialog the model raised, another mod's,
  one asked after a reload lost the state) goes on as the engine draws it (AC-5).

**The head** (AC-1): `Text size="title"` with the item's title (a list's: what it lists and how many), then the state
chip, a `Box` filled in the state's colour holding its icon and its word in the chip's ink, then one dim line with
the repo and the dates k's JSON carries, a date written "today", "yesterday" or "Oct 27" (its year added when it is
not this one; `dateWord`). A list's rows are drawn as rows: a chip, the item's id in bold, its short words. Below the
look comes the engine's own node, once and last, asked only the question's last line, the look above it showing the
rest; its choices and their lines are as the call hook wrote them.

**The five states** (AC-7, AC-8, AC-9, AC-20): the tree cannot see the Desktop app's theme, so a state is a fill
with its own ink, a pair that holds 4.5:1 on any ground (`STATES`; a test computes WCAG's ratio):

| State | Fill, ink | Stages | A task's state (`TASK_STAGES`) |
| --- | --- | --- | --- |
| done (green) | `#1b7a3a`, `#ffffff` | merged, done | done |
| running (yellow) | `#f2c200`, `#1f1f1f` | started, fixing, committed, reviewing | in progress (started), in review (reviewing) |
| n/a (grey) | `#6e6e6e`, `#ffffff` | skipped, not reached | draft, queued, a state of no known name (not reached) |
| waits (orange) | `#e8710a`, `#1f1f1f` | waits, paused | proposed, reviewed, awaiting owner (waits); parked, on hold (paused) |
| failed (red) | `#c62828`, `#ffffff` | stopped, failed | blocked (stopped), stale (failed) |

Each stage's icon (`iconOf`) is an `Svg` of a 16 by 16 disc in its state's fill with its glyph drawn in the ink, its
`alt` the stage's word, drawn at 18 px, and the word stands beside it in the chip, so colour is never the only sign.
No dialog or row holds an emoji (AC-6; a test searches every drawn tree for `\p{Extended_Pictographic}`).

**The fold** (AC-3, AC-4, AC-10, E-1): an item's dialog shows its head and its first lines (a bug's or a draft's
first paragraph, in plain words), then Show all (`variant="primary"`), which unfolds the rest in the same dialog: Why,
What was found and the questions, the ids, paths and commits (short shas) among them, each section under its heading
with a blank line between. The part open is `kirunak.fold`, written by the buttons' `onPress` alone, never while
drawing. Past what a dialog holds, the unfolded text goes in parts, "n of m" above each, Show less on the first part
and Back on the others, Next on all but the last (`variant="secondary"`). A dialog's tree holds at most 48 rows
counted at 40 columns (AC-19), the most the engine draws before it falls back to its plain dialog (measured in S-1).
One counter in `looks.ts` (`rowsOf`, `treeRows`: a text a row a line and one more for each 40 columns, a button's
label and an Svg's alt the same, a `Box`'s gap a row for each child) counts the head, and the parts take what is left
of the 48 less `FREE`, the room the "n of m" line, the buttons and the gaps take. The paging and the tests share it.

**The progress rows** (AC-11, AC-12, AC-13, E-2): the `AssistantMessage` hook draws a reply as rows when a line of it
has one of the forms in `task-files.md`'s "The run's progress" (`progressOf`: a bug's `HH:MM <repo>/<slug>: ...` and
the run's own `HH:MM Quad Damage ...`), or is the summary's head or, under it, one of its `- <id>: ...` lines
(`summedOf`). Each such line is one row: its time dim, its stage's chip, the bug's id in bold, its words as written.
Every other line (the `kirunak-push:` line, prose, any line in a code fence) is drawn as it was, a `Markdown` of the
lines between rows, in order; a line of no known form stays that text, never hidden or guessed at, and a reply with
no row, or the engine's own summary (`isSummary`), goes on as it came. /k-bugs' run line (AC-12, the line `k bugs
quad-damage --status` prints, `runRowOf`) is a row of the list's head, its chip "Quad Damage waits" (paused) while
the run waits for the 5-hour window, else "Quad Damage runs" (started); a run line of no form stays its text.

**Each choice's line, written into the call** (AC-2, AC-14, AC-17, D-1): a `tool.call` hook on `AskUserQuestion` in
the same module gives each option of the mod's own dialogs its `description`, matched by the question's exact text
against `kirunak.dialog`, or against a draft's parts in `kirunak.intake`; any other call goes on as it came. It
changes nothing else: the question and the labels stay, so the answer is the label tapped (AC-18). Since the line is
in the call, the phone, the terminal and the Desktop app all show it. Every choice has one, in its screen's own
words, the likely one first: a bug's "<title>, fix ready, written Oct 27", Review & merge's "a fresh session reviews,
then merges, never pushes", More "the next ones", Back "the dialog before", Cancel "nothing runs"; those three keep
their place last.

**Short list questions** (AC-23): a list's question is its head and its question alone, on one line, the page's
range in it: "Bugs, a fix ready first, then the oldest (1 to 3 of 22): Quad Damage, or which bug?". What each row
said (its words, its state, its date; on `/k-queue` its place first, "place 7, ...") is its choice's line, written
once there and never in the question. What a screen says beyond its list (an item's text, a confirm's sentence)
stays in its question. The dialog log (`dialogs.jsonl`) records the question as asked and the labels.

**The board's page and the pane take the same five** (AC-8, O-2): the page's tokens (`lib/board.mjs`), each measured
at 4.5:1 or more on its bg, card and work grounds in both themes (`test/board.test.mjs`): light done `#1b7a3a`,
running `#806000`, n/a `#696969`, waits `#a84300`, failed `#c62828`; dark done `#6fcf8c`, running `#f2c200`, n/a
`#9e9e9e`, waits `#e8710a`, failed `#ff8a80`. A task's state takes the dialogs' mapping (a test holds every state
`lib/state.mjs` names to `TASK_STAGES` and `STAGES`); a verdict met is done, not met failed, needs device or owner
waits, none n/a; a bug's fix as its chip (Quad Damage on it or in review running, a fix ready or not ready waits, no
fix n/a); a draft waits. The words are unchanged. The terminal pane (`hooks/board.ts` `PANE_COLORS`) takes the
theme's keys `success`, `warning`, `inactive` and `error` for done, running, n/a and failed, and `#e8710a` for waits,
which no theme key names.

**A draft agreed in one tap** (AC-15, AC-16, AC-21, E-3, D-4): Start intake in `/k-drafts` sends a prompt
(`intakePrompt` in `hooks/drafts.ts`) whose first question holds every Proposed answer of the draft (`questionsOf`
reads its Questions section; a Proposed that only says what is missing counts as none). `firstQuestion` writes it:
"<id>: <title>.", "N proposed answers:", each proposal "n. question" with "Proposed: ..." under it, then "Agree to all
N, or not?". Past 48 rows the questions go in parts, "part k of m", by the same counter: an early part asks "On to
part k+1 of m, or not?" with Next, Not and Back (no Back on the first), the last Agree, Not and Back, so Agree is
offered on the last part alone and no proposal is agreed unseen. The lines: Agree "all N proposals become your
answers", Not "asks each proposal alone", Next and Back "part k of m". The prompt has the session ask each part
exactly as written, the choices in order with their lines; the questions with no proposal follow, each asked alone.
Start intake writes the parts to `kirunak.intake` before the prompt is sent (`showIntake`), since the model asks in a
turn of its own, so the call hook writes their lines and the Desktop app draws the draft's head over its list; any
answer but Next or Back, any mod dialog opening, or the next Start intake clears it, and a question in other words
is the engine's. The k-intake skill's "Starting from a kirunak draft" says what Agree records (each proposal the
owner's answer, sourced `[owner <date> Q-n]` to that question) and that Not asks each proposal alone. Nothing in the
k CLI changed (D-4).

## 5. Requirements this file satisfies

D5 and R16 (§1, §2), R28 (§2 the Drafts group, §4 `/k-drafts`), R29 (§2 the Bugs group and the line in `k waiting` and a new session, §4 `/k-bugs`), R34 (§2 Quad Damage's line, §4 its row in `/k-bugs` and the turn after it), R27 (§4 Drop), D10 (§2), D13 (§3), D14 (§4; the approval half in `approval.md` §5), the phone half of D7 (§4, `approval.md` §5), R30's names in `k waiting` and `/k-accept` (§4).
The look of the mod's dialogs and rows, each choice's line and a draft agreed in one tap (§4, "The look"):
gulnya/mobile-dialogs AC-1 to AC-16, AC-23, E-1 to E-3, D-1, D-2, D-4, O-2, held by the mod tests
it names (AC-17 to AC-21).
