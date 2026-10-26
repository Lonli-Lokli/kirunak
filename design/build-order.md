# The build order: slice 1 in full, the later slices to build from

Design. Index: `README.md`. Each slice is built, proven on the first repo that migrates (D8), and only then is the
next started. Each slice names the R and D numbers it closes, the files and functions, the data formats (in the
design files), the tests that prove each requirement, and the numbers to check. Node, `node:test`, no dependency,
no Python (R19).

## Slice 1: what the first repo's migration needs (D8). Closes D2, D4, D6, D7, D11, D12, R1, R2, R3, R4, R5, R6, R7, R16, R19, R20, half of D10 and R15

### Files in this repo

```
README.md                   what kirunak is and how to set it up (below)
package.json                { "name": "kirunak", "private": true, "license": "MIT", "type": "module", "bin": { "k": "bin/k.mjs" },
                              "scripts": { "test": "node --test test/" }, "engines": { "node": ">=22" } }
bin/k.mjs                   argv → verb; loads the workspace (lib/workspace.mjs) for every verb but `init`, `install`,
                            `check` and the hooks; every verb takes --json and --dry-run; exit 0 ok, 1 refused (with
                            the reason on stderr), 2 usage
lib/home.mjs                kirunakHome() → $KIRUNAK_HOME or ~/.kirunak (plugins.md §3, §4)
lib/workspace.mjs           loadWorkspace(pointer = kirunakHome()/workspace) → { repos, queue, plugins, machine, models,
                            budget, runner, keeper, baseline, seams }; loadPlugins(ws) → seams; validate(seamName, impl)
                            throws naming the missing function
lib/seams.mjs               SEAMS: { name → { functions: [...], policy: 'one' | 'many' } } (plugins.md §2)
lib/task.mjs                parseTask(text) → { front, sections: { goal, ac, e, o, d, aspects, q }, lines }
                            checkTask(parsed, aspectIds) → [{ line, problem }]  (task-files.md §2 rules 1 to 6)
                            isReady(parsed, aspectIds) → boolean (check passes and q is empty)
lib/source.mjs              parseTags(line) → [{ kind: 'owner'|'research'|'default'|'from', date?, ref?, q? }] or null
lib/state.mjs               stateOf({ taskDir, record, queue, files }) → one of the twelve states (task-files.md §4)
lib/approval.mjs            hashBytes(buf) → 'sha256:<hex>'; readRecord(repo, slug); approve({ ws, id, amendment?, via,
                            queuePlace? }) → { hash, commit }; verify(ws, id) → 'ok' | 'stale' | 'none'
lib/amend.mjs               parseAmendment(text) → { front, why, ops: [{ op: 'replace'|'add'|'remove', id, section?, line? }] }
                            checkAmendment(task, amendment) → [problems]; applyAmendment(taskText, amendment) → newText
lib/intake.mjs              start({ ws, id, from?, title? }); aspects(ws, id) → [...]; question(ws, id, topic, text) → 'Q-n';
                            answer(ws, id, q, verbatim, ruling) ; all append-only on intake.md
lib/queue.mjs               read(ws) → [ids]; add(ws, id, place); move(ws, id, place); remove(ws, id); each commits in the queue's repo
lib/list.mjs                rows(ws, { repo?, all? }) → [{ id, title, state, queue, step, lock, approved, review, checklist }]
lib/board.mjs               renderHtml(rows, status, now) → string; write(ws) → path
lib/handoff.mjs             handoff({ ws, id, session }) → { targets: [{ where, what }], released: [{ resource, line }] }
lib/install.mjs             install({ settingsPath, kirunakRoot, skillsDir, git?, print? }): the hook block, the skill
                            links, the git hook (below)
lib/git.mjs                 show(root, ':path') ; commit(root, paths, message, env) ; head(root) ; log1(root, path)
plugins/storage-git.mjs     the `storage` seam over lib/git.mjs and the filesystem (plugins.md §2)
plugins/handoff-notes.mjs   the default `handoff`: handoff.md in the task folder; releases the session file (review.md §4)
hooks/kirunak-freeze.mjs    PreToolUse: export decide(input) → reason | null; main reads stdin (approval.md §2)
hooks/git-pre-commit.mjs    export check({ staged: [path], show: fn, env }) → [problems]; main runs in the repo
skills/k-intake/SKILL.md    the interview (intake.md §1, §2), under 120 lines, its own method, loads no other skill
skills/k-done/SKILL.md      closing (review.md §4), under 60 lines
templates/task.md           the skeleton `k intake start` writes
test/*.test.mjs             below
test/fixtures/              an invented workspace: two repos, a checklist plugin, a queue, and the finished task
                            weather/offline-forecast of task-files.md §2 with its intake.md
```

