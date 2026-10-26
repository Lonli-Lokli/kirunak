# The plugin interface: seams, contracts, loading

Design (D1, D2, D3, R2, R10, R12, R15, R17, R18, R19). Each choice is marked **evidence** (with its source) or
**judgement**. Index: `README.md`.

## 1. Shape of the core

- One Node package (this repo), ESM, no dependencies beyond `node:` modules, tests with `node:test` (R19). Judgement:
  no dependency means installing is a clone, and a hook that runs on every tool call starts fast. The package
  declares `"engines": { "node": ">=22" }` (judgement: ESM and `node:test` are stable there).
- The command is `bin/k.mjs`, reached as `k`: the owner puts it on PATH once (`npm link`, or a link from a directory
  on PATH to `<kirunak>/bin/k.mjs`), so `! k approve weather/x` is short to type (D7). Every verb reads `--json` for
  the front ends.
- The core knows: the task grammar (`task-files.md`), the states, the approval record, the plan and step model, the
  review grammar, the cache keeper, the local board. It knows nothing of any workspace's repos, build tools, locks,
  devices or house rules (D2): those come through the seams below and the workspace config (§3).

## 2. Seams

A seam is a name, a contract (the functions an implementation must have, with their arguments and results) and a
policy (one implementation or many). The core ships a default for every seam it cannot run without; a workspace's
own implementations live in the workspace's repo, beside its config (D2).

