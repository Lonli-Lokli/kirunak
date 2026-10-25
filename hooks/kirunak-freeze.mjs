#!/usr/bin/env node
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { kirunakHome } from '../lib/home.mjs';

// PreToolUse (approval.md §2): refuses the model's write to what only the owner's commands write, and the owner's
// verbs run through the Bash tool. A guard against mistakes, not against a deliberate bypass; it fails open.
// It imports nothing but node: modules and lib/home.mjs, because it runs on every Edit, Write and Bash call.
// For the escalation hook (gulnya/enforced-escalation S-2 design §5) it refuses edits while the session's block is in
// force, and every way the model could reach what lifts the block: the Skill call of k-go-on, a scheduled prompt or a
// message carrying /k-go-on, an agent's prompt that starts with it, a claude run from the shell that would type it into
// a session, and the hook's own files.

const OWNER_VERBS = new Set(['approve', 'accept', 'hold', 'resume', 'queue']);
const OWNER_SKILLS = new Set(['k-approve', 'k-accept', 'k-hold', 'k-resume', 'k-go-on']);
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
// The tools that put a prompt into a session, now or later (2.1.310's tools reference): a session-scoped scheduled
// task, a /loop's next wakeup, a message to an agent or another session.
const PROMPT_TOOLS = new Set(['CronCreate', 'ScheduleWakeup', 'SendMessage']);
const GO_ON_TEXT = /\/k-go-on/i;
const GO_ON_START = /^\s*\/k-go-on\b/i;
const RESUMES = /^(?:--continue|--resume|--session-id)(?:=|$)|^-[A-Za-z]*[cr]/;
const TICK = /^\s*[-*+]\s+\[[xX]\]/gm;
const STAMP = /^(applied|declined):/gm;
const GLOB = /[*?[]/;

const count = (text, re) => (text.match(re) ?? []).length;

const frozen = (id, slug, date) =>
  `kirunak: ${id} is frozen since ${date}: propose an amendment in kirunak/tasks/${slug}/amendments/A-<n>.md ` +
  `(\`k amend new ${id} --title "<a few words>"\`) and ask the owner to run \`k approve ${id} --amendment A-<n>\``;
const ownerOnly = (id = '<id>') =>
  `kirunak: only the owner's own command writes this: ask them to type \`! k approve ${id}\` / \`! k accept ${id}\``;
const ownerVerb = (verb) =>
  `kirunak: \`k ${verb}\` is the owner's: it runs only from the owner's own prompt (\`!\`) or the mod`;
const GENERATED = (id = '<id>') =>
  `kirunak: cost.md is generated from done.json's cost, which only \`k accept\` records: \`k cost ${id} --write\` writes it again`;
const INTAKE = 'kirunak: intake.md is append-only: record the question or answer with `k intake question|answer`';
const TICKS = 'kirunak: the owner ticks the checklist: leave its items as `- [ ]`';
const SLAPIGNORE = 'kirunak: .slapignore is the owner\'s (R23): say which pattern to add or remove and why, and ask the ' +
  'owner to edit it and type `! k slapignore approve <repo>`';
const SLAP_RECORD = 'kirunak: only the owner\'s own command writes the .slapignore approvals: ask them to type ' +
  '`! k slapignore approve <repo>`';
const GO_ON = 'kirunak: /k-go-on is the owner\'s: only the owner, typing it, lifts a block.';
const GO_ON_SHELL = 'kirunak: a claude run that resumes a session or types /k-go-on is refused:\n' +
  'only the owner, typing /k-go-on, lifts an escalation block.';
const HOOK_STATE = 'kirunak: the escalation hook\'s state and log are its own: leave them alone.';
// A block written before its reason was stored: the same three things to say.
const BLOCKED = 'kirunak: edits are blocked: a test failed again after the hand-up notice.\n' +
  'Launch the agent one rung up on this step.\nThe owner can type /k-go-on to lift it instead.';

// Whether `path` is the escalation hook's state (a file under $KIRUNAK_HOME/escalate/) or its log; `removing` also
// guards a folder that holds them (rm -r, mv).
function hookState(path, removing = false) {
  const home = kirunakHome();
  const dir = join(home, 'escalate');
  if (path === dir || path.startsWith(`${dir}/`) || path === join(home, 'escalate.log')) return true;
  return removing && `${dir}/`.startsWith(path.endsWith('/') ? path : `${path}/`);
}

// Where a path sits in a repo's kirunak/ folder; the repo is the directory that holds it.
function locate(path) {
  const m = /^(.*)\/kirunak\/(approvals|tasks)(?:\/(.*))?$/.exec(path);
  return m ? { root: m[1] || '/', area: m[2], rest: m[3] ?? '' } : null;
}

function record(root, slug) {
  const file = join(root, 'kirunak', 'approvals', `${slug}.json`);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

// The record of `slug`, or for a glob slug (`tasks/*/task.md`) the first record it matches.
function recordOf(root, slug) {
  if (!GLOB.test(slug)) {
    const rec = record(root, slug);
    return rec && { slug, rec };
  }
  const re = new RegExp(`^${slug.replace(/[.+^${}()|\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}\\.json$`);
  let names = [];
  try {
    names = readdirSync(join(root, 'kirunak', 'approvals'));
  } catch {
    return null;
  }
  const name = names.find((n) => re.test(n));
  return name ? { slug: name.slice(0, -5), rec: record(root, name.slice(0, -5)) } : null;
}

const idOf = (root, slug, rec) => (typeof rec?.task === 'string' ? rec.task : `${basename(root)}/${slug}`);

function frozenReason(root, found) {
  const date = typeof found.rec.approved === 'string' ? found.rec.approved.slice(0, 10) : 'its approval';
  return frozen(idOf(root, found.slug, found.rec), found.slug, date);
}

/**
 * The reason a change to `path` is refused, or null. `change` is { before, after } for an Edit or Write (the text
 * replaced and the text written), null for a shell write whose text is unknown. `removing` also guards a folder
 * that holds protected files (rm -r, mv).
 */
function verdict(path, change, removing = false) {
  if (hookState(path, removing)) return HOOK_STATE;
  if (basename(path) === '.slapignore') return SLAPIGNORE;
  if (path === join(kirunakHome(), 'slapignore.json')) return SLAP_RECORD;
  const at = locate(path);
  if (!at) {
    return removing && basename(path) === 'kirunak' && existsSync(join(path, 'approvals')) ? ownerOnly() : null;
  }
  const { root, area, rest } = at;
  if (area === 'approvals') {
    const slug = rest.split('/')[0].replace(/\.json$/, '');
    return ownerOnly(slug && !GLOB.test(slug) ? idOf(root, slug, record(root, slug)) : undefined);
  }
  const [slug, ...under] = rest.split('/');
  const file = under.join('/');
  if (!slug) return removing && existsSync(join(root, 'kirunak', 'approvals')) ? ownerOnly() : null;
  if (!file) {
    if (!removing) return null;
    const found = recordOf(root, slug);
    if (found) return frozenReason(root, found);
    const held = ['done.json', 'hold.md'].some((f) => existsSync(join(root, 'kirunak', 'tasks', slug, f)));
    return held ? ownerOnly(idOf(root, slug)) : null;
  }
  if (file === 'done.json' || file === 'hold.md') return ownerOnly(idOf(root, slug, record(root, slug)));
  if (file === 'cost.md') return GENERATED(idOf(root, slug, record(root, slug)));
  if (file === 'task.md') {
    const found = recordOf(root, slug);
    return found ? frozenReason(root, found) : null;
  }
  if (!change) return null;
  if (file === 'intake.md') return INTAKE;
  if (file === 'checklist.md') return count(change.after, TICK) > count(change.before, TICK) ? TICKS : null;
  if (/^amendments\/[^/]+$/.test(file) && count(change.after, STAMP) > count(change.before, STAMP)) {
    return ownerOnly(idOf(root, slug, record(root, slug)));
  }
  return null;
}

function changeOf(tool, ti) {
  const s = (v) => (typeof v === 'string' ? v : '');
  if (tool === 'Edit') return { before: s(ti.old_string), after: s(ti.new_string) };
  if (tool === 'MultiEdit') {
    const edits = Array.isArray(ti.edits) ? ti.edits : [];
    return { before: edits.map((e) => s(e?.old_string)).join('\n'), after: edits.map((e) => s(e?.new_string)).join('\n') };
  }
  if (tool === 'NotebookEdit') return { before: '', after: s(ti.new_source) };
  return { before: '', after: s(ti.content) };
}

// ---- Bash: a small segment parser ----

/** [cmd] without the bodies of its here-documents: their lines are text, not commands. The opening line stays. */
function withoutHeredocs(cmd) {
  const kept = [];
  let end = null;
  for (const line of cmd.split('\n')) {
    if (end !== null) {
      if (line.trim() === end) end = null;
      continue;
    }
    kept.push(line);
    end = line.match(/(?<!<)<<(?!<)-?\s*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?/)?.[1] ?? null;
  }
  return kept.join('\n');
}

/**
 * The command's simple commands, split at ; & && | || ( ) and newlines outside quotes. Each is a list of tokens:
 * a word with its quotes removed (a string), or a redirection ({ op: '>' | '>>' | '2>' | '&>' | '<' | ... }).
 * Text inside quotes is never a command, so `git commit -m "k approve later"` is one word.
 */
export function segments(command) {
  const cmd = withoutHeredocs(String(command ?? ''));
  const out = [];
  let tokens = [];
  let word = null;
  let quote = null;
  const end = () => {
    if (word !== null) tokens.push(word);
    word = null;
  };
  const cut = () => {
    end();
    if (tokens.length) out.push(tokens);
    tokens = [];
  };
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    const next = cmd[i + 1];
    if (quote) {
      if (c === quote) quote = null;
      else if (c === '\\' && quote === '"' && next !== undefined && '"\\$`'.includes(next)) word += cmd[++i];
      else word += c;
    } else if (c === "'" || c === '"') {
      quote = c;
      word ??= '';
    } else if (c === '\\') {
      if (next === '\n') i++;
      else word = (word ?? '') + (cmd[++i] ?? '');
    } else if (c === '#' && word === null) {
      while (i + 1 < cmd.length && cmd[i + 1] !== '\n') i++;
    } else if (c === '>' || (c === '&' && next === '>')) {
      let op = c;
      if (c === '>' && word !== null && /^\d+$/.test(word)) {
        op = word + op;
        word = null;
      } else {
        end();
      }
      if (c === '&') op += cmd[++i];
      if (cmd[i + 1] === '>' || cmd[i + 1] === '|') op += cmd[++i];
      if (cmd[i + 1] === '&') op += cmd[++i];
      tokens.push({ op });
    } else if (c === '<') {
      end();
      let op = '<';
      while (cmd[i + 1] === '<') op += cmd[++i];
      if (cmd[i + 1] === '(') {
        cut();
        continue;
      }
      if (op === '<<' && cmd[i + 1] === '-') i++;
      tokens.push({ op });
    } else if (';&|()\n'.includes(c)) {
      cut();
    } else if (c === ' ' || c === '\t') {
      end();
    } else {
      word = (word ?? '') + c;
    }
  }
  cut();
  return out;
}

const WRAPPERS = new Set(['then', 'do', 'else', 'if', 'elif', 'while', 'until', '!', '{', 'time', 'nohup', 'exec', 'env',
  'sudo', 'npx', 'command', 'builtin', 'nice']);

/** One segment's words past assignments and wrappers, and the targets of its output redirections. */
function parse(tokens) {
  const words = [];
  const redirected = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (typeof t === 'string') {
      words.push(t);
      continue;
    }
    const operand = typeof tokens[i + 1] === 'string' ? tokens[++i] : null;
    if (operand === null || !t.op.includes('>')) continue;
    if (t.op.endsWith('&') && /^(\d+|-)$/.test(operand)) continue; // >&2 duplicates a descriptor
    redirected.push(operand);
  }
  let w = words;
  for (;;) {
    if (w.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(w[0])) w = w.slice(1);
    else if (w.length && WRAPPERS.has(w[0])) {
      w = w.slice(1);
      while (w[0]?.startsWith('-')) w = w.slice(1);
    } else break;
  }
  return { words: w, redirected };
}

