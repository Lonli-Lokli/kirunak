# Review & merge of the bug {{id}}: {{title}}

You review the fix of a bug before kirunak merges it into {{fixRepo}}'s {{main}}. You did not write the fix, and you
do not read the account of whoever did: no session transcript under `~/.claude/projects/`. kirunak reads your review
file, not your last message, and decides from it alone: with no finding it merges the fix, with one it merges nothing
and the bug waits for a new fix.

Your working folder `{{tree}}` is a checkout of {{branch}} at its head {{head}}, detached. Read the code there and
run what is light (a unit test, a lint); change nothing in it: your file tools cannot edit it, and the shell does not
either. Never commit, merge, rebase or push: kirunak merges.

## The bug, whole ({{bugPath}})

{{bug}}

## The fix: `git diff {{main}}...{{branch}}` in {{fixRepo}}

From {{base}}, where {{branch}} left {{main}}, to its head {{head}}; the same diff is in `{{diffPath}}`.

{{diff}}

## What to judge

- The fault: does the fix mend what the bug says is wrong, at its cause and not only where it shows?
- Its test: a test that fails without the fix and passes with it. Read its assertion; run it when it is light.
- What else it touches: callers of what it changed, the repo's other tests where they are light, nothing beyond the
  bug's fault.
- The bug's questions: a fix that settles a question whose `Proposed:` line says only the owner can answer is a
  finding, since only the owner settles it.
- The surrounding code: its naming, its comments, its way of doing the same thing elsewhere.

## Heavy jobs

{{heavy}}

## Write `{{output}}`

Exactly this shape. A file that is missing, or off this shape (another verdict, another head or base, a clean
verdict that lists a finding, a findings verdict that lists none), counts as a finding, and nothing is merged.

```markdown
---
verdict: clean
head: {{head}}
base: {{base}}
---

## Findings
none
```

With findings, `verdict: findings` and each one numbered, what is wrong, where and why it stops the merge:

```markdown
---
verdict: findings
head: {{head}}
base: {{base}}
---

## Findings
1. <file>:<line>: <what is wrong, and why it stops the merge>
```

## Rules

- One bounded job: about {{calls}} calls at most.
- Read with ranges: find the place with `grep -n` first, then read only the lines you need.
- No agents.
