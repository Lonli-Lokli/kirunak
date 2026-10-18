# kirunak design (index)

The design from `../REQUIREMENTS.md` (D1-D14, R1-R20). Design only: an implementer builds from these files. Each file
marks every choice as evidence (with its source) or judgement, and ends with the requirements it satisfies. The
examples are invented: a repo `weather`, a task `weather/offline-forecast`, a hub repo `hub` that holds the queue.

| File | What it settles |
| --- | --- |
| `task-files.md` | the `kirunak/` folder in a repo, the frozen `task.md` grammar (every line sourced), the other files, the eleven states and who moves a task, amendments, the one queue |
| `plugins.md` | the core's shape, the ten seams with their contracts, policies and defaults (the default resource guard, the `handoff` seam), the workspace config, how plugins load, the state folder `$KIRUNAK_HOME` |
| `intake.md` | the `k-intake` skill with its own interview method, the `k intake` verbs, what a workspace's checklist plugin supplies, converting an openspec change |
| `approval.md` | the approval record and hash, the PreToolUse freeze hook, the git pre-commit hook, `k approve` and `k accept` through `!`, D14 settled (the mod's command replaces `!`), the instruction text for a workspace's openspec freeze |
| `orchestrator.md` | `plan.md`, the step lifecycle, the headless `claude -p` runner with every flag cited, models and budgets as config, heavy jobs and the machine guard, the cache keeper with the 17-hour figure checked, token records and the workspace's baseline |
| `review.md` | the reviewer's separation and inputs, the `review.md` grammar, the owner's checklist, closing through kirunak's `k-done` skill and `k accept` |
| `boards.md` | `k list`, the generated local page, the phone artifact sync step, the mod |
| `build-order.md` | slice 1 in full (files, functions, verbs, `k install`, what a workspace supplies, the root README, the tests per requirement, the numbers to check), slices 2 to 7 |

## The slices and what each closes

1. Task files, intake, approval, list and board, closing, and the root README (what kirunak is, setup): D2, D4, D6,
   D7, D11, D12, R1-R7, R16, R19, R20, half of D10 and R15. The first repo migrates on it (D8).
2. The orchestrator: R8, R9, R10, R12.
3. The cache keeper: R11, D9.
4. Review and acceptance: R13, R14, R15.
5. The phone board: D13.
6. The mod: D14.
7. Trackers and cloud sync: R17, R18 (later).

## Questions only the owner can answer

1. **The closing word.** `/k-done` stays the skill (it needs the model to write the handoff) and the record is
   written by `! k accept <id>` (`review.md` §4). One word for both is possible only with the mod: a registered
   `/k-done` writes the record on the owner's Enter and then runs the handoff skill under another name through
   `$.command.run`. Keep two words, or one once the mod exists?
2. **Approval from Remote Control.** The mod can tell the owner's phone (`bridge`) from an agent; D13 says never
   from a page. Accept `bridge` for `/k-approve`, or `composer` only (the design's default)?
3. **Headless steps on a subscription.** `claude -p` without `--bare` runs on the plan and counts against its limit,
   with the 1-hour cache; `--bare` would need an API key, lose the hooks and CLAUDE.md, and get a 5-minute cache.
   The design assumes a subscription.
4. **The machine's limits**: the default `maxAgents: 2` headless steps at once beside one build, and keep-alives
   every 50 minutes (threshold 15.8 h) rather than 55 (17.4 h). Both are config and numbers to check on the
   machine in slices 2 and 3.
5. `respondToBashCommands: false` in settings, so a `! k approve` line does not cost a model turn on its output.

## Numbers to check after slice 1 (`build-order.md`, slice 1)

The freeze hook under 60 ms a call (all the workspace's PreToolUse hooks together under 100); `k list` under 1 s;
the git hook under 100 ms on an unrelated commit; each skill's listing under 300 tokens; the first converted task's
interview (questions, calls, tokens) against the workspace's budget; `k verify` against `shasum`; one full cycle on
the first repo in a fresh session, closing included.

## What is left for a next design step

Nothing of the requirements. Slice 7 (trackers, cloud) is deliberately undetailed until a tracker is picked. Two
things are checks, not designs: whether the Artifact tool runs under `claude -p` (slice 5) and the hook latency
budget (slice 1, number 1).
