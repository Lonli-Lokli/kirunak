#!/usr/bin/env node
// k: kirunak's command line. `k <verb> [args] [--json] [--dry-run]`; exit 0 ok, 1 refused (the reason on stderr), 2 usage.
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { KError, usage } from '../lib/errors.mjs';
import { expandHome, kirunakHome } from '../lib/home.mjs';
import { aspectsOf, allTaskIds, loadWorkspace, loadWorkspaceModule, taskPaths } from '../lib/workspace.mjs';
import { amendmentTexts, checkTaskDir } from '../lib/state.mjs';
import { checkTask, parseTask, removedIds } from '../lib/task.mjs';
import { isCommitted } from '../lib/git.mjs';
import * as approval from '../lib/approval.mjs';
import * as amend from '../lib/amend.mjs';
import * as intake from '../lib/intake.mjs';
import * as queue from '../lib/queue.mjs';
import * as list from '../lib/list.mjs';
import * as board from '../lib/board.mjs';
import * as handoff from '../lib/handoff.mjs';
import { install } from '../lib/install.mjs';

const KIRUNAK = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BOOLEAN = new Set(['json', 'dry-run', 'first', 'last', 'all', 'print', 'no-queue', 'no-open']);

const HELP = `k: tasks the owner approves and agents cannot rewrite.

Setup     k init --workspace <module> | k install [--settings <file>] [--skills <dir>] [--git <repo>] [--print]
          k plugins | k doctor
Intake    k intake start <id> [--from <path>] [--title "..."] | k intake aspects <id>
          k intake question <id> --topic <t> "<question>" | k intake answer <id> Q-n "<verbatim>" --ruling "<ruling>"
          k check <id> | k check --file <task.md>
Owner     k approve <id> [--amendment A-n] [--first|--before <id>|--after <id>] [--no-queue]
          k accept <id> [--checklist-open "<why>"] | k hold <id> --why "..." | k resume <id>
          k amend decline <id> A-n --why "..." | k queue add|move <id> [--first|--last|--before <id>|--after <id>]
          k queue remove <id>
Read      k list [--repo <name>] [--all] | k board [--html <path>] [--no-open] | k verify [<id>] | k queue show
Work      k amend new <id> [--by "..."] | k amend check <id> A-n | k start <id> [--session <id>]
          k handoff <id> [--session <id>]
Every verb takes --json and --dry-run.`;

export function parseArgs(argv) {
  const pos = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      pos.push(a);
      continue;
    }
    const eq = a.indexOf('=');
    const name = eq > 0 ? a.slice(2, eq) : a.slice(2);
    if (eq > 0) flags[name] = a.slice(eq + 1);
    else if (BOOLEAN.has(name)) flags[name] = true;
    else if (i + 1 < argv.length) flags[name] = argv[++i];
    else throw usage(`--${name} needs a value`);
  }
  return { pos, flags };
}

const need = (v, what) => {
  if (!v) throw usage(`missing ${what}\n\n${HELP}`);
  return v;
};

function place(flags) {
  if (flags.first) return { first: true };
  if (flags.before) return { before: flags.before };
  if (flags.after) return { after: flags.after };
  return { last: true };
}

const session = (flags) => flags.session || process.env.CLAUDE_CODE_SESSION_ID || null;

// What `k approve` would refuse, without writing anything (the --dry-run the model may run).
async function approvalProblems(ws, id, amendmentId) {
  const p = taskPaths(ws, id);
  const aspectIds = (await aspectsOf(ws)).map((a) => a.id);
  const out = [];
  if (!existsSync(p.task)) return [`${id} has no task.md`];
  if (!isCommitted(p.root, p.rel('task.md'))) out.push(`${p.rel('task.md')} is not committed: commit the intake first`);
  if (amendmentId) {
    const file = join(p.dir, 'amendments', `${amendmentId}.md`);
    if (!existsSync(file)) return [...out, `no amendment ${amendmentId} in ${p.rel('amendments')}`];
    const removed = removedIds(amendmentTexts(p.dir));
    for (const x of amend.checkAmendment(readFileSync(p.task, 'utf8'), readFileSync(file, 'utf8'), { removed })) {
      out.push(typeof x === 'string' ? x : `${x.line ? `${amendmentId}.md line ${x.line}: ` : ''}${x.problem}`);
    }
  } else {
    for (const x of checkTaskDir(p.dir, aspectIds, id).problems) out.push(`line ${x.line}: ${x.problem}`);
  }
  return out;
}

