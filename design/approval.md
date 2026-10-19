# Approval: the frozen task, the hooks, the owner's command

Design (D7, D11, D12, D14, R5, R7, R15). Each choice is marked **evidence** (with its source) or **judgement**.
Index: `README.md`. The examples use the invented task of `task-files.md`, `weather/offline-forecast`.

Three guards, each against a mistake, none against a deliberate bypass (D7): a Claude Code hook that refuses an
agent's edit, a git hook that refuses a commit whose task no longer matches its approval, and a command only the
owner's own gesture runs.

## 1. The approval record

`kirunak/approvals/<slug>.json`, written only by `k approve`:

```json
{
  "task": "weather/offline-forecast",
  "hash": "sha256:3f2a…",
  "approved": "2026-11-05T09:12:00+01:00",
  "by": "owner",
  "via": "shell",
  "commit": "7c1d2e3",
  "history": [
    { "hash": "sha256:9b0c…", "approved": "2026-11-02T19:40:00+01:00", "amendment": null },
    { "hash": "sha256:3f2a…", "approved": "2026-11-05T09:12:00+01:00", "amendment": "A-1" }
  ]
}
```

- `hash` is SHA-256 over the exact bytes of `task.md` (`node:crypto`), so `k verify` and the git hook compute the
  same thing from `git show :kirunak/tasks/<slug>/task.md`. Judgement: bytes, not a normalised text, because a
  normaliser is one more thing to agree on; the intake writes LF and one trailing newline, and `k check` refuses CRLF.
