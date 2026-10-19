# The boards: the list, the local page, the phone artifact, the mod

Design (D5, D10, D13, D14, R16). Each choice is marked **evidence** (with its source) or **judgement**. Index:
`README.md`. All four are front ends over the task files (`frontend` seam, `plugins.md` §2); none holds state of its
own, and none approves anything.

## 1. The list: `k list`

One line per task across every workspace repo, queue order first (invented rows):

```
 1  ready        weather/offline-forecast   The last forecast stays readable offline   next S-1 (sonnet)
 2  in progress  weather/hourly-chart       An hourly chart for today                  S-4 running 12 min, lock: weather unit tests
    awaiting     hub/release-notes          Release notes in every language            Q-3 open
    done         weather/settings-backup    ...                                        2026-11-01
```

`--json` gives the same rows with every field (`id`, `title`, `state`, `queue`, `step`, `lock`, `approved`,
`review`, `checklist`), which the page, the artifact step and the mod read. `--repo <name>`, `--all` (done and on
hold too). Number to check: under 1 s across the workspace's repos (it reads a few files per task and runs no git
command except `git show` for a staged hash when asked).

## 2. The local page: `k board` (D10)

- `k board` writes `$KIRUNAK_HOME/board.html` from `k list --json` and `k status --json` (the lock, the device
  claims, the running steps, the keeper's last lines) and opens it (`open` on macOS, `xdg-open` elsewhere). No
  server: a static page, inline CSS, both themes through `prefers-color-scheme` (judgement: WCAG AA in both themes,
  4.5:1 for text, because the board is read on any screen at any hour).
- Columns by state (draft, proposed, ready, blocked, in progress, in review, awaiting owner, done this week), a card
  per task with its AC and E and their latest verdicts (met, not met, needs device, needs owner, none), the queue
  place, the step running and since when, and links `file://` to `task.md`, `plan.md`, `review.md`, `checklist.md`.
- A footer: the lock holder and queue, device claims, running steps against `maxAgents`, the keeper's last
  keep-alive and miss. Generated at `<time>`; the page says so and has a "regenerate" note (`k board`).
- No control on the page: approval and acceptance are commands (D7). The test asserts the page contains no form,
  button or script.

## 3. The phone artifact: a sync step (D13)

- A `sync` step kind (`orchestrator.md` §1) or `k board --artifact`: a short headless run (the workspace's
  `models.sync`, `--max-turns 8`, `--disallowedTools Agent,Bash(…)` except `k board --html`) whose brief is: "run
  `k board --html <path>`; publish that file as the artifact at `<url>` with the Artifact tool, updating in place;
  no capabilities; say the URL". The URL is kept in `$KIRUNAK_HOME/board-artifact.json` after the first publish;
  later runs pass it. The page is the same HTML as §2 (the Artifact tool wraps it); read-only by construction (D13:
  no form, no `db`, no capabilities).
- Triggered when `events.jsonl` has changed since the last sync and at most once an hour (judgement: each sync is a
  fresh conversation, which costs about Claude Code's opening context at the sync model's weight; hourly at most
  keeps that small against a working day, and `k cost` shows it). The owner can run it by hand.
- Approvals never happen there (D13): the page has no control, and the record is written only by the owner's
  command (`approval.md`).
- A thing to check in slice 5 before building on it: that the Artifact tool is available to a `claude -p` run on the
  account (the docs fetched on 2026-10-18 do not say; one run tells). If it is not, the step runs as a bounded
  interactive command the owner types (`/k-board-sync`), which costs the same tokens in the owner's session.

## 4. The mod: the working view (D14)

A Claude Code plugin in the kirunak repo, `mods/kirunak/` (judgement: it is specific to Claude Code but to no
workspace, so it ships with kirunak, D2), installed by the owner from a folder marketplace or
`CLAUDE_CODE_PLUGIN_DIRS` (`approval.md` §5). The shape is the one Claude Code's `plugin-authoring` skill describes
(2.1.302; built on 2.1.303): `.claude-plugin/plugin.json`, `hooks/hooks.json`, `hooks/register.tsx`,
`types/index.d.ts` for its `$.state`. Built 2026-10-19 (slice 6).

What it shows and does, each from the skill's table of shapes:

| Ask | Shape | Source of the data |
| --- | --- | --- |
| the current task, its AC and E with review state, the queue, the lock | a pane: `$.ui.open({ id: 'kirunak', title })` drawn by a `ui.render` hook on `Pane` | `k status --json --session <id>` and `k list --json --all` through `$.process.run`, at the session's start, every 30 s on `$.clock`, and at once on a new line of `events.jsonl` |
| a line above the prompt | `ui.render` on `AbovePrompt`: `kirunak · task · step · lock holder · queue place`; nothing while the session has no task | the same |
| toasts: a heavy job ended, a review is ready, a cache kept warm, a step waits for the owner, an edit refused | `$.ui.toast(text)` for each new line of those kinds | `events.jsonl`, followed with `tail -n 0 -F` through `$.process.spawn` for the session's life; kinds `build-ended` (`k run`, as a heavy job's record is saved), `review-ready` (`k step finish` of a review step), `keep-alive`, `awaiting owner`, `refusal` (the freeze hook; a workspace's own hooks may append it too) |
| `/k-approve <id>`, `/k-accept <id>`, `/k-hold <id> <why>`, `/k-start <id>` | `$.command.register` in `session.start`, answered by `command.run` hooks that run only on `e.origin.kind` `'composer'` or `'bridge'` (`approval.md` §5, the owner's answer of 2026-10-19) and call `$.process.run(['node', K, verb, id, ...flags, '--via', 'mod'])`, returning the state line as `{ text }` | the core verbs |
| `/kirunak` | a command that opens the pane, or closes it when open | |
| `/k-done` | stays the skill (it needs the model, `review.md` §4); the mod does not register the name | |

- The current task of a session is `sessions/<session_id>.json`, written by `k start <id>` (also a `k-start`
  registered command) and read through `k status --session`; `k-done` clears it (through the default `handoff`).
- `k start` is the one write a mod command makes that is not the owner's alone; it is allowed from the Bash tool
  too (a session may say which task it works on).
- Tests: `claude plugin test mods/kirunak` (`npm run test:mod`, with `claude plugin validate`): the pane renders a
  task's rows from a `k list --json` fixture on the terminal and the desktop; `/k-approve` and the other three with
  origin `sdk`, `plugin`, `peer`, `unclassified`, `peer-send-message`, `task-notification`, `scheduled-trigger` or
  `auto-continuation` are refused with a line and run nothing; with `composer` or `bridge` each runs its verb and the
  state line prints; a `build-ended` event line toasts; `/k-done` is not registered; a `-p` run reads nothing.

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
  the model.
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
- **Not yet:** an openspec refusal toasts once the workspace's openspec hook appends a `refusal` line to
  `events.jsonl` (gulnya's does not). The phone check of `build-order.md` slice 6 waits for the owner.

## 5. Requirements this file satisfies

D5 and R16 (§1, §2), D10 (§2), D13 (§3), D14 (§4; the approval half in `approval.md` §5).
