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
import { card as boardCard, markdown as boardMarkdown } from '../lib/board-md.mjs';
import { brief as boardBrief } from '../lib/board-brief.mjs';
import * as handoff from '../lib/handoff.mjs';
import { install, SKILLS } from '../lib/install.mjs';
import { compactChecks, ladderChecks, trackerLine } from '../lib/doctor.mjs';
import * as slap from '../lib/slap.mjs';
import * as slapignore from '../lib/slapignore.mjs';
import * as cost from '../lib/cost.mjs';
import { costMarkdown } from '../lib/cost-md.mjs';
import * as keeper from '../lib/keeper.mjs';
import * as worktrees from '../lib/worktrees.mjs';
import * as steps from '../lib/steps.mjs';
import * as orchestrator from '../lib/run.mjs';
import * as review from '../lib/review.mjs';
import * as checklist from '../lib/checklist.mjs';
import * as waiting from '../lib/waiting.mjs';
import * as drafts from '../lib/drafts.mjs';
import * as bugs from '../lib/bugs.mjs';

const KIRUNAK = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BOOLEAN = new Set(['json', 'dry-run', 'first', 'last', 'all', 'print', 'no-queue', 'no-open', 'markdown', 'brief', 'staged', 'baseline', 'once', 'watch', 'write', 'replace-agents', 'no-commit']);

