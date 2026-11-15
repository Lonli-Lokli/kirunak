---
name: k-go-on
description: The owner lifts kirunak's escalation block in this session without the agent one rung up. Only the owner types /k-go-on, at the terminal or on the phone; it cannot be run by Claude.
disable-model-invocation: true
---

# k-go-on: the owner lifts the block

The owner lifted the escalation block in this session: edits are open again, and the failures counted so far are
cleared.

Say in one line what you will do next, and go on.

If an edit is still refused with the block's reason, the override did not reach the hook: say so in one line, and
the owner types /k-go-on again at the terminal.

/k-go-on lifts only this session's edit block, and `k resume` is only for a task on hold. A step that k run stopped
for the owner (`[escalate]` on its header) runs again once the owner's session takes `[escalate]` off its header in
plan.md and starts `k run`.
