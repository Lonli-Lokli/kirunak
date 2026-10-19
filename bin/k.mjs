#!/usr/bin/env node
// k: kirunak's command line. `k <verb> [args] [--json] [--dry-run]`; exit 0 ok, 1 refused (the reason on stderr), 2 usage.
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { KError, refuse, usage } from '../lib/errors.mjs';
import { expandHome, kirunakHome } from '../lib/home.mjs';
import { aspectsOf, allTaskIds, loadWorkspace, loadWorkspaceModule, taskPaths } from '../lib/workspace.mjs';
import { amendmentTexts, checkTaskDir } from '../lib/state.mjs';
import { checkTask, parseTask, removedIds } from '../lib/task.mjs';
import { checkPlan, parsePlan } from '../lib/plan.mjs';
import { isCommitted } from '../lib/git.mjs';
import * as approval from '../lib/approval.mjs';
import * as amend from '../lib/amend.mjs';
import * as intake from '../lib/intake.mjs';
import * as queue from '../lib/queue.mjs';
import * as list from '../lib/list.mjs';
import * as board from '../lib/board.mjs';
import * as handoff from '../lib/handoff.mjs';
import { install } from '../lib/install.mjs';
import * as slap from '../lib/slap.mjs';
import * as slapignore from '../lib/slapignore.mjs';
import * as cost from '../lib/cost.mjs';
import { costMarkdown } from '../lib/cost-md.mjs';
import * as keeper from '../lib/keeper.mjs';
import * as steps from '../lib/steps.mjs';
import * as orchestrator from '../lib/run.mjs';
import * as review from '../lib/review.mjs';
import * as checklist from '../lib/checklist.mjs';

const KIRUNAK = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BOOLEAN = new Set(['json', 'dry-run', 'first', 'last', 'all', 'print', 'no-queue', 'no-open', 'staged', 'baseline', 'once', 'watch', 'write']);

