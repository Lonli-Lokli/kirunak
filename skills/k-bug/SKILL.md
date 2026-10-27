---
name: k-bug
description: Write a kirunak bug, a fault in something that already exists with a way to see it, and try its fix on its own branch; or move a draft that is really a bug into the bugs. Use when you or the owner find something that exists working wrongly (a command, a test, a hook, a screen, a shared library, the work of a task the owner has accepted already), and when a draft or an intake never approved turns out to be a fault. Not for new work, a missing tool or anything that waits on the owner's choice: that is a draft, the k-draft skill.
---

# k-bug: a fault written down, its fix tried

A fault found goes into a bug in git, `kirunak/bugs/<slug>.md`, never among the drafts and never only into scratch
files or a session's memory. A bug is not a task: you write one without asking, and it approves and freezes nothing.
The owner sees bugs before drafts, in `/k-bugs`, `k waiting`, the board and a new session's first lines, and starts
one in a single step: Review & merge when its fix is ready, Start fix when it has none.

## A bug or a draft

- **A bug**: something that exists works wrongly, and you can say how to see it (a command, a test run, a file and
  line). A fault in the work of a task the owner has accepted (done in `k list`) is a bug that names that task; the
  task stays as it is, nothing written in its folder.
- **A draft**: new work, or something only the owner's choice settles (what to build, taste, priority). The k-draft
  skill writes it.
- A fault in a task still open is neither: it goes into that task, through its review or an amendment.
- Unsure: when a test could tell the fix right from wrong, it is a bug.

## Writing one

1. **Check it is new.** `k bugs`, `k drafts` and `k list`: if a bug holds the fault already, add to that one. An id
   that is already a bug, a draft or a task is refused. A draft, or an intake never approved, that is really a bug
   moves with `k bug from <id>`: its history kept, its `draft/<slug>` branch renamed `bug/<slug>`.
2. **The skeleton**, in the repo the fault is in: `k bug new <repo>/<slug> --title "<a few words>" --session <session
   id>`, with `--bug-of <task>` when the fault is in an accepted task's work (optional; a task open or unknown is
   refused), and `--fix-repo <repo>` when the fix is made in another repo than the bug's own: a workspace repo by
   name, or `kirunak` for kirunak's own code, which is no workspace repo, so its bugs take the id of a repo that is.
   A repo the workspace does not know is refused: ask the owner to add it first.
3. **Fill every section** of the bug, groomed as a draft is (the k-draft skill, step 3): Who raised it, Why (the fault
   and the way to see it), What was found (each line ending with its source), Fix written (step 4), and Questions,
   numbered, each with an indented `Proposed:` line. Propose the task whole, the goal, criteria, edge cases, aspects
   and the plan's steps, so that Start fix can ask the owner one yes or no. A question stays open only where you
   cannot know, its `Proposed:` line saying what is missing.
4. **Try the fix** when it is small and safe (nothing outside the machine, no choice of the owner's), on the branch
   `bug/<slug>` in a worktree of its own of the fix repo, never in a checkout other sessions use:

   ```sh
   git -C <fix repo> worktree add <path> -b bug/<slug>
   ```

   First a test that fails without the fix, seen failing; then the fix, the test passing, and the docs it makes
   untrue. Commit on the branch; never merge it, and never push. Under Fix written, a `- ` line a commit, ending
   `[commit <sha>]`, and under What was found the test run, failing before and passing after. No fix: delete Fix
   written, heading and all.
5. **A heavy test** (a Gradle or Xcode build or test, a booted emulator or simulator) runs only through the machine's
   heavy lock, never bare: the command the workspace's `bugs.heavyLock` names, or this machine's CLAUDE.md, with the
   job after it. It is the caller's job: an agent stops and returns the exact command and what it needs from it.
6. **Check**: `k bug check <id>` until it passes. It names each problem with its line: the shape, a question with no
   `Proposed:` line, a task not accepted, an unknown fix repo, a Fix written commit it cannot find.
7. **Commit the bug alone**, in its repo:

   ```sh
   git add kirunak/bugs/<slug>.md
   git commit -m "kirunak: bug <id>: <title>" -- kirunak/bugs/<slug>.md
   ```

8. **Say so in one line of your reply**: that you wrote a bug, its id, and whether its fix waits on `bug/<slug>`.

## What is the owner's

A fix is ready when `bug/<slug>` holds commits master does not and no review refused its head; `k bugs` says so.
**Review & merge** is the owner's alone, from `/k-bugs`: a fresh session reviews the fix's diff, and kirunak merges it
into master only with no finding, never pushed, and closes the bug. `k bug review` from your shell is refused. Its
findings, or a conflict, are written beside the bug in `kirunak/bugs/<slug>/review-<n>.md`; a new commit on the
branch that meets them makes the fix ready again. **Start fix** (an intake from the bug, the k-intake skill) and
**Drop** are the owner's too: never start either on your own judgement. When the owner tells you to drop one,
`k bug drop <id> --why "<why>"` removes it and its folder in a commit of their own, its fix branch kept and named.