| Seam | Policy | Contract (every function may be async) | Default in core | What a workspace may supply |
| --- | --- | --- | --- | --- |
| `checklist` | many, merged in load order | `aspects(task) → [{ id, title, question, edgeCases: [string], sources: [string], appliesWhen?: (task) → boolean }]` | none: the core refuses `k intake` with no checklist loaded | its aspects, from its own rules (`intake.md` §3) |
| `storage` | one | `repos() → [{ name, root }]`, `queuePath() → path`, `read(path)`, `write(path, text)`, `exists(path)`, `hash(path) → "sha256:…"`, `commit(root, paths, message, env?) → sha`, `head(root) → sha`, `diff(root, base, head, exclude?) → patch` (leaving out the paths in `exclude`), `changedSince(root, sha, exclude?) → [path]` (likewise) | `storage-git.mjs`: files on disk, git for commit, hash, diff | none needed; the config names the repos (§3) |
| `resourceGuard` | one | `run(job: { session, what, maxMinutes, command: [argv], cwd, say? }) → { exitCode, log }`, `status() → { held: {session, what, since, orphan?} \| null, queued: [...] , estimateMinutes }`, `claim(resource, by, why, hours?)`, `release(resource, by)`, `resources() → [{ id, name, state }]` | `resource-guard-local.mjs`: one job at a time, a lock in the state folder (§4) | a plugin over a lock and device claims it already has |
| `machineGuard` | one | `limits() → { maxAgents, maxHeavy }`, `running() → [{ pid, task, step, session, since }]` (session and since name a step's run; `since` is its process's start, within seconds) | `machine-guard-pids.mjs`: pid files under the state folder (§4); limits from the config, default `{ maxAgents: 2, maxHeavy: 1 }` | the default, with its own limits |
| `runner` | one | `start(step: { brief, prompt, cwd, sessionId, resume?, model, effort, maxTurns, maxBudgetUsd, permissionMode, allowedTools, disallowedTools, deny?, addDirs, env }) → { pid, sessionId, done: Promise<{ exitCode, result, usage }> }`, `keepAlive(sessionId, cwd, step) → { pid, done: Promise<{ exitCode, result, usage }> }`; `deny` (a review step's, `review.md` §1) is a list of permission deny rules in Claude Code's syntax that the run, and a keep-alive given the same step, may not break, and a run given `deny` starts with auto memory off; `pid` leads its own process group, since the orchestrator ends a run by killing `-pid` (past its time, on a stop, and a dead `k run`'s left-over claude), and `start` returns it as soon as the process exists, since its start is recorded beside it | `runner-claude.mjs`: headless `claude -p` (`orchestrator.md` §3) | the default |
| `handoff` | many, merged in load order | `targets({ task, session, cwd }) → [{ where, what }]`, `release({ task, session, cwd }) → [{ resource, line }]` | `handoff-notes.mjs`: the handoff goes to the task's `handoff.md`; releases the session's own kirunak state (its `sessions/` file, the default guard's claims and queue line) | where its sessions keep handoffs, and what else a session holds that must be let go |
| `frontend` | many | `onChange(event)`, `render?(tasks, status) → text` | `board-html.mjs` (D10), `list.mjs` | the phone artifact (a step, D13) and the mod (D14) ship with kirunak (`boards.md`); a workspace may add its own |
| `tracker` | many | `push(task, state)`, `pull() → [{ id, state }]` | none | later: Linear, It's a Plan, GitHub Issues (R18) |
| `sync` | one | `pushTask(id)`, `pullTask(id)`, `watch(cb)` | none | later: the cloud (R17) |
| `prices` | one | `weights(model) → { input, cacheRead, write5m, write1h, output }` | `prices-default.mjs`: per base input token, cache read 0.1, 5-minute write 1.25, 1-hour write 2, output 5; per model against Opus: Sonnet 0.6, Haiku 0.2, Fable 2.5 | its own, when the price list changes or its account pays differently |
| `worktrees` | many, merged in load order | `repos({ ws }) → [path]`, `candidates({ ws, repos }) → [{ path, remove, why }]`, `buildOutput({ ws }) → [name]` | none: the core removes only the merged branch worktrees of the workspace's repos | more repos to look in, detached worktrees it offers or keeps (a keep from any plugin wins), and the folder names that are build output (`approval.md` §4) |

- Evidence for the cache ratios of the `prices` default: Anthropic's prompt-caching documentation (a cache read at
  0.1 times the base input price, a 5-minute write at 1.25 times, a 1-hour write at 2 times; `prompt-caching.md`).
  Judgement for output 5 and the model multipliers: the API list prices when this was written; they are a seam
  because they change with the price list, and `k doctor` prints the weights in use.
- Judgement: `storage`, `resourceGuard`, `machineGuard`, `runner`, `sync` and `prices` take one implementation,
  because two of them would disagree about one fact (where a file is, who holds the machine). `checklist`,
  `handoff`, `frontend` and `tracker` compose. Loading a second implementation of a one-policy seam is an error that
  names both modules, never a silent override.
- Judgement on the default guard: kirunak must work alone, on a machine with no lock of its own (R10). The default
  keeps `$KIRUNAK_HOME/guard/lock` (a directory made with `mkdir`, which is atomic, holding `owner.json`: id,
  session, what, pid, pidStart, job, jobStart, since; pid is the waiting kirunak process and pidStart its start, job
  the command's process group and jobStart its start) and a first-in-first-out queue file `guard/queue` beside it,
  one line per waiting process with the same id, pid and pidStart. `run` waits its turn, runs the command with
  the job's `maxMinutes` as a deadline (past it, TERM to the process group, then KILL after 10 s, exit code 124), and
  releases however the job ends; a kirunak stopped by SIGINT, SIGTERM or SIGHUP ends the job's group first
  (`lib/stop.mjs`), and one that crashes keeps the lock while its job runs. A pid read from a file can name another
  process by now (pids are reused): a pid is the same process only while it started when the file says (`isStill`:
  now less the elapsed time `ps -o etime=` prints, within a minute of it), and a pid this user cannot signal is never
  kirunak's. `isStill` has three answers: true, false (a start that is off, no start recorded, or `ps` saying no such
  process, exit 1), and unknown (`ps` did not start, as when a fork is refused, or exited otherwise, or printed no
  elapsed time). Unknown is never killed and never read as gone: a live pid whose start `ps` cannot tell is believed
  to be that process, and the wait ends when `ps` answers. So an owner or a queue line is alive only while its pid is
  still the process that started at its `pidStart` (or `ps` cannot tell); one with no `pidStart` is dead. A dead
  waiter's line goes, and a lock whose owner is dead is taken over on the next try, after whatever is left of its
  job's group is ended (TERM, then KILL), but only while `job` is still the process that started at `jobStart`; a
  group this user cannot signal, a job with no `jobStart`, or one that started at another time is left alone, and one
  whose start `ps` cannot tell is waited for, and said once: a `wait` line in `guard/log.jsonl` (it has no minutes, so
  no estimate reads it) and the job's `say`, if it has one. While such a job runs, or `ps` cannot tell, `status()`
  shows it as `held`, marked `orphan`, since it holds the lock for every waiter. `claim` and `release` record claims in `guard/claims.json` (resource,
  by, why, until); `resources()` lists what was ever claimed. Every job appends one line to `guard/log.jsonl` (what,
  session, minutes, exit code).
- The resource guard's contract carries `estimateMinutes`: the cache keeper (`orchestrator.md` §5) needs an expected
  wait, and only the guard knows the queue. The default estimates from its own log: the median length of the last
  ten jobs with the same `what`, or 15 minutes with no history (judgement; the number is one to check,
  `build-order.md`). A workspace guard estimates from its own history the same way.
- Judgement on `handoff`: the closing skill (`review.md` §4) needs the model to write the handoff, because only the
  session knows what it did; where the handoff goes and what must be released differ by workspace. So the seam
  returns places and instructions to the skill (`where` may be a path or a sentence the model follows, such as "the
  memory directory named in your system prompt") and releases what a plugin can release by itself.

## 3. How plugins are found and loaded

- The **state folder** is `$KIRUNAK_HOME`, default `~/.kirunak/` (§4). Judgement: one variable, so tests, a second
  workspace or a workspace that keeps machine state elsewhere can point it anywhere; a dot folder in the home
  directory by default, because the state is this machine's and no repo's.
- `$KIRUNAK_HOME/workspace` is one line: the absolute path of the **workspace module**. `k init --workspace
  <path>` writes it. Judgement: the pointer keeps the workspace config itself in git, in the workspace's repo.
- The workspace module default-exports the config. An invented example:

```js
export default {
  repos: [{ name: 'weather', root: '~/code/weather' }, { name: 'hub', root: '~/code/hub' }],
  queue: '~/code/hub/kirunak/queue.md',
  plugins: ['./plugins/checklist.mjs'],
  machine: { maxAgents: 2, maxHeavy: 1 },
  models: {},                         // per step kind: { model, effort }; empty means Claude Code's own defaults
  budget: { calls: 100, minutes: 40, usd: 3 },
  runner: { permissionMode: 'auto' },
  keeper: { intervalMinutes: 50 },
  baseline: './baseline.json',        // R12; optional
  ladder: [                           // where a failed step goes; these are kirunak's defaults
    { model: 'sonnet' },
    { model: 'opus', effort: 'high', mode: 'build', attempts: 1 },
    { model: 'fable', effort: 'high', mode: 'design', attempts: 1 },
  ],
  hook: { enabled: true, block: true, repeats: 2, commands: [] },
  compact: { enabled: true, handoverSize: 150000, midStepLimit: 167000, alsoIn: [] },
};
```

- Every key but `repos` and `queue` is optional and has the default shown, except `models` and `baseline`, which
  default to nothing. Judgement on `models`: which model and effort a kind of step runs on is a cost choice each
  workspace makes, so the core's default is to pass no `--model` and no `--effort` at all (Claude Code's own
  default applies). A workspace sets `models: { agent, review, sync }`, each `{ model, effort }`, and a
  plan line overrides it per step (`orchestrator.md` §1). `models.escalate` is no longer read: `k doctor` names a
  workspace that still sets it.
- **`ladder`** (lib/ladder.mjs; gulnya/enforced-escalation) holds the rungs a step that failed twice climbs, lowest
  first, and nothing else sets a rung's model, effort, attempts or mode. A rung is `{ model, id?, effort?, mode?,
  attempts?, agents?, cacheTtl?, autoCompactWindow? }`. `model` is a lower-case alias (`sonnet`); `id` pins a full model id of that family;
  `effort` is one of low, medium, high, xhigh, max; `mode` is `build` (the default) or `design`; `attempts` is a whole
  number, default 1; `agents` lists the workspace's own agents that stand on the rung (a `music-deep`, say), beside the
  generated `<model>-step`; `cacheTtl` is `5m` or `1h`; `autoCompactWindow` (100,000 to 1,000,000) goes into the rung
  agent's frontmatter, so a long design or review agent keeps its own compaction point instead of the handover
  window it would inherit in a workspace repo (design/orchestrator.md §5 R8.6). Judgement: the list is read in order and no rung is special,
  so no model is named in the code: a workspace with Haiku at the bottom gets a `sonnet-step` agent and its failed
  Haiku steps go to Sonnet. The workspace is refused at load, naming the rung, for an empty list, a repeated model, an
  unknown effort or mode, a rung 1 that names `mode`, `attempts` or `agents` (the lowest rung is the step's own model,
  and its two attempts are `k run`'s), or a design rung with a design rung directly below it (its build run is on the
  rung below, which must build). A design rung's attempt is a design run on its model and a fresh build run on the rung
  below.
- **`hook`** switches the escalation hook (`approval.md` §7): `enabled` (default true; false makes the hook do
  nothing at all), `block` (default true; false keeps the message and sets no block), `repeats` (default 2, the repeat
  after a fix that fires), `commands` (a list of regular-expression strings for more commands to count beyond the
  built-in build and test runners). `k install` copies the ladder and these keys into `$KIRUNAK_HOME/escalate/
  config.json`, which the hook reads, because the hook imports no workspace module (it runs on every failed Bash
  call). `k doctor` says `hook off` and `block off` when either is false, and that the file disagrees with the module
  or is older than it.
- **`compact`** sets the handover, the compaction a session working a task makes at a step boundary (`orchestrator.md`
  §5): `enabled` (default true; false makes the compact hook allow every compaction and `k install` take its window
  back out of each repo's file), `handoverSize` (default 150000, the context a session hands over at; `k install`
  writes `handoverSize + 33000` as `autoCompactWindow` into each workspace repo's own `.claude/settings.local.json`,
  since Claude Code compacts 33,000 under the window), `midStepLimit` (default 167000, the context a step is compacted
  at in its middle, a 200,000 window, measured as the least weight; a number sets it for every model, and `'user'`
  takes the user's own `autoCompactWindow` from their settings file instead, read at each compaction, so a compaction
  in the middle of a step never comes sooner than it would without kirunak; `k run`'s steps keep the user's own window
  either way) and `alsoIn` (default empty: more
  folders that get the handover window and count as the workspace's, such as a checkout of a tool the workspace's tasks
  change, each expanded and made real as the repos' roots are). The workspace is refused at load when `enabled` is
  not a boolean, when the window `handoverSize + 33000` is outside autoCompactWindow's range of 100,000 to 1,000,000,
  when `midStepLimit` is neither `'user'` nor a whole number above `handoverSize` (at or under it, a compaction in the
  middle of a step would never wait for the boundary) up to 967,000 (a 1M model's own point), or when `alsoIn` is not
  a list of folders. `k install`
  copies them into `escalate/config.json` as `compact: { enabled, handoverSize, window, midStepLimit, roots }`, `roots`
  the real paths whose local file the window is in, so the hook reads one file. `k doctor` names each value, the limit
  with its window (`167000 (a 200000 window)`), and the user's own window, and fails a user window not above the
  handover size when `midStepLimit` is `'user'` (R7.2).
- A plugin module default-exports `{ name, version, provides: { <seam>: implementation } }`. The core loads the
  workspace, then each plugin in order, validates every `provides` entry against the seam's contract (each named
  function present and a function; unknown seam names refused), applies the policy, and only then runs a verb.
  A plugin that throws on load stops the command with its name and the error. Judgement: the PreToolUse hook fails
  open (`approval.md` §2), because a hook that cannot read its input must not stop every session; the command fails
  closed, because it protects the owner's records.
- `k plugins` lists what is loaded, per seam, with the module path. `k doctor` runs each seam's self-check
  (`storage`: every repo root exists and is a git repo; `resourceGuard`: `status()` answers; `runner`: `claude
  --version` answers; `prices`: prints the weights) and checks that every checklist aspect has a source and an edge
  case.
- Hooks are not plugins. The PreToolUse hook and the git pre-commit hook (`approval.md`) are files in the kirunak
  repo that `k install` wires (`build-order.md`); they find the repo from the path they are given, so they need no
  workspace (`approval.md` §2).

## 4. Machine state, outside git

`$KIRUNAK_HOME` (default `~/.kirunak/`) holds what is this machine's and no repo's:

```
workspace              the pointer (§3)
machine.json           the limits, when the owner overrides the config's
running/<pid>.json     one file per live step process: task, step, session id, since, the process's start (machineGuard);
                       <k-run-pid>-<n>.json a step admitted and not started yet, with pidStart, that k run's start
sessions/<id>.json     a session's current task and step, context and cache (set by k start and the status line)
keeper.jsonl           every keep-alive, miss and skip (R11, D9)
events.jsonl           what the front ends show as toasts: build ended, review ready, keep-alive, refusal
freeze.log             every refusal of the PreToolUse hook (approval.md §2)
escalate.log           every fire, block, lift and /k-go-on override of the escalation hook, one JSON line each (approval.md §7)
escalate/              the hook's config.json (written by k install) and its state files per session, pruned after 14 days
compact.log            every PreCompact decision of the compact hook and what SessionStart put back, one JSON line each (orchestrator.md §5)
compact/               the compact hook's state: <session>.json (expect, the first block, the parts' join) and cleared.json (a /clear's handover), pruned after 14 days
slapignore.json        the repos with the git hooks and the owner's approval of each one's .slapignore (change-size.md §4)
guard/                 the default resource guard: lock, queue, claims.json, log.jsonl (§2)
board.html             the generated board (boards.md §2)
board-artifact.json    the phone board's URL (boards.md §3)
```

Judgement: nothing here is a record of a task (those are in git); losing the folder loses nothing but a toast, the
guard's history and the board's URL, and the `.slapignore` approvals, which the owner gives again (`k slapignore
approve --all`) before a commit that carries a `.slapignore` passes.

## 5. Requirements this file satisfies

D1 (§1, §2: a small core, seams, no framework), D2 (§1, §3: a workspace's parts in its own repo, nothing of one in
the core), D3 (§2: a seam at every place a later Linear replacement differs), R2 (`checklist`), R10
(`resourceGuard` with its default, `machineGuard`), R12 (`prices`, `baseline`), R15 (`handoff`), R17 (`storage`,
`sync`), R18 (`tracker`), R19 (§1).
