# kirunak

kirunak (кірунак, "direction") is a task system for a solo developer or a small team building software with AI
coding agents (Claude Code), where the agents do most of the work and one person decides what is wanted and when it
is done.

## What it is

- **An intake that leaves nothing to guess.** A task starts with an interview (`/k-intake`): one question at a time,
  edge cases proposed and ruled in or out, every line of the task tagged with its source (the owner's answer, a
  research link, or a default the owner accepted).
- **Tasks agents cannot rewrite.** The owner approves a task with a command only they can type (`! k approve <id>`).
  From then on a Claude Code hook refuses an agent's edit of it, and a git hook refuses a commit whose task no longer
  matches its approved hash. A change is an amendment the owner approves.
- **A review against every criterion**, by someone who did not do the work, and an owner's checklist of what needs a
  device or a person. A task is done when the owner says so (`/k-done`).
- **A board**: `k list` in the terminal, a generated page (`k board`), and on the phone a brief board, in the chat
  (`/k-board`: the groups, then a group's tasks, then a task's card) or as a private page you open (`/k-board-page`).
- **Drafts.** An idea for a task that comes up in the middle of other work is kept in git as a draft, not lost in
  scratch files: `k draft new <id> --title "..."` writes the skeleton in `kirunak/drafts/`, `k draft check <id>` holds
  its shape, `k draft drop <id> --why "..."` removes it with the reason in the commit, and `k drafts` lists them. A
  draft is not a task and nothing in it is a ruling. Start the intake from one (`/k-drafts`, or `k intake start <id>
  --from kirunak/drafts/<slug>.md`): it moves into the task's folder as background and the intake asks every line
  again. A bug found in a task already accepted is a draft too, `k draft new <id> --title "..." --bug-of <task>`: the
  task stays closed, the draft may name a fix written already, and it shows among the drafts as bug of <task>.
- **Small commits.** Every commit is measured, and one over size M is refused (below, "Change size").
- Plain files in git, one folder per repo (`kirunak/`), one queue across your repos. No server, no database, no
  dependency beyond Node.

The rest is in `REQUIREMENTS.md` and `design/`.

## Setup

You need Node 22 or later, git and Claude Code.

1. Put `k` on your PATH:

   ```sh
   git clone <this repository's URL> kirunak
   cd kirunak && npm link
   ```

2. Write a **workspace module** in a repo of yours (not in this one): the repos kirunak serves, where the queue file
   lives, and your plugins. A checklist plugin is required: the aspects your own rules ask of every change (platforms,
   themes, locales, offline, and so on), each with its sources and the edge cases that went wrong before. Shape:
   `design/plugins.md` §3; the checklist: `design/intake.md` §3.

   ```js
   export default {
     repos: [{ name: 'app', root: '~/code/app' }, { name: 'hub', root: '~/code/hub' }],
     queue: '~/code/hub/kirunak/queue.md',
     plugins: ['./plugins/checklist.mjs'],
   };
   ```

   Commit it with the queue file (one comment line is enough to start).

