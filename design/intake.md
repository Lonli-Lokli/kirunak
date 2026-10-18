# The intake: nothing guessed

Design (R1, R2, R3, R4, D6, D8, D12, R20). Each choice is marked **evidence** (with its source) or **judgement**.
Index: `README.md`.

## 1. What it is

Two parts, one in Claude Code and one in `k`:

- **The skill `k-intake`** (`skills/k-intake/SKILL.md` in this repo, linked into `~/.claude/skills/` by `k install`,
  D12): the interview the model conducts with the owner in an interactive session. It carries its own interview
  method and loads no other skill (R1). Judgement: kirunak relies on nothing it does not ship, so the method is
  written into the skill: one question at a time; the weakest assumption first; no moving on while an answer is
  vague; for each aspect, propose the edge cases and ask the owner to rule each in or out; record every ruling as it
  is made, never in a batch at the end; say plainly what is still open.
- **The verbs `k intake start|aspects|question|answer|check`**: the tooling that writes the records. The model never
  edits `intake.md` by hand; it records through the verbs, so every entry has its number and date. The model does
  write `task.md` while it is a draft (the freeze hook allows it until approval, `approval.md` §2), and `k check`
  judges the result.

Judgement: the model runs the conversation, the tool keeps the ledger. An interview the model wrote straight into
Markdown would drift from the grammar; an interview run by a tool with no model could not follow up a vague answer.

## 2. The interview

1. `k intake start <repo>/<slug> [--from <path>] [--title "..."]`: creates `kirunak/tasks/<slug>/` with a `task.md`
   skeleton (front matter, the seven sections, the Aspects section pre-filled with every loaded aspect ruled
   `? [open]`) and an empty `intake.md`. With `--from`, it reads the openspec change (`proposal.md`, `tasks.md`,
   any `design.md`) and writes `notes.md` with its headings and unchecked items, as background only (R20, D6).
   It also looks at `git log --since` for the files the change names, so the model can tell the owner what has
   already landed (judgement: a change left open for weeks often has items that landed without being ticked).
2. **The goal first**: the model proposes a one-paragraph goal from the background or the owner's words and asks the
   owner to confirm or correct it. `k intake question <id> --topic goal "<text>"` writes `Q-1`; the owner answers in
   the conversation; `k intake answer <id> Q-1 "<verbatim>" --ruling "→ Goal"` records it. Every question and answer
   goes through these two verbs. The model copies the owner's words as typed, never a summary (R4: the source is the
   owner's answer).
