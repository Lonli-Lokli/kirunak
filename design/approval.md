# Approval: the frozen task, the hooks, the owner's command

Design (D7, D11, D12, D14, R5, R7, R15). Each choice is marked **evidence** (with its source) or **judgement**.
Index: `README.md`. The examples use the invented task of `task-files.md`, `weather/offline-forecast`.

Three guards, each against a mistake, none against a deliberate bypass (D7): a Claude Code hook that refuses an
agent's edit, a git hook that refuses a commit whose task no longer matches its approval, and a command only the
owner's own gesture runs.

## 1. The approval record

`kirunak/approvals/<slug>.json`, written only by `k approve`:

```json
{
  "task": "weather/offline-forecast",
  "hash": "sha256:3f2a…",
  "approved": "2026-11-05T09:12:00+01:00",
  "by": "owner",
  "via": "shell",
  "commit": "7c1d2e3",
  "history": [
    { "hash": "sha256:9b0c…", "approved": "2026-11-02T19:40:00+01:00", "amendment": null },
    { "hash": "sha256:3f2a…", "approved": "2026-11-05T09:12:00+01:00", "amendment": "A-1" }
  ]
}
```

- `hash` is SHA-256 over the exact bytes of `task.md` (`node:crypto`), so `k verify` and the git hook compute the
  same thing from `git show :kirunak/tasks/<slug>/task.md`. Judgement: bytes, not a normalised text, because a
  normaliser is one more thing to agree on; the intake writes LF and one trailing newline, and `k check` refuses CRLF.
