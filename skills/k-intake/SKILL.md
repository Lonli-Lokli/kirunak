---
name: k-intake
description: kirunak's intake interview. Turns what the owner wants (or an old planning record, such as an openspec change) into a kirunak task that guesses nothing, one question at a time, with every line sourced. Use when the owner asks for a new task, asks to bring an openspec change into kirunak, asks to start one from a draft (Start intake in /k-drafts, or naming the draft), types /k-intake, or when a planning tool refuses an edit and names this intake.
---

# k-intake: the interview that leaves nothing to guess

You run the conversation; `k` keeps the ledger. You never edit `intake.md` by hand, and you never run
`k approve`: only the owner approves, with a line they type (`! k approve <id>`).

## The method

- **One question at a time.** Ask, wait for the answer, record it, then ask the next.
- **The weakest assumption first**: ask about what you are least sure of before what you can source.
- **No moving on while an answer is vague.** If the answer leaves two readings, ask which.
- **Propose, then ask.** For each aspect, propose the edge cases (the checklist's and your own from this task) and
  ask the owner to rule each one in or out. What is out is written down as an `O-n` line.
- **Record every ruling as it is made**, never in a batch at the end.
- **Copy the owner's words as typed** into `k intake answer`, never a summary: the answer is the source.
- **Say plainly what is still open**: "the task cannot become ready: Q-7 is open".
- **Keep it short.** An aspect that plainly cannot apply is one question ("large text: no screen changes, so n/a?"),
  not a walk through its edge cases.

## The steps

1. **Start.** `k intake start <repo>/<slug> --title "..."`, or with an old record as background:
   `k intake start <repo>/<slug> --from <path to the change>`, or from a kirunak draft (below):
   `k intake start <repo>/<slug> --from kirunak/drafts/<slug>.md`. The slug is lower-case letters, digits and
   hyphens, at most 40. This writes `kirunak/tasks/<slug>/task.md` (a draft), `intake.md`, and with `--from` a
   `notes.md`.
2. **The goal.** Propose one paragraph from the owner's words or the background, then:
   `k intake question <id> --topic goal "<the question>"` → it prints `Q-n`. Ask the owner. Record:
   `k intake answer <id> Q-n "<their words, verbatim>" --ruling "→ Goal"`. Every question and answer goes
   through these two commands.
3. **Acceptance criteria.** Draft `AC-n` lines from the goal. For each one you cannot source, ask: "AC-3 says X; is
   that what you want, or a default?" A default the owner accepts is recorded with
   `--ruling "default accepted → AC-3"` and tagged `[default <date>]`.
4. **The aspects.** `k intake aspects <id>` lists the workspace's checklist: each aspect's question, its proposed
   edge cases, its sources, and a guess whether it applies. Walk them in order. For each: does it apply? If yes,
   propose edge cases and record each ruling (in → `E-n`, out → `O-n`); if not, record `n/a: <why>`.
5. **Decisions.** Anything decided along the way that is not a criterion (a number, a name, a date) is a `D-n` line.
6. **Deferred questions.** A question the owner defers stays a `Q-n` line under Open questions. The task cannot
   become ready while one is there.
7. **Check.** `k check <id>` until it passes. Fix what it names; it gives a line number for each problem.
8. **Commit the intake**: `git add kirunak/tasks/<slug>` and `git commit -m "kirunak: intake <id>"`, in the
   task's repo, before asking for approval. From a kirunak draft, its staged move goes in the same commit.
9. **Hand over.** Print the task once, whole. Then say: "Type `! k approve <id>` to freeze and queue it." Stop
   there. If the owner wants a change first, edit the draft, `k check`, commit, and hand over again.

## Writing `task.md` while it is a draft

You write the draft; `k check` judges it. The shape:

```
---
id: <repo>/<slug>
title: <one line>
created: <YYYY-MM-DD>
from: <path of the old record, only when there is one>
---

## Goal
<one paragraph> [owner <date> Q-1]

## Acceptance criteria
- AC-1 <one criterion> [owner <date> Q-n]

## Edge cases
- E-1 <one case> [owner <date> Q-n]

## Out of scope
- O-1 <what is out> [owner <date> Q-n]

## Decisions
- D-1 <a decision> [owner <date> Q-n]

## Aspects
- <aspect>: in (AC-3, E-1) [owner <date> Q-n]
- <aspect>: out (O-2) [owner <date> Q-n]
- <aspect>: n/a: <why> [owner <date> Q-n]

## Open questions
```

- **Every line ends with its source**: `[owner YYYY-MM-DD Q-n]` (the owner's answer; `Q-n` is its entry in
  `intake.md`), `[research <path or URL> §x]`, or `[default YYYY-MM-DD]`. `[from <path>]` may follow as background,
  never alone: a line from an old record is still the owner's to confirm.
- Numbers start at 1 with no gap, and are never reused.
- Short sentences. One criterion per line, testable by someone who did not do the work.
- The sections stay in this order, all seven, even when empty.

## Bringing in an openspec change (or any old plan)

The old text is a brief to re-ask, never a source. Every unchecked item becomes a question. An item that already
landed (the `notes.md` that `--from` wrote lists commits that touched the change's files) becomes a line in
`notes.md`, "already landed: ...", and you ask whether the task still covers its edge cases. An item that belongs to
another repo becomes an `O-n` line naming where it goes. Every call the old change left open becomes a `Q-n` that
must close or be ruled out. Each line may keep `[from <path> <item>]` beside its real source. Never write in the old
record's folder.

## Starting from a kirunak draft

A draft is an intake prepared ahead (`kirunak/drafts/<slug>.md`, the k-draft skill). Start from one only when the
owner asks: Start intake in `/k-drafts`, or the owner naming it. Run step 1's command with the draft's own id,
`k intake start <id> --from kirunak/drafts/<slug>.md`. It moves the draft to `kirunak/tasks/<slug>/draft.md`, the
move staged in git, and the task takes its title. Read `draft.md` as background, never a source: nothing in it is a
ruling, and the owner's words quoted there are still asked. Its questions come among the first, after the goal, each
through `k intake question`, its `Proposed:` answer offered as the proposal (the k-draft skill grooms drafts so). Every line of the task is still asked and sourced from the owner's answer;
`[from kirunak/tasks/<slug>/draft.md]` may sit beside that source, never alone. **A bug** (`bug-of: <task>`, an
accepted task; refused, nothing moved, if not) has in `notes.md` the task's Edge cases, Out of scope and Aspects
lines as they stand. After the goal, propose together those that still apply, in one question naming their ids: a
yes keeps each under this task's next number, `[owner <date> Q-n] [from <repo>/<slug> <id>]`, an aspect naming this
task's ids; anything else is a no, each asked alone. Then only what is new: the bug, its criteria.

## After approval

The task is frozen. A change is an amendment: `k amend new <id> --title "<a few words>"`, fill in Why and Changes
(`replace <id>: <line>`, `add <id>: <line>`, `remove <id>`, each new line with its source), `k amend check <id> A-n`,
then ask the owner to type `! k approve <id> --amendment A-n`.
