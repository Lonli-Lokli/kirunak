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
- **A board**: `k list` in the terminal and a generated page (`k board`).
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
   the `k-intake` and `k-done` skills into `~/.claude/skills/`. It also prints one line to add to your status line
   command, so the cache keeper sees each session's context and cache; it never edits your status line itself.
   `--print` shows what it would do and writes nothing. A repo that already
   has a pre-commit hook gets the one line to add, printed, instead of a new hook. `--git` also writes a starter
   `.slapignore`, the files left out of a commit's size (R21), when the repo has none: read it, type
   `! k slapignore approve ~/code/app`, and commit it.

4. In Claude Code, start your first task with `/k-intake`. When `k check` passes, type `! k approve <id>`.

The state kirunak keeps on this machine (the pointer, logs, the board) is in `~/.kirunak`, or wherever
`KIRUNAK_HOME` points.

## Working a task

Until the orchestrator lands (`k run`, slice 2 in `design/build-order.md`), the queue is an order you read and a
task is started by hand, one task per session:

1. `k queue show` lists the approved tasks in order. Only the owner changes it:
   `! k queue move <id> --first` (or `--last`, `--before <id>`, `--after <id>`).
2. Open a fresh Claude Code session in the task's repo and ask it to work the task by its id. The session runs
   `k start <id>`, which records which task that session is on and changes nothing else.
3. The session keeps its plan and progress beside the task, in `plan.md` and `progress.md`, never in `task.md`.
   `k list` shows the task as in progress once `progress.md` has a line such as `S-1 started`.
4. A change to what the task asks for is an amendment: `k amend new <id>`, then the owner types
   `! k approve <id> --amendment A-n`.
5. The plan's review step writes `review.md` in a fresh conversation, and `k review check <id>` holds it to the
   grammar. `k checklist <id>` then writes `checklist.md` from its `needs device` and `needs owner` rows; only the
   owner ticks them.
6. When the owner judges the task done, `/k-done` in that session, and the owner types `! k accept <id>`. It refuses
   without the review's verdict and while a checklist item is unticked; the owner may accept with items open by
   adding `--checklist-open "<why>"`, which is recorded.

MIT licence: `LICENSE`.
