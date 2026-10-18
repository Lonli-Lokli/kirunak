# Change size: SLAP on every commit

Design (R21, R22). Each choice is marked **evidence** (with its source) or **judgement**. Index: `README.md`.
Built as slice 1b (`build-order.md`).

## 1. The measure

`SLAP = √L × √F_adj`, `F_adj = F × min(1, (L/F) / 5) + ln(1 + max(0, L/F − 50))`, L the lines added plus deleted
and F the files changed, both over code only (§2). The score is rounded to a whole number; the tiers are S up to 10,
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

## 2. What counts: code only (R21)

Left out of L and F, in this order:

1. **Binary files**: `git diff --numstat` gives `-` for their lines.
2. **Not code by name**: lock files (`*.lock`, `package-lock.json`, `npm-shrinkwrap.json`, `yarn.lock`,
   `pnpm-lock.yaml`, `Package.resolved`, `gradle.lockfile`), anything under a `dist/` or `build/` folder, minified
   files (`*.min.js`, `*.min.css`), source maps (`*.map`), prose (`.md`, `.mdx`, `.markdown`, `.txt`, `.rst`,
   `.adoc`) and data tables (`.tsv`, `.csv`).
3. **Marked in the repo's `.gitattributes`**: `linguist-generated`, `linguist-vendored` or
   `linguist-documentation` set. Evidence: these are GitHub Linguist's documented overrides for exactly these three
   kinds of file, which GitHub itself uses to collapse generated files in a diff; a repo that already marks them for
   GitHub marks them for kirunak at no cost. Read with one `git check-attr -z --stdin` call.

- A file whose change is only a rename (no line changed) adds nothing; renames are found with `-M`.
- Judgement: configuration and resources (`.json`, `.xml`, `.yaml`, `.gradle.kts`, string tables) count. A reviewer
  reads them, and a string table translated into many languages at once is the change R22 means to split.
- Judgement: deleted lines count as the specification says. A large deletion is split, or the deleted file is marked
  in `.gitattributes` first.

## 3. The gate: `hooks/git-prepare-commit-msg.mjs` (R22)

- **Why prepare-commit-msg.** Evidence, githooks(5) (git 2.54): the hook runs on every `git commit`, "If the exit
  status is non-zero, git commit will abort", and "it is not suppressed by the --no-verify option". So "no override"
  holds against `--no-verify`, which skips pre-commit and commit-msg. The same page says the hook "should not be used
  as a replacement for the pre-commit hook": judgement, it is not one, since kirunak's pre-commit checks stay where
  they are (`approval.md` §3); SLAP needs the message file and the one hook `--no-verify` cannot skip.
- **What it measures**: the staged change against HEAD (`git diff --cached --numstat -z -M HEAD`), against the
  empty tree for a repo's first commit, and against HEAD's parent for `--amend` (the hook gets `commit HEAD` as its
  arguments; evidence, measured on git 2.54). So an amend is measured as the whole commit it becomes.
- **What it does**: XL exits 1 with the reason (the score, L, F, the first files, how to split: `git restore
  --staged <file>`, `git add -p`, `k slap --staged`). Anything else gets `SLAP: <score> (<tier>)` through
  `git interpret-trailers --in-place --if-exists replace`, so it joins the message's trailer block and an amend
  replaces the line instead of adding a second.
- **What it skips**: a merge (the hook's `merge` argument), and a commit made while a rebase, cherry-pick or revert
  replays others (`rebase-merge`, `rebase-apply`, `CHERRY_PICK_HEAD`, `REVERT_HEAD`, `sequencer` or `MERGE_MSG` in
  the git folder; a revert leaves only `MERGE_MSG`, measured on git 2.54). Judgement: a replayed commit was measured
  when it was made, and refusing a rebase over history older than the rule would stop ordinary work; R22 is about
  the change a person or an agent writes now. Like the rest of kirunak this guards against mistakes, not a deliberate
  bypass (`core.hooksPath=/dev/null` is one).
- **It fails closed**: if the hook cannot run (kirunak moved, git failed), the commit is refused with the error.
  Judgement: R22 has no override, so a gate that silently lets everything through when broken would be one.
- Known edge: `git commit -C HEAD` (a new commit reusing HEAD's message) also arrives as `commit HEAD` and is
  measured as an amend.

## 4. `k slap` and `k install`

- `k slap --staged`: what the gate would say now (exit 1 for XL). `k slap [<commit>]`: one commit against its
  parent (HEAD by default). `k slap <from>..<to>`: each commit of the range but merges, and a count per tier. Runs in
  the current repo, with no workspace. `--json` gives each row's `score`, `tier`, `L`, `F`.
- `k install --git <repo>` writes `prepare-commit-msg` beside `pre-commit` in the repo's hooks folder as git resolves
  it (`git rev-parse --git-path hooks`, so `core.hooksPath` and worktrees are followed): `exec node
  <kirunak>/hooks/git-prepare-commit-msg.mjs "$@"`. A repo with a `prepare-commit-msg` of its own gets the line to
  add printed, as for pre-commit (`approval.md` §3).

## 5. Tests and numbers

- `test/slap.test.mjs`: the formula on the specification's cases and the tiers' edges; what counts (lock, build,
  minified, maps, prose, data, binary, `.gitattributes`); numstat with a rename; in temp repos with the hook: a small
  commit gets its line in the trailer block; an XL commit refused, also under `--no-verify`; an amend measured against
  the parent and its line replaced; a merge, a revert and a cherry-pick of an XL commit pass; a first commit is
  measured against the empty tree. `test/install.test.mjs`: the hook written beside pre-commit, `core.hooksPath`
  followed.
- Numbers: the hook's time per commit (it runs on every commit; under 100 ms); a workspace's own history through
  `k slap <range>`, to see what share of past commits R22 would have split.

## 6. Requirements this file satisfies

R21 (§1, §2, §4), R22 (§3).