3. Point kirunak at it, wire the hooks and skills, and add the git hook to each repo that will hold tasks:

   ```sh
   k init --workspace ~/code/hub/kirunak/workspace.mjs
   k install
   k install --git ~/code/app
   k doctor
   ```

   `k install` adds a PreToolUse hook and a SessionStart hook to `~/.claude/settings.json` (keeping yours) and links
   the `k-intake`, `k-draft`, `k-done` and `k-board-page` skills into `~/.claude/skills/` (`k-board-page` publishes the board as
   a page, below). It also prints one line to add to your
   status line command, so the cache keeper sees each session's context and cache; it never edits your status line
   itself.
   It also writes what escalation needs (below): one `<model>-step` agent in `~/.claude/agents/` for every rung of the
   ladder above the lowest, `escalate/config.json` in the state folder, the escalation hook on eight events, and the
   `k-go-on` skill.

   It also sets up the **handover** (`design/orchestrator.md` §5): a session working a task compacts by itself at the
   next step boundary once its context passes the handover size, and kirunak puts the task's files and state back.
   The compact hook goes on PreCompact (`auto|manual`: it holds an automatic compaction while a step the session
   started is running), SessionEnd (`clear`: it hands the task to the session id `/clear` starts) and SessionStart
   (`compact|clear`, four blocks, one per part it puts back: the state, `task.md`, the plan's open steps and the end
   of `progress.md`). The window is set per repo, never in your own settings file: `k install` writes
   `"autoCompactWindow": 183000` (the handover size, 150,000 by default, plus the 33,000 Claude Code compacts under
   the window) into each workspace repo's own `.claude/settings.local.json`, keeping every other key there, and into
   each folder the workspace's `compact.alsoIn` names. A session in a subfolder or a worktree of a repo reads the
   file at the main checkout's root, so that is where it is written. The file is personal: when git does not ignore
   it already, `k install` adds `/.claude/settings.local.json` to the repo's `.git/info/exclude`, and a file git
   tracks is left alone and named. It never overwrites a window that is not its own: a value you set in that file, a
   window in the repo's committed `.claude/settings.json`, a per-model `modelSettings` window and the
   `CLAUDE_CODE_AUTO_COMPACT_WINDOW` variable are each named, with what to change, and `k doctor` fails them until
   you do. A compaction in the middle of a step waits for the **mid-step limit**, by default 167,000 tokens of
   context (a 200,000 window, measured as the least weight); `compact.midStepLimit` sets another number, or `'user'`
   for your own `autoCompactWindow` (the one in `~/.claude/settings.json`, or Claude Code's own point when you set
   none), so it never comes sooner than it does without kirunak. `k install` and `k doctor` name your window, and
   each `modelSettings.<model>.autoCompactWindow` beside it, as yours; neither writes it. A session outside every
   workspace repo keeps your own window, and the hook never holds its compaction. `k run`'s steps keep your own
   window too, through the variable. `compact: { enabled: false }` turns it off, and the
   next `k install` takes its window back out (`design/plugins.md` §3).

   `--print` shows what it would do and writes nothing. A repo that already
   has a pre-commit hook gets the one line to add, printed, instead of a new hook. `--git` also writes a starter
   `.slapignore`, the files left out of a commit's size (R21), when the repo has none: read it, type
   `! k slapignore approve ~/code/app`, and commit it.

4. In Claude Code, start your first task with `/k-intake`. When `k check` passes, type `! k approve <id>`.

