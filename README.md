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

   `k install` adds one PreToolUse hook to `~/.claude/settings.json` (keeping yours) and links the `k-intake` and
   `k-done` skills into `~/.claude/skills/`. `--print` shows what it would do and writes nothing. A repo that already
   has a pre-commit hook gets the one line to add, printed, instead of a new hook.

4. In Claude Code, start your first task with `/k-intake`. When `k check` passes, type `! k approve <id>`.

The state kirunak keeps on this machine (the pointer, logs, the board) is in `~/.kirunak`, or wherever
`KIRUNAK_HOME` points.

MIT licence: `LICENSE`.