### What a workspace supplies (in its own repo, its own commit)

- The **workspace module** (`plugins.md` §3): its repos, the queue's path, its plugins, its limits, its models and
  budget, its baseline if it has one.
- A **checklist plugin** with its test (`intake.md` §3).
- The **queue file**, empty but for a comment line, in the repo the config names.
- Optionally a **handoff plugin** (where its sessions keep handoffs, what else a session holds) and, from slice 2, a
  **resource guard plugin** over a lock and device claims it already has.
- If it froze openspec: its freeze hook's instructions change to name the intake (`approval.md` §6).

### What the owner wires, once

`k` on PATH (`npm link`); `k init --workspace <path to the workspace module>`; `k install`, which:

- writes the PreToolUse block into `~/.claude/settings.json` (or `--settings <path>`), with `<kirunak>` replaced by
  this repo's absolute path, keeping every other hook; run again, it changes nothing:

```json
{ "matcher": "Edit|Write|MultiEdit|NotebookEdit|Bash|Skill",
  "hooks": [{ "type": "command", "command": "node <kirunak>/hooks/kirunak-freeze.mjs", "timeout": 10 }] }
```

- links `skills/k-intake` and `skills/k-done` into `~/.claude/skills/`, refusing to replace a skill of the same name
  that is not its own link (it names the one in the way, and the owner decides);
- with `--git <repo>`, writes `.git/hooks/pre-commit` for a repo with no hook, or prints the one line a repo with its
  own hook adds: `node <kirunak>/hooks/git-pre-commit.mjs || exit 1` (`approval.md` §3);
- with `--print`, writes nothing and prints all of the above with the path filled in.

Judgement: one verb, so no install path is typed by hand and no path of one machine is written in a file of this
repo. The `kirunak/` folder in a repo is created by the intake, nothing by hand.

### The root README