5. Optional: load the mod, `mods/kirunak/`, so the owner's verbs are slash commands (`/k-approve`, `/k-accept`,
   `/k-hold`, `/k-resume`, `/k-start`) that also work from the phone through Remote Control, with a pane
   (`/kirunak`), a line above the prompt and toasts. Add this checkout as a marketplace, install the mod from it and
   start a new session:

   ```sh
   claude plugin marketplace add ~/code/kirunak
   claude plugin install kirunak@kirunak
   ```

   (Or name its folder in the `env` block of `~/.claude/settings.json`:
   `"CLAUDE_CODE_PLUGIN_DIRS": "~/code/kirunak/mods/kirunak"`.)

   **From the phone**, in Remote Control, the mod gives you these (a command that takes an id opens a dialog of
   touch choices when you type it without one; its list names each task or amendment and nothing more, and the one
   you pick shows its details in the next dialog):

   | Type | You get |
   | --- | --- |
   | `/k-list` (`/k-list all`) | the tasks, the queue first, as numbered entries with state, place, title and step |
   | `/k-board` | the board's groups (working on now, queued, done this week and the rest) and how many tasks each holds, at once and without a model turn; tap a group for its tasks, a line each, then a task for its card, or Skip for the brief board as text |
   | `/k-board <id>` | that task's card: its state, step, session, approval and every AC and E with its verdict |
   | `/k-board-page` | the skill: the board as a private page on claude.ai, a brief row per task that opens its card when tapped; one model turn; it updates the one link it keeps in `$KIRUNAK_HOME/board-artifact.json` |
   | `/k-drafts` | the drafts waiting, by the date written, as numbered entries; the one picked shows whole, with Start intake (the session starts the intake from it), Drop (you type the reason, then confirm) and Back |
   | `/k-approve`, `/k-accept` | what waits for you, each task's id and state, to pick by touch; the one picked shows its title, state and what still blocks it, above a last choice that names the task ("Approve <id>") |
   | `/k-amendments` | the amendments waiting, each one's task, A-n and name, to pick by touch; the one picked shows in full (date, Why, Changes, what blocks it), to approve or decline; `/k-amendments <n>` shows one in full, `/k-approve-amendment <n>` approves it |
   | `/k-hold`, `/k-start` | the tasks you can put on hold or work on, each task's id and state, by touch; the one picked shows its title |
   | `/k-resume` | the tasks on hold, each task's id and state, by touch; the one picked shows its title and state above "Resume <id>", which takes it off hold; `/k-resume <id>` does so at once |
   | `/k-queue` | the queue in order, then the parked tasks, each line numbered by the task's place in the queue with its id, state and title, to pick by touch; the one picked can be moved one place earlier or later, before another task or to the end, parked or put back |

   A tap in these dialogs is your own gesture, like a typed command; `/k-board-page` is the only one of these that
   uses the model, and nothing on a page approves anything (`design/boards.md` §3, `design/approval.md` §5).

   Its commands run `k` only when you typed them (at the terminal, or in Remote Control); any other origin, the
   model included, gets a line saying so and nothing runs (`design/approval.md` §5). That rule is a file of this
   checkout, which the session reloads when it changes, so it guards against mistakes, not against an edit of the
   checkout itself. Load the folder itself, never a copy: the mod runs this checkout's `bin/k.mjs`.
   `npm run test:mod` runs its tests.

The state kirunak keeps on this machine (the pointer, logs, the board) is in `~/.kirunak`, or wherever
`KIRUNAK_HOME` points.

## Change size

Small changes are reviewed better and ship more safely, so every commit is measured and one larger than M is
refused, an agent's or your own. An agent's work then arrives in pieces a person can read in one sitting.

The measure is SLAP, from the lines added plus deleted (L) and the files changed (F), rounded to a whole number:

```text
SLAP = √L × √F_adj        F_adj = F × min(1, (L/F) / 5) + ln(1 + max(0, L/F − 50))
```

The first part of `F_adj` weighs less a file with only a few changed lines (a rename, a sweep across many files); the
second adds weight once the files average more than 50 changed lines (one large file). The tiers: S up to 10, M 11 to
35, L 36 to 70, XL 71 and over.

| The commit | SLAP | Tier |
| --- | --- | --- |
| 10 lines in 1 file | 3 | S |
| 45 lines, one in each of 45 files | 20 | M |
| 120 lines in 4 files | 22 | M |
| 207 lines in 1 file | 35 | M, the most one file can take |
| 210 lines in 1 file | 36 | L, refused |
| 300 lines in 5 files | 47 | L, refused |
| 1,500 lines in 1 file | 111 | XL, refused |

At most M is about 207 changed lines in one file, 250 over 5 files, 126 over 10 and 79 over 20: spreading a change
over more files lowers the limit.

**What counts** is everything the repo's `.slapignore` does not list. It takes gitignore patterns from the repo's
root and names what is not read as code: lock files, build output, generated files, prose such as Markdown, tables.
`k install --git` writes a starter. A file deleted whole is never counted. A binary file the list does not name
refuses the commit, and the message names the pattern to add. Only the owner changes the list: they edit it and type
`! k slapignore approve <repo>`. Until then the git hook refuses a commit with a changed `.slapignore`, and the Claude
Code hook refuses an agent's edit of it.

`k slap --staged` measures what you are about to commit, and `k slap <range>` a stretch of history. Over M, split
the commit: `git restore --staged <file>` takes a file out, `git add -p` stages part of one. The check runs in git's
prepare-commit-msg hook, so `--no-verify` does not skip it; merges, reverts and cherry-picks are not measured.

