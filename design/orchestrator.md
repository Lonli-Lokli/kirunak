# The orchestrator: plan, steps, headless runs, heavy jobs, the cache keeper, token records

Design (R8, R9, R10, R11, R12, D9). Each choice is marked **evidence** (with its source) or **judgement**. Index:
`README.md`. Every `claude` flag and field below was checked against `code.claude.com/docs/en/*.md` on 2026-10-18 by
an agent that fetched the pages; the page is named after each. The engine-side facts (`$.process.run`, origins) are
in `approval.md` §5. The examples use the invented task of `task-files.md`.

## 1. The plan, `plan.md` (R8)

```markdown
---
task: weather/offline-forecast
blocked-by: []
---

### S-1 Keep the last forecast on disk [agent, sonnet, high]
covers: AC-1, AC-2, E-1, E-3
inputs: task, src/forecast/cache.ts
outputs: steps/S-1/report.md, evidence/S-1-cache-sizes.tsv
budget: 100 calls, 40 minutes, 3 USD
brief: steps/S-1/brief.md

### S-2 Unit tests [heavy]
needs: S-1
command: npm test
what: weather unit tests, 4 minutes
max-minutes: 10
outputs: evidence/S-2-tests.xml

### S-3 Review [review]
needs: S-2
covers: all
inputs: task, diff, evidence/
outputs: review.md
```