const HELP = `k: tasks the owner approves and agents cannot rewrite.

Setup     k init --workspace <module> | k install [--settings <file>] [--skills <dir>] [--git <repo>]... [--print]
          k plugins | k doctor
Intake    k intake start <id> [--from <path>] [--title "..."] | k intake aspects <id>
          k intake question <id> --topic <t> "<question>" | k intake answer <id> Q-n "<verbatim>" --ruling "<ruling>"
          k check <id> | k check --file <task.md>
Plan      k plan check <id> | k run <id> [--once|--watch]: start every ready step; --watch until none is ready
          k step brief|start|finish <id> S-n [--session <id>] | k step fail <id> S-n --why "..."
Review    k review check <id> [<review-n.md>]: the latest review against the frozen task and the code at its head
          k checklist <id>: checklist.md, the latest review's needs device and needs owner rows, for the owner to tick
Cost      k cost <id> [--baseline]: the task's token weight, money and calls; --baseline only the comparisons
          k cost <id> --write: cost.md again, rendered from the numbers k accept recorded in done.json
Cache     k keep --session <id>: in the background, ends when the session's wake-up keeps its cache warm
          k keeper report: keep-alives, misses, hits and skips per task and per week
Owner     k approve <id> [--amendment A-n] [--first|--before <id>|--after <id>] [--no-queue]
          k accept <id> [--checklist-open "<why>"] | k hold <id> --why "..." | k resume <id>
          k amend decline <id> A-n --why "..." | k queue add|move <id> [--first|--last|--before <id>|--after <id>]
          k queue remove <id>
Read      k list [--repo <name>] [--all] | k board [--html <path>] [--no-open] | k verify [<id>] | k queue show
          k status [--session <id>]: the lock, its queue, device claims, running steps, and the session's task
Size      k slap [--staged | <commit> | <from>..<to>]: SLAP of the staged change or of commits, in this repo
          k slapignore status | k slapignore approve <repo>... | --all (the owner's)
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
    let value;
    if (eq > 0) value = a.slice(eq + 1);
    else if (BOOLEAN.has(name)) value = true;
    else if (i + 1 < argv.length) value = argv[++i];
    else throw usage(`--${name} needs a value`);
    // A repeated flag (`--git a --git b`) collects its values.
    flags[name] = name in flags && value !== true ? [flags[name], value].flat() : value;
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
const baselineOf = (ws) => (ws.baseline && existsSync(ws.baseline) ? JSON.parse(readFileSync(ws.baseline, 'utf8')) : null);

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
      git: flags.git ? [flags.git].flat().map((g) => resolve(expandHome(g))) : undefined,
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
      const st = await ws.seams.resourceGuard.status();
      say(true, `resource guard: ${st.held ? `held by ${st.held.session} (${st.held.what}${st.held.orphan ? ', its holder gone, the job still running' : ''})` : 'free'}, ${st.queued.length} queued`);
    } catch (e) {
      say(false, `resource guard: status() did not answer: ${e.message}`);
    }
    const limits = await ws.seams.machineGuard.limits();
    say(true, `machine: at most ${limits.maxAgents} steps at once, ${limits.maxHeavy} heavy job`);
    for (const model of ['opus', 'sonnet', 'haiku', 'fable']) {
      const w = await ws.seams.prices.weights(model);
      say(true, `prices ${model}: ${Object.entries(w).map(([k, v]) => `${k} ${+v.toFixed(4)}`).join(', ')}`);
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

  async plan({ ws, pos }) {
    const sub = need(pos[0], 'plan verb: check');
    if (sub !== 'check') throw usage(`unknown plan verb ${sub}`);
    const id = need(pos[1], 'task id');
    const p = taskPaths(ws, id);
    if (!existsSync(p.task)) throw new KError(`unknown task ${id}: ${p.task} does not exist`, 1);
    const plan = join(p.dir, 'plan.md');
    if (!existsSync(plan)) throw new KError(`${id} has no plan: ${p.rel('plan.md')}`, 1);
    const problems = checkPlan(parsePlan(readFileSync(plan, 'utf8')), parseTask(readFileSync(p.task, 'utf8')), p);
    return report(`${id} plan`, problems, '');
  },

  async cost({ ws, pos, flags }) {
    const id = need(pos[0], 'task id');
    if (!existsSync(taskPaths(ws, id).task)) throw new KError(`unknown task ${id}`, 1);
    // cost.md again from done.json's cost, which only k accept writes: the same numbers give the same file.
    if (flags.write) {
      const p = taskPaths(ws, id);
      const done = existsSync(join(p.dir, 'done.json')) ? JSON.parse(readFileSync(join(p.dir, 'done.json'), 'utf8')) : null;
      if (!done?.cost) throw new KError(`${id}: cost.md is rendered from done.json's cost, which k accept records; ${done ? 'this accept recorded none' : `${id} is not accepted`}`, 1);
      let md;
      try {
        md = costMarkdown(done.task ?? id, done.cost);
      } catch {
        throw new KError(`${id}: done.json's cost is not one k accept writes, so cost.md cannot be rendered from it`, 1);
      }
      writeFileSync(join(p.dir, 'cost.md'), md);
      return { text: `${id}: cost.md written from done.json` };
    }
    const c = await cost.costOf(ws, id);
    const baseline = baselineOf(ws);
    const comparisons = baseline ? cost.compare(c, baseline) : [];
    if (flags.baseline) return { comparisons, text: comparisons.join('\n') };
    return { ...c, comparisons, text: [cost.format(c), ...(comparisons.length ? ['', ...comparisons] : [])].join('\n') };
  },

  async keep({ ws, flags }) {
    const s = need(session(flags), '--session <id> (or $CLAUDE_CODE_SESSION_ID)');
    const { conversation, ...r } = await keeper.keep({ ws, session: s, dryRun: !!flags['dry-run'] });
    return r;
  },

  async keeper({ ws, pos }) {
    const sub = need(pos[0], 'keeper verb: report');
    if (sub !== 'report') throw usage(`unknown keeper verb ${sub}`);
    const r = await keeper.report(ws);
    return { ...r, text: keeper.formatReport(r) };
  },

  async step({ ws, pos, flags }) {
    const sub = need(pos[0], 'step verb: brief|start|finish|fail');
    const id = need(pos[1], 'task id');
    const step = need(pos[2], 'the step, S-n');
    if (!['brief', 'start', 'finish', 'fail'].includes(sub)) throw usage(`unknown step verb ${sub}`);
    if (flags['dry-run']) return { text: `would ${sub} ${id} ${step}` };
    if (sub === 'brief') {
      const r = await steps.brief({ ws, id, step, session: session(flags) });
      return { path: r.path, text: r.path };
    }
    if (sub === 'start') {
      await steps.start({ ws, id, step, session: session(flags) });
      return { text: `${id} ${step}: started` };
    }
    if (sub === 'finish') {
      steps.finish({ ws, id, step });
      return { text: `${id} ${step}: done` };
    }
    const why = need(flags.why, '--why "<why>"');
    // A stop's words are k run's own: such a failure would not count, a way around the two failures.
    if (steps.isStop(steps.reasonOf(why))) throw refuse(`"${steps.reasonOf(why)}" is k run's own reason for a stop; say what went wrong`);
    const r = steps.fail({ ws, id, step, why });
    return { ...r, text: `${id} ${step}: failed, ${r.report}${r.escalated ? '; marked [escalate] in plan.md' : ''}` };
  },

  async run({ ws, pos, flags }) {
    const id = need(pos[0], 'task id');
    if (flags.once && flags.watch) throw usage('--once or --watch, not both');
    if (flags['dry-run']) {
      const t = steps.load(ws, id);
      const problems = steps.gate(t);
      const states = [...t.states].map(([k, v]) => `${k} ${v.state}${v.why ? ` (${v.why})` : ''}`);
      return { problems, code: problems.length ? 1 : 0, text: [...problems, ...states].join('\n') };
    }
    const r = await orchestrator.run({ ws, id, watch: !!flags.watch, out: flags.json ? () => {} : (line) => console.log(line) });
    const states = Object.entries(r.states).map(([k, v]) => `${k} ${v}`).join(', ');
    return { ...r, code: r.refused.length && !flags.watch ? 1 : 0, text: `${id}: ${states}` };
  },

  async review({ ws, pos }) {
    const sub = need(pos[0], 'review verb: check');
    if (sub !== 'check') throw usage(`unknown review verb ${sub}`);
    const id = need(pos[1], 'task id');
    const r = review.check(ws, id, pos[2] || null);
    return report(`${id} ${r.file}`, r.problems, '');
  },

  async checklist({ ws, pos, flags }) {
    const id = need(pos[0], 'task id');
    if (flags['dry-run']) return { text: `would write ${taskPaths(ws, id).rel('checklist.md')}` };
    const r = checklist.generate(ws, id);
    const items = r.items.map((x) => `- [${x.ticked ? 'x' : ' '}] ${x.text}`);
    return { ...r, text: [`${r.path}: ${r.items.length} item${r.items.length === 1 ? '' : 's'} from ${r.review}`, ...items].join('\n') };
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
    // The task's cost, read before the accept, which records it in done.json and commits cost.md rendered from it; a
    // cost that cannot be read (the records, or a baseline that does not parse) is recorded as why and never stops
    // the accept.
    let taskCost;
    try {
      const c = await cost.costOf(ws, id);
      const b = baselineOf(ws);
      taskCost = cost.summary(c, b ? cost.compare(c, b) : []);
    } catch (e) {
      taskCost = { error: e.message };
    }
    const r = await approval.accept({ ws, id, checklistOpen: flags['checklist-open'], via: flags.via || 'shell', cost: taskCost });
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

  // What the mod's pane and band read beside k list (boards.md §4): board.status, the guard queue's lines parsed, the
  // home the events are in, and the session's task from sessions/<id>.json.
  async status({ ws, flags }) {
    const st = board.status(ws);
    const home = ws.home || kirunakHome();
    const parse = (l) => {
      try {
        return JSON.parse(l);
      } catch {
        return { line: l };
      }
    };
    const s = session(flags);
    const rec = s ? keeper.readSession(home, s) : null;
    const out = { ...st, queue: st.queue.map(parse), home, session: s ? { id: s, task: rec?.task ?? null, step: rec?.step ?? null, since: rec?.since ?? null } : null };
    const lock = st.lock ? `lock: ${st.lock.what} (session ${st.lock.session}, since ${st.lock.since})` : 'no lock';
    const text = [
      `${lock}${st.queue.length ? `, ${st.queue.length} waiting` : ''}`,
      `running steps: ${st.running.length} of ${st.maxAgents}`,
      ...(out.session ? [`session ${s}: ${out.session.task ?? 'no task'}`] : []),
    ].join('\n');
    return { ...out, text };
  },

  async board({ ws, flags }) {
    if (flags['dry-run']) return { text: `would write ${flags.html || join(ws.home, 'board.html')}` };
    const path = await board.write(ws, { path: flags.html ? resolve(flags.html) : undefined, open: !flags.html && !flags['no-open'] });
    return { path, text: path };
  },

  async slap({ pos, flags }) {
    const root = process.cwd();
    const git = (args) => {
      try {
        return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
      } catch (e) {
        throw new KError(`git ${args[0]}: ${String(e.stderr || e.message).trim().split('\n')[0]}`, 1);
      }
    };
    const fmt = (m, what) => `${String(m.score).padStart(4)} ${m.tier.padEnd(2)} L ${String(m.L).padStart(5)} F ${String(m.F).padStart(3)}  ${what}`;
    if (flags.staged) {
      let head = null;
      try {
        head = git(['rev-parse', '--verify', '-q', 'HEAD']);
      } catch {}
      const { m, refusals } = slap.gate(root, head || slap.EMPTY_TREE);
      const text = [m ? fmt(m, 'staged') : null, ...refusals].filter(Boolean).join('\n');
      return { ...m, refusals, code: refusals.length ? 1 : 0, text };
    }
    const spec = pos[0] || 'HEAD';
    const shas = spec.includes('..') ? git(['rev-list', '--no-merges', '--reverse', spec]).split('\n').filter(Boolean) : [git(['rev-parse', '--verify', spec])];
    const rows = shas.map((sha) => ({ sha, subject: git(['log', '-1', '--format=%h %s', sha]), ...slap.measureDiff(root, [slap.parentOf(root, sha), sha], slap.slapignoreAt(root, sha)) }));
    const tiers = rows.reduce((t, r) => ({ ...t, [r.tier]: (t[r.tier] || 0) + 1 }), {});
    const summary = rows.length > 1 ? `\n${rows.length} commits: ${['S', 'M', 'L', 'XL'].map((t) => `${t} ${tiers[t] || 0}`).join(', ')}` : '';
    return { rows: rows.map(({ counted, skipped, ...r }) => r), text: rows.map((r) => fmt(r, r.subject.slice(0, 80))).join('\n') + summary };
  },

  // The owner's approval of each repo's .slapignore (R23); status reads it.
  async slapignore({ pos, flags }) {
    const sub = need(pos[0], 'slapignore verb: status|approve');
    if (sub === 'status') {
      const rows = slapignore.status();
      return { rows, text: rows.map((r) => `${r.state.padEnd(10)} ${r.key}${r.approved ? `  (approved ${r.approved})` : ''}`).join('\n') || 'no repo is registered: k install --git <repo>' };
    }
    if (sub !== 'approve') throw usage(`unknown slapignore verb ${sub}`);
    const dryRun = !!flags['dry-run'];
    const rows = slapignore.approve({ repos: pos.slice(1), all: !!flags.all, via: flags.via || 'shell', dryRun });
    const text = rows.map((r) => `${r.already ? 'already approved' : dryRun ? 'would approve' : 'approved'} ${r.key}/.slapignore (${r.patterns} patterns, ${r.hash.slice(0, 19)}…)`).join('\n');
    return { rows, text: text || 'nothing to approve' };
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

const NO_WORKSPACE = new Set(['init', 'install', 'slap', 'slapignore']);

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

