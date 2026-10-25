# kirunak: a task system for Claude Code workspaces. Requirements

kirunak (кірунак) means direction. Status: **approved by the owner** (D1-D14, R1-R28). A change from here on is an
amendment the owner approves (R7 applies to this file too). "The owner" is the person whose workspace kirunak serves:
the one who approves tasks and says when one is done. A **workspace** is the set of repos one owner works on with
Claude Code on one machine.

## Why

kirunak is for a solo developer or a small team building software with AI coding agents (Claude Code), where the
agents do most of the work and one person decides what is wanted and when it is done. Spec notebooks drift when
agents keep them. An agent that works through a task list rewrites its text as it goes: it ticks boxes, rewords
criteria to fit what it built, and adds items no one asked for. A planning tool's own features (spec deltas,
validation, archives) then go unused, and what the owner needs is not in it:

- an intake that leaves nothing to guess, so a task says what the owner decided, not what an agent assumed;
- tasks no one changes without the owner's approval;
- a review against every point of the task, by someone who did not do the work;
- an orchestrator that suits one machine and a usage limit: one heavy build at a time, no agent kept alive while it
  waits, warm caches across long waits, and the tokens of every step recorded.

## Decisions

- D1 **A small core with plugins**, not a framework, and not built on a tracker that needs a server and a database
  (It's a Plan: AGPL, Docker and Postgres) or on a tool built around parallel builds in worktrees (plan-bender). Their
  ideas may be borrowed (an interview, thin slices, blocked-by).
- D2 **Its own repo**, apart from the workspace it serves. The core carries nothing specific to any workspace: a
  workspace's own parts (its checklist, its resource guard, its handoff, its queue file, its config) are plugins and
  config kept in the workspace's own repo. kirunak is open source under the MIT licence (`LICENSE`).
- D3 **Plugins** at every seam, so it can grow into a full tracker (a Linear replacement) later.
- D4 **Tasks live in their repo** (in git), with **one queue** across the workspace, since one machine serves all of
  it.
- D5 **People see the tasks.** Local first, built so it can move to the cloud later without changing the task format.
- D6 **Old planning records are history.** A workspace that planned in openspec keeps those folders, read-only; a
  change becomes a task only when it is picked up again, through the intake.
- D7 **Approval by hooks and the owner's own gesture**: a Claude Code hook blocks agents from editing a frozen task,
  a git hook checks the task's hash against its approval record, and only the owner's own gesture approves: a
  command the owner types (with `!`, or the mod's command, D14), or a choice the owner taps in a dialog that such a
  command opened, answered while it runs. This guards against mistakes, not a deliberate bypass.
- D8 **One repo migrates first, as the first thing kirunak does**: as soon as the intake works, that repo's open
  changes become kirunak tasks through it, and its work runs on kirunak from then on. Other repos follow only after
  that. So the first slice built is the one that migration needs: the task files, the intake, approval and the board.
- D9 **Caches stay warm through waits over an hour**, and every keep-alive and miss is recorded.
- D10 **The first version shows a generated board page**: readable files in git, a command-line list, and a board page
  generated from the files and opened in a browser, with no server. A served board comes with the cloud.
- D11 **A frozen planning tool is refused, not only discouraged.** A workspace that freezes openspec does it with its
  own PreToolUse hook, which refuses changes to the openspec folders and tells the agent how to migrate; reading stays
  allowed. Once kirunak's intake exists, those instructions name it. kirunak ships the instruction text, not the hook.
- D12 **Every kirunak command carries the `k-` prefix**, so it never meets a built-in, plugin or Anthropic command of
  the same name: `/k-done` closes a task and asks for `/clear`; the intake, approval and review commands follow as
  `k-<verb>`. A workspace's other skills keep their names.
- D13 **A board on the phone**: on the owner's command and nothing else, the board reaches the phone two ways. The mod's
  `/k-board` shows the board in brief, with no model turn, in a dialog of the owner's own command: the groups with how
  many tasks each holds, a group's tasks one line each once picked, a task's card in the chat once tapped; the skill
  `/k-board-page` publishes the generated board as a private claude.ai artifact, read-only, a brief row per task that
  opens its card in place, updating the one link it keeps, in one model turn (an artifact is published through Claude's
  tools, which ask on every publish, so a Claude turn the owner's command asks for does it; a mod cannot). Approvals
  never happen on a page: anything a page records could also be written by an agent acting as the owner, so they stay
  the owner's own gesture (D7). A front end over the task files, like the others.
- D14 **A Claude Code mod as the working view**: a pane or panel with the current task, its criteria and their review
  state, the queue and the build lock; a line above the prompt; toasts when a build ends, a review is ready, a cache
  is kept warm or an openspec change is refused; the `k-` commands. A mod's registered command runs without the
  model and carries an engine-stamped origin the model cannot produce (`design/approval.md` §5), so it is the
  owner's approval command in place of `!`, typed at the terminal or through Remote Control; `!` stays for sessions
  without it. With no id, the owner's commands list what they can take in the engine's choice dialog, raised only
  by the owner's own command and answered while it runs, so a tap there is the owner's gesture (D7). A mod is
  specific to Claude Code, so it stays one front end, a plugin over the core.

## Requirements

### Intake: nothing guessed
- R1 A task enters the queue only through an intake interview with the owner. The interview method is kirunak's own:
  one question at a time, edge cases proposed, every ruling recorded; it relies on no skill kirunak does not ship.
- R2 The interview walks a checklist of aspects; the checklist is a plugin. A workspace's checklist names what its own
  rules ask of every change (for example the platforms, both themes, large text, right-to-left, locales, offline,
  low-end devices and memory, screen readers, purchases, data kept across versions, the release gates).
- R3 For each aspect the interview proposes edge cases; the owner rules each in or out, and what is out is written down.
- R4 Every line of a task names its source: the owner's answer (dated), research (linked), or a default the owner
  accepted. A task cannot become ready with an open question.

### Drafts: an intake prepared ahead
- R24 A **draft** is an intake prepared ahead for a task that does not exist yet. It is kept in git in the repo its
  task is for, as `kirunak/drafts/<slug>.md` beside `kirunak/tasks/`, and its id is `<repo>/<slug>` from the start;
  the task started from it keeps that id. A draft for a repo the workspace does not know is refused, and the agent
  asks the owner to add that repo first. An id that is already a draft or a task is refused, and named.
- R25 Any session or agent writes a draft without the owner's approval: a draft is not a task, and it approves and
  freezes nothing. It writes one when the owner names a future task, and when it finds something itself that is
  worth its own task, instead of keeping it only in scratch files or a session's memory. It then says in one line
  of its reply that it wrote a draft, and its id.
- R26 A draft holds its id and a title of a few words; who raised it (the owner's words as typed, with the date and
  the session, or found by the agent, with what it saw); why; what was already found (files, commands, research),
  each with its source; and the questions for the owner's turn, numbered. kirunak checks that shape when the draft
  is written. Nothing in a draft is a ruling: an intake started from it reads it as background, as it reads an
  openspec change (R20), starts from its questions and still asks the owner every line of the task (R1, R4). That
  intake moves the draft into the new task's folder, as `kirunak/tasks/<slug>/draft.md`, and out of the drafts, so
  it never waits twice; git keeps its history.
- R27 The owner drops a draft from `/k-drafts`, typing the reason; with no reason, nothing runs. An agent may drop
  one too, and says in its reply which one and why. Either way kirunak removes the file in a commit of that file
  alone, whose message carries the reason, so git keeps both. Dropping is not one of the owner's verbs: the hooks
  that guard approval (D7) leave it alone.
- R28 Drafts show in `/k-drafts`, typed at the terminal or through Remote Control: every draft in every repo of the
  workspace, one line each (its id, title and the date written), in the owner's own dialog (D14); a draft picked
  shows whole, with Start intake (the session starts the intake from it), Drop and Back. The waiting summary
  (`k waiting`) says in one line how many drafts wait and names `/k-drafts`. The board, in brief and as its page
  (D10, D13), shows a group Drafts after the tasks, one line per draft. The task list (`k list`) lists tasks only.

### The task is frozen
- R5 On approval, the task's file is frozen: its goal, numbered acceptance criteria (AC-1, AC-2, ...), numbered edge
  cases (E-1, ...), what is out of scope, and the owner's decisions.
- R6 Progress, notes, the plan and the review live in other files. Nothing writes results into the task.
- R7 A change to a frozen task is an amendment, proposed in its own file, applied only after the owner approves it (D7).

### Plan and orchestration
- R8 A plan maps steps to the AC and E numbers; it may change without approval, and every AC and E is covered.
- R9 Each step is one bounded job (about 100 calls at most), with its inputs and outputs as files. A step starts only
  when its inputs exist. No agent is alive while it waits for another step or a build.
- R10 Heavy jobs (builds, tests, emulators, simulators) run outside agents, through a resource-guard plugin, one at a
  time. The core's default guard is a lock in kirunak's state folder; a workspace with its own lock supplies a plugin.
  The number of agents running at once is capped by a machine guard. It counts headless steps and the subagents a
  step is allowed; the owner's interactive sessions are not counted (nothing can cap them).
- R11 A cache keeper tracks each live conversation's last call, context size and cache lifetime; it keeps the cache
  warm while the expected wait stays under the break-even, where a keep-alive stops paying for itself, and records
  every keep-alive and every miss. The break-even is a ratio, not hours: (cache write price − cache read price) /
  cache read price keep-alive intervals, taken from the `prices` seam so a price change moves it. At today's prices
  that is 19 intervals under a 1-hour cache (`(2 − 0.1) / 0.1`): 17.4 hours at 55-minute intervals, 15.8 at 50;
  under a 5-minute cache, 52 minutes.
- R12 Each step records its token use, so a task's cost can be measured against a baseline the workspace supplies.
  What is compared: the median and p90 context per call, the share of calls over a context size the workspace sets,
  the weight per repo and working day, and keep-alives and misses per task (the baseline is per call and per
  period, so it has no per-task figure to compare with directly).

### Review and acceptance
- R13 The reviewer is not the agent that did the work. It gets the frozen task, the diff and the evidence, not the
  implementer's account.
- R14 The review has a row for every AC and E: met, not met, or needs a device or the owner. "Met" needs evidence: a
  test name, a file and line, a measurement or a screenshot.
- R15 What needs a device or the owner becomes the owner's checklist. A task is done only when the owner says so
  (kirunak's `k-done` skill).

### Change size
- R21 Every commit in a repo where kirunak's git hooks are installed is measured by SLAP:
  `SLAP = √L × √F_adj`, where L is the lines added plus deleted and F the files changed, and
  `F_adj = F × min(1, (L/F) / 5) + ln(1 + max(0, L/F − 50))`. Nothing is left out by default: the repo's
  `.slapignore` (gitignore patterns, at its root) lists every file left out, and a file deleted whole is left out.
  Tiers: S up to 10, M 11 to 35, L 36 to 70, XL 71 and over. A workspace installs the hooks in every repo it wants
  measured, on kirunak or not; installing writes a starter `.slapignore` (lock files, build output, minified files
  and source maps, the binary types the repo tracks, Markdown, plain text, tables) into a repo that has none.
- R22 An L or XL commit is refused, with no override: it is split into smaller commits. A commit with a binary file
  that `.slapignore` does not list is refused, naming the pattern to add. Every other commit records its score as a
  line `SLAP: <score> (<tier>)` in its message.
- R23 A repo's `.slapignore` is the owner's: the owner approves its content with a command only they type, which
  records its hash; the git hook refuses a commit whose `.slapignore` differs from the approved hash, and an agent's
  edit of it, or the approve command from an agent, is refused as for a task.

### Escalation
- R24 A step that fails twice goes up a model ladder on its own (gulnya/enforced-escalation). The workspace's `ladder`
  lists the rungs; kirunak's default is Sonnet, Opus at high effort building, and Fable at high effort designing for
  a fresh Opus run to build, one attempt a rung. `k run` counts the failures, never a stop or a review's `not met`
  verdict, and stops the task for the owner only when the top rung has failed, naming every failure report. In an
  interactive session an installed hook counts repeated build and test failures, tells the session once to hand the
  step one rung up, and blocks edits at the next failure until an agent of that rung has run or the owner types
  `/k-go-on`, which the model cannot run. A workspace can turn the hook or the block off, and `k doctor` says so.
  Every escalation is recorded; every notice is at most three lines, names the task by title and id, and says what to
  do next; the push to the phone is best effort. `design/orchestrator.md` §2, `design/plugins.md` §3,
  `design/approval.md` §7.

### Visibility, cloud, trackers
- R16 Tasks are readable files in git. A list and a generated board page can be seen locally (D5, D10).
- R17 Storage and sync are plugins, so the same tasks can later live in the cloud.
- R18 Tracker plugins later (Linear, It's a Plan, GitHub Issues), with the task files as the source of truth.

### Product
- R19 Node, with no dependency beyond Node's own modules; no Python.
- R20 openspec folders stay readable and untouched (D6, D11). kirunak's intake can start a task from an openspec
  change, reading it as background; that is the migration path a workspace's freeze hook names.

## Open questions for the owner
None in the requirements. The design's questions are in `design/README.md`.

## Next steps
1. The owner approves these requirements. Done.
2. The design (`design/`): the task files and their states, the plugin interface, the orchestrator (step lifecycle
   with headless `claude -p`, the agent cap, the build lock, the cache keeper), the approval mechanics, the review
   record, and converting an openspec change. With the tests that prove it and the numbers to check. Done.
3. Build from the design, the slice the first repo's migration needs first (D8), and migrate that repo at once: its
   open changes become tasks through the intake, and its next work runs on kirunak. Then the rest of the design (the
   orchestrator, the cache keeper, review, the phone board and the mod), each slice proven on that repo.
4. Measure tokens per task and cache misses against the workspace's baseline, then roll out to the other repos.
