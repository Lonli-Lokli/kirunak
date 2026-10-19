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
(2.1.302): `.claude-plugin/plugin.json`, `hooks/hooks.json`, `hooks/register.tsx`, `types/index.d.ts` for its
`$.state`.

What it shows and does, each from the skill's table of shapes:

| Ask | Shape | Source of the data |
| --- | --- | --- |
| the current task, its AC and E with review state, the queue, the lock | a pane: `$.ui.open({ id: 'kirunak', title })` drawn by a `ui.render` hook on `Pane` | `k status --json` and `k list --json --repo <cwd's repo>` through `$.process.run`, every 30 s on `$.clock`, and at once on `events.jsonl` change |
| a line above the prompt | `ui.render` on `AbovePrompt`: `task · step · lock holder · queue place` | the same |
| toasts: a build ended, a review is ready, a cache kept warm, an openspec change refused | `$.ui.toast(text)` from the clock hook when `events.jsonl` has a new line of those kinds | `events.jsonl` (the k verbs and the keeper append it; a workspace's own hooks may append to it too, such as a freeze hook's refusals) |
| `/k-approve <id>`, `/k-accept <id>`, `/k-hold <id>`, `/k-start <id>` | `$.command.register` in `session.start`, answered by `command.run` hooks that run only on `e.origin.kind` `'composer'` or `'bridge'` (`approval.md` §5, the owner's answer of 2026-10-19) and call `$.process.run(['node', K, verb, id, '--via', 'mod'])`, returning the state line as `{ text }` | the core verbs |
| `/k-done` | stays the skill (it needs the model, `review.md` §4); the mod does not register the name | |

- The current task of a session is `sessions/<session_id>.json`, written by `k start <id>` (also a `k-start`
  registered command) and read by the pane; `k-done` clears it (through the default `handoff`).
- `k start` is the one write a mod command makes that is not the owner's alone; it is allowed from the Bash tool
  too (a session may say which task it works on).
- Tests: `claude plugin test mods/kirunak` with a `*.test.ts` per behaviour the skill asks for: the pane renders a
  task's rows; `/k-approve` with origin `sdk` or `plugin` is refused with a line and runs nothing; with `composer`
  or `bridge` it runs the verb; a toast appears for a `build-ended` event line.

## 5. Requirements this file satisfies

D5 and R16 (§1, §2), D10 (§2), D13 (§3), D14 (§4; the approval half in `approval.md` §5).