const VERBS = {
  async init({ flags }) {
    const module = resolve(expandHome(need(flags.workspace, '--workspace <path to the workspace module>')));
    const ws = await loadWorkspaceModule(module);
    const pointer = join(kirunakHome(), 'workspace');
    if (flags['dry-run']) return { text: `would write ${pointer} → ${module}`, pointer, module };
    mkdirSync(dirname(pointer), { recursive: true });
    writeFileSync(pointer, module + '\n');
    return { text: `${pointer} → ${module} (${ws.repos.length} repos, queue ${ws.queue})`, pointer, module };
  },

  async install({ flags }) {
    const r = await install({
      settingsPath: flags.settings ? resolve(expandHome(flags.settings)) : join(homedir(), '.claude', 'settings.json'),
      kirunakRoot: KIRUNAK,
      skillsDir: flags.skills ? resolve(expandHome(flags.skills)) : join(homedir(), '.claude', 'skills'),
      git: flags.git ? resolve(expandHome(flags.git)) : undefined,
      print: !!(flags.print || flags['dry-run']),
    });
    return { ...r, text: r.actions.join('\n') };
  },

  async plugins({ ws }) {
    const rows = ws.seams.loaded;
    return { plugins: rows, text: rows.map((l) => `${l.seam.padEnd(14)} ${l.plugin.padEnd(22)} ${l.module}`).join('\n') };
  },

  async doctor({ ws }) {
    const lines = [];
    let bad = 0;
    const say = (ok, line) => {
      if (!ok) bad++;
      lines.push(`${ok ? 'ok  ' : 'FAIL'} ${line}`);
    };
    say(true, `state folder ${ws.home}, workspace ${ws.modulePath}`);
    for (const r of ws.repos) say(existsSync(join(r.root, '.git')), `repo ${r.name}: ${r.root} is a git repo`);
    say(existsSync(ws.queue), `queue ${ws.queue}`);
    const aspects = await aspectsOf(ws);
    say(aspects.length > 0, `${aspects.length} checklist aspects loaded`);
    for (const a of aspects) {
      say((a.sources || []).length > 0 && (a.edgeCases || []).length > 0, `aspect ${a.id} has a source and an edge case`);
    }
    for (const name of ['kirunak-freeze.mjs', 'git-pre-commit.mjs']) say(existsSync(join(KIRUNAK, 'hooks', name)), `hook ${name}`);
    const settings = join(homedir(), '.claude', 'settings.json');
    const wired = existsSync(settings) && readFileSync(settings, 'utf8').includes('hooks/kirunak-freeze.mjs');
    say(wired, `the freeze hook is wired in ${settings}${wired ? '' : ' (run k install)'}`);
    for (const s of ['k-intake', 'k-done']) {
      say(existsSync(join(homedir(), '.claude', 'skills', s, 'SKILL.md')), `skill ${s} is linked (k install)`);
    }
    try {
      say(true, `claude ${execFileSync('claude', ['--version'], { encoding: 'utf8', timeout: 10000 }).trim()}`);
    } catch {
      say(false, 'claude --version did not answer (needed from slice 2, the runner)');
    }
    return { ok: bad === 0, code: bad ? 1 : 0, text: lines.join('\n') };
  },

  async intake({ ws, pos, flags }) {
    const sub = need(pos[0], 'intake verb: start|aspects|question|answer|check');
    const id = need(pos[1], 'task id');
    if (sub === 'start') {
      if (flags['dry-run']) return { text: `would start ${id} in ${taskPaths(ws, id).dir}` };
      const r = await intake.start({ ws, id, from: flags.from, title: flags.title });
      return { ...r, text: `started ${id}: ${r.dir} (${r.aspects} aspects open)` };
    }
    if (sub === 'aspects') {
      const a = await intake.aspects(ws, id);
      const text = a.map((x) => `${x.id}: ${x.title}${x.applies === null ? '' : x.applies ? ' (likely applies)' : ' (likely n/a)'}\n  ${x.question}\n  edge cases: ${x.edgeCases.join('; ')}\n  sources: ${x.sources.join('; ')}`).join('\n');
      return { aspects: a, text };
    }
    if (sub === 'question') {
      const text = need(pos[2], 'the question text');
      if (flags['dry-run']) return { text: `would record a question on ${id}` };
      const q = await intake.question(ws, id, need(flags.topic, '--topic'), text);
      return { q, text: q };
    }
    if (sub === 'answer') {
      const q = need(pos[2], 'Q-n');
      const verbatim = need(pos[3], 'the owner\'s answer, verbatim');
      if (flags['dry-run']) return { text: `would record the answer to ${q} on ${id}` };
      await intake.answer(ws, id, q, verbatim, need(flags.ruling, '--ruling'));
      return { q, text: `recorded ${q}` };
    }
    if (sub === 'check') return VERBS.check({ ws, pos: [id], flags });
    throw usage(`unknown intake verb ${sub}`);
  },

  async check({ ws, pos, flags }) {
    if (flags.file) {
      const problems = checkTask(parseTask(readFileSync(resolve(flags.file), 'utf8')), [], {})
        .filter((p) => !/of the checklist|not in the loaded checklist/.test(p.problem));
      return report(flags.file, problems, ' (grammar only: no workspace, so the aspects are not checked)');
    }
    const id = need(pos[0], 'task id');
    const p = taskPaths(ws, id);
    const r = checkTaskDir(p.dir, (await aspectsOf(ws)).map((a) => a.id), id);
    return report(id, r.problems, '');
  },

  async verify({ ws, pos }) {
    const ids = pos[0] ? [pos[0]] : allTaskIds(ws).filter((id) => existsSync(taskPaths(ws, id).record));
    const rows = ids.map((id) => ({ id, verdict: approval.verify(ws, id) }));
    const stale = rows.some((r) => r.verdict === 'stale');
    return { rows, code: stale ? 1 : 0, text: rows.map((r) => `${r.verdict.padEnd(5)} ${r.id}`).join('\n') || 'no approved task' };
  },

  async approve({ ws, pos, flags }) {
    const id = need(pos[0], 'task id');
    if (flags['dry-run']) {
      const problems = await approvalProblems(ws, id, flags.amendment);
      if (problems.length) return { problems, code: 1, text: `would refuse ${id}:\n${problems.map((x) => `  ${x}`).join('\n')}` };
      return { problems, text: `would approve ${id}${flags.amendment ? ` with ${flags.amendment}` : ''}` };
    }
    const r = await approval.approve({
      ws, id, amendment: flags.amendment, via: flags.via || 'shell', queuePlace: place(flags), noQueue: !!flags['no-queue'],
    });
    return { ...r, text: `${id}: ready${r.queuePlace ? `, queue place ${r.queuePlace}` : ''} (${r.hash.slice(0, 19)}…, commit ${r.commit})` };
  },

  async accept({ ws, pos, flags }) {
    const id = need(pos[0], 'task id');
    if (flags['dry-run']) return { text: `would accept ${id}` };
    const r = await approval.accept({ ws, id, checklistOpen: flags['checklist-open'], via: flags.via || 'shell' });
    return { ...r, text: `${id}: done${flags['checklist-open'] ? ` (checklist open: ${flags['checklist-open']})` : ''}` };
  },

  async hold({ ws, pos, flags }) {
    const id = need(pos[0], 'task id');
    if (flags['dry-run']) return { text: `would hold ${id}` };
    await approval.hold({ ws, id, why: need(flags.why, '--why') });
    return { text: `${id}: on hold` };
  },

  async resume({ ws, pos, flags }) {
    const id = need(pos[0], 'task id');
    if (flags['dry-run']) return { text: `would resume ${id}` };
    await approval.resume({ ws, id });
    return { text: `${id}: resumed` };
  },

  async amend({ ws, pos, flags }) {
    const sub = need(pos[0], 'amend verb: new|check|decline');
    const id = need(pos[1], 'task id');
    const p = taskPaths(ws, id);
    if (sub === 'new') {
      if (flags['dry-run']) return { text: `would write the next amendment in ${p.rel('amendments')}` };
      const r = await amend.newAmendment({ ws, id, by: flags.by || (session(flags) ? `session ${session(flags)}` : 'a session') });
      return { ...r, text: `${r.path}: fill in Why and Changes, then \`k amend check ${id} A-${r.n}\`` };
    }
    const a = need(pos[2], 'A-n');
    if (sub === 'check') {
      const problems = await approvalProblems(ws, id, a);
      return report(`${id} ${a}`, problems.map((x) => ({ problem: x })), '');
    }
    if (sub === 'decline') {
      if (flags['dry-run']) return { text: `would decline ${a}` };
      await amend.decline({ ws, id, amendment: a, why: need(flags.why, '--why') });
      return { text: `${id} ${a}: declined` };
    }
    throw usage(`unknown amend verb ${sub}`);
  },

  async queue({ ws, pos, flags }) {
    const sub = need(pos[0], 'queue verb: add|move|remove|show');
    if (sub === 'show') {
      const ids = queue.read(ws);
      return { queue: ids, text: ids.map((id, i) => `${String(i + 1).padStart(2)}  ${id}`).join('\n') || 'the queue is empty' };
    }
    const id = need(pos[1], 'task id');
    if (flags['dry-run']) return { text: `would ${sub} ${id}` };
    if (sub === 'add') queue.add(ws, id, place(flags));
    else if (sub === 'move') queue.move(ws, id, place(flags));
    else if (sub === 'remove') queue.remove(ws, id);
    else throw usage(`unknown queue verb ${sub}`);
    return VERBS.queue({ ws, pos: ['show'], flags });
  },

  async list({ ws, flags }) {
    const rows = await list.rows(ws, { repo: flags.repo, all: !!flags.all });
    return { rows, text: list.format(rows) || 'no task' };
  },

  async board({ ws, flags }) {
    if (flags['dry-run']) return { text: `would write ${flags.html || join(ws.home, 'board.html')}` };
    const path = await board.write(ws, { path: flags.html ? resolve(flags.html) : undefined, open: !flags.html && !flags['no-open'] });
    return { path, text: path };
  },

  async start({ ws, pos, flags }) {
    const id = need(pos[0], 'task id');
    const s = need(session(flags), '--session (or $CLAUDE_CODE_SESSION_ID)');
    if (flags['dry-run']) return { text: `would record ${id} as session ${s}'s task` };
    await handoff.start({ ws, id, session: s });
    return { text: `session ${s}: ${id}` };
  },

  async handoff({ ws, pos, flags }) {
    const id = need(pos[0], 'task id');
    const s = session(flags);
    if (flags['dry-run']) return { text: `would hand off ${id}` };
    const r = await handoff.handoff({ ws, id, session: s, cwd: process.cwd() });
    const text = [
      ...r.targets.map((t) => `write the handoff at: ${t.where}\n  ${t.what}`),
      ...r.released.map((x) => `released: ${x.line}`),
    ].join('\n');
    return { ...r, text };
  },
};