- A step is `### S-n <title> [<kind>[, <model>[, <effort>]]]`; kinds: `agent` (a headless run, §3), `heavy` (a job
  through the resource guard, no agent, §4), `review` (an agent run with the reviewer's constraints, `review.md`),
  `owner` (waits for the owner: the orchestrator stops and names what it needs), `sync` (the board artifact,
  `boards.md` §3).
- Model and effort: the plan line's, else the workspace's `models.<kind>` (`plugins.md` §3), else none, so Claude
  Code's own default applies. Judgement: the model is a cost choice the workspace makes, and a plan line names one
  only where a step needs it.
  That is the model of the step's own attempts. After two failures the step runs on the rungs of the workspace's
  `ladder` (§2), each on the model and effort the rung names, whatever the plan line says; the plan line is never
  rewritten for a climb. A review step climbs the same way, always in build mode.
- `covers:` names AC and E ids (or `all`). `k plan check <id>` refuses a plan that leaves an AC or E uncovered, names
  an id the task does not have, or has a step whose `inputs:` no earlier step produces and no file in the repo
  matches (R8, R9), and a plan with no step of kind `review`, since `k accept` takes only a review (`review.md` §3).
  Every step start runs the same check (`k step start`, `k run`), so a task already running whose plan has no review
  step is refused at its next step, naming the problem, and `k list` shows it blocked (`task-files.md` §4). `task` and `diff` are the two named inputs (`task` the frozen file; `diff` the patch from the
  task's base commit to HEAD, written by `k step start` into `steps/<step>/diff.patch`).
- The plan changes without approval (R8): whoever plans edits it and `k plan check` guards the coverage. Judgement:
  the plan is the model's working document, the task is the owner's contract; keeping the coverage check mechanical
  is what lets the plan stay free.
- `blocked-by:` names other tasks (ids) or the word `owner` with a `Q-n`; a blocked task shows so in `k list`.
- The budget's three numbers are the step's promise: calls (`--max-turns`), minutes (the orchestrator's timeout),
  money (`--max-budget-usd`). Defaults 100, 40, 3, from the workspace's `budget` (`plugins.md` §3). Judgement: 100
  calls is R9's bound, past which an agent's context has grown large and is re-read on every call; 40 minutes keeps a
  step well inside a 1-hour cache; 3 USD at list price is about 120k Opus input tokens with a modest context, enough
  for a bounded step and far under one runaway agent.

## 2. The step lifecycle (R9)

```
pending  →  ready  →  running  →  done
                        │  ↘ waiting-heavy → (heavy job runs, no agent) → running (resumed)
                        │  ↘ waiting-owner
                        └→ failed (exit ≠ 0, timeout, budget, missing outputs)
```

- `pending`: an input is missing or a `needs:` step is not done. `ready`: every input exists, every `needs:` is
  done, the task is queued and not on hold. The orchestrator computes both from files each pass; nothing is stored
  but what happened (`progress.md`, `steps/<step>/run-<k>.json`).
- `running`: `k step start <id> S-n` appends to `progress.md`, writes `running/<pid>.json` (machine guard), and
  the runner starts. The process is the only thing alive. When it exits, the orchestrator checks `outputs:`; all
  present and exit 0 → `done` (`k step finish`), else `failed` with the reason. A `k run` that takes a task's lock
  and finds a step `running` whose run record (for a heavy step, its `started` line) names a `k run` that no longer
  runs (dead, or its pid now another process than the one that started at the record's `krunStart`; a heavy step's
  line records no start, so its `k run` counts as gone) kills that step's claude if it still runs (nobody will
  collect its result) and fails the step: `the k run that started it stopped`. The claude is the record's pid (and
  its `running/` file's) only while that pid still started when the record's `claudeStart` (or the file's `since`)
  says, within a minute (pids are reused); any other process now holding the pid, or a record with no start, is left
  running and named (`pid N is not the claude of that run`), and the step still fails. A pid whose start `ps` cannot
  tell (it did not start or failed, `plugins.md` §2) is believed to be what the file says: such a `k run` still runs,
  and a step whose claude may still run is left `running`, nothing killed or failed (`ps gave no answer for pid N`,
  said once), for a later `k run` to decide; under `--watch`, for its next pass, which asks again about those steps
  alone and decides each as at a start once `ps` answers. A step started by hand has neither: `k run` names it and leaves it.
- `waiting-heavy`: the step's run wrote `steps/S-n/needs.json` (`{ "heavy": { "what", "command": [argv],
  "maxMinutes" }, "then": "resume" }`) and ended its turn. The orchestrator runs the job (§4), writes
  `steps/S-n/heavy-<k>.json` (exit code, minutes, the report path, the last 60 lines), and resumes the same
  conversation (§3) with the prompt "the job ended; read steps/S-n/heavy-<k>.json and continue". Between the two,
  no process of the step exists (R9), and the cache keeper decides whether to keep its cache warm (§5). The
  conversation resumed is the one the step's `started` line names, with a run record of `k run`. A step started by
  hand has none: `k run` runs its job and says that its session resumes itself, naming `heavy-<k>.json`; it never
  starts a new conversation with only the resume prompt. A question such a step asks the owner stops the task the
  same way, the `needs.json` left for the session that wrote it.
- `waiting-owner`: `needs.json` has `{ "owner": "<question>" }`: the orchestrator stops the task, appends the
  question to `progress.md` and `events.jsonl`, and `k list` shows `awaiting owner`. The owner answers in a session
  (`k intake answer` if it changes the task: then an amendment) or by editing `notes.md`; `k run` resumes.
- `failed` climbs the ladder (gulnya/enforced-escalation; **evidence**: its design, S-2, and the builders' reports).
  The workspace's `ladder` (`plugins.md` §3) is a list of rungs, lowest first; kirunak's default is `sonnet`, then
  `opus` at high effort in build mode, then `fable` at high effort in design mode, one attempt on each rung above the
  lowest. A step's own model is the lowest rung's in effect: it gets two attempts, the second with a fresh
  conversation and the failure's report as an extra input. A `needs.json` the failed run left is moved to
  `steps/S-n/needs-<k>.json` first (one index for every request, answered or not), and the report names it, so the
  retry never reads it. After the second failure `k run` goes on by itself: the next pass hands the step to the next
  rung, which runs it as a fresh conversation with every failure report of the step as input.
  - **A rung's mode** says who builds. In `build` mode the rung's model does the step. In `design` mode it runs a
    design conversation first, whose one output is `steps/S-n/design-<k>.md` (brief: `steps/S-n/design-brief.md`,
    from `templates/design-brief.md`, design only, no agents, no heavy job), and then a fresh run of the rung directly
    below builds from that design. The two runs are one attempt, and only its end counts. Judgement: the owner's rule
    that the top model designs and reviews and the cheaper one builds, since building on Fable costs two and a half
    times what Opus does.
  - **The rungs run in order**: a Sonnet step goes to Opus, never straight to Fable; a step that began on Opus goes to
    Fable. A step whose Fable-led attempt fails, or a
    heavy step after its second failure, **stops the task for the owner**: `plan.md` marks the step `[escalate]` and
    gets a `failures:` field naming every failure report of the step, and the stop line reads `S-1 failed on every
    rung (sonnet 2, opus 1, fable 1); the owner decides: read steps/S-1/failure-4.md`. Removing the mark retries the
    step on its own rung. An older plan's `[escalate: <model>, <effort>]` mark still parses.
  - **What counts**: a step that exits other than 0, ends without its outputs, times out or overruns its budget. Only
    the step's own failures count: one written because `k run` stopped (`k run was stopped (<signal>)`, or `the k run
    that started it stopped` after a crash) is not one of them (nothing went wrong in the step; a person starts every
    `k run` again, so this does not loop). A stop writes no failure report, its `failed` line the whole record, and
    the attempt after a stop reads the step's last own report, if it has one since the last climb. A review's `not
    met` verdict is the review's result, never a failure. `k step fail --why` refuses a stop's words: a failure given
    by hand is the step's own and counts.
  - **The record**: `progress.md` gets a line `escalated: to <model> (…)` per climb and the stop line; `events.jsonl`
    gets an `escalate` event per climb or stop (trigger `k run failure count`, the failures, the rung from and to)
    and an `escalated-run` event when each rung's conversation ends, with its tokens and cost; `k board --card` lists
    the climbs. The count is read from `progress.md` on every pass (0.13 ms for 2,000 lines, measured), so it needs no
    state of its own.
  - **Who is told** (`lib/notice.mjs`): a climb tells no one (a line in `k run`'s output and the card). A stop for the
    owner, or a question the owner must answer, shows first in `k waiting` and `k board --brief` as at most three
    lines of at most 80 characters (the title and id, what happened with why, the one thing to do or the folder of
    the reports), and ends `k run` with a last line `kirunak-push: <text>`. A session that started `k run` as a
    background command has the hook hand it that text to send with Claude Code's PushNotification tool. **Judgement**
    (amendment A-1): the push is best effort. S-15 sent five and two never showed, one came two minutes late; delivery
    and what a tap opens are Claude Code's and the phone's. So `k doctor` says when `agentPushNotifEnabled` is not true
    in `settings.json`, and the stop is in `k waiting` whether or not the push arrives.
  - **In a session the same rung rule** is held by the escalation hook (`approval.md` §7), which counts a session's
    repeated build and test failures; inside a `k run` step it stays quiet, because `k run` counts that step itself.
- The orchestrator is `k run <id> [--once|--watch]`: a plain Node loop, no model, run by the owner in a terminal or
  as a background command of their session. `--watch` passes every 30 s and exits when no step is ready, nothing
  runs and no step is left undecided because `ps` could not answer (above; with `ps` broken for good it waits in
  view, and Ctrl-C ends it). Two `k run`s on the machine (two tasks) coordinate only through the machine guard and the queue: the front
  of the queue starts first, up to `maxAgents` running steps (judgement: strict queue order is the one rule the
  owner can predict). One task has one `k run`: it holds `$KIRUNAK_HOME/k-run/<id>.json` (its pid and its start,
  `pidStart`; the id URI-encoded, `<repo>%2F<slug>.json`) while it runs, a second refuses and names that pid, and a
  lock whose `k run` is dead, or whose pid is now another process or recorded no start, is taken over. A `k run`
  stopped by Ctrl-C, a TERM or a closed terminal kills every process it started (its steps' runs and keep-alives;
  the guard ends a heavy job), fails each step whose run it killed (`running`) with `k run was stopped (<signal>)`,
  a stop's failure that the step does not count, releases the device claims its steps hold, releases its lock and
  exits with the signal's code. A resume's
  `needs.json` is moved to `needs-<k>.json` only as its claude starts (nothing awaited between the move and the
  spawn), and `progress.md` says `resumed` then, so a step waiting for its job, or whose job has ended and whose
  resume waits for a machine slot, is left `waiting-heavy`, its `needs.json` and `started` line kept: the next
  `k run` runs the job again and resumes the same conversation, as after a crash (the price, one rerun of a finished
  job in that window). A resume of the owner's answer that waits for a slot is left `waiting-owner` the same way.

## 3. The runner: headless `claude -p` (`plugins.md` seam `runner`)

The command `runner-claude.mjs` builds, every flag from `cli-reference.md` and `headless.md` (fetched 2026-10-18):

```
claude -p
  --output-format json
  [--model <opus|sonnet|haiku|fable>]        aliases documented in cli-reference.md / model-config.md; omitted when unset (§1)
  [--effort <low|medium|high|xhigh|max>]     cli-reference.md; CLAUDE_CODE_EFFORT_LEVEL is the env equivalent; omitted when unset
  --permission-mode <mode>                   headless.md: "a run which sets no mode takes the built-in starting mode", so it is set
  --max-turns <calls>                        cli-reference.md ("No limit by default")
  --max-budget-usd <usd>                     cli-reference.md (print mode only)
  --disallowedTools Agent                    cli-reference.md: "A bare tool name removes the matching tools"; sub-agents.md
  --session-id <uuid>                        cli-reference.md ("must be a valid UUID"): the orchestrator mints it, so the record exists before the run
  --add-dir <other workspace repos the step reads>   cli-reference.md; passed again on resume (sessions.md)
  [--resume <session_id>]                    headless.md: `claude -p "..." --resume "$session_id"`
  < steps/S-n/brief.md                       headless.md: piped stdin, capped at 10 MB
```

- Not `--bare`: it "skips hooks, skills, custom commands, subagents, installed plugins, MCP servers and CLAUDE.md"
  and "never reads OAuth or keychain credentials" (headless.md). The steps need the repo's CLAUDE.md, the PreToolUse
  hooks (kirunak's freeze hook and the workspace's own) and the subscription. Judgement, and a number to check: a
  step on the subscription counts against the same plan the workspace's baseline measured, which is what R12
  compares.
- `cwd` is the task's repo root, so CLAUDE.md, `.claude/settings.local.json` and the project hooks apply, as in an
  interactive session.
- The brief is the prompt, not `--append-system-prompt`. Evidence: the cache is a prefix match "scoped to one machine
  and directory" (prompt-caching.md), so every step with the same cwd, settings and system prompt shares Claude
  Code's own opening context (the system prompt, the tools, CLAUDE.md: tens of thousands of tokens) within the
  cache's lifetime; a per-step system prompt would end the shared prefix early. Judgement: keep the system prompt
  identical across steps, put the step in the user message.
- `--disallowedTools Agent` is the default for `agent` steps (R9: one bounded job). A step marked `fanout` in the
  plan allows it with `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS=<maxAgents − running>` and
  `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH=1` ("Set 1 to turn nesting off", sub-agents.md), and the machine guard
  counts the step as 1 + that number.
- The environment also carries `KIRUNAK_TASK=<id>` and `KIRUNAK_STEP=S-n`, so the hooks and `k` verbs inside the
  run know the step (used by `k step note`, by the freeze hook's log, and by the token records).
- The result: the JSON result's documented fields `session_id`, `result`, `total_cost_usd` (with a per-model
  breakdown), `usage` ("covers the main agent loop only") with `cache_creation.ephemeral_5m_input_tokens` and
  `ephemeral_1h_input_tokens`, `model_usage` (totals including subagents), `num_turns`, `duration_ms`, `is_error`,
  `subtype`, `permission_denials`, `errors` (headless.md, prompt-caching.md, agent-sdk/typescript.md). The
  orchestrator writes `steps/S-n/run-<k>.json` before the run starts (the session id, and under `kirunak` its own
  pid `krun` with its start `krunStart`, the claude's pid `claude` with its start `claudeStart` once it starts, and
  the start `started`) and adds the whole object to it when the run ends, with the end and the exit code; §6
  derives the weight from `model_usage`. A record without a result (`kirunak.result: false`) counts no calls and no
  money.
- `--permission-mode` comes from the workspace's `runner.permissionMode`, default `auto` (judgement: a headless step
  should run as the owner's interactive sessions do; a workspace whose sessions use another mode sets it). A
  behaviour to check in slice 2 before trusting it: a step that hits a prompt no one can answer must fail within the
  timeout, not hang. The orchestrator's timeout (budget minutes) kills the process tree as the default guard does
  (TERM, then KILL, `plugins.md` §2).
- On resume, pass the same `--add-dir`, `--settings`, `--plugin-dir` flags (sessions.md: they are not remembered).

The brief, `steps/S-n/brief.md`, generated by `k step brief <id> S-n` from a template: the task's Goal and the
exact AC, E and D lines the step covers (quoted from the frozen file); the inputs with their paths; the outputs it
must write; the rules: bounded (about `calls` calls); read with ranges; no heavy job (write `needs.json` and stop);
no agents; every result as a file under `steps/S-n/` or `evidence/`, and a `report.md` of at most a page, the
last thing written. The reviewer's brief differs (`review.md` §2).

## 4. Heavy jobs and the machine guard (R10)

- A `heavy` step and a `needs.json` heavy request both go to the resource guard's `run(job)`, with
  `session: 'kirunak:' + id`, so the guard's `status()` shows which task holds the machine. The core's default guard
  (`plugins.md` §2) is a lock in `$KIRUNAK_HOME/guard/`; a workspace that already has a lock supplies a
  `resourceGuard` plugin over it, so kirunak's jobs and the workspace's other sessions take turns in one queue.
- No agent is alive meanwhile (R9): the `claude -p` process has exited before the job starts. The orchestrator
  itself waits in the queue, not a model. The owner's interactive session, if it started `k run` as a background
  command, is woken only when `k run` ends or prints a keep-alive (§5).
- Device claims go through the same seam (`claim`, `release`), named in the plan step (`device: <id>`, an id from
  the guard's `resources()`) and released when the step ends however it ends, a stop of `k run` included (a step
  still in flight, a resume waiting for its slot among them, gives its device back before `k run` exits).
- The machine guard: `running/<pid>.json` per live step process; `limits()` from the workspace (default
  `maxAgents: 2`; judgement: a laptop runs one build beside two headless sessions, not three; a number to check
  against memory pressure on the machine in slice 2). `k run` refuses to start a step past the cap and says who
  runs. `maxHeavy: 1` is the lock itself. A pid file whose process is dead, or whose pid is now another process than
  the one that started at its `since`, is removed on the next pass (as the default guard treats a dead owner).
  Counting and reserving are one step across processes, inside a short mutex (`running/.admit`): an admitted step's
  reservation, `running/<k-run-pid>-<n>.json`, counts as running while that `k run` lives (its pid still the process
  that started at the file's `pidStart`), becomes the run's pid file by a rename when the run starts (a resume takes
  a slot as a start does), and is removed if the step never starts, by the `k run`'s end or its stop.

## 5. The cache keeper (R11, D9)

**What it tracks.** Every live conversation, in `$KIRUNAK_HOME/sessions/<session_id>.json`: the last call's time,
the context size, the TTL and when the cache expires, what the conversation waits for and the expected wait.

- Headless steps: from the run record (the JSON result's `usage` for the context, the run's end time for the last
  call, the TTL from the settings) and from what the step waits for (a heavy job in the guard's queue, with its
  `estimateMinutes`; a `needs:` step; the owner).
- Interactive sessions: from the status line. The status line command receives, on stdin, `session_id`,
  `transcript_path`, `context_window.current_usage` (`input_tokens`, `cache_creation_input_tokens`,
  `cache_read_input_tokens`), `prompt_cache` (`warm`, `ttl`, `expires_at`, `hit_ratio`), `cost.total_cost_usd`
  (statusline.md, fetched 2026-10-18), and runs every `refreshInterval` seconds when one is set (judgement: 30). So
  the user's status line command gains one line, `node <kirunak>/hooks/statusline-track.mjs`, which reads the same
  stdin and writes the session file (`k install --print` prints it with the path). Evidence that this is the only
  documented source: "No hook receives token usage or context size" (hooks.md); the transcript's per-message
  `usage` is "internal to Claude Code and changes between versions" (sessions.md), so it stays a fallback, marked
  observed.
- A miss, recorded where it is seen: for an interactive session, a `SessionStart` hook with `source: "resume"`
  receives `context_tokens`, `prompt_cache_likely_expired` and `estimated_cache_write_usd` (hooks.md): the hook
  `hooks/kirunak-session.mjs` appends `{ kind: "miss" | "hit", ... }` to `keeper.jsonl`. For a headless step, the
  first resumed call's `cache_creation` against `cache_read_input_tokens` in the run record says which it was; k run
  records it as the resumed run starts, once it holds its machine slot and its device, so a resume that never starts
  records nothing, and the hook records nothing (the step's env carries `KIRUNAK_STEP`, its session file says
  `kind: "headless"`), so a keep-alive or a resume is counted once. A wait for a slot is not kept warm: it is
  recorded once as a `skip` with the guard's reason.

**When it keeps warm.** The rule, with the weights from the `prices` seam (the default: cache read 0.1, 1-hour
write 2, 5-minute write 1.25, `plugins.md` §2):

- A keep-alive costs one read of the context: `0.1 × C` (its own new tokens are tens, negligible against any C over
  10k). A miss costs writing the whole context again on the next call: `2 × C` at the 1-hour price, against the
  `0.1 × C` the hit would have cost, so a miss loses `1.9 × C`.
- Break-even: `(2 − 0.1) / 0.1 = 19` keep-alives. One keep-alive per interval `i` under the TTL ("Each request
  that hits the cache resets the timer", prompt-caching.md) keeps the cache for `19 × i` before the keep-alives have
  cost what one miss would. At `i = 55` minutes that is **17.4 hours**; at 50 minutes, 15.8 hours. R11's "about 17
  hours" checks out at 55-minute intervals. Judgement: use 50 minutes (`keeper.intervalMinutes`), because a
  keep-alive on a loaded machine can start late and a 5-minute margin is too thin; the threshold is then
  `19 × 50 min = 15.8 h`, derived from the prices seam and the interval as `keepWhileWaitUnderMinutes: 950`, so a
  price change moves it.
- Under a 5-minute cache (API key, or a subscription past its plan, prompt-caching.md): write 1.25, break-even
  `(1.25 − 0.1) / 0.1 = 11.5` intervals of 4.5 minutes, **52 minutes**. The keeper reads the TTL per conversation
  and uses the matching number; a keep-alive under 5 minutes every 4.5 minutes is only worth it for a short wait.
- The model multiplier cancels: both sides of the comparison are the same conversation.
- A keep-alive is sent only to a conversation that **will** resume: a heavy job is queued for it, or the input it
  waits for is produced by a step that is ready or running, or the owner's session has a `k run` in the
  background. A conversation that waits for the owner is never kept (the wait is unbounded); it is recorded as
  `skip: owner`.

**How it keeps warm.** For a headless conversation: `claude -p --resume <session_id> --max-turns 1
--output-format json "keep-alive: reply with the word ok"` with the same flags as the step (§3); the run record
goes to `steps/S-n/keep-<k>.json`, so the keep-alive's cost is in the step's total. It goes at
`expires_at − (TTL − interval)`, one per interval: 10 minutes before a 1-hour cache's expiry at the default
`keeper.intervalMinutes` of 50, 30 s before a 5-minute cache's at 4.5. One turn has 5 minutes: a
keep-alive still running then is killed with its tree, and the keeping ends. One that wrote more than it read came
after the expiry, and the next would too: it is recorded as a miss, and the keeping ends with a `skip` saying why.
For the owner's interactive
session: a background command the session itself started, whose end wakes the session: `k keep --session <name>`,
run with the Bash tool's `run_in_background`, ends at that same time when the expected wait justifies it, and
the session's wake-up turn is the keep-alive. Judgement: the keeper never injects a turn into an interactive session
any other way; there is no documented way, and a background command's end is the one wake-up a session already
gets.

**What it records** (`keeper.jsonl`, one line each): `{ ts, session, kind: keepalive | miss | hit | skip,
context, ttl, expectedWaitMin, reason, costWeight }`. `k keeper report` sums keep-alives and misses per task and per
week: the numbers R11 asks for, and the ones to compare with the workspace's baseline (§6).

### The handover: a compaction at the step boundary

A session working a task carries every earlier step in its context, and each call reads all of it again. The
handover lets Claude Code's own automatic compaction do the forgetting, at a moment kirunak chooses: once the context
passes the **handover size**, the session compacts at the next **step boundary** (no step it started is running), and
kirunak puts the task's files and state back. The session stays interactive; nobody types anything. A compaction in
the middle of a step waits for the **mid-step limit**, by default the user's own window, so it never comes sooner than
it would without kirunak. The pieces are `hooks/kirunak-compact.mjs` with its rules in `hooks/compact-rules.mjs`
(PreCompact), `hooks/compact-start.mjs` (SessionStart) and `hooks/compact-clear.mjs` (SessionEnd), the agent records
and the turn flag in the escalation hook (`approval.md` §7), and `k install` and `k doctor`. Facts about Claude Code
come from its hooks and settings pages (hooks.md, settings.md on code.claude.com) and from probes of Claude Code
2.1.310; the rest is judgement.

**The numbers.** `SLACK` = 33,000: Claude Code compacts at the window − min(max output, 20,000) − 13,000, and every
model kirunak runs has a max output of at least 20,000, so the threshold `T` is the window − 33,000. `LAG` = 100,000:
the most one request adds past the transcript's last usage (Claude Code checks the request about to go out; the
transcript lags it by the last tool results); in two weeks of real main transcripts (22,509 steps between two usages)
the largest step was 89,288, so the usage review checks the number again against each week's largest. `OVERSHOOT` =
50,000: an agent this far past `T` is having its compactions held by us. `IDLE_MIN` = 50 minutes: idle compaction fires
after about 54 minutes on the 1-hour cache. `CAP` = 9,500 characters: an additionalContext string over 10,000 is filed
and the model gets a preview instead. `EXPECT_S` = 180 s: how recent PreCompact's `expect`, or the main transcript's
compaction boundary, must be for SessionStart to put the task back (R5.2). `CLEAR_S` = 120 s: how recent SessionEnd's
`cleared.json` must be for SessionStart `clear` to join the old id (R5.3). `PARTS_S` = 20 s: the parts' timeout, and how
recent the state part's decision must be for the other three parts to take it (R5.2). `PRUNE_DAYS` = 14 days:
`compact/*.json` untouched this long are removed (R5.5). `PROJECT_ROOT` = `main`: which folder's
`.claude/settings.local.json` a session reads (R2.7). The handover size's default, 150,000, was measured on a week of
real sessions as the size with the least total weight read.

**R1 The step boundary.** progress.md is the only record of a step worked by hand.
- **R1.1** `runningBy(progressText, sessions, dir)` (lib/steps.mjs) lists the steps whose last event line is
  `started` or `resumed`, whose `started` line names `session <id>` with an id in `sessions`, and with no
  `steps/<step>/needs.json` (a step waiting for the owner or a heavy job is paused, not running). A boundary is an
  empty list.
- **R1.2** `sessions` is the session's chain: its own id and every `previous` id in `sessions/<id>.json`, so a step
  started before `/clear` is still this session's.
- **R1.3** A `started` line with no session (by hand) or k run's label never holds this session's compaction.

**R2 What the hook reads.**
- **R2.1** The context: the main transcript's last assistant entry, `input_tokens + cache_creation_input_tokens +
  cache_read_input_tokens` (the status line's formula), read from the file's tail, 256 KB then 1 MB; none → unknown.
- **R2.2** The lag: the context read is a lower bound on the real one, late by at most `LAG`.
- **R2.3** The model: the last assistant entry's, else the escalation record's.
- **R2.4** The model's window: `sessions/<id>.json` `window` when the status line's tracker wrote it, else a table
  (ids with `[1m]`, and the Haiku, Opus and Sonnet 5.5 and Fable 5.1 ids → 1,000,000; any other → 200,000, the
  documented default, on which the hook holds at most one request).
- **R2.5** The window in force, as Claude Code resolves it: `CLAUDE_CODE_AUTO_COMPACT_WINDOW` beats everything; else
  the first file that sets `modelSettings.<model>.autoCompactWindow` or `autoCompactWindow` (the per-model key wins
  inside a file, the higher file across files): `<root>/.claude/settings.local.json`, a local file an older Claude
  Code left in the starting folder, the starting folder's `.claude/settings.json`, the user's
  `settings.json` (`CLAUDE_CONFIG_DIR`, else `~/.claude`). `windowSetting` returns `{ window, from: { kind, file, key },
  kirunak }`; `kirunak` is true only when a project file set it and the root is one of config.json's `compact.roots`.
  `--settings` and managed settings cannot be seen.
- **R2.6** The threshold `T` = the window, clamped to [100,000, the model's window], − `SLACK`: 150,000 with the
  default handover window of 183,000.
- **R2.7** The project root: Claude Code reads the local file at the repository root for a session started in a
  subfolder, and the main checkout's for a worktree (settings.md), except outside git, at the home folder or when
  the root is not the user's. `projectRoot(cwd)` mirrors it with node:fs alone (a walk up to `.git`; a `.git` file
  naming `<main>/.git/worktrees/<name>`), returning a real path. A probe found the same window from a repo's root, a
  subfolder and a worktree, so `PROJECT_ROOT` is `main`; `k install` writes where the same function says Claude Code
  reads, so the two agree either way.

**R3 Whose compaction it is.** PreCompact names no agent: a subagent's own compaction reaches the hook with the main
session's ids, at the same `T`. Each fire is attributed from what the hook can know.
- **R3.1** The turn flag: the escalation hook writes `turn: { state, at, promptId }` into `escalate/<session>.json`,
  `open` on each main-session UserPromptSubmit, `closed` on Stop.
- **R3.2** The running agents' contexts: for each agent record with no `ended`, the last usage of its own transcript,
  read with its sidechain entries (every entry of an agent's transcript is marked `isSidechain`; the main
  transcript's reading, R2.1, passes over them).
- **R3.3** Attribution, the first row that applies: (1) no turn record → as open; (2) a running agent at least
  `OVERSHOOT` past `T` → an agent's, starving: allow; (3) the turn open and the context more than `LAG` under `T` →
  not the main's; (4) the turn closed less than `IDLE_MIN` ago → not the main's (no request between turns); (5) else
  the main's, and R4 decides.
- **R3.4** What remains: an agent's fire while the main is within `LAG` of `T` mid-step is held with the main's, at
  most `OVERSHOOT` tokens longer; a stale closed turn lets one mid-step compaction through. Both are logged. Never
  holding while any agent runs would break the boundary for every step worked through an agent.

**R4 PreCompact, the rule table** (matcher `auto|manual`), cheapest reads first:
- **R4.1** `KIRUNAK_STEP` set (a `k run` step): exit at once, nothing read or written.
- **R4.2** A manual `/compact`: allow, and record `expect`.
- **R4.3** config.json missing, `compact.enabled: false`, no session id, or anything unreadable: allow (`state
  unreadable`).
- **R4.3a** The window in force is not a workspace root's (the user's own, the variable's or none): allow (`user's
  window`). A session outside every workspace repo (an ordinary chat, a project without kirunak) is never held.
- **R4.4** The context unknown: allow (the limit cannot be bounded).
- **R4.5** Attributed to an agent (R3.3 rows 2-4): allow.
- **R4.6** The context at least the limit, `min(LIMIT, the model's window − SLACK − LAG)`: allow, record `expect`.
  `LIMIT` is `compact.midStepLimit` when a number, else the user's own window for this model, read live from their
  file (its `modelSettings.<model>.autoCompactWindow`, else its `autoCompactWindow`, else the model's window). On a
  1M model with a user window of 500,000 the allow comes with the real context between 500k and 600k, past the 467k
  the user's own window compacts at, so never sooner; with no window set the limit is 867,000, so the held request is
  under 967,000; on a 200k model the limit is 67,000, under `T`, and the hook holds at most one request.
- **R4.7** No task in `sessions/<id>.json`: block (a session with no task compacts at the limit, as without kirunak).
- **R4.8** A step of the chain running (R1.1): block, `kirunak: S-n is running; the compaction waits for the step
  boundary`. The reason reaches nobody: a block of an automatic compaction shows nothing and costs no tokens.
- **R4.9** Otherwise, a boundary: allow, record `expect`.
- **The log.** Every decision is one JSON line of `compact.log`: `{ ts, session, cwd, trigger, ctx, model, window: {
  value, from }, T, limit, turn, agents, steps, decision, row, why }`; the usage review counts its `why`.

**R5 SessionStart after a compaction or `/clear`** (matcher `compact|clear`).
- **R5.1** Four parts, four hook entries (`--part state|task|plan|progress`, `timeout: 20`), since each
  additionalContext string is capped alone; each at most `CAP` characters with a label `kirunak, after a compaction
  (part k of 4): <name>`, cut at a line end with the whole file's path. `task`: task.md whole. `plan`: plan.md's header
  and the blocks of the steps not finished (still too long: the running, paused and ready ones, a paused step being one
  waiting for a heavy job or the owner's answer). `progress`: the end of progress.md. `state`: the task and its title,
  the running steps with their start, `k status --session <id>`, `k waiting`'s rows for the task, the running agents
  (description, type, id, output file, launched, by), the shell tasks of the last Stop, and three sentences telling the
  model it is the same session and to go on from progress.md's last line without starting a step or asking the owner
  again. The entries run in parallel in any order, so no part refers to another's place.
- **R5.2** Only the main session's compaction gets the parts: PreCompact records `expect: { at, why, ctx }` in
  `compact/<session>.json` on every allow it attributes to the main (R4.2, R4.6, R4.9); SessionStart adds the parts
  when `expect` is under 180 s old, else when the main transcript's tail holds a compaction boundary newer than its
  last assistant entry and under 180 s old, else nothing. `expect` is consumed. The state part records the boundary's
  time as `fire.boundaryAt`; the same boundary seen again (an agent compacting within 180 s of a `/compact` or an idle
  compaction, with no request between) is `boundary already put back`, and gets nothing. The four entries run in
  parallel, so only the state part decides: it consumes `expect` (after `/clear`, `cleared.json`) and records its
  decision as `fire` (`joined`); a task, plan or progress part takes a decision under `PARTS_S` (20 s) old as its own,
  and decides as above when there is none. The risk: an agent whose SessionStart comes within 20 s of the main's, its
  own parts running before its state part, gets the three files (the state part, never).
- **R5.3** After `/clear`: SessionEnd (`clear`, `timeout: 5`) under the old id writes `compact/cleared.json` when its
  sessions file holds a task, and removes it otherwise (after a task is done nothing is put back); SessionStart
  `clear` under the new id, within 120 s and from the same folder, writes `sessions/<new>.json` with the task and the
  chain, marks the old file `clearedTo`, and adds the four parts labelled after `/clear`.
- **R5.4** A manual `/compact` gets the parts as an automatic one (R4.2 records `expect`).
- **R5.5** `compact/*.json` untouched for 14 days are pruned; `compact.log` never.

**R6 The agent records**, kept by the escalation hook in `escalate/<session>.json` `agents`.
- **R6.1** A launch records `description` and `outputFile`; a foreground agent's launch, which fires at its end, is
  recorded ended.
- **R6.2** Every named agent's end is recorded: SubagentStop's matcher is `.+`, which keeps out Claude Code's internal
  agents (their type is empty); which agents lift an escalation block is still the hook's own check.
- **R6.3** The running agents are the records with no `ended`.
- **R6.4** The turn flag (R3.1): UserPromptSubmit without `agent_id` opens it, Stop closes it.
- **R6.5** Stop's `background_tasks` is kept as `tasks: { at, list }`; an agent record older than the snapshot with
  no entry in it is marked ended by the snapshot. Its `shell` entries are the background shell tasks R5.1 lists.
- **R6.6** One writer per file: the escalation hook writes `escalate/<session>.json`, the compact hook writes
  `compact/` and `compact.log`, and `sessions/<id>.json` is written through `updateSession` only.

**R7 The workspace settings** (`plugins.md` §3, `compact`).
- **R7.1** `compact: { enabled: true, handoverSize: 150000, midStepLimit: 'user', alsoIn: [] }`, merged as `hook` is;
  `alsoIn` folders are expanded and made real as the repos' roots are, and count as the workspace's for R4.3a.
- **R7.2** Checked at load: `enabled` a boolean; `handoverSize + SLACK` in [100,000, 1,000,000]; `midStepLimit`
  `'user'` or a whole number from `handoverSize + SLACK + LAG` (under it the hook could never hold a call) to 967,000;
  `alsoIn` a list of folders. For `'user'` the same floor is checked by `k doctor`, where the value is known.
- **R7.3** config.json carries `compact: { enabled, handoverSize, window, midStepLimit, roots }`, `roots` the real paths
  whose local file holds the window (a worktree root's main checkout), so the hook reads one file. `window` is also
  how `k install` knows its own earlier value.
- **R7.4** `k run`'s steps keep their compaction point: a step runs in its repo's root, whose file now sets the
  handover window, so its environment sets `CLAUDE_CODE_AUTO_COMPACT_WINDOW` to `midStepLimit` when a number, else the
  user's own window for the step's model, else 1,000,000 (Claude Code cuts it to the model's own window); none with
  `enabled: false`.

**R8 `k install` and `k doctor`.**
- **R8.1** The wiring, in the user's settings file as kirunak's other hooks: PreCompact `auto|manual` (`timeout: 10`),
  SessionEnd `clear` (`timeout: 5`), SessionStart `compact|clear` as four blocks, one per part (`timeout: 20`), each
  recognised by its own command pattern, so one part's block is never taken for another's. They run in every session;
  R4.3a keeps them quiet outside the workspace.
- **R8.2** The window per root: `handoverSize + SLACK` into `<projectRoot(root)>/.claude/settings.local.json` for each
  repo and `alsoIn` folder, after checking everything. A file git tracks is named and not written (a window there would
  be committed). A file that is not a JSON object is named and skipped; the others still get theirs. Then the first
  case that matches: (a) no window in the local file and none in the shared `.claude/settings.json` → written, every
  other key and the file's indent kept, `.claude` made when missing; (b) already the handover window → nothing;
  (c) kirunak's earlier window (config.json's `compact.window`) → replaced; (d) any other value, the user's own → kept
  and named; (e) a window in the committed shared file and none in the local one → nothing written, named (a local
  key would silently beat the repo's). Beside them, (f) a `modelSettings.<model>.autoCompactWindow` in the local file
  is named (it beats the handover window for that model), and (g) `CLAUDE_CODE_AUTO_COMPACT_WINDOW` in the shell or in
  a settings file's `env` is named (it beats every setting). With `enabled: false`, kirunak's own window is removed
  and any other kept. Then, when git does not ignore the file (`git check-ignore`), `/.claude/settings.local.json` is
  added to the repo's own excludes file (`git rev-parse --git-path info/exclude`, shared with its worktrees); never
  the committed `.gitignore` and never the global excludes file, which is Claude Code's. The user's settings file is
  never written for the window, and its `autoCompactWindow` is the mid-step limit. Before `k init`, no roots: the line
  says the next `k install` writes them.
- **R8.3** `k doctor`: `compact (<module> | kirunak's defaults): handover size, window, mid-step limit` with the user's
  own window and its per-model values, failing a user window under R7.2's floor; the compact hook's wiring; per root
  the window, ignored by git, or the case that keeps it out (failing until the user acts); the user's own window,
  named and never failed; `here`, the window a session started in this folder gets and from where, and that outside
  the roots the hook never blocks; and the window of this session's model, failing a model not in R2.4's table.
- **R8.4** These docs: the install section of README.md, `plugins.md` §3 and this section.
- **R8.5** Undoing it: nothing of the user's changes, so nothing needs restoring; `compact.enabled: false` and
  `k install` take kirunak's window back out of every root.

## 6. Token records (R12)

- Every run record (`run-<k>.json`, `keep-<k>.json`) carries the result's `model_usage`; `k cost <id>` folds them
  with the `prices` seam: `weight = Σ_model mult(model) × (input + 1.25 × cw5m + 2 × cw1h + 0.1 × cr + 5 × out)`
  with the default weights, in units of one base input token of the reference model. It prints per step and per
  task: weight, `total_cost_usd` (list price, client-side, cost-tracking.md), calls (`num_turns`), misses, and the
  median context per call.
- **The run records stay out of git; their numbers go into `done.json`, and `cost.md` is generated from them.**
  `run-<k>.json` and `keep-<k>.json` are read on disk while the task runs (`k run`'s resumes and stopped runs, `k
  cost`), and a run's record is complete only after its step's `k step finish`, so nothing commits them: the step
  folder's `.gitignore` leaves them out, with a heavy job's `heavy-<k>.json` and its whole log (the owner, 2026-10-19),
  beside a review's copies (`review.md` §1); numbered names only, so a step's own `run-summary.json` is the step's. `k
  accept` records the task's cost in `done.json` as `cost`: per step and in total the weight, USD, calls, runs and
  median context (tokens to whole numbers, USD to four places), with the keeper's counts and the baseline's comparisons,
  or `{ "error": why }` when they cannot be read, which never stops the accept. It commits `cost.md` with it, rendered
  from those numbers alone (`lib/cost-md.mjs`), so a later change of prices or baseline never changes it (the owner,
  2026-10-19: "Json is not human friendly at all", then "Can we make it generated? We know rules"). `k cost <id>
  --write` writes it again; the git hook refuses a `cost.md` that is not that rendering (`approval.md` §3), and the
  freeze hook a hand edit (§2).
- **The baseline is the workspace's.** A workspace that wants R12's comparison supplies `baseline` in its config
  (`plugins.md` §3): a JSON file it measured before kirunak, in the same weight unit:

```json
{
  "period": { "from": "2026-09-01", "to": "2026-09-14" },
  "contextPerCall": { "median": 150000, "p90": 400000 },
  "over": { "threshold": 300000, "share": 0.2 },
  "weightPerRepoDay": { "weather": 9.5e6 },
  "missRate": 0.05
}
```

  (the numbers are invented). Judgement: a baseline measured from past transcripts usually has no per-task number,
  only per call and per period, so `k cost --baseline` prints only comparisons that exist: the median and p90 context
  per call of the task's steps against the baseline's; the share of calls over the threshold; the task's weight
  against the baseline's weight in the same repo over the same number of working days; keep-alives and misses
  against the miss rate. Honest numbers that exist, rather than a per-task figure the baseline cannot give. With no
  baseline, `k cost` prints the task's own numbers only.
- The interactive session's own usage for a task (the intake, the owner's turns) comes from the status line's
  `cost.total_cost_usd` and `context_window` per session file, summed by `k cost` for sessions whose
  `sessions/<id>.json` names the task (`k start <id>` sets it, `boards.md` §4).

## 7. Requirements this file satisfies

R8 (§1), R9 (§1 inputs, §2 including the ladder, §3 `--disallowedTools Agent`), R10 (§4), R11 and D9 (§5, with the
handover, its rules R1.1 to R8.5), R12 (§6).