A slice 1 deliverable, written with the slice, when the setup it describes exists (the owner's request): a brief
`README.md` at this repo's root, minimal and focused on a solo developer or a small team building with AI coding
agents (Claude Code). Its parts: **what kirunak is** (a few sentences: tasks the owner approves and agents cannot
rewrite, an intake that leaves nothing to guess, a review against every criterion, a board, small commits; files in
git, no server), **setup** (the steps of "What the owner wires" above as commands: `npm link`, a workspace module
with its repos and queue, `k init --workspace`, `k install`, `k install --git` per repo, then a first
`/k-intake`), **change size** (the owner's request, 2026-10-19: what SLAP is for, how it is calculated, a few worked
examples, and `.slapignore` for the files left out; `change-size.md` has the rest), and **working a task** (by hand
until the orchestrator lands). It names no workspace, person or machine, points at `REQUIREMENTS.md` and `design/` for the rest, and
ends with one line naming the MIT licence (`LICENSE`). Judgement: everything else a reader needs is in the design files, and a
long README goes stale first.

### Verbs in slice 1

`k init`, `k install`, `k plugins`, `k doctor`, `k intake start|aspects|question|answer`, `k check`, `k verify`,
`k approve`, `k amend new|check|decline`, `k queue add|move|remove|show`, `k list`, `k board`, `k hold`, `k resume`,
`k accept` (the record only; the review grammar it reads comes in slice 4, so until then `k accept` accepts with
`--checklist-open "no review yet"` recorded), `k start`, `k handoff`.

### Tests, each proving a requirement (`node --test test/`)

| Test file | Proves | Cases |
| --- | --- | --- |
| `task.test.mjs` | R4, R5, R2, R3 | an unsourced line fails with its number; each tag kind parses; `[from ...]` alone fails; a `Q-n` line makes `isReady` false; a gap in AC numbering fails; sections out of order fail; an aspect missing from Aspects fails; an unknown aspect fails; `in` naming no existing line fails; CRLF fails; the invented finished task (`test/fixtures`, `weather/offline-forecast`) passes |
| `state.test.mjs` | R16, task-files.md §4 | one fixture folder per state, all twelve (queued and parked among them), including `stale` |
| `approval.test.mjs` | D7, R5, R7 | the hash equals `shasum -a 256`; approve writes the record and history; one changed byte → `verify` says `stale`; approve refuses with a Q open, with `check` failing, with an uncommitted task; an amendment's replace, add and remove apply; a removed number is never reused; apply re-hashes and appends history with the amendment id; `declined:` stamps |
| `freeze-hook.test.mjs` | D7 | spawned as a child with the hook JSON on stdin: Edit of a frozen `task.md` denied with the amendment instruction; Edit of a draft allowed; any Write under `approvals/`, to `done.json`, a `- [x]` tick in `checklist.md`, `intake.md` denied; Bash `k approve x`, `>> kirunak/approvals/x.json`, `sed -i` on a frozen task denied; `k check`, `k intake answer`, `k handoff`, `cat`, `git log` allowed; a subagent's input (`agent_id` present) treated the same; bad input → exit 0 (fails open); `KIRUNAK_FREEZE_OFF=1` allows and logs |
| `git-hook.test.mjs` | D7 | in a temp repo: a commit with a changed frozen task refused with the message; the same with `KIRUNAK_APPROVING=<id>` allowed; staged `approvals/` without the variable refused; a non-append `intake.md` refused; a commit touching no kirunak file allowed |
| `queue.test.mjs` | D4 | add first/last/before/after; move; remove; a duplicate refused; an unknown id refused; comment lines kept; each change is one commit with the message `kirunak: queue <verb> <id>` |
| `list.test.mjs` | R16, D4 | queue order first, then the rest; `--json` fields; two fixture repos in one workspace |
| `board.test.mjs` | D10, D13 | every task appears with its AC and E; no `<form`, `<button`, `<script`; both themes' CSS present; `file://` links to the four files |
| `plugins.test.mjs` | D1, D2, D3 | a workspace fixture loads; an unknown seam refused by name; a missing contract function refused by name; two `storage` plugins refused naming both; two `checklist` plugins merge in order; two `handoff` plugins merge in order; `KIRUNAK_HOME` moves the pointer |
| `intake.test.mjs` | R1, R2, R4, R20 | `start` writes the skeleton with every aspect `? [open]`; `--from` writes `notes.md` with the headings and unchecked items and touches nothing under `openspec/`; `question`/`answer` append numbered entries and never rewrite; `answer --ruling` yields the `Q-n` the tag points at |
| `handoff.test.mjs` | R15 | the default targets the task's `handoff.md` and clears the session file; a fixture plugin's targets and releases are merged after it; nothing is written outside the task folder and `$KIRUNAK_HOME` |
| `install.test.mjs` | D2, D7 | in a temp home: the block is written with the absolute path and no `<kirunak>` left; other hooks are kept; a second run changes nothing; a foreign skill of the same name is refused by name; `--print` writes nothing; `--git` writes a hook in a bare repo and only prints in a repo with one |
| `skills.test.mjs` | R1, R15, D2 | `k-intake`, `k-done` and the root `README.md` name no skill, tool or path outside this repo (a grep over the three files against an allow-list: `k`, `claude`, `git`, `node`, `npm`) |

### Numbers to check after slice 1

1. The freeze hook's wall time per call: under 60 ms, and all of the workspace's PreToolUse hooks together under
   100 ms, measured over 50 spawns (`time` in a loop). If over, the workspace merges its hooks into one dispatcher
   that calls each hook's `decide` (`approval.md` §2) before its first repo runs on kirunak: a hook runs on every
   Edit, Write and Bash call.
2. `k list` across the workspace under 1 s; `k board` under 2 s.
3. The git hook on a commit touching no kirunak file: under 100 ms.
4. The k-intake and k-done skills' listing cost: under 300 tokens each added to a fresh session's skill list
   (compare the first turn's context before and after linking them; the status line shows `context_window`).
5. The first converted task's interview: its questions, its calls and the tokens it adds to the owner's session,
   against the budget the workspace sets. Over budget, tune `appliesWhen` so an aspect that cannot apply is ruled
   `n/a` in one question.
6. `k verify` agrees with `shasum -a 256` on every approved task.
7. One full cycle on the first repo, in a fresh session: intake → `k check` → `! k approve` → an agent's Edit of the
   task refused with the instruction → an amendment → `! k approve --amendment A-1` → `k list` and `k board` show
   it → `git log` shows the intake commit, the approval commit, the queue commit in the queue's repo → `/k-done` with
   `! k accept` and the handoff written where the workspace's `handoff` says.

## Slice 1b: change size. Closes R21, R22, R23

Built after slice 1, before the first repo's migration, so every commit of its tasks is measured from the start.
Files: `lib/slap.mjs` (`score`, `tier`, `limit`, `measure`, `measureDiff`, `parseDiff`, `gate`), `lib/ignore.mjs`
(the `.slapignore` matcher), `lib/slapignore.mjs` (the starter, the registry, `approve`),
`hooks/git-prepare-commit-msg.mjs`, the `k slap` and `k slapignore` verbs, `k install --git` writing the hook and the
starter. R23 and "at most M" came with the owner's amendment of the same week. Design, tests and numbers:
`change-size.md`.

## Slice 2: the orchestrator. Closes R8, R9, R10, R12

- Files: `lib/plan.mjs` (parse, `check` coverage and inputs), `lib/steps.mjs` (the lifecycle, `k step
  brief|start|finish|fail`, `needs.json`), `lib/run.mjs` (`k run --once|--watch`), `plugins/runner-claude.mjs`
  (orchestrator.md §3, the exact flags), `plugins/machine-guard-pids.mjs`, `plugins/resource-guard-local.mjs` (the
  default guard, plugins.md §2), `lib/cost.mjs` (`k cost`, the formula of orchestrator.md §6, `--baseline`),
  `plugins/prices-default.mjs`, `templates/brief.md`.
- Tests: plan coverage (an uncovered E fails; an unknown id fails; an input no step produces fails); the lifecycle
  with a fake runner (pending → ready → running → done; missing output → failed; `needs.json` heavy → the guard's
  `run` is called while `running/` holds no step pid; owner → stops; a second failure marks `[escalate]`); the
  machine guard refuses past `maxAgents` and clears a dead pid; the default guard runs one job at a time (a second
  waits its turn), kills a `sleep` child tree past `maxMinutes` with exit 124, takes over a dead owner's lock,
  estimates from its log; the run record parser on a fixture of the documented JSON result (`session_id`, `usage`,
  `model_usage`, `num_turns`, `is_error`); `k cost` equals the formula worked by hand on a fixture; `k cost
  --baseline` prints only the comparisons of orchestrator.md §6 and nothing without a baseline; no `--model` or
  `--effort` is passed when neither the plan nor the config names one; a review step refuses a shared session id
  (used by slice 4).
- Numbers: a step's first call reads the shared prefix from cache (`cache_read_input_tokens` about the size of a
  fresh session's opening context) when another step ran within the hour; a step that meets a permission prompt
  fails within its budget minutes rather than hanging (run one on purpose with `--permission-mode default`); free
  memory with two steps and one build running (the OS's own measure, `vm_stat` on macOS) to set `maxAgents`; one
  full task (the first migrated repo's) run by `k run --watch` end to end, its `k cost` against the workspace's
  baseline (orchestrator.md §6).

## Slice 3: the cache keeper. Closes R11, D9

- Files: `lib/keeper.mjs` (the rule of orchestrator.md §5, `decide(conversation, now) → keepalive | skip | none`,
  `k keep --session`, `k keeper report`), `hooks/statusline-track.mjs` (one line in the user's status line command,
  printed by `k install --print`), `hooks/kirunak-session.mjs` (SessionStart on `resume`: records hit or miss from
  `prompt_cache_likely_expired`, `context_tokens`, `estimated_cache_write_usd`; `k install` adds its block), the
  runner's `keepAlive`.
- Tests: the break-even from the prices seam (19 intervals at 1h, 11.5 at 5m; threshold minutes 950 at 50-minute
  intervals; a changed price moves it); the decision table (will resume and wait under threshold → keepalive at
  `expires_at − (TTL − interval)`, 10 minutes before the expiry at 50-minute intervals; waits for the owner → skip;
  expired → miss); the session file written from a statusline JSON fixture; the report sums per task.
- Numbers: a keep-alive's weight measured at about `0.1 × C` (its run record); two keep-alives 50 minutes apart on
  one conversation: the second's `cache_read_input_tokens` equals the context (the TTL did reset); misses per task
  against the baseline's miss rate; whether `-p` runs on the account get the 1-hour TTL (prompt-caching.md says so
  within plan usage: check the first keep-alive's `cache_creation.ephemeral_1h_input_tokens`).

## Slice 4: review and acceptance. Closes R13, R14, R15 (with slice 1's `k accept` and `k-done`)

- Files: `lib/review.mjs` (`k review check`, the grammar of review.md §2), `lib/checklist.mjs` (`k checklist`),
  the review kind in `lib/steps.mjs` (fresh session, the three inputs copied to `steps/S-review/in/`), the
  reviewer's brief template, `k accept` reading the verdict and the checklist.
- Tests: grammar (a missing row, an extra row, `met` without evidence, `file:line` past the file's length, a test
  name not in the named file, the verdict line); the review step refuses a shared session id and an input outside
  the three; `k checklist` lists exactly the needs-device and needs-owner rows; `k accept` refuses an unticked item
  and no verdict, records `--checklist-open`.
- Numbers: the review of the first migrated task: its cost (`k cost`), the rows it marks `needs owner`, and whether
  its `met` evidence stands when the owner checks two rows by hand.

## Slice 5: the phone board. Closes D13

Built 2026-10-21 (gulnya/kirunak-phone S-1, S-8; amendment A-9), in place of the sync step this slice first named.
Slice 5 was to check one thing before building on it, whether a Claude step could publish the page; S-1 measured the
mod's side of that and the answer changed the design (`boards.md` §3 has the evidence): a mod cannot publish, so the
board reaches the phone by two commands the owner types and nothing else refreshes it.

- Files: `lib/board-model.mjs` (the one order every surface uses, `boards.md` §2), `lib/board.mjs` (the page, `k board
  --html <file> --no-open`), `lib/board-md.mjs` (`k board --markdown`, with `--json` as `{ markdown }`, and `k board
  --card <id>`, one task's card alone), `lib/board-brief.mjs` (`k board --brief`, with `--json` as `{ made, text, ids,
  groups, machine }`: the brief board of the mod's `/k-board` dialogs, its groups and its machine line),
  `skills/k-board-page/SKILL.md` (`k install` links it, `k doctor` checks it), `$KIRUNAK_HOME/board-artifact.json` (the
  one link the skill keeps). The mod's `/k-board` is slice 6. There is no `sync` step kind and no `k board --artifact`.
- Tests: `board-model.test.mjs` (the order, the sections); `board.test.mjs` (the page has no form, button or script, no
  `file://` link under `--html`, follows `data-theme`, 17 text pairs held at 4.5:1 or more in both themes);
  `board-md.test.mjs` (a word-for-word fixture, no line broken inside a paragraph or a list item however long, a card's
  AC and E cut at 70 characters with "…", "kirunak" once, `--card <id>` the board's card and an id that names no task
  refused); `board-brief.test.mjs` (a word-for-word fixture, plain text with no markdown mark and one line per entry
  however long, each group named and counted in the board's order, a group's name never starting with a digit, the
  machine's line, `--brief --json` as the printed text); `skills.test.mjs`.
- Numbers, measured: the page at 390 px wide in headless Chrome, scrollWidth 390 of 390 with a 40-character id and an
  80-character path; `k board --markdown` on the live workspace, 223 lines (1,077 before it was made pane-sized, the
  owner's decision of 2026-10-21); the new "Working on now" ground 5.57:1 to 14.60:1 light and 6.95:1 to 13.03:1 dark;
  `npm test` 344 of 344 at S-8's first build and 346 after the pane-sized form. Not yet measured: the cost of one
  `/k-board-page` turn (expected about a fresh session's opening context, more in a long one); the owner's phone check
  of the published page is S-10's.

## Slice 6: the mod. Closes D14

- Files: `mods/kirunak/` (boards.md §4), `claude plugin validate` and `claude plugin test` green, `tsc -p`.
- Tests (`*.test.ts`): the pane renders rows from a `k list --json` fixture; `/k-approve` with origin `sdk`,
  `plugin`, `peer`, `unclassified` refused and nothing run; with `composer` or `bridge` the verb runs and the state
  line prints; a `build-ended` event line toasts; `/k-done` is not registered by the mod.
- On the phone: a `/k-accept` typed in Remote Control arrives as `bridge` and runs (the owner's answer of
  2026-10-19, `README.md` question 2).
- Numbers: the mod's load time at session start; the clock hook's cost (it must spawn `k` no more than every 30 s).
- Built 2026-10-19 (branch `slice-6/mod`): validate, test (20) and `tsc -p` green; the numbers are in `boards.md` §4
  (no measurable load time; two reads of 0.08 and 0.07 s every 30 s, a test holds the cadence). The phone check
  passed the same evening: a `/k-accept` typed in Remote Control arrived as `bridge` and ran (`boards.md` §4).
- The phone commands, built 2026-10-21 (gulnya/kirunak-phone S-5, S-6, A-9): `/k-list`, `/k-board`, `/k-amendments`,
  `/k-approve-amendment`, `/k-queue`, and `/k-approve`, `/k-accept`, `/k-hold`, `/k-start` with no id opening the
  owner's choice dialog (`boards.md` §4); the tap is the owner's gesture by the rule of `approval.md` §5, held in
  `hooks/owner.ts`. Tests: `rule.test.ts` and `commands.test.ts` (every origin refused before any read or dialog;
  a dialog the model raised runs nothing), `dialog.test.ts`, the AC-12 walk of every dialog, `lists.test.ts`,
  `pick.test.ts` (all under `mods/kirunak/tests/`). Numbers: `claude plugin test` 79 of 79 (50 before S-6); `npm test` 354 of 354 after the states
  merged; `k list --json --all` piped whole at 90,372 bytes (the pipe cut it at 64 KiB until `k` exited only after
  stdout and stderr flushed). The phone check of the dialogs is S-10's.
- The queue on the phone, built 2026-10-21 (gulnya/kirunak-phone A-11, S-19, branch `phone/queue`): Back is the
  lowest choice of every dialog, below More and Cancel; `/k-queue`'s lines are numbered by queue place, parked tasks
  unnumbered; Move lists Earlier and Later first, each a tap running `k queue move --before` or `--after` by id
  (`hooks/owner.ts`, `picks.ts`, `lists.ts`). Tests: `touch.test.ts` (Earlier and Later at the first, a middle and the
  last task; place numbers on every page), `dialog.test.ts` (Back last in every dialog kind). Numbers: `claude plugin
  test` 115 of 115; `npm test` 369 of 369.
- `/k-resume`, built 2026-10-21 (gulnya/kirunak-phone A-12, S-21, branch `phone/resume`): the tasks on hold by touch,
  the one picked with its title and state above "Resume <id>", running `k resume <id>` by id; `/k-resume <id>` typed
  runs at once; the owner's rule as `/k-hold`'s (`hooks/commands.ts`, `owner.ts`, `picks.ts`, `register.tsx`). Tests:
  `touch.test.ts`, `rule.test.ts`, `commands.test.ts`, `dialog.test.ts`, `answers.test.ts`, `pick.test.ts`. Numbers:
  `claude plugin test` 122 of 122; `npm test` 369 of 369.

## Drafts: an intake prepared ahead. Closes R24 to R28

Built 2026-10-22 (gulnya/kirunak-drafts S-3 to S-6, amendment A-11), after slice 6 and before slice 7.

- Files: `lib/drafts.mjs` and `templates/draft.md` (`k draft new|check|drop`, `k drafts`; `--json` and `--dry-run` on
  each); `lib/intake.mjs` (a draft as `--from`, moved by `git mv`); `lib/waiting.mjs` (the `k waiting` line and the
  `drafts` field); the board model, markdown, brief and page, and `k board --card <draft id>`; `mods/kirunak/hooks/drafts.ts`
  (`/k-drafts`); `skills/k-draft/SKILL.md` (new) and a section in `skills/k-intake/SKILL.md`; `k install` links four
  skills and `k doctor` checks them. `design/task-files.md` §1, `intake.md` §1 and `boards.md` say how it works.
- Tests: `drafts.test.mjs` (the skeleton, every refusal, an unknown repo, a duplicate id, a drop that leaves other
  staged files staged, a hook refusing the commit, the list), `freeze-hook.test.mjs` (the hook leaves drafts alone),
  the intake, waiting and board tests (the move and its history, the Drafts group, its order and contrast),
  `install.test.mjs` and `skills.test.mjs`; the mod's `drafts.test.ts` (each tap, a gone draft, the owner-only rule).
- Numbers: `npm test` 420 of 420 (407 after the verbs); `claude plugin test` 138 of 138 (126 before).
- Not yet measured: Start intake in a live session. It sends its prompt from a timer after the command has answered
  (a prompt cannot be submitted inside the hook the turn waits on), so the owner's phone check is the proof
  (gulnya/kirunak-drafts S-10).

## Escalation on the ladder (gulnya/enforced-escalation, built 2026-10-25 on branches `escalate/ladder`, `escalate/hook`, `escalate/run`)

Not a slice of its own: it extends slice 2 (`k run`), slice 1's `k install` and `k doctor`, and the freeze hook, and
ships on by default.

- Files: `lib/ladder.mjs` (the default ladder and hook switches, the refusals, `rungOf`, `above`, `agentsOf`,
  `buildRungFor`), `lib/workspace.mjs` (the `ladder` and `hook` keys), `lib/steps.mjs` (`historyOf`, the failure count
  by rung, `climb`, `escalate`, the briefs), `lib/run.mjs` (`attemptStep`: a build attempt, or a design run then a fresh
  build run; the events and the push line), `lib/notice.mjs` (the three-line notices), `lib/waiting.mjs`,
  `lib/board-brief.mjs` and `lib/board-md.mjs` (the stop group and the card's climbs), `lib/install.mjs` and
  `templates/rung-agent.md` (the `<model>-step` agents, `escalate/config.json`, the seven hook events),
  `lib/doctor.mjs` (the ladder, agent, settings, hook and push checks), `hooks/kirunak-escalate.mjs` and
  `hooks/escalate-state.mjs` (the hook), `hooks/kirunak-freeze.mjs` (the block and the refusals), `skills/k-go-on/SKILL.md`,
  `templates/design-brief.md`. `design/orchestrator.md` §2, `plugins.md` §3 and `approval.md` §7 say how it works.
- `k install` also takes `--agents <dir>` and `--replace-agents`; `k doctor` takes `--settings <file>` and `--agents <dir>`.
- Tests: `ladder.test.mjs`, `climb.test.mjs`, `run.test.mjs` and `review-step.test.mjs` (the sequences per rung, a stop
  never counting, a review not climbing on its verdict), `notice.test.mjs`, `waiting.test.mjs`, `board-brief.test.mjs`,
  `doctor.test.mjs`, `install.test.mjs`, the hook's own tests, `freeze-hook.test.mjs` (the block and every refusal), and
  `skills.test.mjs` (`k-go-on` closed to the model).
- Numbers: `npm test` 528 tests, 527 pass, 1 skipped (the hook's timing test, run with `KIRUNAK_TIMING=1`); the hook
  adds about 26.8 ms median, 30.2 ms at the 95th percentile, to a failed call on a Mac where `node -e ""` takes 20.8 ms
  (limit 50 ms); the freeze hook on an edit is unchanged within 0.4 ms; `historyOf` on 2,000 lines of `progress.md`
  0.13 ms median.
- Not yet measured: `/k-go-on` over Remote Control from the phone (the task's S-16); whether the push arrives is
  Claude Code's (amendment A-1).

## Bugs of accepted tasks. Closes R29

Built 2026-10-26 (gulnya/kirunak-spikes S-1 to S-4, on the branch `bugs/drafts`), on the drafts above: a bug is a
draft with `bug-of`, no new kind of file.

- Files: `templates/bug.md` (new: the draft's skeleton with `bug-of` and Fix written) and `lib/drafts.mjs` (`newDraft`
  with `bugOf`, `notAccepted`, a bug's shape in `checkDraft`, its task and its fix's commits in `check`, `bugOf` in
  `list` and `format`); `bin/k.mjs` (`--bug-of` on `k draft new`, the help); `lib/intake.mjs` (a bug refused unless
  its task is accepted, that task's lines in `notes.md`); `lib/board-model.mjs` (`draftTail`), `board-md.mjs` and
  `board.mjs` (bug of <task> on the board, its brief, page and card); `mods/kirunak/hooks/drafts.ts` (`/k-drafts`' list,
  whole view and Drop) and `register.tsx` (its description); `skills/k-draft/SKILL.md` (a section on bugs) and
  `skills/k-intake/SKILL.md` (the one proposal). `REQUIREMENTS.md` R29, `design/task-files.md` §1, `intake.md` §1
  and `boards.md` §2 and §4 say how it works.
- Tests: `drafts.test.mjs` (the skeleton kept in step with the draft's, a bug in another repo than its task with that
  task's folder byte for byte the same and still done, a task unknown or not accepted, the shape rules, no state
  field, a task gone or a fix commit in neither repo, the list, the format and the CLI), `intake.test.mjs` (a bug's
  `notes.md` from a task in another repo and in its own, a plain draft's without it, the refusals with nothing moved
  or written), `board-model`, `board-brief`, `board-md` and `board.test.mjs` (a bug's line on each surface, a plain
  draft's unchanged); the mod's `drafts.test.ts` (the list, the whole view, Drop by id, no command for bugs).
- Numbers: `npm test` 664 tests, 662 pass, 2 skipped (the timing tests, run with `KIRUNAK_TIMING=1`);
  `claude plugin test` 139 of 139.
- Not yet measured: a bug in `/k-drafts` from the phone, and the two bugs of katyafm/music-variety written as drafts
  (S-5), once the branch merges and the mod runs it from the main checkout.

## Slice 7, later and not detailed here: R17, R18

Trackers (Linear, It's a Plan, GitHub Issues) and cloud sync as plugins on the `tracker` and `sync` seams, with
the task files as the source of truth; the other repos' migration (D8: only after the first repo runs on kirunak).
