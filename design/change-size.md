# Change size: SLAP on every commit

Design (R21, R22, R23). Each choice is marked **evidence** (with its source) or **judgement**. Index: `README.md`.
Built as slice 1b (`build-order.md`); R22 tightened to "at most M" and R23 added by the owner's
amendment of the same week.

## 1. The measure

`SLAP = √L × √F_adj`, `F_adj = F × min(1, (L/F) / 5) + ln(1 + max(0, L/F − 50))`, L the lines added plus deleted
and F the files changed, both over what the repo's `.slapignore` does not list (§2). The score is rounded to a whole number; the tiers are S up to 10,
M 11 to 35, L 36 to 70, XL 71 and over.

- Evidence: the formula, the tiers and their reading (a fast review for S, a normal review block for M, deep focus for
  L, "strongly discouraged" for XL) are the SLAP Metric Specification's, which the owner supplied with R21.
- Judgement, recorded with the requirement: the research that specification cites (code review at Google and
  Microsoft, DORA) supports smaller changes being reviewed better and shipped more safely; it does not derive this
  formula or the cut-offs 10, 35 and 70. They are the owner's decision, and a workspace that measures its own history
  with `k slap` (§4) sees what they mean for it before it relies on them.
- What the shape does, worked from the formula: one line in one file scores 0; 10 lines in one file 3; 45 one-line
  changes in 45 files 20 (the density weight discounts a mechanical sweep); 300 lines in 5 files 47; 1,500 lines in
  one file 111 (the logarithm charges a monolithic diff); 1,000 lines in 10 files 118.

## 2. What counts: what `.slapignore` does not list (R21)

Nothing is left out by default. Left out of L and F:

1. **A file deleted whole** (git's status `D`). Judgement, the owner's: a whole deletion removes something to review
   rather than adding it, and it cannot be split, so a limit on it would forbid deleting any large file. Lines
   deleted inside a file that stays still count: they are read in context. A file moved with heavy edits, which git
   shows as a deletion and an addition, counts only its new side. A provisional rule, to revisit with data.
2. **What the repo's `.slapignore` lists**: gitignore patterns (gitignore(5)) at the repo's root, matched against
   paths relative to it, the last matching pattern deciding, `!` re-including, a trailing `/` matching folders, and
   nothing re-included inside a folder that is left out. Evidence: `lib/ignore.mjs` is checked against git's own
   matcher (`git ls-files -c -i --exclude-from`) on a fixture of 34 paths. Judgement: matched case-sensitively, the
   same on every machine whatever the file system's `core.ignorecase`; character classes like `[[:alpha:]]` are
   not supported.
3. **A binary file moved unchanged** (a rename with the same blob): nothing to read.

- The `.slapignore` that applies is the one the change carries: the index's for a commit being made, the commit's
  own for `k slap <commit>`, so the score in a message is what `k slap` gives for that commit later.
- Every other binary file (`git diff --numstat` gives `-` for its lines) refuses the commit (§3), naming both patterns
  that would leave it out: its type (`*.<extension>`, every file of it) and its own path (only this one).
- A file whose change is only a rename (no line changed) adds nothing; renames are found with `-M`.
- `.gitattributes` is not read. Judgement, the owner's: one list, in one file the owner approves, says everything that
  is left out.

**The starter** `k install --git` writes into a repo with no `.slapignore` (§4), so a repo starts where slice 1b's
built-in list left it: lock files (`*.lock`, `package-lock.json`, `npm-shrinkwrap.json`, `yarn.lock`,
`pnpm-lock.yaml`, `Package.resolved`, `gradle.lockfile`), `build/` and `dist/` folders, minified files (`*.min.js`,
`*.min.css`), source maps (`*.map`), prose (`*.md`, `*.mdx`, `*.markdown`, `*.txt`, `*.rst`, `*.adoc`) and tables
(`*.tsv`, `*.csv`); then the same extensions in other cases the repo tracks (the built-in list ignored case); the
binary files the repo tracks (`git diff --numstat` of HEAD against the empty tree, rows with `-`, not already left
out), named by extension when every tracked file of it is binary and by their own paths when not (a binary fixture
among code files of its extension leaves out only itself); and the patterns its root `.gitattributes` marks
`linguist-generated`, `linguist-vendored` or `linguist-documentation`, which slice 1b read. The starter is not
committed by `k install`: the owner approves it first (§4), then it is committed like any file.

- Judgement: configuration and resources (`.json`, `.xml`, `.yaml`, `.gradle.kts`, string tables) count unless a repo
  lists them. A reviewer reads them, and a string table translated into many languages at once is the change R22
  means to split.

## 3. The gate: `hooks/git-prepare-commit-msg.mjs` (R22, R23)

- **Why prepare-commit-msg.** Evidence, githooks(5) (git 2.54): the hook runs on every `git commit`, "If the exit
  status is non-zero, git commit will abort", and "it is not suppressed by the --no-verify option". So "no override"
  holds against `--no-verify`, which skips pre-commit and commit-msg. The same page says the hook "should not be used
  as a replacement for the pre-commit hook": judgement, it is not one, since kirunak's pre-commit checks stay where
  they are (`approval.md` §3); SLAP needs the message file and the one hook `--no-verify` cannot skip.
- **What it measures**: the staged change against HEAD (`git diff --cached --raw --numstat -z -M HEAD`, one call:
  the raw part gives each file's status, the numstat part its lines), against the empty tree for a repo's first
  commit, and against HEAD's parent for `--amend` (the hook gets `commit HEAD` as its arguments; evidence, measured
  on git 2.54). So an amend is measured as the whole commit it becomes.
- **What it refuses**, each with what to do instead, all in one message:
  1. A `.slapignore` in the index that is not the approved one (R23): the hash of its bytes against the repo's
     record (§4). With none in the index, nothing is checked and nothing but whole deletions is left out: a repo
     without the file, or one whose file is removed, measures more, never less, so that needs no approval.
     Judgement: comparing the index's file, not the working tree's, because that is what the commit carries.
  2. A binary file `.slapignore` does not list, naming its type's pattern and its own, for the owner to choose and
     approve.
  3. A score over 35, tier L or XL (R22): the score, L, F, the first files, the most lines at most M allows over this
     many files and at the usual edges (207 lines in one file, 250 in 5, 126 in 10, 79 in 20, computed by `limit(F)`),
     and how to split: `git restore --staged <file>`, `git add -p`, `k slap --staged`.
- **Otherwise** it writes `SLAP: <score> (<tier>)` through `git interpret-trailers --in-place --if-exists replace`,
  so it joins the message's trailer block and an amend replaces the line instead of adding a second.
- **Then a task's part** (`approval.md` §3, gulnya/kirunak-accept-shared-repo): a `Task: <id>` line after it when
  the commit's environment has `KIRUNAK_TASK`, and a refusal of a commit whose message names a task the owner has
  accepted, unless it stages only kirunak's records.
- **What it skips**: a merge (the hook's `merge` argument), and a commit made while a rebase, cherry-pick or revert
  replays others (`rebase-merge`, `rebase-apply`, `CHERRY_PICK_HEAD`, `REVERT_HEAD`, `sequencer` or `MERGE_MSG` in
  the git folder; a revert leaves only `MERGE_MSG`, measured on git 2.54). Judgement: a replayed commit was measured
  when it was made, and refusing a rebase over history older than the rule would stop ordinary work; R22 is about
  the change a person or an agent writes now. Like the rest of kirunak this guards against mistakes, not a deliberate
  bypass (`core.hooksPath=/dev/null` is one).
- **It fails closed**: if the hook cannot run (kirunak moved, git failed, the record unreadable), the commit is refused
  with the error. Judgement: R22 has no override, so a gate that silently lets everything through when broken would
  be one.
- Known edge: `git commit -C HEAD` (a new commit reusing HEAD's message) also arrives as `commit HEAD` and is
  measured as an amend.

## 4. The owner's `.slapignore` (R23), `k slap` and `k install`

- **The record**: `$KIRUNAK_HOME/slapignore.json`, `{ "repos": { "<repo>": { hash, approved, by, via, history } } }`,
  keyed by the repo's main folder (the parent of `git rev-parse --git-common-dir`), so every worktree of a repo shares
  its approval. `hash` is SHA-256 over the file's exact bytes, as for a task (`approval.md` §1); `hash: null` is a
  repo with the hooks whose file was never approved. Judgement: in the state folder, not in git, because the hooks
  measure repos that hold no tasks and have no `kirunak/` folder; the cost is that losing the folder refuses every
  commit that carries a `.slapignore` until the owner approves again (`plugins.md` §4).
- **`k slapignore approve <repo>... | --all`**, the owner's verb: records the hash of each repo's `.slapignore` as it is
  on disk. A repo is a folder in it or the name of a registered repo; `--all` takes every registered repo whose file
  is unapproved or changed. Everything is checked before the record is written. `--dry-run` says what it would
  approve. Like `k approve`, it runs only from the owner's own prompt: the PreToolUse hook refuses it from the Bash
  tool, and refuses an agent's Edit or Write of any `.slapignore` and of the record, and a shell write to either
  (`approval.md` §2). `k slapignore status` lists each registered repo as approved, changed, unapproved or none.
- `k slap --staged`: what the gate would say now, every refusal included (exit 1 for any). `k slap [<commit>]`: one
  commit against its parent (HEAD by default), with that commit's `.slapignore`. `k slap <from>..<to>`: each commit
  of the range but merges, and a count per tier. Runs in the current repo, with no workspace. `--json` gives each
  row's `score`, `tier`, `L`, `F`.
- `k install --git <repo>` writes `prepare-commit-msg` beside `pre-commit` in the repo's hooks folder as git resolves
  it (`git rev-parse --git-path hooks`, so `core.hooksPath` and worktrees are followed): `exec node
  <kirunak>/hooks/git-prepare-commit-msg.mjs "$@"`. A repo with a `prepare-commit-msg` of its own gets the line to
  add printed, as for pre-commit (`approval.md` §3). It writes the starter `.slapignore` (§2) when the repo has none,
  keeps one that is there, and registers the repo in the record, so `--all` finds it. `--print` shows the starter.
- **Rolling out to repos that already have the hooks**: run `k install --git` on each (the hooks are already there;
  the starter and the registry are new), then the owner reads the starters and runs `k slapignore approve --all`,
  then each starter is committed (it passes, being the approved one). Until a repo's starter is committed, its prose
  counts, so this is done in one sitting.

## 5. Tests and numbers

- `test/ignore.test.mjs`: the matcher against git's own on a fixture, and each rule alone. `test/slap.test.mjs`: the
  formula on the specification's cases and the tiers' edges; `limit` at 1, 3, 5, 10, 20 files; raw and numstat
  parsed together (renames, deletions, a binary moved unchanged); in temp repos with the hook: a small commit gets its
  line in the trailer block; 35 passes and 36 is refused, also under `--no-verify`; with no `.slapignore` a
  Markdown file counts; an approved `.slapignore` leaves out what it lists; an unlisted binary is refused naming its
  pattern; an unapproved or changed `.slapignore` is refused and the approved one passes; a removed one needs no
  approval; a worktree shares its repo's approval; a whole deletion of 1,000 lines scores 0 while 300 lines deleted
  inside a kept file count; an amend is measured against the parent; a merge, a revert and a cherry-pick pass; a
  first commit is measured against the empty tree. `test/slapignore.test.mjs`: the starter's sections, `k install
  --git` writing and keeping it, `approve` for one repo, by name and `--all` with its history and dry run, a refusal
  that writes nothing, and the whole path through `k`. `test/freeze-hook.test.mjs`: the edits, shell writes and verb
  R23 refuses. `test/install.test.mjs`: the hook written beside pre-commit, `core.hooksPath` followed.
- Numbers: the hook's time per commit, under 100 ms: measured 64 ms median over 20 runs (max 65) on a repo of 109
  commits with a starter of 26 patterns, against 83 ms for slice 1b's hook, which also ran `git check-attr`. A
  workspace's own history through `k slap <range>` (commits before a `.slapignore` count everything).

## 6. Requirements this file satisfies

R21 (§1, §2, §4), R22 (§3), R23 (§3, §4).