const HELP = `k: tasks the owner approves and agents cannot rewrite.

Setup     k init --workspace <module> | k plugins | k doctor [--settings <file>] [--agents <dir>]
          k install [--settings <file>] [--skills <dir>] [--agents <dir>] [--replace-agents] [--git <repo>]... [--print]:
            the hooks, the skills, and a <model>-step agent for every rung of the workspace's ladder above the lowest;
            the handover window in each workspace repo's own .claude/settings.local.json (never in --settings' file)
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
          k accept <id> [--checklist-open "<why>"]: then removes the merged worktrees, printing each removed and kept
          k hold <id> --why "..." | k resume <id>
          k amend decline <id> A-n --why "..." | k queue add|move <id> [--first|--last|--before <id>|--after <id>]
          k queue remove <id>: parks the task; k run starts none of its steps until k queue add puts it back
Read      k list [--repo <name>] [--all] | k board [--html <path>] [--no-open] [--markdown] | k verify [<id>] | k queue show
          k board --brief: a line per task and per draft, for the phone; k board --card <id>: one task's or draft's card as markdown
          k status [--session <id>]: the lock, its queue, device claims, running steps, and the session's task
          k worktrees [--closing <id>]: the worktrees an acceptance would remove (what each holds besides build
            output) and keep, with why; it removes nothing
          k waiting: what waits for the owner (tasks and amendments to approve, tasks to accept, drafts) and what
            each verb would refuse; with --json also the tasks k hold and k start take
Size      k slap [--staged | <commit> | <from>..<to>]: SLAP of the staged change or of commits, in this repo
          k slapignore status | k slapignore approve <repo>... | --all (the owner's)
Work      k amend new <id> --title "..." [--by "..."] | k amend check <id> A-n | k start <id> [--session <id>]
          k handoff <id> [--session <id>]
Bugs      k bug new <repo>/<slug> --title "..." [--bug-of <task>] [--fix-repo <repo>]: a bug's skeleton,
            kirunak/bugs/<slug>.md in that repo, to fill in; its fix is the branch bug/<slug> in its fix repo (a repo of
            the workspace, or kirunak for kirunak's own checkout; its own when none is named)
          k bug check <id>: the bug's shape, its task and its fix's commits | k bug drop <id> --why "...": removes it
            and its folder in a commit of their own, a fix branch kept and named in it
          k bug from <id> [--no-commit]: a draft, or a task whose intake is not approved, moved into kirunak/bugs/
            with its history, draft/<slug> renamed bug/<slug>, each repo's paths committed alone
          k bugs: every bug in every repo, one line each (id, title, date written, its fix, bug of <task>), those with a
            fix ready first, then the oldest first
Drafts    k draft new <repo>/<slug> --title "...": a draft's skeleton, kirunak/drafts/<slug>.md in that repo, to fill in
          k draft check <id>: the draft's shape | k draft drop <id> --why "...": removes it in a commit of its own
          k drafts: every draft in every repo, one line each (id, title, date written), in the drafts' order: those it
            names first, the others by the date written
          k drafts move <id>... [--first|--last|--before <id>|--after <id>]: those drafts, in that order, to that
            place (no flag: last), in a commit of the order alone
          k intake start <id> --from kirunak/drafts/<slug>.md: the intake takes the draft, moved to the task's draft.md
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
    // A value is never a flag: `--checklist-open --dry-run` would otherwise run for real while the freeze hook, which
    // lets any line with the word --dry-run through, took it for a dry run (review G24).
    if (typeof value === 'string' && value.startsWith('--')) throw usage(`--${name} needs a value, not ${value}`);
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
    // Before k init there is no workspace yet: the rung agents and config.json then come from kirunak's default ladder.
    const ws = existsSync(join(kirunakHome(), 'workspace')) ? await loadWorkspace() : null;
    const r = await install({
      settingsPath: flags.settings ? resolve(expandHome(flags.settings)) : join(homedir(), '.claude', 'settings.json'),
      kirunakRoot: KIRUNAK,
      skillsDir: flags.skills ? resolve(expandHome(flags.skills)) : join(homedir(), '.claude', 'skills'),
      agentsDir: flags.agents ? resolve(expandHome(flags.agents)) : join(homedir(), '.claude', 'agents'),
      replaceAgents: !!flags['replace-agents'],
      ws,
      git: flags.git ? [flags.git].flat().map((g) => resolve(expandHome(g))) : undefined,
      print: !!(flags.print || flags['dry-run']),
    });
    return { ...r, text: r.actions.join('\n') };
  },

  async plugins({ ws }) {
    const rows = ws.seams.loaded;
    return { plugins: rows, text: rows.map((l) => `${l.seam.padEnd(14)} ${l.plugin.padEnd(22)} ${l.module}`).join('\n') };
  },

  async doctor({ ws, flags }) {
    const lines = [];
    let bad = 0;
    // ok true, false (a FAIL, counted) or 'warn' (named, never counted).
    const say = (ok, line) => {
      if (!ok) bad++;
      lines.push(`${ok === 'warn' ? 'WARN' : ok ? 'ok  ' : 'FAIL'} ${line}`);
    };
    say(true, `state folder ${ws.home}, workspace ${ws.modulePath}`);
    for (const r of ws.repos) say(existsSync(join(r.root, '.git')), `repo ${r.name}: ${r.root} is a git repo`);
    say(existsSync(ws.queue), `queue ${ws.queue}`);
    const aspects = await aspectsOf(ws);
    say(aspects.length > 0, `${aspects.length} checklist aspects loaded`);
    for (const a of aspects) {
      say((a.sources || []).length > 0 && (a.edgeCases || []).length > 0, `aspect ${a.id} has a source and an edge case`);
    }
    for (const name of ['kirunak-freeze.mjs', 'kirunak-escalate.mjs', 'git-pre-commit.mjs']) say(existsSync(join(KIRUNAK, 'hooks', name)), `hook ${name}`);
    const settings = flags.settings ? resolve(expandHome(flags.settings)) : join(homedir(), '.claude', 'settings.json');
    const wired = existsSync(settings) && readFileSync(settings, 'utf8').includes('hooks/kirunak-freeze.mjs');
    say(wired, `the freeze hook is wired in ${settings}${wired ? '' : ' (run k install)'}`);
    for (const s of SKILLS) {
      say(existsSync(join(homedir(), '.claude', 'skills', s, 'SKILL.md')), `skill ${s} is linked (k install)`);
    }
    const agentsDir = flags.agents ? resolve(expandHome(flags.agents)) : join(homedir(), '.claude', 'agents');
    for (const [ok, line] of ladderChecks({ ws, settingsPath: settings, agentsDir })) say(ok, line);
    for (const [ok, line] of compactChecks({ ws, settingsPath: settings })) say(ok, line);
    say(...trackerLine({ settingsPath: settings, kirunakRoot: KIRUNAK }));
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
      const moved = r.draft ? `; the draft is now ${r.draft}${r.staged ? ', the move staged' : ''}: commit it with the intake` : '';
      return { ...r, text: `started ${id}: ${r.dir} (${r.aspects} aspects open)${moved}` };
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
    // k run's next pass climbs a step that failed as often as it may, or stops past the top rung.
    return { ...r, text: `${id} ${step}: failed, ${r.report}` };
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
    if (flags['dry-run'] && flags.amendment) {
      // The checks k approve makes, as k waiting's refuse says them (lib/waiting.mjs).
      const why = await waiting.amendmentRefusal(ws, id, flags.amendment);
      if (why) return { problems: [why], code: 1, text: `would refuse ${id}:\n  ${why}` };
      return { problems: [], text: `would approve ${id} with ${flags.amendment}` };
    }
    if (flags['dry-run']) {
      const problems = await approvalProblems(ws, id);
      if (problems.length) return { problems, code: 1, text: `would refuse ${id}:\n${problems.map((x) => `  ${x}`).join('\n')}` };
      return { problems, text: `would approve ${id}${flags.amendment ? ` with ${flags.amendment}` : ''}` };
    }
    const r = await approval.approve({
      ws, id, amendment: flags.amendment, via: flags.via || 'shell', queuePlace: place(flags), noQueue: !!flags['no-queue'],
    });
    return { ...r, text: `${id}: ${r.state}${r.queuePlace ? `, queue place ${r.queuePlace}` : ''} (${r.hash.slice(0, 19)}…, commit ${r.commit})` };
  },

  async accept({ ws, pos, flags }) {
    const id = need(pos[0], 'task id');
    if (flags['dry-run']) {
      const r = approval.accept({ ws, id, checklistOpen: flags['checklist-open'], dryRun: true });
      return { ...r, text: `would accept ${id} (${r.review}, verdict: ${r.verdict})${r.openItems.length ? `, with ${r.openItems.length} checklist item(s) open` : ''}` };
    }
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
    // Once the acceptance is committed, the merged worktrees go (approval.md §4); nothing there undoes or fails it.
    const w = await worktrees.worktrees({ ws, closing: id, remove: true });
    const text = `${id}: done${flags['checklist-open'] ? ` (checklist open: ${flags['checklist-open']})` : ''}`;
    return { ...r, worktrees: w, text: [text, ...worktrees.lines(w)].join('\n') };
  },

  // `k worktrees [--closing <id>]`: what an acceptance would remove now and keep, with what each worktree that would
  // go holds besides build output (k-done shows it before asking for the acceptance); it removes nothing.
  async worktrees({ ws, flags }) {
    const closing = 'closing' in flags ? need(typeof flags.closing === 'string' && flags.closing, '--closing <task id>') : null;
    if (closing && !existsSync(taskPaths(ws, closing).task)) throw refuse(`unknown task ${closing}`);
    const w = await worktrees.worktrees({ ws, closing, sizes: true });
    const out = worktrees.lines(w, { dry: true });
    return { ...w, text: out.length ? out.join('\n') : 'no worktrees besides the main checkouts' };
  },

  async hold({ ws, pos, flags }) {
    const id = need(pos[0], 'task id');
    if (flags['dry-run']) {
      approval.hold({ ws, id, dryRun: true });
      return { text: `would hold ${id}` };
    }
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
      // Its name in every list (kirunak-phone A-8), so a dry run refuses without it too.
      const title = typeof flags.title === 'string' ? flags.title.trim() : '';
      if (!title) throw usage(`k amend new needs --title "<a few words>", the name the amendment goes by in every list`);
      if (flags['dry-run']) return { text: `would write the next amendment in ${p.rel('amendments')}, titled ${title}` };
      const r = await amend.newAmendment({ ws, id, title, by: flags.by || (session(flags) ? `session ${session(flags)}` : 'a session') });
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
    // Only an approved task that is not done goes in, a dry run checking it too.
    if (sub === 'add') approval.queueable(ws, id);
    if (flags['dry-run']) return { text: `would ${sub} ${id}` };
    if (sub === 'add') queue.add(ws, id, place(flags));
    else if (sub === 'move') queue.move(ws, id, place(flags));
    else if (sub === 'remove') queue.remove(ws, id);
    else throw usage(`unknown queue verb ${sub}`);
    return VERBS.queue({ ws, pos: ['show'], flags });
  },

  // A prepared intake for a future task (kirunak-drafts): not the owner's, so any session runs these. Neither `new`
  // nor `check` commits; the session that writes the draft commits it. A bug is no draft: `--bug-of` is refused,
  // naming `k bug new` (gulnya/kirunak-bugs AC-1).
  async draft({ ws, pos, flags }) {
    const sub = need(pos[0], 'draft verb: new|check|drop');
    const id = need(pos[1], 'draft id <repo>/<slug>');
    const dryRun = !!flags['dry-run'];
    if (sub === 'new') {
      const bugOf = flags['bug-of'] ?? null;
      const title = typeof flags.title === 'string' ? flags.title : '';
      const r = drafts.newDraft({ ws, id, title, bugOf: bugOf === null || typeof bugOf === 'string' ? bugOf : '', session: session(flags), dryRun });
      if (dryRun) return { ...r, text: `would write ${r.path}` };
      return { ...r, text: `${r.path}: fill in every section, then \`k draft check ${id}\`, and commit it` };
    }
    if (sub === 'check') return report(id, drafts.check(ws, id), '');
    if (sub === 'drop') {
      const r = drafts.drop({ ws, id, why: typeof flags.why === 'string' ? flags.why : '', dryRun });
      if (dryRun) return { ...r, text: `would remove ${r.rel} in ${r.repo}${r.tracked ? ` and commit "${r.message}"` : ' (never committed, so no commit)'}` };
      return { ...r, text: r.commit ? `${id}: dropped in ${r.commit}` : `${id}: dropped; it was never committed, so no commit` };
    }
    throw usage(`unknown draft verb ${sub}`);
  },

  // A bug, a fault in something that exists (gulnya/kirunak-bugs): not the owner's, so any session runs these. `new`
  // and `check` commit nothing; the session that writes the bug commits it. `drop` and `from` commit each repo's own
  // paths alone; `from --no-commit` only stages them.
  async bug({ ws, pos, flags }) {
    const sub = need(pos[0], 'bug verb: new|check|drop|from');
    const id = need(pos[1], 'bug id <repo>/<slug>');
    const dryRun = !!flags['dry-run'];
    const one = (name, what) => {
      const v = flags[name] ?? null;
      if (v !== null && typeof v !== 'string') throw usage(`--${name} names ${what}`);
      return v;
    };
    if (sub === 'new') {
      const bugOf = one('bug-of', 'one accepted task: --bug-of <repo>/<slug>');
      const fixRepo = one('fix-repo', 'the repo of the fix branch: --fix-repo <repo>');
      const title = typeof flags.title === 'string' ? flags.title : '';
      const r = bugs.newBug({ ws, id, title, bugOf, fixRepo, session: session(flags), dryRun });
      const of = [r.bugOf && `a bug of ${r.bugOf}`, r.fixRepo && `its fix in ${r.fixRepo}`].filter(Boolean).join(', ');
      const about = of ? `, ${of}` : '';
      if (dryRun) return { ...r, text: `would write ${r.path}${about}` };
      return { ...r, text: `${r.path}${about}: fill in every section (name the fix on ${r.branch} under ${drafts.FIX}, ` +
        `or delete that section when no fix exists), then \`k bug check ${id}\`, and commit it` };
    }
    if (sub === 'check') return report(id, bugs.checkBug(ws, id), '');
    if (sub === 'drop') {
      const r = bugs.drop({ ws, id, why: typeof flags.why === 'string' ? flags.why : '', dryRun });
      const kept = r.branch ? `; its fix branch ${r.branch.branch} is kept in ${r.branch.repo}` : '';
      if (dryRun) return { ...r, text: `would remove ${r.rel} and ${r.dir} in ${r.repo}${r.tracked ? ` and commit "${r.message.split('\n')[0]}"` : ' (never committed, so no commit)'}${kept}` };
      return { ...r, text: (r.commit ? `${id}: dropped in ${r.commit}` : `${id}: dropped; it was never committed, so no commit`) + kept };
    }
    if (sub === 'from') {
      const r = bugs.from({ ws, id, dryRun, noCommit: !!flags['no-commit'] });
      const lines = [
        ...r.moves.map((m) => `${m.from} -> ${m.to}`),
        ...r.renames.map((b) => `${b.repo}: branch ${b.from} -> ${b.to}`),
        ...(r.skeleton ? [`${r.rel}: a bug's skeleton, to fill in from the intake and commit`] : []),
        ...(r.fixRepo ? [`fix-repo: ${r.fixRepo}`] : []),
        ...(r.order ? [`${r.order}: ${id} left the drafts' order`] : []),
      ];
      if (dryRun) return { ...r, text: [`would move the ${r.kind} ${id} into kirunak/bugs/:`, ...lines.map((l) => `  ${l}`)].join('\n') };
      const done = flags['no-commit'] ? ['staged, not committed: commit each repo\'s paths alone (git commit -- <paths>)']
        : r.commits.filter((c) => c.commit).map((c) => `committed in ${c.repo}: ${c.commit}`);
      return { ...r, text: [`${id}: moved from the ${r.kind} into kirunak/bugs/`, ...lines.map((l) => `  ${l}`), ...done].join('\n') };
    }
    throw usage(`unknown bug verb ${sub}`);
  },

  // Every bug in every repo, those with a fix ready first, then the oldest: for /k-bugs, as an array with --json.
  async bugs({ ws, pos }) {
    if (pos.length) throw usage(`unknown bugs verb ${pos[0]}: k bugs`);
    const rows = bugs.list(ws);
    return { json: rows, text: bugs.format(rows) };
  },

  // Every draft in every repo, in the drafts' order: for /k-drafts, as an array with --json. `move` changes the order;
  // a draft is not the owner's, so any session runs it (owner, 2026-10-27).
  async drafts({ ws, pos, flags }) {
    if (pos[0] === 'move') {
      const r = drafts.move({ ws, ids: pos.slice(1), place: place(flags), dryRun: !!flags['dry-run'] });
      if (flags['dry-run']) {
        const then = r.order.map((id, i) => `${String(i + 1).padStart(2)}  ${id}`);
        return { ...r, text: [`would commit "${r.message.split('\n')[0]}", the order then:`, ...then].join('\n') };
      }
      const done = r.commit ? `moved in ${r.commit}` : 'already in that order: nothing to commit';
      return { ...r, text: `${done}\n${drafts.format(drafts.list(ws))}` };
    }
    if (pos.length) throw usage(`unknown drafts verb ${pos[0]}: k drafts, or k drafts move <id>...`);
    const rows = drafts.list(ws);
    return { json: rows, text: drafts.format(rows) };
  },

  async list({ ws, flags }) {
    const rows = await list.rows(ws, { repo: flags.repo, all: !!flags.all });
    return { rows, text: list.format(rows) || 'no task' };
  },

  // What waits for the owner, for the mod's /k-approve and /k-accept with no id (boards.md §4): the proposed tasks
  // with what k approve would refuse, and the reviewed ones with what k accept would refuse; null when it would not.
  // For its pick lists (kirunak-phone): the amendments waiting with what their approval would refuse, each accept
  // row's open checklist items, and the tasks k hold and k start take (lib/waiting.mjs). Last, the drafts that wait for
  // the owner's intake: a count and their ids (kirunak-drafts AC-8). First in the text when there is one, a step k run
  // stopped at for the owner, each as its notice of at most 3 lines (orchestrator.md §2, E-15).
  async waiting({ ws }) {
    const rows = await list.rows(ws);
    const all = await list.rows(ws, { all: true });
    const approve = [];
    for (const r of rows.filter((x) => x.state === 'proposed')) {
      const problems = await approvalProblems(ws, r.id);
      approve.push({ id: r.id, title: r.title, state: r.state, why: problems.length ? problems.join('; ') : null });
    }
    // A task awaiting the owner with no review asked a question in progress (lib/state.mjs): nothing to accept (G26).
    const accept = [];
    for (const r of rows.filter((x) => (x.state === 'reviewed' || x.state === 'awaiting owner') && x.review)) accept.push(await waiting.acceptRow(ws, r));
    const amendments = await waiting.pendingAmendments(ws, all);
    const brief = ({ id, title, state }) => ({ id, title, state });
    const hold = (await waiting.holdable(ws, all)).map(brief);
    // k start refuses no state; it is offered what k list shows, a task neither done nor on hold.
    const start = rows.map(brief);
    const drafts = waiting.waitingDrafts(ws);
    const stopped = waiting.stoppedFor(all);
    // Each row's word when the verb would pass is the verb's, never a task's state (kirunak-phone AC-15).
    const line = (verb) => (x) => `  ${x.id}  ${x.why ? `not yet: ${x.why.split('\n')[0]}` : `can ${verb}`}`;
    const text = [
      ...(stopped.length ? [waiting.stoppedText(stopped)] : []),
      approve.length ? ['to approve:', ...approve.map(line('approve'))].join('\n') : 'nothing to approve',
      amendments.length ? ['amendments to approve:', ...amendments.map((x) => waiting.amendmentLine(x))].join('\n') : 'no amendment to approve',
      // Under an accept row its later commits block, each file with its commit and task, as k accept names them (AC-6).
      accept.length ? ['to accept:', ...accept.flatMap((x) => [line('accept')(x), ...waiting.blockingLines(x)])].join('\n') : 'nothing to accept',
      waiting.draftsLine(drafts),
    ].join('\n');
    return { approve, accept, amendments, hold, start, drafts, stopped, text };
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

  // --markdown prints the board for a chat answer on a phone and writes nothing; --brief the brief board of the mod's
  // /k-board dialogs (with --json: { made, text, ids, groups, machine }, text included), --card <id> the card a task
  // tapped there answers.
  async board({ ws, flags }) {
    if (flags.card) {
      const text = await boardCard(ws, flags.card);
      return { markdown: text, text: text.trimEnd() };
    }
    if (flags.brief) {
      const b = await boardBrief(ws);
      return { json: b, text: b.text };
    }
    if (flags.markdown) {
      const text = await boardMarkdown(ws);
      return { markdown: text, text: text.trimEnd() };
    }
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
    // A verb whose JSON must carry its text too returns it whole as `json`.
    const { text, code, json, ...rest } = r;
    console.log(JSON.stringify(json ?? rest, null, 2));
  } else if (r.text) {
    (r.code ? console.error : console.log)(r.text);
  }
  return r.code || 0;
}

// Exits once stdout and stderr have handed on all they hold: on macOS a pipe takes them asynchronously, and an exit
// straight away cut `k list --json` at 64 KiB for the mod, which reads k through pipes.
function exit(code) {
  let left = 2;
  const flushed = () => {
    if (--left === 0) process.exit(code);
  };
  process.stdout.write('', flushed);
  process.stderr.write('', flushed);
}

// Run as the command (also through a link on PATH), not when a test imports it.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(exit, (e) => {
    console.error(e instanceof KError ? `k: ${e.message}` : e.stack || String(e));
    exit(e instanceof KError ? e.code : 1);
  });
}