const base = (word) => (word ?? '').split('/').pop();
const options = (words) => words.filter((w) => w && !w.startsWith('-'));

/** The words after `k` when the segment runs kirunak's CLI (`k`, `k.mjs`, `node <path>/k.mjs`), else null. */
function kArgs(words) {
  let w = words;
  if (['node', 'nodejs'].includes(base(w[0]))) {
    w = w.slice(1);
    while (w[0]?.startsWith('-')) w = w.slice(1);
  }
  return ['k', 'k.mjs'].includes(base(w[0])) ? w.slice(1) : null;
}

function ownerVerbOf(args) {
  if (args.includes('--dry-run')) return null;
  const [verb, sub] = options(args);
  if (verb === 'queue' && sub === 'show') return null;
  if (OWNER_VERBS.has(verb)) return verb;
  if (verb === 'amend' && sub === 'decline') return 'amend decline';
  if (verb === 'slapignore' && sub === 'approve') return 'slapignore approve';
  return null;
}

function absolute(path, dir) {
  let p = path;
  const home = process.env.HOME || homedir();
  if (p === '~' || p.startsWith('~/')) p = home + p.slice(1);
  p = p.replace(/^\$\{?HOME\}?(?=\/|$)/, home);
  return resolve(dir, p);
}

const isDir = (abs) => {
  try {
    return statSync(abs).isDirectory();
  } catch {
    return false;
  }
};