## Working a task

Until the orchestrator lands (`k run`, slice 2 in `design/build-order.md`), the queue is an order you read and a
task is started by hand, one task per session:

1. `k queue show` lists the approved tasks in order. Only the owner changes it:
   `! k queue move <id> --first` (or `--last`, `--before <id>`, `--after <id>`). A task out of the queue is
   "parked" (`! k queue remove <id>`, or `k approve --no-queue`): it is approved and starts nothing until
   `! k queue add <id>` puts it back; a task in the queue is "queued". With the mod, `/k-queue` does all of this by
   touch.
2. Open a fresh Claude Code session in the task's repo and ask it to work the task by its id. The session runs
   `k start <id>`, which records which task that session is on and changes nothing else.
3. The session keeps its plan and progress beside the task, in `plan.md` and `progress.md`, never in `task.md`.
   `k list` shows the task as in progress once `progress.md` has a line such as `S-1 started`.
4. A change to what the task asks for is an amendment: `k amend new <id> --title "<a few words>"`, then the owner types
   `! k approve <id> --amendment A-n`.
5. The plan's review step writes `review.md` in a fresh conversation, and `k review check <id>` holds it to the
   grammar. `k checklist <id>` then writes `checklist.md` from its `needs device` and `needs owner` rows; only the
   owner ticks them.
6. When the owner judges the task done, `/k-done` in that session, and the owner types `! k accept <id>` (with the
   mod, `/k-accept <id>`, also from the phone; `/k-accept` alone lists what waits for you to accept, the one you
   pick showing what still blocks it, and `/k-accept 1` takes the first). It refuses
   unless the latest review passes `k review check` and its review step finished, refuses a `not met` verdict and a
   task with no review, and refuses while a checklist item is unticked; the owner may accept with checklist items
   open by adding `--checklist-open "<why>"`, which is recorded and never waives a `not met` verdict. It also refuses
   when the task's own work changed after the review: a later commit to a file the task's own commits touched, or one
   that names the task. Other work committed in the repo, and kirunak's own records (task folders, drafts, approvals,
   the queue), never do. The refusal, `k waiting` and `/k-accept` name each such file with its commit and the task
   that commit names, and the way out is a new review. Once the task is accepted, the git hook refuses a commit that
   names it unless it touches only kirunak's records: new work on it is a new task.

### Escalation: a step that keeps failing goes one model up

kirunak counts failures and hands a step up a **ladder** of models; a session's own opinion of its depth is not the
trigger. It is on by default, installed by `k install`, and the design is `design/orchestrator.md` §2, `design/plugins.md`
§3 and `design/approval.md` §7.

**The default ladder.** A step runs on its own model (Sonnet, or what its plan line names). After its second failure
`k run` goes on without you and hands it to the next rung, one at a time:

| Rung | Effort | What it does | Attempts |
| --- | --- | --- | --- |
| `sonnet` | the step's own | the step's own two attempts | 2, as always |
| `opus` | high | designs and builds the step | 1 |
| `fable` | high | designs the step; a fresh Opus run, at high, builds from the design | 1 |

A Sonnet step that fails on Opus climbs once more, to Fable; if the Fable-led attempt fails, the task stops for you
with every failure report of the step named in `plan.md`. Nothing ever goes from Sonnet straight to Fable.

**Changing it.** The workspace module takes a `ladder`, a list of rungs, lowest first. A rung is `{ model, effort,
mode, attempts, agents }`: `mode` is `build` (this model does the step) or `design` (this model designs it and the rung
below builds from the design, so a design rung needs a build rung directly under it), `attempts` is how many tries the
rung gets, `agents` names your own agents that stand on the rung besides the generated one, and `id` pins a model id.
The lowest rung names only its model. Put Haiku at the bottom and `k install` writes a `sonnet-step` agent, and failed
Haiku steps go to Sonnet. Nothing else sets the ladder: `models.escalate` is no longer read. Shape and refusals:
`design/plugins.md` §3.

