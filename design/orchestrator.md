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
- `covers:` names AC and E ids (or `all`). `k plan check <id>` refuses a plan that leaves an AC or E uncovered, names
  an id the task does not have, or has a step whose `inputs:` no earlier step produces and no file in the repo
  matches (R8, R9). `task` and `diff` are the two named inputs (`task` the frozen file; `diff` the patch from the
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
  and finds a step `running` whose run record (for a heavy step, its `started` line) names a `k run` that is dead
  kills that step's claude if it still runs (nobody will collect its result) and fails the step: `the k run that
  started it stopped`. A step started by hand has neither: `k run` names it and leaves it.
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
- `failed` is retried once with a fresh conversation and the failure's report as an extra input; a `needs.json` the
  failed run left is moved to `steps/S-n/needs-<k>.json` first (one index for every request, answered or not), and
  the report names it, so the retry never reads it. A second failure stops the task and marks the step `[escalate]`
  in `plan.md` for the owner's session. When the workspace names `models.escalate`, the mark says which model and
  effort the owner's session should hand the step to. Judgement: a step that went wrong twice needs a person or a
  stronger model, and the orchestrator must not loop.
- The orchestrator is `k run <id> [--once|--watch]`: a plain Node loop, no model, run by the owner in a terminal or
  as a background command of their session. `--watch` passes every 30 s and exits when no step is ready and nothing
  runs. Two `k run`s on the machine (two tasks) coordinate only through the machine guard and the queue: the front
  of the queue starts first, up to `maxAgents` running steps (judgement: strict queue order is the one rule the
  owner can predict). One task has one `k run`: it holds `$KIRUNAK_HOME/k-run/<id>.json` (its pid) while it runs,
  a second refuses and names that pid, and a lock whose `k run` is dead is taken over. A `k run` stopped by Ctrl-C,
  a TERM or a closed terminal kills every process it started (its steps' runs and keep-alives; the guard ends a heavy
  job), fails each step it had in flight with `k run was stopped (<signal>)`, so the step is retried once, releases
  its lock and exits with the signal's code.

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
  pid, the claude's pid and the start) and adds the whole object to it when the run ends, with the end and the exit
  code; §6 derives the weight from `model_usage`. A record without a result (`kirunak.result: false`) counts no
  calls and no money.
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
  the guard's `resources()`) and released when the step ends however it ends.
- The machine guard: `running/<pid>.json` per live step process; `limits()` from the workspace (default
  `maxAgents: 2`; judgement: a laptop runs one build beside two headless sessions, not three; a number to check
  against memory pressure on the machine in slice 2). `k run` refuses to start a step past the cap and says who
  runs. `maxHeavy: 1` is the lock itself. A pid file whose process is dead is removed on the next pass (as the
  default guard treats a dead owner). Counting and reserving are one step across processes, inside a short mutex
  (`running/.admit`): an admitted step's reservation, `running/<k-run-pid>-<n>.json`, counts as running while that
  `k run` lives, becomes the run's pid file by a rename when the run starts (a resume takes a slot as a start does),
  and is removed if the step never starts, by the `k run`'s end or its stop.

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
  records nothing. A wait for a slot is not kept warm: it is recorded once as a `skip` with the guard's reason.

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

## 6. Token records (R12)

- Every run record (`run-<k>.json`, `keep-<k>.json`) carries the result's `model_usage`; `k cost <id>` folds them
  with the `prices` seam: `weight = Σ_model mult(model) × (input + 1.25 × cw5m + 2 × cw1h + 0.1 × cr + 5 × out)`
  with the default weights, in units of one base input token of the reference model. It prints per step and per
  task: weight, `total_cost_usd` (list price, client-side, cost-tracking.md), calls (`num_turns`), misses, and the
  median context per call.
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

R8 (§1), R9 (§1 inputs, §2, §3 `--disallowedTools Agent`), R10 (§4), R11 and D9 (§5), R12 (§6).