// cp/mv's target: a folder takes each source's name.
function into(target, sources, dir) {
  const abs = absolute(target, dir);
  if (!target.endsWith('/') && !(locate(abs) && isDir(abs))) return [abs];
  return [abs, ...sources.map((s) => join(abs, basename(s)))];
}

const WRITE_API = /\b(writeFileSync|appendFileSync|writeFile|appendFile|rmSync|unlinkSync|unlink|renameSync|rename|copyFileSync|cpSync|createWriteStream|truncateSync)\b/;

/** What one segment writes and removes: { writes: [abs], removes: [abs] }, and the `cd` it makes. */
function effects(words, redirected, dir) {
  const writes = redirected.map((p) => absolute(p, dir));
  const removes = [];
  const verb = base(words[0]);
  const args = words.slice(1);
  const plain = options(args);
  const all = (list) => list.map((p) => absolute(p, dir));
  if (verb === 'tee' || ['touch', 'truncate', 'mkdir'].includes(verb)) writes.push(...all(plain));
  else if (['sed', 'gsed', 'perl'].includes(verb) && args.some((a) => /^-[A-Za-z]*i/.test(a) || a.startsWith('--in-place'))) {
    writes.push(...all(plain));
  } else if (['rm', 'rmdir', 'unlink', 'shred'].includes(verb)) removes.push(...all(plain));
  else if (['cp', 'rsync', 'install', 'ditto', 'ln'].includes(verb) && plain.length >= 2) {
    writes.push(...into(plain.at(-1), plain.slice(0, -1), dir));
  } else if (verb === 'mv' && plain.length >= 2) {
    removes.push(...all(plain.slice(0, -1)));
    writes.push(...into(plain.at(-1), plain.slice(0, -1), dir));
  } else if (verb === 'git') {
    let at = dir;
    let i = 0;
    while (i < args.length && args[i].startsWith('-')) {
      if (args[i] === '-C') at = absolute(args[++i] ?? '.', at);
      else if (args[i] === '-c') i++;
      i++;
    }
    const sub = args[i];
    const paths = options(args.slice(i + 1)).map((p) => absolute(p, at));
    if (sub === 'checkout' || sub === 'restore') writes.push(...paths);
    else if (sub === 'rm' || sub === 'mv') removes.push(...paths);
  } else if (['node', 'nodejs', 'bun', 'deno'].includes(verb)) {
    const code = args.filter((a) => WRITE_API.test(a)).join('\n');
    for (const m of code.matchAll(/[^\s'"`(),]*(?:kirunak\/(?:approvals|tasks)\/[^\s'"`(),]*|\.slapignore\b|escalate(?:\/[^\s'"`(),]*|\.log\b))/g)) writes.push(absolute(m[0], dir));
  }
  return { writes, removes };
}

function shell(command, cwd) {
  let dir = cwd;
  for (const tokens of segments(command)) {
    const { words, redirected } = parse(tokens);
    const k = kArgs(words);
    if (k) {
      const verb = ownerVerbOf(k);
      if (verb) return ownerVerb(verb);
    }
    // A claude run from the shell that resumes a session (its prompt may come from a file) or carries /k-go-on would
    // fire UserPromptExpansion in that session as if the owner typed it.
    if (base(words[0]) === 'claude' && (GO_ON_TEXT.test(command) || words.slice(1).some((w) => RESUMES.test(w)))) return GO_ON_SHELL;
    if (words[0] === 'cd') {
      dir = absolute(words[1] ?? '~', dir);
      continue;
    }
    const { writes, removes } = effects(words, redirected, dir);
    for (const p of writes) {
      const reason = verdict(p, null);
      if (reason) return reason;
    }
    for (const p of removes) {
      const reason = verdict(p, null, true);
      if (reason) return reason;
    }
  }
  return null;
}

/** The reason to refuse the tool call described by the hook's `input`, or null to allow it. */
export function decide(input) {
  const tool = input?.tool_name;
  const ti = input?.tool_input ?? {};
  const cwd = typeof input?.cwd === 'string' ? input.cwd : process.cwd();
  if (EDIT_TOOLS.has(tool)) {
    const path = ti.file_path ?? ti.notebook_path;
    if (typeof path === 'string' && hookState(absolute(path, cwd))) return HOOK_STATE;
    const blocked = blockOf(input);
    if (blocked) return blocked;
    if (typeof path !== 'string' || !/kirunak\/|\.slapignore$|slapignore\.json$/.test(path)) return null;
    return verdict(absolute(path, cwd), changeOf(tool, ti));
  }
  if (tool === 'Skill') {
    const name = String(ti.skill ?? '').split(':').pop();
    if (!OWNER_SKILLS.has(name)) return null;
    return name === 'k-go-on' ? GO_ON : ownerVerb(name.slice(2));
  }
  if (PROMPT_TOOLS.has(tool)) return GO_ON_TEXT.test(JSON.stringify(ti)) ? GO_ON : null;
  // A subagent's prompt is a prompt into a session (S-10 S-4); only its start would expand, and a brief that quotes the
  // block's reason, which names /k-go-on, must still reach the agent that lifts it.
  if (tool === 'Agent') return GO_ON_START.test(String(ti.prompt ?? '')) ? GO_ON : null;
  // Monitor runs a shell command as Bash does, under Bash's permission rules (tools reference).
  if (tool === 'Bash' || tool === 'Monitor') return shell(String(ti.command ?? ''), cwd);
  return null;
}

/**
 * The deny reason of the escalation block in force in the session (S-2 design R5.1, E-10), or null: read from the
 * session's state file, which a subagent's edit shares with its caller (E-13), while `block.lifted` is null,
 * config.json has the hook and `hook.block` on, and no k run step runs (E-12). One existsSync when there is no file.
 */
function blockOf(input) {
  if (process.env.KIRUNAK_STEP) return null;
  const home = kirunakHome();
  const file = escalationFile({ session_id: input?.session_id }, home);
  if (!file || !existsSync(file)) return null;
  const { block } = readJson(file) ?? {};
  if (!block || typeof block !== 'object' || block.lifted != null) return null;
  const config = readJson(join(home, 'escalate', 'config.json'));
  if (!config || config.hook?.enabled === false || config.hook?.block === false) return null;
  const reason = input.agent_id ? block.subagentReason : block.reason;
  return typeof reason === 'string' && reason ? reason : BLOCKED;
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

// Every refusal, and every call KIRUNAK_FREEZE_OFF let through, goes to freeze.log; a refusal also to events.jsonl.
function log(input, reason, off) {
  const home = kirunakHome();
  const ti = input.tool_input ?? {};
  const time = new Date().toISOString();
  const tool = input.tool_name ?? null;
  const entry = {
    time,
    kind: off ? 'allowed' : 'refusal',
    ...(off ? { why: 'KIRUNAK_FREEZE_OFF=1' } : {}),
    tool,
    target: String(ti.command ?? ti.file_path ?? ti.notebook_path ?? ti.skill ?? '').slice(0, 300),
    reason,
    session: input.session_id ?? null,
    agent: input.agent_type ?? input.agent_id ?? null,
    cwd: input.cwd ?? null,
  };
  try {
    mkdirSync(home, { recursive: true });
    appendFileSync(join(home, 'freeze.log'), JSON.stringify(entry) + '\n');
  } catch {
    // the log is a record, never a reason to fail
  }
  if (off) return;
  try {
    appendFileSync(join(home, 'events.jsonl'), JSON.stringify({ time, kind: 'refusal', tool, reason }) + '\n');
  } catch {
    // the same
  }
}

// ---- What the escalation hook needs from a call let through (gulnya/enforced-escalation S-2 design R4.4, R4.5) ----

/** The escalation hook's state file of the session or subagent making the call: hooks/escalate-state.mjs statePath. */
export function escalationFile(input, home = kirunakHome()) {
  const id = /^[A-Za-z0-9_-]+$/;
  const session = input?.session_id;
  const agent = input?.agent_id;
  if (!id.test(session ?? '') || (agent != null && !id.test(agent))) return null;
  return join(home, 'escalate', agent ? `${session}.${agent}.json` : `${session}.json`);
}

// Whether the file tracks a failure with no edit since, read here so that most edits load nothing more.
function untracked(file) {
  if (!existsSync(file)) return false;
  try {
    return Object.values(JSON.parse(readFileSync(file, 'utf8')).failures ?? {}).some((f) => f && !f.editedSince);
  } catch {
    return false;
  }
}

// An edit marks the failures the escalation hook counts as edited since, so the next one is a fix that failed; a
// counted build or a k run started in the background is noted, so its end can be counted or its push handed on
// (gulnya/enforced-escalation S-2 design R7.2). Done in this process, so the hot path gets no second one; never in a
// k run step or without the hook's config.json, and the rules load only when there is something to write.
async function forEscalation(input) {
  if (process.env.KIRUNAK_STEP) return;
  const edit = EDIT_TOOLS.has(input.tool_name);
  if (!edit && !(input.tool_name === 'Bash' && input.tool_input?.run_in_background === true)) return;
  const home = kirunakHome();
  const file = escalationFile(input, home);
  if (!file || !existsSync(join(home, 'escalate', 'config.json'))) return;
  if (edit && !untracked(file)) return;
  const rules = await import('./escalate-state.mjs');
  if (edit) rules.edited(home, input);
  else rules.startedInBackground(home, input, rules.readConfig(home));
}

async function main() {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    return;
  }
  if (!input || typeof input !== 'object') return;
  const reason = decide(input);
  if (!reason) {
    try {
      await forEscalation(input);
    } catch {
      // the escalation hook's notes never change the decision
    }
    return;
  }
  const off = process.env.KIRUNAK_FREEZE_OFF === '1';
  log(input, reason, off);
  if (off) return;
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
  }));
}

function isMain() {
  try {
    return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isMain()) {
  main().catch(() => {
    process.exitCode = 0; // fails open
  });
}