function report(what, problems, note) {
  if (!problems.length) return { ok: true, problems, text: `${what}: check passes${note}` };
  const lines = problems.map((p) => (p.line ? `  line ${p.line}: ${p.problem}` : `  ${p.problem}`));
  return { ok: false, problems, code: 1, text: `${what}: ${problems.length} problem${problems.length > 1 ? 's' : ''}${note}\n${lines.join('\n')}` };
}

const NO_WORKSPACE = new Set(['init', 'install']);

export async function main(argv = process.argv.slice(2)) {
  const { pos, flags } = parseArgs(argv);
  const verb = pos.shift();
  if (!verb || verb === 'help' || flags.help) {
    console.log(HELP);
    return verb ? 0 : 2;
  }
  const fn = VERBS[verb];
  if (!fn) throw usage(`unknown verb ${verb}\n\n${HELP}`);
  const needsWs = !NO_WORKSPACE.has(verb) && !(verb === 'check' && flags.file);
  const ws = needsWs ? await loadWorkspace() : null;
  const r = (await fn({ ws, pos, flags })) || {};
  if (flags.json) {
    const { text, code, ...rest } = r;
    console.log(JSON.stringify(rest, null, 2));
  } else if (r.text) {
    (r.code ? console.error : console.log)(r.text);
  }
  return r.code || 0;
}

// Run as the command (also through a link on PATH), not when a test imports it.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => process.exit(code),
    (e) => {
      console.error(e instanceof KError ? `k: ${e.message}` : e.stack || String(e));
      process.exit(e instanceof KError ? e.code : 1);
    },
  );
}

