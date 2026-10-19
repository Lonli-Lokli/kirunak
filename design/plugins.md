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
| `storage` | one | `repos() → [{ name, root }]`, `queuePath() → path`, `read(path)`, `write(path, text)`, `exists(path)`, `hash(path) → "sha256:…"`, `commit(root, paths, message, env?) → sha`, `head(root) → sha`, `diff(root, base, head) → patch`, `changedSince(root, sha) → [path]` | `storage-git.mjs`: files on disk, git for commit, hash, diff | none needed; the config names the repos (§3) |
| `resourceGuard` | one | `run(job: { session, what, maxMinutes, command: [argv], cwd }) → { exitCode, log }`, `status() → { held: {session, what, since} \| null, queued: [...] , estimateMinutes }`, `claim(resource, by, why, hours?)`, `release(resource, by)`, `resources() → [{ id, name, state }]` | `resource-guard-local.mjs`: one job at a time, a lock in the state folder (§4) | a plugin over a lock and device claims it already has |
| `machineGuard` | one | `limits() → { maxAgents, maxHeavy }`, `running() → [{ pid, task, step, since }]` | `machine-guard-pids.mjs`: pid files under the state folder (§4); limits from the config, default `{ maxAgents: 2, maxHeavy: 1 }` | the default, with its own limits |
| `runner` | one | `start(step: { brief, cwd, model, effort, maxTurns, allowedTools, disallowedTools, resume? }) → { pid, sessionId, done: Promise<{ exitCode, result, usage }> }`, `keepAlive(sessionId, cwd) → usage` | `runner-claude.mjs`: headless `claude -p` (`orchestrator.md` §3) | the default |
| `handoff` | many, merged in load order | `targets({ task, session, cwd }) → [{ where, what }]`, `release({ task, session, cwd }) → [{ resource, line }]` | `handoff-notes.mjs`: the handoff goes to the task's `handoff.md`; releases the session's own kirunak state (its `sessions/` file, the default guard's claims and queue line) | where its sessions keep handoffs, and what else a session holds that must be let go |
| `frontend` | many | `onChange(event)`, `render?(tasks, status) → text` | `board-html.mjs` (D10), `list.mjs` | the phone artifact (a step, D13) and the mod (D14) ship with kirunak (`boards.md`); a workspace may add its own |
| `tracker` | many | `push(task, state)`, `pull() → [{ id, state }]` | none | later: Linear, It's a Plan, GitHub Issues (R18) |
| `sync` | one | `pushTask(id)`, `pullTask(id)`, `watch(cb)` | none | later: the cloud (R17) |
| `prices` | one | `weights(model) → { input, cacheRead, write5m, write1h, output }` | `prices-default.mjs`: per base input token, cache read 0.1, 5-minute write 1.25, 1-hour write 2, output 5; per model against Opus: Sonnet 0.6, Haiku 0.2, Fable 2.5 | its own, when the price list changes or its account pays differently |

- Evidence for the cache ratios of the `prices` default: Anthropic's prompt-caching documentation (a cache read at
  0.1 times the base input price, a 5-minute write at 1.25 times, a 1-hour write at 2 times; `prompt-caching.md`).
  Judgement for output 5 and the model multipliers: the API list prices when this was written; they are a seam
  because they change with the price list, and `k doctor` prints the weights in use.
- Judgement: `storage`, `resourceGuard`, `machineGuard`, `runner`, `sync` and `prices` take one implementation,
  because two of them would disagree about one fact (where a file is, who holds the machine). `checklist`,
  `handoff`, `frontend` and `tracker` compose. Loading a second implementation of a one-policy seam is an error that
  names both modules, never a silent override.
- Judgement on the default guard: kirunak must work alone, on a machine with no lock of its own (R10). The default
  keeps `$KIRUNAK_HOME/guard/lock` (a directory made with `mkdir`, which is atomic, holding `owner.json`: session,
  what, pid, job, since; pid is the waiting kirunak process, job the command's process group) and a
  first-in-first-out queue file `guard/queue` beside it. `run` waits its turn, runs the command with the job's
  `maxMinutes` as a deadline (past it, TERM to the process group, then KILL after 10 s, exit code 124), and releases
  however the job ends; a kirunak stopped by SIGINT, SIGTERM or SIGHUP ends the job's group first (`lib/stop.mjs`),
  and one that crashes keeps the lock while its job runs. A lock whose pid is dead is taken over on the next try,
  after whatever is left of its job's group is ended (TERM, then KILL). `claim` and `release` record claims in
  `guard/claims.json` (resource, by, why, until); `resources()` lists what was ever claimed. Every job appends one
  line to `guard/log.jsonl` (what, session, minutes, exit code).
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
};
```

- Every key but `repos` and `queue` is optional and has the default shown, except `models` and `baseline`, which
  default to nothing. Judgement on `models`: which model and effort a kind of step runs on is a cost choice each
  workspace makes, so the core's default is to pass no `--model` and no `--effort` at all (Claude Code's own
  default applies). A workspace sets `models: { agent, review, sync, escalate }`, each `{ model, effort }`, and a
  plan line overrides it per step (`orchestrator.md` §1). `escalate` is what a step that failed twice is retried on,
  when the workspace names one (`orchestrator.md` §2).
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
running/<pid>.json     one file per live step process: task, step, session id, since (machineGuard)
sessions/<id>.json     a session's current task and step, context and cache (set by k start and the status line)
keeper.jsonl           every keep-alive, miss and skip (R11, D9)
events.jsonl           what the front ends show as toasts: build ended, review ready, keep-alive, refusal
freeze.log             every refusal of the PreToolUse hook (approval.md §2)
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