3. **Acceptance criteria**: from the goal, the model drafts AC lines, each with the source it has (research link,
   openspec line as background, or none), and asks the owner for each one it cannot source: "AC-3 says X; is that
   what you want, or a default?" An accepted default is recorded as `[default <date>]` through `k intake answer ...
   --ruling "default accepted → AC-3"`.
4. **The aspects** (R2, R3): `k intake aspects <id> --json` lists the loaded checklist's aspects, each with its
   question, its proposed edge cases and its sources, and for each the plugin's `appliesWhen` guess. The model walks
   them in order. For each aspect it (a) asks whether it applies, (b) for one that does, proposes the plugin's edge
   cases and its own from the task's specifics, (c) records each ruling: an edge case in becomes `E-n`, one out
   becomes `O-n` ("what is out is written down", R3), an aspect that does not apply becomes `n/a: <why>`. One
   `k intake answer` per ruling, so each `E-n` and `O-n` line's tag points at its `Q-n`.
5. **Decisions**: anything the owner decided along the way that is not a criterion (a number, a name, a date) goes
   to `D-n` with its `Q-n`.
6. **Open questions**: a question the owner defers is `Q-n` under Open questions, and `k check` fails while any
   remains (R4). The model says so plainly: "the task cannot become ready: Q-7 is open".
7. **Check and hand over**: `k check <id>` until it passes; then the model prints the task once, whole, and says:
   "Type `! k approve <id>` to freeze and queue it" (or `/k-approve <id>` once the mod exists, `approval.md` §5).
   The model never runs `k approve`: the freeze hook refuses it from the Bash tool.

A number to measure on the first converted task (`build-order.md`, slice 1): the interview's questions, calls and
the tokens it adds to the owner's session, against a budget the workspace sets. A long interview means the checklist
asks what the task's text already settles, and the plugin's `appliesWhen` needs tuning.

## 3. The checklist plugin: what a workspace supplies (R2)

A workspace's `checklist` plugin (`plugins.md` §2) exports its aspects. Each `sources` entry names the rule's home in
the workspace's own documents (a section of its contributor rules, a skill, a style guide), so the intake can cite
it; the edge cases are the failures those sources record, so the intake proposes what has already gone wrong once
(judgement: an edge case drawn from a real failure is one the owner recognises in a second). An invented example:

| id | title | sources | proposed edge cases (examples; a plugin lists them whole) |
| --- | --- | --- | --- |
| platforms | every target the app ships on | the workspace's platform rules | an API missing on the oldest supported version |
| themes | light and dark, each contrast-checked | the workspace's accessibility rules | a new colour pairing without a contrast test |
| large-text | the largest system text size | the accessibility rules | a row that clips; a button under the touch-target minimum |
| locales | every shipped language | the localisation guide | a string concatenated from parts; a plural with one form |
| offline | works with no network | the product's offline promise | a feature that reaches a server |
| data-kept | settings and saves across versions | the storage rules | a renamed settings file |

`appliesWhen` is a guess from the task's words and the files it names (a strings file → locales; a screen → themes,
large-text); the owner's answer overrides it, and `n/a` still needs a reason and a source (judgement: an aspect
skipped silently is exactly what R2 forbids).

A checklist plugin brings its own test (`build-order.md`): every aspect present, each with at least one source that
names an existing file or document and at least one edge case.

## 4. What the intake writes

- `task.md` (draft until approval), `intake.md` (append-only), `notes.md` (background with `--from`).
- The commit: the model commits the three files with `kirunak: intake <id>` when `k check` passes, before asking for
  approval, so the approval commit (`approval.md` §4) carries only the record and the unchanged task. Judgement:
  the hash in the record then names a committed file, and `git log` separates what the interview produced from the
  owner's act.
- Nothing in openspec: the intake reads it and never writes there (a workspace's freeze hook, if it has one, refuses
  it anyway), and the task's `from:` line is the only link back (R20, D11).

## 5. Converting an openspec change (R20, D8)

`k intake start <id> --from openspec/changes/<name>` is the migration path a workspace's freeze hook names once
slice 1 exists (`approval.md` §6 has the text). The model treats the change as a brief it must re-ask: every item
becomes a question, a done item becomes a line in `notes.md` ("already landed: ..."), an item that belongs to
another repo becomes an `O-n` line naming where it goes, and every call the change left open becomes a `Q-n` that
must close or be ruled out before `k check` passes.

An invented example. `openspec/changes/add-offline-mode/tasks.md` has five unchecked items:

```
- [ ] 1.1 Cache the last forecast on disk
- [ ] 1.2 Show the fetch time on the forecast screen
- [ ] 2.1 Offline banner on the map screen
- [ ] 3.1 The server sends a smaller payload for the cache
- [ ] 3.2 Alerts while offline (open: needs a decision)
```

`git log --since` shows 1.1 landed (commit `4d2e1f0`, "Cache the last forecast"), so `notes.md` says "already
landed: 1.1, commit 4d2e1f0", and the interview asks whether the task still covers its edge cases. 1.2 becomes a
question, then AC-1 with the owner's answer as its source. 2.1 becomes a question; the owner rules it out (`O-2`,
"the map has its own task"). 3.1 belongs to the server's repo: `O-3 The smaller payload: the server repo's task.`
3.2 says it is open, so it is a `Q-n` the owner must close; ruled out, it is `O-1`. Each line keeps
`[from openspec/changes/add-offline-mode/tasks.md <item>]` as background beside its real source.

## 6. Requirements this file satisfies

R1 (§1, §2: only through the interview, with kirunak's own method), R2 (§3, §2 step 4), R3 (§2 step 4), R4 (§2
steps 2 to 7), R20 and D6 (§4, §5), D8 (§5: the first repo's migration path), D12 (`k-intake`).