- `via` is `shell` (the owner typed `! k approve ...`, §4) or `mod` (the mod's `/k-approve`, §5). `commit` is the
  sha of the commit `task.md` had when it was approved (`git log -1 --format=%h -- task.md`), so a reader can diff
  the approved text against anything later; the approval commit itself is `git log -1 -- kirunak/approvals/<slug>.json`.
  The hooks never read `commit`; they read `hash`.

## 2. The Claude Code hook: `hooks/kirunak-freeze.mjs` (PreToolUse)

The documented PreToolUse shape: it reads the hook JSON on stdin, prints a `permissionDecision: "deny"` with a reason
the model reads, or exits 0 with nothing. `k install` wires it in the user's `~/.claude/settings.json` on
`Edit|Write|MultiEdit|NotebookEdit|Bash|Skill`, beside any other PreToolUse hook the workspace has (`build-order.md`,
slice 1). Input fields it reads: `tool_name`, `tool_input` (`file_path`, `notebook_path`, `command`, `skill`), `cwd`
(documented for PreToolUse: `session_id`, `transcript_path`, `cwd`, `tool_name`, `tool_input`, `tool_use_id`;
`code.claude.com/docs/en/hooks.md`, fetched 2026-10-18).

It refuses, with the reason that says what to do instead:

| What | Why | The reason it prints |
| --- | --- | --- |
| Edit/Write of `kirunak/tasks/<slug>/task.md` when `kirunak/approvals/<slug>.json` exists in that repo | R5: frozen | "frozen since <date>: propose an amendment in `kirunak/tasks/<slug>/amendments/A-<n>.md` (`k amend new <id> --title "<a few words>"`) and ask the owner to run `k approve <id> --amendment A-<n>`" |
| Any write under `kirunak/approvals/`, to `done.json`, `hold.md`, or an amendment's `applied:`/`declined:` stamp (an Edit whose new text adds one) | D7: only the owner | "only the owner's own command writes this: ask them to type `! k approve <id>` / `! k accept <id>`" |
| A Bash command that writes there (redirection, `tee`, `sed -i`, `cp`/`mv`/`rm` into it, `git checkout`/`restore` of it), found by a small segment parser (split on `;`, `&&`, `\|\|`, `\|` and newlines, then the write targets of each segment) | the same | the same |
| Any write to `kirunak/tasks/<slug>/cost.md` (Edit, Write, or a Bash command that writes there) | generated from `done.json`'s `cost`, which only `k accept` records (`orchestrator.md` §6) | "cost.md is generated from done.json's cost, which only `k accept` records: `k cost <id> --write` writes it again" |
| A Bash command running `k approve`, `k accept`, `k amend decline`, `k hold`, `k resume`, `k queue` (or `k.mjs` with those verbs) | the owner's verbs | "`k <verb>` is the owner's: it runs only from the owner's own prompt (`!`) or the mod" |
| Edit/Write of `kirunak/tasks/<slug>/intake.md` | append-only through `k intake` | "record the question or answer with `k intake question|answer`" |
| Edit/Write of `checklist.md` ticks (`- [x]`) | R15: the owner's checklist | "the owner ticks the checklist" |
| Edit/Write of any `.slapignore`, or a shell write to one (redirection, `sed -i`, `cp`, `rm`, `git checkout`/`restore` of it, a `node -e` that writes it) | R23: the owner's list (`change-size.md` §4) | "`.slapignore` is the owner's (R23): say which pattern to add or remove and why, and ask the owner to edit it and type `! k slapignore approve <repo>`" |
| Any write to `$KIRUNAK_HOME/slapignore.json`, or a Bash command running `k slapignore approve` | R23: only the owner approves | "only the owner's own command writes the `.slapignore` approvals" / "`k slapignore approve` is the owner's" |

It allows everything else: draft `task.md`, `plan.md`, `progress.md`, `notes.md`, `handoff.md`, `review.md`,
`evidence/`, a new amendment file, reading anything, `git commit` of the allowed files (a `.slapignore` too: the git
hook checks it against its approval), every `k` reading verb and
`k intake`, `k check`, `k step`, `k review`, `k board`, `k handoff`. A `k` verb run with `--dry-run` is always
allowed.

- Fails **open** (judgement: a hook that cannot read its input must not stop every session), and logs every refusal
  to `$KIRUNAK_HOME/freeze.log` (`plugins.md` §4). `KIRUNAK_FREEZE_OFF=1` turns it off for the owner's own session,
  logged.
- Finding the repo and the record: from `file_path` (or `cwd` for Bash), walk up to the directory that holds
  `kirunak/`; the slug is the path segment after `kirunak/tasks/`. No workspace needed: judgement, the hook must be
  fast (it runs on every Edit, Write and Bash call) and must not depend on the loader.
- Speed: one `fs.existsSync` per call in the common case. Number to check: under 50 ms per call, measured over 50
  spawns (`build-order.md`).
- It exports `decide(input) → reason | null` beside its `main`, so a workspace that runs several PreToolUse hooks on
  the same tools can call them from one dispatcher process (`build-order.md`, number 1).
- Under a subagent the input carries `agent_id` and `agent_type` (hooks.md, fetched 2026-10-18); the hook treats
  agents and the main session alike (both are the model).

## 3. The git hooks: `hooks/git-pre-commit.mjs`, and a task's part of `prepare-commit-msg` and `commit-msg`

Installed per repo that holds tasks. `k install --git <repo>` writes `.git/hooks/pre-commit` calling it when the repo
has no pre-commit hook; a repo that already has one (often a committed `githooks/pre-commit` copied into
`.git/hooks`) adds one line, which `k install --git <repo> --print` prints with the install path filled in:
`node <kirunak>/hooks/git-pre-commit.mjs || exit 1`. Judgement: kirunak never rewrites a hook it did not write. It
reads the index (`git diff --cached --name-only`, `git show :<path>`) and refuses a commit when:

1. a staged `kirunak/tasks/<slug>/task.md` has an approval record (in the index, else in HEAD) whose `hash` differs
   from the SHA-256 of the staged bytes, and `KIRUNAK_APPROVING` is not `<id>` in the environment: "task.md changed
   after approval; `k approve <id> --amendment A-n` applies an approved amendment and re-hashes";
2. a staged file under `kirunak/approvals/`, a `done.json`, a `hold.md`, or an amendment stamp, without
   `KIRUNAK_APPROVING` / `KIRUNAK_ACCEPTING` / `KIRUNAK_HOLDING` naming the task: "written by the owner's command only";
3. a staged `intake.md` that is not an append of the committed one (the old text must be a prefix of the new):
   "intake.md is append-only; use `k intake`";
4. a staged `cost.md` that is not the rendering of its `done.json`'s `cost` (in the index, else in HEAD), whatever
   the variables, so not even an accept commits a hand edit: "cost.md is generated from done.json; `k cost <id>
   --write` writes it again" (a removal passes: the command brings it back).

`k approve`, `k accept` and `k hold` set those variables on the one `git commit` they run. The mod's route takes the
same hooks (review N49, settled 2026-10-19): `$.process.run` says "Git runs with repo hooks off", and measured on
Claude Code 2.1.303 that means only a `git` it starts itself (`argv[0]` git, given `-c core.hooksPath=/dev/null` on
the command line); a `git` started by `sh` or `node` under it ran the repo's `prepare-commit-msg` in a probe repo.
The mod runs `node k <verb>`, so its commit gets this hook and the `SLAP:` line as a `!` commit does. A mod must
therefore never commit with `$.process.run(['git', ...])`. Judgement: the variable is a mistake guard in the spirit
of D7; a model that sets it has read this file and chosen to.

It also runs `k verify --staged` logic for every task whose record is in HEAD and whose `task.md` is unchanged:
nothing to do, so the hook costs one `git diff --cached` on a commit that touches no kirunak file (number to check:
under 100 ms).

### A step's `Task:` trailer, and no new work on an accepted task (gulnya/kirunak-accept-shared-repo)

The prepare-commit-msg hook (`hooks/git-prepare-commit-msg.mjs`, the SLAP gate of `change-size.md` §3, which git runs
even under `--no-verify`) does two things for tasks once the SLAP gate passes, or skips a replay; the commit-msg hook
(`hooks/git-commit-msg.mjs`) checks the second again on the message the commit keeps, after the editor. What names a
task and what kirunak's records are is `lib/records.mjs`, the same for the hooks and for `k accept` (§4).

- **The trailer** (AC-3, AC-4): with `KIRUNAK_TASK` in the commit's environment, which `k run` sets on every step
  (`orchestrator.md` §3), the hook writes `Task: <id>` after the `SLAP:` line, through `git interpret-trailers
  --if-exists replace`, so an amend keeps one; a merge gets it with no `SLAP:` line, since the SLAP gate skips a replay.
  A commit git makes as a pick, by `git cherry-pick` or a rebase, keeps its message as it is, with no trailer added
  (AC-3 as amendment A-2 words it): it carries the `Task:` of the step that made it, and stamping a rebase with the
  current step's task would make every picked path that task's own change under D-1. A commit is git's pick when it is
  judged so inside a replay (below); the user's commits there get the trailer. A commit with no task in its environment
  gets no trailer and is never refused for it. A task's commit made outside a step `k run` started, such as one from an
  interactive session, is not stamped (O-1); it is the task's own change only if its message names the task.
- **Naming a task**: a message names a task by its id, or, in the task's own repo, by its slug as a whole word (a
  letter, digit, `-` or `_` on either side ends it, so `kit-wanted` does not name `kit`). A slug right after another
  repo's name and a slash names that repo's task (`katyafm/settings` never names gulnya's `settings`). The `Task:`
  trailer is part of the message, so it names its task the same way.
- **kirunak's records** (AC-5): in every repo, `kirunak/tasks/`, `kirunak/drafts/`, `kirunak/approvals/`, the
  workspace's queue file, the drafts' order beside it (`task-files.md` §1), and each file or folder the workspace's
  `records` names (`plugins.md` §3; gulnya's names `kirunak/plan.md` and `kirunak/amendments.md`, D-3), each at its
  path inside the repo that holds it (`kirunak/queue.md` and `kirunak/drafts-order.md` in gulnya), the same path in a
  worktree of that repo.
- **No new work on an accepted task** (AC-8, E-1): a commit whose message names a task of this repo the owner has
  accepted (its folder in the main checkout holds `done.json`, whose `task` is its id, or the default branch has that
  file committed: the accepted set below), the trailer the hook is about to write included, is refused when it stages
  anything besides records (inside a replay, beyond what git's replay alone stages: below). A message that only mentions
  the task names it too. The refusal: "kirunak: this commit's message names <id>, which the owner has accepted: new work
  on it is a new task. Reword the message so it does not name <id>, or start a new task (/k-intake); only kirunak's
  records (task folders, drafts, approvals, the queue, and what the workspace names as records) may still be committed
  naming it." So the accept's own commit and the handoff written after it pass.
- **The message the commit keeps** (review.md of the task found a message typed in the editor let through):
  prepare-commit-msg runs before the editor and checks a message given with `-m` or `-F`; commit-msg runs after it and
  checks the final message, whether typed, given, edited with `-e` or kept by an amend. Both read the text as git will
  keep it (git-commit(1) `--cleanup`, measured in the task's steps/S-11/design.md §2). The comment string is
  `core.commentChar` (or `core.commentString`), else `#`. The mode is `commit.cleanup`; unset or `default`, it is
  `strip` when an editor runs and `whitespace` when none does, which git tells a hook by `GIT_EDITOR=:`. `verbatim`
  keeps every line. Every other mode cuts the text at the scissors line (the comment string, then `>8` between dashes)
  and keeps what is above it. `strip` also leaves out every line starting with the comment string, git's status block
  among them (its file list names a task's records); `whitespace` and `scissors` keep them. So under `whitespace` or
  `scissors` with an editor, git keeps its own status block, and a commit that stages code beside an accepted task's
  records names that task in the message it keeps and is refused; under `strip` set in config, a `#` line given with
  `-m` is dropped by git and names nothing. The staged paths are taken against the commit's parent: prepare-commit-msg
  works it out (an amend's is HEAD's parent) and leaves it in the worktree's git folder as `KIRUNAK_COMMIT_BASE`,
  which commit-msg reads and removes. An amend given `-m` or `-F` reaches the hook as any commit does; git keeps
  HEAD's author date for it and gives it to the hook as `GIT_AUTHOR_DATE`, so a date equal to HEAD's and two seconds
  old or more counts as an amend here (the SLAP gate measures as before).
- **The accepted set** (review-2.md of the task found a worktree, or a branch made before the accept, let through):
  whichever working tree commits, the hooks read the main checkout's `kirunak/tasks/*/done.json`, found from any
  worktree as the folder above `git rev-parse --git-common-dir`, and, when the main checkout is not on the default
  branch, the `done.json` files committed on that branch. The default branch is `origin/HEAD`'s target, else `main`,
  else `master`. Both it and the main checkout's branch are read from their files in the common git folder, so the
  main checkout on the default branch costs no git call; without those files, one `for-each-ref` or `symbolic-ref`
  says. Off the default branch, one `ls-tree` and one `cat-file --batch` read the committed files. The staged paths
  are still those of the committing worktree.
- **Inside a replay** (review-3.md of the task found `revert -n`, `cherry-pick -n` and a conflict stop let through;
  `lib/replay.mjs`, the task's steps/S-16/design.md, measured on git 2.54): a commit made while git merges, picks,
  rebases or reverts is judged like any other, by the message it keeps and the paths it stages, with one difference:
  what git's replay alone would stage is not its own change. For a merge (`MERGE_HEAD`) the own change is the staged
  tree against `git merge-tree --write-tree HEAD MERGE_HEAD`, so a merge whose message names an accepted task, given
  with `-m` or written by git from a branch's name, passes when it adds nothing beyond what the two branches already
  hold, and is refused when it carries code of its own, an evil merge or a `--no-commit` merge with new code (E-4).
  For a pick git is making (`CHERRY_PICK_HEAD`, or a rebase stopped on a conflict: `rebase-merge/stopped-sha` without
  `rebase-merge/amend`) whose message is git's (`MERGE_MSG`, else `rebase-merge/message`, both read as git's `strip`
  cleanup reads them, so the editor's status block and a conflict's `# Conflicts:` lines are git's words too), the
  own change is the staged tree against `git merge-tree --write-tree --merge-base <sha>^ HEAD <sha>`, so git's picks
  and rebases of an accepted task's commits, with git's message and nothing added, pass and keep their messages (E-3).
  Everything else is the user's commit, judged whole, and refused when it names an accepted task beside code: a `-n`
  pick or revert then committed, a conflict stop committed with `-m`, a `reword`, `squash` or `fixup` of its commits,
  an amend at a rebase's `edit` stop (E-3), a `git merge --squash` of its branch, and `git revert` of its commit,
  since git's `Revert "<subject>"` names the task and undoing its change is new work (E-5; the way out:
  `git revert -n <c>`, then `git commit -m` with the new task's words). prepare-commit-msg leaves the base file with a
  second line, `replay`, and commit-msg redoes the test on the message the commit keeps, so an editor that turns git's
  words into the user's at a stop is judged as the user's commit. The SLAP gate still skips every replay
  (change-size.md). An ordinary commit pays three file reads for this and no git call.
- **What it does not check**: under `--no-verify` git skips commit-msg, so only a message given with `-m` or `-F` is
  checked: a mistake guard, as the pre-commit checks are. An amend with `--reset-author`, or one within two seconds of
  the commit it amends, given `-m`, is taken as a new commit. A merge or pick stopped on a conflict and committed with
  git's words passes, since the resolution cannot be told from new work (merge-tree exits 1), as do an octopus merge
  and git's pick of a root commit, which has no parent to pick against; `rebase --apply` runs no hook; a git older than 2.38 has no `merge-tree --write-tree` and passes every replay as
  before. After the editor of `cherry-pick -e`, `revert -e` (a revert's default at a terminal) or a rebase's `squash`,
  git runs no commit-msg, so words typed there are not checked: prepare-commit-msg judged the message git wrote (code
  staged while the editor of `cherry-pick -e` is open stays out of that commit, whose tree git wrote before). A merge by
  another strategy than git's default, such as `-s ours`, is judged against the default join, so one naming an accepted
  task is refused when the side it drops holds code. A workspace that cannot be loaded refuses nothing here, since its
  queue file cannot be told from code; the trailer is still written. The hooks load the workspace, and read git's
  `commit.cleanup` and `core.commentChar`, only when the message's raw text names a done task's slug or id. An accept
  committed while the main checkout was on a side branch is known on that branch and from the main checkout's tree, and
  lost once the main checkout moves to another branch without merging it, until the merge. A `done.json` left
  uncommitted in the main checkout counts as an accept until it goes. A sparse checkout of the main checkout that leaves
  out `kirunak/tasks` hides its accepts from the first read. `--cleanup=<mode>` and `--verbose` on the command line are
  not seen (config is), nor a scissors line typed by hand where git keeps what follows it; `core.commentChar=auto`
  (deprecated, gone in Git 3.0) is read as `#`.
- Only the task's own repo is guarded: its commits in another repo are out of scope (O-2).

## 4. The owner's command: `k approve`, `k accept`, through `!`

`k approve <id> [--amendment A-n] [--first|--before <id>|--after <id>]`:

1. refuses unless `k check <id>` passes, Open questions is empty and `task.md` is committed (the intake's commit,
   `intake.md` §4); with `--amendment`, refuses unless `k amend check` passes, then applies the operations to
   `task.md`;
2. computes the hash, writes the record (new, or with the old hash pushed to `history`), stamps the amendment
   `applied:`;
3. stages `task.md`, the record, the amendment; commits `kirunak: approve <id>` (`... amendment A-n`) with
   `KIRUNAK_APPROVING=<id>`; adds the task to the queue (`k queue add`, a commit in the queue's repo) unless
   `--no-queue`;
4. prints the state line (`queued, queue place 3`, or `parked` with `--no-queue`) and appends `events.jsonl` (the
   mod's toast).

`k accept <id> --dry-run` makes every check below and writes nothing, so it says what `k accept` would refuse (`k
waiting` lists it for every reviewed task, for the mod, `boards.md` §4). `k accept <id>`: refuses unless the latest review (`review.md`, `review-2.md`, ...) counts, that is it passes
`k review check` and the review step whose output it is has `finished` in `progress.md` with the file's hash, so a
review changed after its step finished is refused and the way out is a new review (`review.md` §2), and every
`checklist.md` item is ticked or the owner passes `--checklist-open "<why>"` (recorded in `done.json` with the items
it leaves open; `cost.md`, the task's cost, is committed with it, `orchestrator.md` §6); a refusal names each
problem. The verdict it takes is `met`, or `needs owner (<ids>)` once the checklist is done. It refuses `verdict: not
met (<ids>)` whatever the flags, `--checklist-open` included, which waives checklist items and never a criterion: the
way out is an amendment (`k amend new <id>`, approved, then a new review) or a new review after a fix. It refuses a
task with no review: a task closes only through a review step of `plan.md` that ran. It refuses a task whose own work
changed after the review, and only that: other work committed in the same repo after the review never forces a new
review (gulnya/kirunak-accept-shared-repo). A task's own change is the paths of the commits whose message names the
task, by its id or its slug, from its first approval to its latest review's head (D-1): the commits `git log <first
approval>..<review head>` lists, the first approval being the oldest commit that added `kirunak/approvals/<slug>.json`
(a task whose record was never committed is refused: its own change has no start), with kirunak's records (§3) left
out. Then each commit in `<review head>..HEAD` is judged by its own paths, records left out:

- a path in the task's own change blocks (AC-1);
- every path of a commit that names the task, in its message or its `Task:` trailer, blocks, whatever files it
  touches (AC-7);
- a path the task's own change never touched, in a commit that does not name the task, blocks nothing (AC-2);
- kirunak's own records (every task folder, the drafts folder, the queue file, the approvals folder, and any other
  file or folder the workspace names as a record, wherever the workspace keeps them) are never part of a task's own
  change, and a change to them after the review never blocks `k accept` (AC-5), so a commit whose paths are all
  records blocks nothing, even one naming the task.

A file changed and changed back still blocks: the commits are judged, not the net diff. A merge adds no paths of its
own; the commits it brings in count one by one. No flag waives a block, and the way out is a new review. The refusal's
first line says how many files and names the next review's file ("<id>: its work changed after review.md's head <sha>,
in 2 file(s) the review never saw: run a new review (a review step whose output is review-2.md):"); a line follows for
each blocking file and commit, `<path>  <sha>  <task>`, where the task is the commit's `Task:` trailer when it has
one, else every workspace task its message names, else `no task` (AC-6). `k waiting` and `/k-accept` show the same
lines, the phone at most ten for a task (`boards.md` §4). Only the task's own repo is judged (O-2). It writes
`done.json` with the review it took (file, verdict, head, hash, `task-files.md` §3), commits with `KIRUNAK_ACCEPTING`,
removes the task from the queue. It is what the `k-done` skill asks the owner to type (`review.md` §4).

Once the acceptance is committed, `k accept` removes the worktrees the closed work left (`lib/worktrees.mjs`,
gulnya/worktrees-on-close). A refusal or `--dry-run` removes nothing, and nothing in the removal undoes or fails the
acceptance. It looks, from no record, at every worktree of the workspace's repos and of the repos a `worktrees`
plugin adds (`plugins.md` §2), each repo once by git's common dir, nested ones too. A worktree goes when:

- its branch is merged into its repo's main line (origin's HEAD branch, else `main`, else `master`), by ancestry or
  with nothing left in `git cherry`;
- it has no uncommitted or untracked change;
- no open task but the one accepted names its path in one of its files, absolute or from `~` (on macOS in any case):
  a task that still needs a worktree writes its path so. The files are read one at a time in one walk, so a task's
  evidence costs time, never memory; one over 4 MB, a binary one (a NUL byte in its first 8,000 bytes, git's own
  test, read no further) and one that cannot be read name nothing (gulnya/worktrees-read-oom);
- no process works in it or runs a program from it (`lsof`'s cwd and txt; when lsof cannot tell, none goes);
- no checkout that stays is inside it, at any depth past build output (past 50 000 folders it stays). A checkout
  inside build output is not looked for, and goes with the worktree.

The main checkout never goes, nor a locked worktree or one whose folder is gone. A detached one goes only when a
plugin offers it and its HEAD is on a branch, remote branch or tag, so no commit is lost with it; a keep from any
plugin wins. Deepest first, each goes with `git worktree remove`, whole with the files git ignores in it; then its
branch goes with `git branch -D`. It is never `--force` but for a removal cut short (killed partway, say by the
phone's time limit): when its only changes are tracked files deleted, nothing of its own is left in it, and it goes
with `--force`. Every git call but the removal has a time limit (two minutes; lsof one), and what one cannot tell in
time keeps the worktree. A failure is a kept line with git's error. `k accept` prints a line for each worktree removed
and each kept, with why.

`k worktrees [--closing <id>]` prints the same survey and removes nothing. For each worktree that would go it adds one
line: the folders git ignores in it besides build output (the plugins' `buildOutput`), the five largest with their
sizes and the rest summed. The `k-done` skill shows it before asking for the acceptance, so the owner saves what they
still need first.

Why `!`: the shortcuts documentation says a `!` line is "Run a command directly, add its output to the session, and
have Claude respond to it", shell mode "Doesn't require Claude to interpret or approve the command", and the
model's own route to a shell is the `Bash` tool (`code.claude.com/docs/en/interactive-mode.md`, fetched
2026-10-18; no statement was found that the model can trigger shell mode). The Bash tool goes through PreToolUse,
where §2 refuses the owner's verbs. So the only way `k approve` runs is a line the owner typed. Note:
`respondToBashCommands: false` in settings stops the model from answering the command's output with a turn
(interactive-mode.md); the owner may set it, since the output is a state line and a turn on it costs a cache read of
the whole context.

## 5. D14 settled: the mod's slash command replaces `!`, once the mod exists

The question (D14): does a mod's slash command run without the model, and can the model not call it? Both hold on
this build, from the engine's own type declarations, not from memory (Claude Code's `plugin-authoring` skill, Claude
Code 2.1.302, `types/claude-code.d.ts`, read 2026-10-18; line numbers from that file):

- **Runs without the model.** A plugin declares `/<name>` with `$.command.register({ name, description })` and
  serves it with a `command.run` hook that returns `{ text }` (lines 3164 to 3174). "A hook's own answer without
  `next` runs no command: its `text` is shown as the command's output" (1860 to 1866), and "Core is the engine's
  command (a registered one has none)" (4343). The hook runs in the hooks module, an environment of the engine's
  with `$.process.run(argv)` to run a host command (3581 to 3598). No model turn is part of it. The public docs agree
  on the other half: markdown commands and skills are injected "as user messages at the point of invocation", so a
  model turn follows them (`code.claude.com/docs/en/skills.md`, fetched 2026-10-18); a markdown command cannot do
  this, only a mod can.
- **The model cannot call it as the owner.** `command.run`'s input carries `origin: PromptOrigin`, "a closed set,
  never a text prefix" that "no hook sets" (9215 to 9223), with `composer` defined as "The user's own gesture at the
  terminal, as the engine stamped it (never presumed from an unstamped command)" (9224 to 9232). The other kinds are
  `bridge`, `sdk`, `task-notification`, `scheduled-trigger`, `peer`, `projects-relay`, `channel`, `coordinator`,
  `observer`, `observer-activity`, `auto-continuation`, `unclassified`, and `{ kind: 'plugin', name }` for another
  plugin's `$.command.run` (1836 to 1843, 9233 to 9310); 2.1.303 adds `peer-send-message` (another session's
  SendMessage) and `slack-ping`, both refused by the allow-list. The model has no kind of its own: its routes are the Skill
  tool (a skill, which is a model turn; the tools reference lists no `SlashCommand` tool, `tools-reference.md`,
  fetched 2026-10-18), another plugin's `$.command.run` (`plugin`), or `claude -p "/k-approve"` from the Bash tool,
  which is a new process with origin `sdk` (and under `-p` the mods folder's hot reload is off, plugin-authoring
  SKILL.md "What happens when the turn ends"). So a `command.run` hook that answers only when `e.origin.kind ===
  'composer'` and refuses every other origin with a line answers the owner's Enter and nothing else, and, since the
  owner's answer of 2026-10-19, `bridge` (the last paragraph of this section).
- Two caveats the build must keep: (1) "Registering a name again replaces it" (3167): another plugin could take
  `/k-approve`; that is a deliberate act, out of D7's scope, and `k plugins`/`/plugins` shows what is loaded. Of the
  same class (S-7 review, finding 5): the mod's dialog is a `tool.call` of `AskUserQuestion` "through every hook but
  the calling one" (2.1.304's types, `$.ui.ask`, line 2455), so another plugin's `tool.call` hook on
  `AskUserQuestion` could answer it, with a verb's label among the answers; a loaded plugin doing so is the same
  deliberate act, D7's class, and the same `/plugins` shows it.
  (2) The mod must be loaded in the owner's session: installed from a folder marketplace, or named in
  `CLAUDE_CODE_PLUGIN_DIRS` in the `env` block of `~/.claude/settings.json` (plugin-authoring reference.md,
  "`--plugin-dir`"); hot reloading from the dev-mods folder is for developing it. (3) The gate is a file of the loaded
  checkout (`mods/kirunak/hooks/commands.ts`), which a session watching that folder reloads on save, as the freeze
  hook is (`hooks/kirunak-freeze.mjs`): a model that edits either has changed the gate with no tool call refused.
  D7's class, a mistake guard; sessions build kirunak in worktrees and the merge is what reaches it (review N62,
  for the owner: whether the freeze hook should refuse writes under the loaded checkout).

So: **yes, the mod's `/k-approve <id>` and `/k-accept <id>` replace `!` as the owner's commands** (D14), in the mod
slice (`boards.md` §4, `build-order.md` slice 6). The hook calls `$.process.run(['node', K, 'approve', id,
'--via', 'mod'])` and prints the state line; the core function is the same as §4's, so the record's `via` is the only
difference, and its commit runs under the repo's git hooks (§3). `!` stays as the route for a session without the mod (a `claude -p` step never approves anything).
`bridge` (Claude Code's Remote Control from the phone) is also the owner's own gesture, and the owner accepted it on
2026-10-19 (`README.md`, question 2: "Yes, allow phone", knowing that anyone holding the unlocked phone with Remote
Control open could approve too). So the hooks of `/k-approve`, `/k-accept` and `/k-hold` run on `composer` and
`bridge` and refuse every other kind (`sdk`, `plugin`, `peer` and the rest) with a line, running nothing; `/k-start`
takes the same rule (judgement: one rule for them all), and so does `/k-resume`, added for the phone (kirunak-phone
A-12). D13 is unchanged: a command typed in Remote Control is the
owner's gesture, a page is not.

### A tap in the owner's dialog is the owner's gesture (kirunak-phone, built 2026-10-21)

The rule above covered a typed command. Since amendment A-9 (the owner's answers of 2026-10-20 and 21, Q-6 and Q-17,
approved 2026-10-21) it covers one more thing: **a choice the owner taps in a dialog that such a command opened,
answered while the command runs.** The verbs a tap may run are approve (a task or an amendment), accept, decline an
amendment, hold, start, and the queue's add, move and remove (park); each stands behind a last explicit choice that
names the verb and the task, with the task's text above it ("Approve <id> A-n", "Accept <id>", `boards.md` §4). The
owner accepted the same risk as before: anyone holding the unlocked phone with Remote Control open could tap as they
could type. `!` and the typed `/k-` commands are unchanged, and a command typed with its id runs as it always did.

**The evidence it rests on** (`evidence/S-1-phone-probe.md`, S-1): the dialog's answer is a plain string with no origin
of its own, and Skip answers `[No preference]`. So the origin cannot be read from the tap; the rule is held by where
the dialog may be raised and by what an answer may do. Judgement: a tap is no weaker than a typed line only if nothing
but the owner's own command can raise the dialog whose answer runs a verb.

**How `mods/kirunak/hooks/owner.ts` holds it**, in code, each part with the test that holds it (`claude plugin test
mods/kirunak`, 79 of 79 at the build's end, in `mods/kirunak/tests/`):

- *Origin first.* `owners()` is the one wrapper every owner command uses. It refuses every origin but `composer` and
  `bridge` with a line, before any read of `k` and before any dialog. `rule.test.ts` runs each command from five
  origins; `commands.test.ts` runs the typed verbs from eight.
- *A turn exists only inside `owners()`.* The command's `Turn` is made there, in the command's own `command.run` hook,
  and closes when the hook answers; a verb or a dialog asked of a closed turn throws. A turn opens at most one dialog.
- *The dialog and the verb are owner.ts's own.* `$.ui.ask` and the function that runs a verb appear in that file and
  nowhere else in the mod (checked by search at the end of S-6: `$.ui.ask(` and `runVerb(` appear only in
  `hooks/owner.ts`), and neither is exported.
- *Only k's owner verbs run.* The verb a turn chooses is a sealed object bound to its turn, whether tapped or typed,
  and its words must match `VERBS` (approve, accept, amend decline, hold, start, queue add, move, remove); a reading
  verb or a session's own command throws.
- *A tap counts only as the last one, in an item's dialog.* A verb choice stands only in an item dialog, under the
  item's own text, and an answer counts only if it equals a choice of that same dialog. A list's row opens a dialog and
  runs nothing.
- *Words typed equal to a choice are that choice* (S-7 review, finding 4, accepted). The free-text row answers with
  the same plain string a tap does (`$.ui.ask` returns "the label chosen, ... or free text typed under 'Other'"; the
  tool's own `response` field is out of the mod's reach), so "Approve <id>" typed there equals the choice and runs it.
  That is accepted, not worked around: the words are the owner's own, they name the verb and the id, and they are
  typed under the item's text, in the dialog of the owner's own command, the same gesture as the tap. Only exact
  equality counts: a case or a space apart is no choice and runs nothing (`rule.test.ts`).
- *A dialog the model raised runs nothing.* The mod has no hook on `AskUserQuestion`, and the engine refuses a mod the
  tool anyway (S-1: "that is $.ui.ask"). `rule.test.ts` answers a dialog the model raised with "Approve <id>", "Hold
  <id>", "Start <id>", "Move <id> before <Y>", "Park <id>" and "Put back <id>", before and after the owner's own
  dialog: nothing runs.
- *Anything else is nothing.* Skip, a dismissal, a label typed where it is no choice, a blank reason, a reason
  starting with `--` (S-7 finding 8: k would take it for a flag) and Cancel run nothing, at every depth of every
  command (tested at four depths); Back shows the dialog before again; no dialog names kirunak.

The binding to one turn is tested from outside since S-7 (`turn.test.ts`, test b): `owners()` with a fake body that
hands back another turn's Outcome, typed or tapped there, or a typed one after its own dialog opened, runs nothing.

The dialog's own idle auto-answer (`afkTimeoutMs`, read in Claude Code 2.1.305 by the S-7 review) cannot act for the
owner: it is off while another surface can answer the dialog or a screen reader is on; it submits only answers the
owner had already picked, never one of its own; and a question left with no answer rejects, which the mod reports as
dismissed and runs nothing, as it does for a reload mid-dialog. And an answer acts only if it equals a choice, so
whatever string a time-out returned would run nothing. Buttons in the pane remain unbuilt for the reason in
`boards.md` §4: a press carries no origin.

## 6. A frozen openspec's instructions, once slice 1 exists (D11, R20)

kirunak ships no openspec hook (judgement: freezing a tool is a workspace's decision, D11). A workspace whose
PreToolUse hook refuses openspec changes points its refusal at the intake once slice 1 exists. The text kirunak
proposes for that refusal: "(1) do not edit anything under openspec/; (2) to work on an openspec change, bring it
into kirunak: `k intake start <repo>/<slug> --from openspec/changes/<name>` and run the `k-intake` interview with
the owner (the openspec text is background; every line is re-asked); (3) progress on a kirunak task goes to its
`progress.md` and `notes.md`, never to openspec. Tell the owner what you were about to change in openspec, so
nothing is lost."

## 7. The escalation hook, its block and `/k-go-on` (gulnya/enforced-escalation)

A guard of another kind: not against an agent editing what is frozen, but against a session that keeps trying the
same fix. Evidence is the task's design (S-2), its probes (S-1) and the Claude Code pages fetched on 2026-10-25; the
rest is marked as judgement. The ladder and what `k run` does is `orchestrator.md` §2.

**What the hook counts.** `hooks/kirunak-escalate.mjs` (with `hooks/escalate-state.mjs`) is wired by `k install` on eight
events: PostToolUseFailure of `Bash`, `Edit`, `Write`, `MultiEdit` and `NotebookEdit`; PostToolUse of `Agent`;
SubagentStop of every named agent (matcher `.+`, which keeps out Claude Code's internal agents, whose type is empty;
which agents lift a block is the hook's own check); UserPromptSubmit; UserPromptExpansion; SessionStart;
PostModelSwitch; and Stop, which closes the main session's turn and keeps its background tasks for the handover's
agent records (`orchestrator.md` §5, R6). A failed build or
test command is given a signature (the runner, and the failing test or error with line numbers and times left out;
`heavy-lock.mjs`'s wrapped command counts as the command, and `hook.commands` adds more). It is counted as a repeat
when the same signature fails again after the session edited something in between. A rerun with no edit, a green run,
a test written red and then fixed, and an edit that did not apply are not repeats. A known runner's log with no
failure line left in it (an xcodebuild or Gradle output cut short) counts nothing; a command known only from the
workspace is signed by its exit code. The count is per session; a subagent's is kept apart from its caller's. Inside a
`k run` step (`KIRUNAK_STEP` set) it does nothing.

**When it fires.** At `hook.repeats` repeats (2: fail, edit, fail, edit, fail), once for that signature, never again
on the same failures. Its message is three lines: the label and the count, the task by title and id (or that the
session names none), and the one thing to do. Judgement: the design wanted the first line to carry both and could not
in 80 characters. An Opus session is told to launch `fable-step` (or the workspace's own agent on that rung) and a
Sonnet session `opus-step`; a Fable session is told it is at the top: stop and say plainly what is missing. A subagent
is told to stop and return to its caller marked `NEEDS-OPUS` or `NEEDS-FABLE` (`NEEDS-OWNER` at the top). The hook
prints nothing in any other call (AC-9).

**The block.** The first failure after a fire sets a block on the session (a subagent's sets it on its caller). The
freeze hook (§2) then refuses `Edit`, `Write`, `MultiEdit` and `NotebookEdit` there with a reason of three lines
naming the rung and `/k-go-on`; reading, running tests and launching an agent stay open. Judgement: it refuses those
four tools only (E-10), because the session must still be able to run the agent that lifts it, so a write through the
shell (`sed -i`, `cat >`, `git apply`) is not refused: the block guards against a mistake, not against a deliberate
way round it. With `hook.block: false` no block is set and the failure is only logged. Two things lift a block, and
the code has no third (the rule at the top of the hook file, which a reviewer can check):

1. A finished run of an agent of the rung above the block's (SubagentStop), launched by that session after the block
   was set, or after the fire when it was still running at the block. It lifts only when it ran as that rung (each
   model the launch names of the rung's family, its effort not below the rung's) and finished its run (a hand-back, or
   a last message with no tool call, and not interrupted); else `escalate.log` gets `lift refused` with the model, the
   effort and why. An Opus session's block is lifted by `fable-step` (or `music-deep` in gulnya) and not by
   `opus-step`; a block a subagent's failure set in its caller's session is lifted one rung above the subagent's
   model, so `opus-step` lifts a Sonnet builder's block in an Opus session (amendment A-2); a Fable session's has no
   agent that lifts it. The agent launched after the fire counts: if it already finished when the block is set, the
   step failed on that rung too, and the block names the rung above it (at the top, the owner's `/k-go-on`).
2. The owner's `/k-go-on`.

**`/k-go-on` is the owner's gesture, typed.** It is the skill `skills/k-go-on/SKILL.md` with
`disable-model-invocation: true`, so Claude Code lists it for the owner and does not let the model call it. Typed at the
terminal or in Remote Control from the phone, it fires UserPromptExpansion; the hook counts that, and only that, as the
override, ignores one inside a subagent or in a `claude` run that another claude started (on `/k-go-on` alone it walks
its ancestors with `ps`, at most 8 steps, and logs `/k-go-on refused: nested run`), lifts the block and clears the
counted failures. The skill's text then tells
the session to say in one line what it does next and go on. **Evidence** for the route (S-1): a typed `/k-go-on` fires
UserPromptExpansion; a scheduled prompt fires UserPromptSubmit alone; a prompt sent with `claude -p` fires
UserPromptExpansion too and carries no origin.

What the model cannot do, held by the freeze hook's deny rules (all of them refused with a line, none through the hook
that lifts): call the Skill tool on `k-go-on`; carry `/k-go-on` in a CronCreate, ScheduleWakeup or SendMessage, or at
the start of an Agent prompt (a brief that quotes the block's reason still goes); run `claude` from the shell with a
resume flag, or with `/k-go-on` in the command (`Monitor`'s command is read as Bash's); run `kirunak-escalate.mjs` or
`escalate-state.mjs` from the shell, named by basename, with node or as itself, so a hand-written event piped in is
refused before it arrives ("the escalation hook's events come from Claude Code, not from a shell"; reading them and
`node --test` stay open); write to `$KIRUNAK_HOME/escalate/` or `escalate.log` with an edit tool, a redirect, `rm`/`mv`
of a parent or `node -e`. Judgement: like the rest of this file, it guards against mistakes, not a deliberate bypass: a
script file, python, a computed path or a shell that hides the script's name can still reach the hook's state unseen.
**Open**: an edit refused at a permission prompt fires no failure event, so its flag stays and the hook may fire one
repeat late, never early.

**Switches and records.** `hook.enabled`, `hook.block`, `hook.repeats` and `hook.commands` in the workspace
(`plugins.md` §3); `k doctor` says when the hook or the block is off. Every fire, block, lift, refusal and override is
a line in `$KIRUNAK_HOME/escalate.log` (time, session, agent, task, step, trigger `hook fired`, `hook blocked`, `block
lifted`, `/k-go-on override`, `lift refused` or `/k-go-on refused: nested run`, the rung from and to, the signature).
So is every escalation's cost (AC-21): when a rung agent (one `config.json` lists for some rung) that the session
itself launched after a fire still on record stops, lifting or not, a `rung agent ended` line carries the agent's id
and type, `for` (`hook blocked` while that signature's block was in force, else `hook fired`), the rung it ran as, the
signature, its model (its transcript's newest, else the launch's), `finished`, `lifted`, and `tokens` (`input`,
`output`, `cacheRead`, `cacheWrite`) summed over its whole transcript, each API message once; `tokens` is null when the
transcript cannot be read. A `/k-go-on override` line carries tokens all 0, since no agent ran; `block lifted` and
`lift refused` carry none, so nothing is counted twice. A failure
of the log never fails the call. State files sit in `$KIRUNAK_HOME/escalate/` and are removed after 14 days. Every
read-modify-write of one takes a `<file>.lock` folder: it waits at most 100 ms, takes over a lock older than 2 s, and
when it cannot take it skips the write rather than fail the call, so two hooks at one instant no longer lose a block
or a lift.

**Cost** (measured on this machine, S-5 and S-6, 30 spawns each after a warm-up): the freeze hook on an edit with no
state file 23.8 ms median, the escalate hook on a matching failed call 26.8 ms median, 30.2 ms at the 95th percentile,
against a bare `node -e ""` of 20.8 ms; the limit is 50 ms (AC-12). The timing test runs with `KIRUNAK_TIMING=1`.

**The push of a stop.** The hook also hands a session the push of a `k run` it started in the background that stopped
for the owner (`orchestrator.md` §2): the last `kirunak-push:` line of the output, in three lines of additional context
that tell the session to send it with PushNotification. Best effort (amendment A-1).

## 8. Requirements this file satisfies

D7 (§2, §3, §4), D11 and R20 (§6), D12 (`k-approve`, `k-accept`), D14 (§5, the tap in the dialog included), R5 (§1, §2), R7 (§2 row 1, §4 step 1),
R15 (`k accept`, with `review.md`), R30 (§4, what blocks `k accept`), R31 (§3, the `Task:` trailer and an accepted
task).
The escalation hook, its block and the owner's `/k-go-on` (§7): gulnya/enforced-escalation AC-8 to AC-14, AC-27, AC-29.
