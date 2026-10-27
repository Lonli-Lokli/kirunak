---
name: k-draft
description: Write a kirunak draft, an intake prepared ahead for a task that does not exist yet, or drop one. Use when the owner names a future task ("its own task", "later", "another session"), when you find new work worth its own task yourself (a missing tool, a change to a shared library), and when a draft should go (it landed already, the owner said no, another draft says the same). Not for a fault in something that exists already, the work of an accepted task included: that is a bug, the k-bug skill.
---

# k-draft: an intake prepared ahead

A future task goes into a draft in git, never only into scratch files or a session's memory: new work, or something
only the owner's choice settles. A fault in something that exists, with a way to see it, is a bug, never a draft (the
k-bug skill). A draft is not a task: you write one without asking, and it approves and freezes nothing. The owner
later starts the intake from it, which reads it as background and still asks every line.

## Writing one

1. **Check it is new.** `k drafts` and `k list`: if a draft already holds the idea, add to that one. An id that is
   already a draft or a task is refused.
2. **The skeleton**, in the repo the task is for (not always the one you work in), with
   `k draft new <repo>/<slug> --title "<a few words>" --session <session id>`. The slug is lower-case letters, digits
   and hyphens. A repo the workspace does not know is refused: ask the owner to add it to kirunak's workspace first,
   and write the draft once it is there.
3. **Fill every section** of `kirunak/drafts/<slug>.md`, replacing each `<!-- fill in ... -->`:
   - **Who raised it**: the owner's words as typed, each line starting with `> `, never a summary; then
     `owner, YYYY-MM-DD, session <id>`, the day and the session they said it in. Or, when you found it yourself,
     `found by the agent:` and what you saw, where.
   - **Why**: a few lines on why it is a task of its own, not part of the work at hand.
   - **What was found**: one `- ` line per thing you saw yourself (a file, a command's output, a commit, research),
     each ending with its source: `[file <path>]`, `[command <command>]`, `[commit <sha>]` or
     `[research <path or URL>]`. Nothing guessed.
   - **Questions**: numbered `1.`, `2.`, one point each, each one the intake can ask as it stands, a plain yes or no,
     or A or B, where it can be; under each an indented `Proposed:` line, your answer and why, never a bare question.

   **Groom it** (owner, 2026-10-26): leave the owner nothing to work out, only what to change. Ask the task as you
   would write it, each part a question with its `Proposed:` answer: the goal, the criteria, the edge cases and out of
   scope, the aspects (all n/a in one question when nothing has an app), the plan's steps. When the fix is small and
   safe (no heavy job, nothing outside the machine), try it on a `draft/<slug>` branch in its own worktree, with a test
   that fails without it and the docs, never merged, and cite its commits and test runs under What was found. A
   question stays open only where you cannot know (the owner's taste, a fact you cannot measure), its `Proposed:`
   line saying what is missing. Nothing in a draft is a ruling: the owner's answers at the intake decide.
4. **Check**: `k draft check <id>` until it passes. It names each problem with its line.
5. **Commit the draft alone**, in its repo:

   ```sh
   git add kirunak/drafts/<slug>.md
   git commit -m "kirunak: draft <id>: <title>" -- kirunak/drafts/<slug>.md
   ```

6. **Say so in one line of your reply**: that you wrote a draft, and its id. When you raised it yourself, the owner
   reads that line to keep it or have it dropped.

Never start an intake from a draft on your own: the owner starts it, with Start intake in `/k-drafts` or by naming
the draft (the k-intake skill says how).

## A bug is not a draft

A fault in something that exists, a fault in the work of a task the owner has accepted included, goes into
`kirunak/bugs/` through `k bug new` (the k-bug skill). `k draft new --bug-of` is refused, naming `k bug new`, and
`k draft check` refuses a draft with `bug-of:` or Fix written, naming `k bug from <id>`, which moves it into the bugs
with its history and renames its `draft/<slug>` branch `bug/<slug>`.

## Dropping one

`k draft drop <id> --why "<why it goes>"` removes the file in a commit of that file alone, the reason in its message,
so git keeps both and the draft can come back. With no reason nothing runs. Say in your reply which draft you dropped
and why.

## Where the owner sees drafts

`/k-drafts` lists every draft in every repo; one picked shows whole, with Start intake, Drop and Back. `k waiting`
says how many drafts wait, and the board (`/k-board`, `k board`) shows a group Drafts after the tasks. Bugs are not
among them: `/k-bugs` lists them, and `k waiting` and the board name them before the drafts.