**What `k run` counts.** A step that exits other than 0, ends without its outputs, times out or overruns its budget
has failed. A stop (you killed `k run`, or the `k run` that started the step is gone) never counts, and a review's
`not met` verdict is the review's result, not a failure. The record is in `progress.md` (a line per climb and per
stop), `plan.md` (the stopped step is marked `[escalate]` and gets a `failures:` field listing every report), and
`events.jsonl` (each climb with its trigger, and each rung's run with its tokens and cost). A climb the ladder carries
on with sends you nothing; a stop shows first in `k waiting` and `k board --brief`, with the title, the reason and the
folder of the reports, and a `k run` that a session started in the background ends with a line that session sends as
a push.

**The hook.** In an interactive session the escalation hook counts a build or test command (also through
`heavy-lock.mjs`) that fails again on the same test or error after the session edited something in between; a test
written red and then fixed is not counted, a failed edit is not an edit, and a runner's log cut short before its failure
line counts nothing. On the second such repeat it fires, once, with a message of three lines naming the task: a Sonnet
session is told to hand the step to `opus-step`, an Opus session to `fable-step`, a Fable session to stop and say what
is missing. The hook prints nothing in any other call, stays quiet inside a `k run` step (which counts its own), and
adds a few milliseconds to a tool call. A subagent is counted apart and is told to return to its caller marked
`NEEDS-OPUS` or `NEEDS-FABLE`.

**The block.** After the hook has fired, the next failure of the same test blocks Edit, Write, MultiEdit and
NotebookEdit in that session, and only those, so the session can still read, run tests and launch the agent, and a
write through the shell (`sed -i`, `cat >`) is not refused: the block guards against a mistake, not against a
deliberate way round it. Only an agent one rung up lifts it: `fable-step` in an Opus session, and for a block a
subagent's failure set, one rung above the subagent's model, so `opus-step` lifts a Sonnet builder's block. It lifts
only when it ran as that rung (a model of the rung's family, an effort not below the rung's) and finished its run (a
hand-back or a final message, not interrupted); otherwise `escalate.log` records `lift refused` and why. The agent the
session launched after the warning counts too: if it already finished when the block comes, the step failed on that
rung as well, and the block names the rung above (at the top, your `/k-go-on`). Or you can lift it: type `/k-go-on`
in the session, at the terminal or from the phone over Remote Control, which also clears the failures counted so far.
It is yours alone: the skill is closed to the model, a Skill call of it is refused, the hook counts it only when it
arrives as your prompt, and in a `claude` run that another claude started it lifts nothing. A shell command that runs
the hook's scripts is refused as well, since the hook's events come from Claude Code.

**Switches.** In the workspace module, `hook: { enabled, block, repeats, commands }`: `enabled: false` turns the hook
off, `block: false` turns the block off and keeps the message, `repeats` is the repeat that fires (2), and `commands`
is a list of regular expressions for more commands to count beyond the usual test and build runners. `k doctor` says
when the hook or the block is off. Every fire, block, lift, refused lift and override is a line in `escalate.log` in
the state folder, with the trigger, the rung and the signature counted. The hook's state files take a lock, so two
hook calls at one instant do not lose a block or a lift.

**What `k install` and `k doctor` do for it.** `k install` writes `~/.claude/agents/<model>-step.md` from the ladder
(model and effort of the rung), through a link when the file is one, and refuses an agent file it did not write unless
you pass `--replace-agents`. `k doctor` names every rung agent, and every `modelSettings` entry in `settings.json`,
whose model or effort disagrees with the ladder; a Fable entry with any effort; a missing hook event or
`escalate/config.json`; and a push that is off. The push is best effort: the session sends it with Claude Code's
PushNotification tool when `agentPushNotifEnabled` is true in `settings.json`, whether it reaches the phone and what a
tap opens are Claude Code's, and every stop shows in `k waiting` and `k board --brief` regardless.

MIT licence: `LICENSE`.
