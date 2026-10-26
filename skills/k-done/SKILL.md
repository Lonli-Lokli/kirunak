---
name: k-done
description: Close a finished kirunak task so the next one starts in a fresh session. Use ONLY when the owner says the task is done, by typing /k-done or in their own words. Never on your own judgement, and never because tests are green or a build succeeded (a build can still have bugs the owner finds on a device).
---

# k-done: closing a task

The owner says when a task is done. You record nothing yourself: the acceptance is a line the owner types.

1. **Say what is done, in a few lines**: the task id, the commits (short hash and subject), the builds made. List
   anything uncommitted, unpushed or unverified, and ask whether it belongs to the task. Commit only if the owner
   says so.
2. **Show what the acceptance removes**: run `k worktrees --closing <id>` and show its lines as printed. Each worktree
   that will go has one line of the folders it holds besides build output, with their sizes; each that stays says
   why. `k accept` removes those worktrees whole, files git ignores included, so ask the owner to save first what they
   still need from them (an approved store set, a render).
3. **Ask for the acceptance**: "Type `! k accept <id>` to record it." (With the kirunak mod: `/k-accept <id>`.)
   The task is done only when the command succeeds and `kirunak/tasks/<slug>/done.json` exists. If it refuses (an
   unticked checklist item, a review that fails `k review check`, whose step has not finished or that was changed
   after it finished, a `not met` verdict, code committed after the review, no review), say what it named and stop.
   The owner may accept with checklist items open by adding `--checklist-open "<why>"`, which is recorded with the
   items it leaves open; it never accepts a `not met` verdict or a task with no review. Never run `k accept`
   yourself. Once it succeeds, it prints a line for each worktree it removed and each it kept, with why.
4. **Write the handoff and release**: run `k handoff <id> --json`. For each target, write the handoff there: the
   state now, what is open, the next step, the owner's decisions with their dates, and where things are; nothing
   git or the code already records. The command has already released what kirunak and the workspace's plugins
   could; it lists each line. Then stop what this session started that no plugin knows of (background commands,
   agents still running), or say why one keeps running.
5. **End with two lines**: where the handoff is, and "Type /clear to start the next task fresh." A session cannot
   clear itself. If the owner would rather go on here, that is their call.