- `via` is `shell` (the owner typed `! k approve ...`, §4) or `mod` (the mod's `/k-approve`, §5). `commit` is the
  sha of the commit `task.md` had when it was approved (`git log -1 --format=%h -- task.md`), so a reader can diff
  the approved text against anything later; the approval commit itself is `git log -1 -- kirunak/approvals/<slug>.json`.
  The hooks never read `commit`; they read `hash`.

## 2. The Claude Code hook: `hooks/kirunak-freeze.mjs` (PreToolUse)

The documented PreToolUse shape: it reads the hook JSON on stdin, prints a `permissionDecision: "deny"` with a reason
the model reads, or exits 0 with nothing. `k install` wires it in the user's `~/.claude/settings.json` on
`Edit|Write|MultiEdit|NotebookEdit|Bash|Skill`, beside any other PreToolUse hook the workspace has (`build-order.md`,
slice 1). Input fields it reads: `tool_name`, `tool_input` (`file_path`, `notebook_path`, `command`, `skill`), `cwd`
(documented for PreToolUse: `session_id`, `transcript_path`, `cwd`, `tool_name`, `tool_input`, `tool_use_id`;
`code.claude.com/docs/en/hooks.md`, fetched 2026-10-18).

It refuses, with the reason that says what to do instead:

| What | Why | The reason it prints |
| --- | --- | --- |
| Edit/Write of `kirunak/tasks/<slug>/task.md` when `kirunak/approvals/<slug>.json` exists in that repo | R5: frozen | "frozen since <date>: propose an amendment in `kirunak/tasks/<slug>/amendments/A-<n>.md` (`k amend new <id>`) and ask the owner to run `k approve <id> --amendment A-<n>`" |
| Any write under `kirunak/approvals/`, to `done.json`, `hold.md`, or an amendment's `applied:`/`declined:` stamp (an Edit whose new text adds one) | D7: only the owner | "only the owner's own command writes this: ask them to type `! k approve <id>` / `! k accept <id>`" |
| A Bash command that writes there (redirection, `tee`, `sed -i`, `cp`/`mv`/`rm` into it, `git checkout`/`restore` of it), found by a small segment parser (split on `;`, `&&`, `\|\|`, `\|` and newlines, then the write targets of each segment) | the same | the same |
| A Bash command running `k approve`, `k accept`, `k amend decline`, `k hold`, `k resume`, `k queue` (or `k.mjs` with those verbs) | the owner's verbs | "`k <verb>` is the owner's: it runs only from the owner's own prompt (`!`) or the mod" |
| Edit/Write of `kirunak/tasks/<slug>/intake.md` | append-only through `k intake` | "record the question or answer with `k intake question|answer`" |
| Edit/Write of `checklist.md` ticks (`- [x]`) | R15: the owner's checklist | "the owner ticks the checklist" |
| Edit/Write of any `.slapignore`, or a shell write to one (redirection, `sed -i`, `cp`, `rm`, `git checkout`/`restore` of it, a `node -e` that writes it) | R23: the owner's list (`change-size.md` §4) | "`.slapignore` is the owner's (R23): say which pattern to add or remove and why, and ask the owner to edit it and type `! k slapignore approve <repo>`" |
| Any write to `$KIRUNAK_HOME/slapignore.json`, or a Bash command running `k slapignore approve` | R23: only the owner approves | "only the owner's own command writes the `.slapignore` approvals" / "`k slapignore approve` is the owner's" |

It allows everything else: draft `task.md`, `plan.md`, `progress.md`, `notes.md`, `handoff.md`, `review.md`,
`evidence/`, a new amendment file, reading anything, `git commit` of the allowed files (a `.slapignore` too: the git
hook checks it against its approval), every `k` reading verb and
`k intake`, `k check`, `k step`, `k review`, `k board`, `k handoff`. A `k` verb run with `--dry-run` is always
allowed.

- Fails **open** (judgement: a hook that cannot read its input must not stop every session), and logs every refusal
  to `$KIRUNAK_HOME/freeze.log` (`plugins.md` §4). `KIRUNAK_FREEZE_OFF=1` turns it off for the owner's own session,
  logged.
- Finding the repo and the record: from `file_path` (or `cwd` for Bash), walk up to the directory that holds
  `kirunak/`; the slug is the path segment after `kirunak/tasks/`. No workspace needed: judgement, the hook must be
  fast (it runs on every Edit, Write and Bash call) and must not depend on the loader.
- Speed: one `fs.existsSync` per call in the common case. Number to check: under 50 ms per call, measured over 50
  spawns (`build-order.md`).
- It exports `decide(input) → reason | null` beside its `main`, so a workspace that runs several PreToolUse hooks on
  the same tools can call them from one dispatcher process (`build-order.md`, number 1).
- Under a subagent the input carries `agent_id` and `agent_type` (hooks.md, fetched 2026-10-18); the hook treats
  agents and the main session alike (both are the model).

## 3. The git hook: `hooks/git-pre-commit.mjs`

Installed per repo that holds tasks. `k install --git <repo>` writes `.git/hooks/pre-commit` calling it when the repo
has no pre-commit hook; a repo that already has one (often a committed `githooks/pre-commit` copied into
`.git/hooks`) adds one line, which `k install --git <repo> --print` prints with the install path filled in:
`node <kirunak>/hooks/git-pre-commit.mjs || exit 1`. Judgement: kirunak never rewrites a hook it did not write. It
reads the index (`git diff --cached --name-only`, `git show :<path>`) and refuses a commit when:

1. a staged `kirunak/tasks/<slug>/task.md` has an approval record (in the index, else in HEAD) whose `hash` differs
   from the SHA-256 of the staged bytes, and `KIRUNAK_APPROVING` is not `<id>` in the environment: "task.md changed
   after approval; `k approve <id> --amendment A-n` applies an approved amendment and re-hashes";
2. a staged file under `kirunak/approvals/`, a `done.json`, a `hold.md`, or an amendment stamp, without
   `KIRUNAK_APPROVING` / `KIRUNAK_ACCEPTING` / `KIRUNAK_HOLDING` naming the task: "written by the owner's command only";
3. a staged `intake.md` that is not an append of the committed one (the old text must be a prefix of the new):
   "intake.md is append-only; use `k intake`".

`k approve`, `k accept` and `k hold` set those variables on the one `git commit` they run. Evidence that the mod's
route needs nothing more: `$.process.run` "Git runs with repo hooks off" (Claude Code's plugin-authoring types,
2.1.302, the `process.run` doc), so the mod's commit bypasses this hook anyway, and the command validates before it
commits. Judgement: the variable is a mistake guard in the spirit of D7; a model that sets it has read this file and
chosen to.

It also runs `k verify --staged` logic for every task whose record is in HEAD and whose `task.md` is unchanged:
nothing to do, so the hook costs one `git diff --cached` on a commit that touches no kirunak file (number to check:
under 100 ms).

## 4. The owner's command: `k approve`, `k accept`, through `!`

`k approve <id> [--amendment A-n] [--first|--before <id>|--after <id>]`:

1. refuses unless `k check <id>` passes, Open questions is empty and `task.md` is committed (the intake's commit,
   `intake.md` §4); with `--amendment`, refuses unless `k amend check` passes, then applies the operations to
   `task.md`;
2. computes the hash, writes the record (new, or with the old hash pushed to `history`), stamps the amendment
   `applied:`;
3. stages `task.md`, the record, the amendment; commits `kirunak: approve <id>` (`... amendment A-n`) with
   `KIRUNAK_APPROVING=<id>`; adds the task to the queue (`k queue add`, a commit in the queue's repo) unless
   `--no-queue`;
4. prints the state line (`ready, queue place 3`) and appends `events.jsonl` (the mod's toast).

`k accept <id>`: refuses unless the latest review (`review.md`, `review-2.md`, ...) counts, that is it passes
`k review check` and the review step whose output it is has `finished` in `progress.md` (`review.md` §2), and every
`checklist.md` item is ticked or the owner passes `--checklist-open "<why>"` (recorded in `done.json`); a refusal
names each problem. The verdict it takes is `met`, or `needs owner (<ids>)` once the checklist is done. It refuses
`verdict: not met (<ids>)` whatever the flags, `--checklist-open` included, which waives checklist items and never a
criterion: the way out is an amendment (`k amend new <id>`, approved, then a new review) or a new review after a
fix. It refuses a task with no review: a task closes only through a review step of `plan.md` that ran. It writes
`done.json`, commits with `KIRUNAK_ACCEPTING`, removes the task from the queue. It is what the `k-done` skill asks the owner to type (`review.md` §4).

Why `!`: the shortcuts documentation says a `!` line is "Run a command directly, add its output to the session, and
have Claude respond to it", shell mode "Doesn't require Claude to interpret or approve the command", and the
model's own route to a shell is the `Bash` tool (`code.claude.com/docs/en/interactive-mode.md`, fetched
2026-10-18; no statement was found that the model can trigger shell mode). The Bash tool goes through PreToolUse,
where §2 refuses the owner's verbs. So the only way `k approve` runs is a line the owner typed. Note:
`respondToBashCommands: false` in settings stops the model from answering the command's output with a turn
(interactive-mode.md); the owner may set it, since the output is a state line and a turn on it costs a cache read of
the whole context.

## 5. D14 settled: the mod's slash command replaces `!`, once the mod exists

The question (D14): does a mod's slash command run without the model, and can the model not call it? Both hold on
this build, from the engine's own type declarations, not from memory (Claude Code's `plugin-authoring` skill, Claude
Code 2.1.302, `types/claude-code.d.ts`, read 2026-10-18; line numbers from that file):

- **Runs without the model.** A plugin declares `/<name>` with `$.command.register({ name, description })` and
  serves it with a `command.run` hook that returns `{ text }` (lines 3164 to 3174). "A hook's own answer without
  `next` runs no command: its `text` is shown as the command's output" (1860 to 1866), and "Core is the engine's
  command (a registered one has none)" (4343). The hook runs in the hooks module, an environment of the engine's
  with `$.process.run(argv)` to run a host command (3581 to 3598). No model turn is part of it. The public docs agree
  on the other half: markdown commands and skills are injected "as user messages at the point of invocation", so a
  model turn follows them (`code.claude.com/docs/en/skills.md`, fetched 2026-10-18); a markdown command cannot do
  this, only a mod can.
- **The model cannot call it as the owner.** `command.run`'s input carries `origin: PromptOrigin`, "a closed set,
  never a text prefix" that "no hook sets" (9215 to 9223), with `composer` defined as "The user's own gesture at the
  terminal, as the engine stamped it (never presumed from an unstamped command)" (9224 to 9232). The other kinds are
  `bridge`, `sdk`, `task-notification`, `scheduled-trigger`, `peer`, `projects-relay`, `channel`, `coordinator`,
  `observer`, `observer-activity`, `auto-continuation`, `unclassified`, and `{ kind: 'plugin', name }` for another
  plugin's `$.command.run` (1836 to 1843, 9233 to 9310). The model has no kind of its own: its routes are the Skill
  tool (a skill, which is a model turn; the tools reference lists no `SlashCommand` tool, `tools-reference.md`,
  fetched 2026-10-18), another plugin's `$.command.run` (`plugin`), or `claude -p "/k-approve"` from the Bash tool,
  which is a new process with origin `sdk` (and under `-p` the mods folder's hot reload is off, plugin-authoring
  SKILL.md "What happens when the turn ends"). So a `command.run` hook that answers only when `e.origin.kind ===
  'composer'` and refuses every other origin with a line answers the owner's Enter and nothing else.
- Two caveats the build must keep: (1) "Registering a name again replaces it" (3167): another plugin could take
  `/k-approve`; that is a deliberate act, out of D7's scope, and `k plugins`/`/plugins` shows what is loaded.
  (2) The mod must be loaded in the owner's session: installed from a folder marketplace, or named in
  `CLAUDE_CODE_PLUGIN_DIRS` in the `env` block of `~/.claude/settings.json` (plugin-authoring reference.md,
  "`--plugin-dir`"); hot reloading from the dev-mods folder is for developing it.

So: **yes, the mod's `/k-approve <id>` and `/k-accept <id>` replace `!` as the owner's commands** (D14), in the mod
slice (`boards.md` §4, `build-order.md` slice 6). The hook calls `$.process.run(['node', K, 'approve', id,
'--via', 'mod'])` and prints the state line; the core function is the same as §4's, so the record's `via` is the only
difference. `!` stays as the route for a session without the mod (a `claude -p` step never approves anything).
`bridge` (Claude Code's Remote Control from the phone) is also the owner's own gesture; whether to accept it is
the owner's call (`README.md`, questions), default refused, consistent with D13.

## 6. A frozen openspec's instructions, once slice 1 exists (D11, R20)

kirunak ships no openspec hook (judgement: freezing a tool is a workspace's decision, D11). A workspace whose
PreToolUse hook refuses openspec changes points its refusal at the intake once slice 1 exists. The text kirunak
proposes for that refusal: "(1) do not edit anything under openspec/; (2) to work on an openspec change, bring it
into kirunak: `k intake start <repo>/<slug> --from openspec/changes/<name>` and run the `k-intake` interview with
the owner (the openspec text is background; every line is re-asked); (3) progress on a kirunak task goes to its
`progress.md` and `notes.md`, never to openspec. Tell the owner what you were about to change in openspec, so
nothing is lost."

## 7. Requirements this file satisfies

D7 (§2, §3, §4), D11 and R20 (§6), D12 (`k-approve`, `k-accept`), D14 (§5), R5 (§1, §2), R7 (§2 row 1, §4 step 1),
R15 (`k accept`, with `review.md`).
