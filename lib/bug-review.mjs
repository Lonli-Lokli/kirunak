import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { logEvent } from './approval.mjs';
import { refuse } from './errors.mjs';
import { commit, git, head, succeeds } from './git.mjs';
import { bugPaths, fixLine, fixOf, known, list, mainOf, pidRuns, quadDamageRun, repoNamed, reviewLockPath, reviewsOf, sameSha } from './bugs.mjs';
import { oneLine, parseDraft } from './drafts.mjs';
import { timed } from './run.mjs';
import { worktrees as removeWorktrees, worktreesOf } from './worktrees.mjs';
import { register, unregister } from '../plugins/machine-guard-pids.mjs';

// Review & merge (gulnya/kirunak-bugs AC-4, AC-5, E-1, E-2, E-3, E-6, O-1, D-1): `k bug review <id>`, the owner's
// verb, merges a bug's fix only after a fresh headless session reviewed its diff. It takes the bug's lock, checks the
// fix is ready, tests the merge touching nothing, runs the review through the workspace's `runner` (the one k run
// uses) in a worktree of the fix's head, and reads the review file itself: the model writes it, kirunak decides from
// it. Clean: bug/<slug> is merged into its fix repo's master with --no-ff, never pushed (O-1), and the bug closes in
// its own repo, which may be another (E-6). Findings, a malformed review or a conflict: nothing is merged, the review
// file is committed beside the bug, and the bug waits with its fix not ready at that head (E-1).

// The review session's environment names the bug, so the session-start hooks stay silent in it (E-7).
export const REVIEW_ENV = 'KIRUNAK_BUG_REVIEW';
// The pid that hands its lock to the detached process doing the work (--detach).
const HANDOFF_ENV = 'KIRUNAK_BUG_REVIEW_HANDOFF';
const BRIEF = new URL('../templates/bug-review-brief.md', import.meta.url);
const K = fileURLToPath(new URL('../bin/k.mjs', import.meta.url));
// Past this size the diff stays in its file and the brief names it.
const DIFF_INLINE = 100 * 1024;
const VERDICTS = new Set(['clean', 'findings']);
const NUMBERED = /^(\d+)\.\s+\S/;
const HEAVY = 'A heavy job (a Gradle or Xcode build or test, a booted emulator or simulator) runs only through ' +
  "this machine's heavy lock, never bare: {{command}}. Run at most that one queued job in this session; when the " +
  "fix's test is a heavy job, it is that one. With the lock held by another job, wait for it rather than run around it.";
const HEAVY_DEFAULT = "the heavy-lock command this machine's CLAUDE.md names, with the job's command after it";
// The workspace's heavy-lock command in backquotes, its `<session>` the session's own id (gulnya/quad-damage AC-14), so
// the queue's turns are fair by session; null when the workspace names none.
export const heavyCommand = (ws, sessionId) => (ws.bugs?.heavyLock ? `\`${ws.bugs.heavyLock.replace(/<session>/g, sessionId)}\`` : null);

// $KIRUNAK_HOME/bugs/<repo>/<slug>/: each review's brief, diff, session file and result, and the detached log.
export const runDir = (home, id) => reviewLockPath(home, id).replace(/\.review\.json$/, '');
export const logPath = (home, id) => join(runDir(home, id), 'review.log');

const readJson = (path) => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
};

// --- The lock (E-3) ---

// A bug Quad Damage is on is named so (gulnya/quad-damage E-4): its run holds the same lock.
const busy = (home, id, l) => (quadDamageRun(home)?.pid === l.pid
  ? refuse(`${id} is in Quad Damage's run: pid ${l.pid}, started ${l.started ?? 'at a time not recorded'}; Review & merge ` +
    'waits until the run moves on, and k bugs quad-damage --status shows it')
  : refuse(`${id} is in Review & merge already: pid ${l.pid}, started ${l.started ?? 'at a time not recorded'}; ` +
    'a second one waits until it ends, and k bugs shows its result'));

// Takes the bug's lock for `pid`: refused while another live pid holds it. A dead pid's lock is taken over, and so is
// the lock of `from`, the process that hands it on, keeping its start. → { pid, started }.
export function lock(home, id, { pid = process.pid, from = null, now = new Date() } = {}) {
  const path = reviewLockPath(home, id);
  mkdirSync(dirname(path), { recursive: true });
  for (let tries = 0; tries < 3; tries++) {
    if (!existsSync(path)) {
      // A new lock is made with O_EXCL, so of two first runs one wins and the other looks again.
      const mine = { pid, started: now.toISOString() };
      try {
        writeFileSync(path, JSON.stringify(mine) + '\n', { flag: 'wx' });
        return mine;
      } catch (e) {
        if (e.code !== 'EEXIST') throw e;
        continue;
      }
    }
    const held = readJson(path);
    const ours = held && (held.pid === pid || (from && held.pid === from));
    if (held && !ours && pidRuns(held.pid)) throw busy(home, id, held);
    const mine = { pid, started: (ours && held.started) || now.toISOString() };
    writeFileSync(path, JSON.stringify(mine) + '\n');
    return mine;
  }
  throw busy(home, id, readJson(path) ?? { pid: '?', started: null });
}

// Lets the lock go, only while it is `pid`'s.
export function unlock(home, id, pid = process.pid) {
  const path = reviewLockPath(home, id);
  if (readJson(path)?.pid === pid) rmSync(path, { force: true });
}

// --- The merge test (E-1) and the merge (O-1) ---

// `git merge-tree --write-tree <main> <sha>`: touches no checkout, no index and no branch. → { clean: true } or
// { clean: false, files }, the files that conflict.
export function mergeTest(root, main, sha) {
  try {
    git(root, ['merge-tree', '--write-tree', '--name-only', '--no-messages', `refs/heads/${main}`, sha]);
    return { clean: true, files: [] };
  } catch (e) {
    if (e.status !== 1) throw refuse(`git merge-tree in ${root} failed: ${String(e.stderr || e.message).trim()}`);
    const files = [...new Set(String(e.stdout).split('\n').slice(1).map((l) => l.trim()).filter(Boolean))];
    return { clean: false, files };
  }
}

const lines = (s) => String(s).split('\n').filter(Boolean);
const firstLines = (e) => String(e.stderr || e.stdout || e.message).trim().split('\n').slice(0, 4).join('; ');
const indexClean = (dir) => succeeds(dir, ['diff', '--cached', '--quiet']) && !git(dir, ['ls-files', '-u']).trim();
const inMerge = (dir) => ['MERGE_HEAD', 'REBASE_HEAD', 'CHERRY_PICK_HEAD'].some((r) => succeeds(dir, ['rev-parse', '-q', '--verify', r]));

// Merges `sha` into `main` with --no-ff and pushes nothing. In the checkout that has `main` out when its index is
// clean, as `git merge` there. Else (another session's staged files, or `main` out nowhere) in a temporary worktree,
// then `main` moved there and, in the checkout that has it out, only the files the merge changed brought up to it:
// so another session's staged files stay staged and out of the merge, and a merge that changes one of them, or a
// file changed and not staged there, is refused, touching nothing. → { merged, where } or { refused }.
export function mergeInto(root, main, sha, message) {
  const ref = `refs/heads/${main}`;
  const old = git(root, ['rev-parse', ref]).trim();
  const out = worktreesOf(root).find((w) => w.branch === main && !w.bare) ?? null;
  if (out && inMerge(out.path)) return { refused: `${out.path}, where ${main} is out, is in the middle of a merge, rebase or cherry-pick` };
  if (out && indexClean(out.path)) {
    try {
      git(out.path, ['merge', '--no-ff', '-q', '-m', message, sha]);
    } catch (e) {
      if (succeeds(out.path, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'])) succeeds(out.path, ['merge', '--abort']);
      return { refused: `git merge in ${out.path} failed: ${firstLines(e)}` };
    }
    return { merged: git(out.path, ['rev-parse', 'HEAD']).trim(), where: out.path };
  }
  const tmp = mkdtempSync(join(tmpdir(), 'kirunak-merge-'));
  let made;
  try {
    git(root, ['worktree', 'add', '-q', '--detach', tmp, old]);
    git(tmp, ['merge', '--no-ff', '-q', '-m', message, sha]);
    made = git(tmp, ['rev-parse', 'HEAD']).trim();
  } catch (e) {
    return { refused: `git merge in a temporary worktree of ${main} failed: ${firstLines(e)}` };
  } finally {
    succeeds(root, ['worktree', 'remove', '--force', tmp]);
    rmSync(tmp, { recursive: true, force: true });
  }
  const changed = lines(git(root, ['diff', '--name-status', '--no-renames', old, made])).map((l) => {
    const [status, ...path] = l.split('\t');
    return { status, path: path.join('\t') };
  });
  if (out) {
    const own = new Set([...lines(git(out.path, ['diff', '--cached', '--name-only', '--no-renames'])), ...lines(git(out.path, ['diff', '--name-only', '--no-renames']))]);
    const taken = changed.filter((c) => own.has(c.path) || (c.status === 'A' && existsSync(join(out.path, c.path))));
    if (taken.length) {
      return { refused: `${out.path}, where ${main} is out, has changes of its own in files the merge changes ` +
        `(${taken.map((c) => c.path).join(', ')}): once they are committed or gone, Review & merge again` };
    }
  }
  try {
    git(root, ['update-ref', '-m', `kirunak: ${message.split('\n')[0]}`, ref, made, old]);
  } catch (e) {
    return { refused: `${main} moved while it merged: ${firstLines(e)}` };
  }
  if (out) {
    const present = changed.filter((c) => c.status !== 'D').map((c) => c.path);
    const gone = changed.filter((c) => c.status === 'D').map((c) => c.path);
    if (present.length) git(out.path, ['checkout', made, '--', ...present]);
    if (gone.length) git(out.path, ['rm', '-q', '-f', '--ignore-unmatch', '--', ...gone]);
  }
  return { merged: made, where: out?.path ?? null };
}

// --- The review file ---

// What a review file the session wrote says: { verdict, head, base, findings: [text], problems: [string] }; a problem
// makes the file malformed, which counts as a finding. Its front matter must name the head and base kirunak gave.
export function checkReview(text, { head: h, base }) {
  if (text === null || text === undefined) return { verdict: null, findings: [], problems: ['the review session wrote no review file'] };
  const d = parseDraft(text);
  const problems = [];
  const f = d.front;
  if (!d.frontEnd) problems.push('no front matter: the file starts with --- and verdict, head, base');
  const verdict = oneLine(f.verdict) || null;
  if (!VERDICTS.has(verdict)) problems.push(`verdict ${verdict ?? '(none)'} is neither clean nor findings`);
  if (!sameSha(oneLine(f.head), h)) problems.push(`head ${oneLine(f.head) || '(none)'} is not the head reviewed, ${h}`);
  if (!sameSha(oneLine(f.base), base)) problems.push(`base ${oneLine(f.base) || '(none)'} is not the base given, ${base}`);
  const section = d.sections.find((s) => s.name === 'Findings');
  const findings = (section?.lines ?? []).filter((l) => NUMBERED.test(l.text)).map((l) => l.text.trim());
  if (!section) problems.push('no ## Findings section');
  else if (verdict === 'clean' && findings.length) problems.push(`a clean verdict lists ${findings.length} finding${findings.length > 1 ? 's' : ''}`);
  else if (verdict === 'findings' && !findings.length) problems.push('a findings verdict lists no numbered finding');
  return { verdict, findings, problems };
}

const quoted = (text) => text.replace(/\n+$/, '').split('\n').map((l) => (l ? `> ${l}` : '>')).join('\n');

// The review file kirunak writes in place of a malformed one: a finding naming its problems, its text quoted (so no
// line of it reads as a key), and the run's exit.
function malformed({ head: h, base, problems, text, exit }) {
  const said = text ? `\n\n## The file the review session wrote\n\n${quoted(text)}\n` : '\n';
  return `---\nverdict: findings\nhead: ${h}\nbase: ${base}\n---\n\n## Findings\n` +
    `1. The review is not one kirunak can take, so it counts as a finding: ${problems.join('; ')}. ` +
    `The session ended with exit ${exit ?? 'unknown'}. A Review & merge of this head runs a new review once the fix has a new head.${said}`;
}

function conflictReview({ head: h, base, branch, main, files }) {
  return `---\nverdict: conflict\nhead: ${h}\nbase: ${base}\n---\n\n## Conflict\n` +
    `${branch} at ${h} no longer merges onto ${main} at ${base}; git merge-tree finds a conflict in:\n` +
    `${files.map((f) => `- ${f}`).join('\n') || '- (git named no file)'}\n\n` +
    `Nothing was merged, and no review ran. The fix is not ready at this head: rebase ${branch} onto ${main} or make it again there, then Review & merge.\n`;
}

const noted = (text, title, body) => `${text.replace(/\n*$/, '\n')}\n## ${title}\n${body}\n`;

// --- The review session ---

function brief(ws, c) {
  const diff = readFileSync(c.diffPath, 'utf8');
  const fill = {
    id: c.id, title: c.title, fixRepo: c.fix.name, main: c.main, branch: c.branch, head: c.head, base: c.base,
    tree: c.tree, bugPath: c.p.path, bug: readFileSync(c.p.path, 'utf8').trim(), diffPath: c.diffPath, output: c.output,
    diff: diff.length > DIFF_INLINE ? `The diff is ${Math.round(diff.length / 1024)} KB: read it in \`${c.diffPath}\`, with ranges.` : '```diff\n' + diff.trimEnd() + '\n```',
    heavy: HEAVY.replace('{{command}}', heavyCommand(ws, c.sessionId) ?? HEAVY_DEFAULT),
    calls: String(c.budget.calls),
  };
  return readFileSync(BRIEF, 'utf8').replace(/\{\{(\w+)\}\}/g, (m, k) => fill[k] ?? m);
}

// One fresh headless session through the workspace's runner, in a detached worktree of the head under review, its
// file tools denied that worktree and the session transcripts. → { text, exit }: the file it wrote, or null.
async function runSession(ws, c) {
  rmSync(c.dir, { recursive: true, force: true });
  mkdirSync(c.dir, { recursive: true });
  writeFileSync(c.diffPath, git(c.fix.root, ['diff', `${c.base}..${c.head}`]));
  succeeds(c.fix.root, ['worktree', 'prune']);
  git(c.fix.root, ['worktree', 'add', '-q', '--detach', c.tree, c.head]);
  try {
    const sessionId = randomUUID();
    c.sessionId = sessionId;
    const text = brief(ws, c);
    writeFileSync(join(c.dir, 'brief.md'), text);
    const handle = await ws.seams.runner.start({
      brief: text, prompt: text, cwd: c.tree, sessionId,
      model: ws.bugs?.reviewModel || 'opus', ...(ws.bugs?.reviewEffort ? { effort: ws.bugs.reviewEffort } : {}),
      disallowedTools: ['Agent'], addDirs: [c.dir],
      deny: [`Edit(/${c.tree}/**)`, `Write(/${c.tree}/**)`, 'Read(~/.claude/projects)', 'Read(~/.claude/projects/**)'],
      maxTurns: c.budget.calls, maxBudgetUsd: c.budget.usd,
      env: { [REVIEW_ENV]: c.id },
    });
    if (handle.pid) register(ws, handle.pid, { task: c.id, step: 'review', session: handle.sessionId || sessionId });
    const o = await timed(handle, c.budget.minutes);
    if (handle.pid) unregister(ws, handle.pid);
    writeFileSync(join(c.dir, 'result.json'), JSON.stringify({ sessionId: handle.sessionId || sessionId, exitCode: o.exitCode, timedOut: !!o.timedOut, result: o.result ?? null }, null, 2) + '\n');
    return { text: existsSync(c.output) ? readFileSync(c.output, 'utf8') : null, exit: o.exitCode };
  } finally {
    succeeds(c.fix.root, ['worktree', 'remove', '--force', c.tree]);
    rmSync(c.tree, { recursive: true, force: true });
  }
}

// --- Review & merge ---

// The bug as Review & merge takes it: refused when it is no bug or its fix is not ready.
function inHand(ws, id, home) {
  const p = bugPaths(ws, id);
  if (!existsSync(p.path)) throw refuse(`no bug ${id}: ${p.path} does not exist; k bugs lists the bugs`);
  const row = list(ws, { home }).find((r) => r.id === id);
  const fix = repoNamed(ws, row.fixRepo);
  if (!fix) throw refuse(`${id} names the fix repo ${row.fixRepo}, which is no repo of the workspace and not kirunak`);
  if (!row.fixReady) {
    throw refuse(`${id} has no fix ready (${fixLine({ ...row, reviewing: null, quadDamageRun: null })}): Review & merge takes a branch ${p.branch} in ` +
      `${fix.name} with commits its master lacks, at a head no review refused`);
  }
  const main = mainOf(fix.root);
  return { p, row, fix, main, id, title: row.title, branch: p.branch, head: row.head, base: git(fix.root, ['merge-base', `refs/heads/${main}`, row.head]).trim() };
}

// Writes the review file beside the bug and commits that path alone. → the commit, or null when the commit failed
// (the file stays, and the failure is in `problems`).
function keep(c, n, text, message, problems) {
  const rel = `${c.p.dirRel}/review-${n}.md`;
  mkdirSync(c.p.dir, { recursive: true });
  writeFileSync(join(c.p.root, rel), text);
  try {
    return { rel, commit: commit(c.p.root, [rel], message) };
  } catch (e) {
    problems.push(e.message);
    return { rel, commit: null };
  }
}

// The bug closed in its own repo once its fix is merged: the bug and its folder removed in a commit of those paths
// alone, naming the merge and the review; then the worktree of bug/<slug> goes when it holds nothing else.
async function close(ws, c, { merged, review }, problems, processes) {
  const paths = known(c.p.root, [c.p.rel, c.p.dirRel]);
  const message = `kirunak: close the bug ${c.id}: ${c.branch} merged into ${c.fix.name}'s ${c.main} as ${merged.slice(0, 12)}, ` +
    `after its review ${review.rel}${review.commit ? ` (${review.commit})` : ''}`;
  let closed = null;
  try {
    if (paths.length) {
      git(c.p.root, ['rm', '-r', '-q', '-f', '--ignore-unmatch', '--', ...paths]);
      git(c.p.root, ['commit', '-q', '-m', message, '--', ...paths]);
      closed = head(c.p.root);
    }
    rmSync(c.p.path, { force: true });
    rmSync(c.p.dir, { recursive: true, force: true });
  } catch (e) {
    problems.push(`the fix is merged, but closing the bug in ${c.p.root} failed: ${firstLines(e)}; k bug drop ${c.id} --why "merged" closes it`);
  }
  const w = await removeWorktrees({ ws, only: { root: c.fix.root, branch: c.branch }, remove: true, ...(processes ? { processes } : {}) });
  return { closed, message, worktrees: w };
}

// `k bug review <id>`: Review & merge, in this process. → { id, outcome, review, merged, closed, problems, ... },
// outcome one of merged, findings, conflict, merge-refused. `from` is the pid that hands the lock on (--detach).
export async function review({ ws, id, via = 'shell', home = ws.home, from = Number(process.env[HANDOFF_ENV]) || null, processes = null, now = new Date() }) {
  bugPaths(ws, id);
  const held = lock(home, id, { from, now });
  const problems = [];
  try {
    const c = inHand(ws, id, home);
    const reviews = reviewsOf(c.p.dir);
    const n = (reviews.at(-1)?.n ?? 0) + 1;
    c.dir = join(runDir(home, id), `review-${n}`);
    c.tree = join(c.dir, 'tree');
    c.output = join(c.dir, 'review.md');
    c.diffPath = join(c.dir, 'diff.patch');
    c.budget = { calls: 100, minutes: 40, usd: 3, ...ws.budget, ...ws.bugs?.budget };
    const out = { id, via, branch: c.branch, fixRepo: c.fix.name, head: c.head, base: c.base, review: null, verdict: null, merged: null, closed: null, problems };
    const done = (r) => {
      logEvent(ws, { time: new Date().toISOString(), kind: 'bug-review', bug: id, via, outcome: r.outcome, head: c.head, review: r.review?.rel ?? null, merged: r.merged });
      return r;
    };

    const t = mergeTest(c.fix.root, c.main, c.head);
    if (!t.clean) {
      const master = git(c.fix.root, ['rev-parse', `refs/heads/${c.main}`]).trim();
      const r = keep(c, n, conflictReview({ ...c, base: master, files: t.files }), `kirunak: the bug ${id}: ${c.branch} no longer merges onto ${c.main}, review-${n}.md`, problems);
      return done({ ...out, outcome: 'conflict', verdict: 'conflict', conflict: t.files, review: r });
    }

    // A clean review of this very head, whose merge was refused before, is taken again rather than run a second time.
    const again = reviews.filter((v) => v.verdict === 'clean' && sameSha(v.head, c.head)).at(-1);
    let r;
    if (again) r = { rel: `${c.p.dirRel}/${again.file}`, commit: null, reused: true };
    else {
      const s = await runSession(ws, c);
      const v = checkReview(s.text, c);
      const verdict = v.problems.length ? 'findings' : v.verdict;
      const text = v.problems.length ? malformed({ ...c, problems: v.problems, text: s.text, exit: s.exit }) : s.text;
      r = keep(c, n, text, `kirunak: review-${n}.md of the bug ${id}: ${verdict}`, problems);
      out.verdict = verdict;
      if (v.problems.length) out.malformed = v.problems;
      if (verdict !== 'clean') return done({ ...out, outcome: 'findings', findings: v.problems.length ? v.problems : v.findings, review: r });
    }
    out.verdict = 'clean';
    out.review = r;

    const refused = (why) => {
      const path = join(c.p.root, r.rel);
      writeFileSync(path, noted(readFileSync(path, 'utf8'), `Merge refused, ${now.toISOString()}`,
        `${why}.\nNothing was merged. This review stays clean for the head ${c.head}: a Review & merge of that head takes it again and runs no second review.`));
      try {
        r.commit = commit(c.p.root, [r.rel], `kirunak: the bug ${id}: the merge of ${c.branch} refused, written in ${r.rel}`);
      } catch (e) {
        problems.push(e.message);
      }
      return done({ ...out, outcome: 'merge-refused', why });
    };
    const now2 = fixOf(c.fix.root, c.branch);
    if (!now2 || now2.head !== c.head) return refused(`${c.branch} moved to ${now2?.head ?? 'nothing'} while ${c.head} was reviewed`);
    const message = `Merge ${c.branch}: ${c.title} (the bug ${id}, its review ${r.rel} clean, by Review & merge)`;
    const m = mergeInto(c.fix.root, c.main, c.head, message);
    if (m.refused) return refused(m.refused);
    out.merged = m.merged;
    out.mergedIn = m.where;
    const cl = await close(ws, c, { merged: m.merged, review: r }, problems, processes);
    return done({ ...out, outcome: 'merged', closed: cl.closed, worktrees: cl.worktrees });
  } finally {
    unlock(home, id, held.pid);
  }
}

// What a Review & merge would do now, touching nothing: the fix, the merge test, and the clean review it would take.
export function preview({ ws, id, home = ws.home }) {
  const p = bugPaths(ws, id);
  if (!existsSync(p.path)) throw refuse(`no bug ${id}: ${p.path} does not exist; k bugs lists the bugs`);
  const row = list(ws, { home }).find((r) => r.id === id);
  if (row.reviewing) throw busy(home, id, row.reviewing);
  const c = inHand(ws, id, home);
  const t = mergeTest(c.fix.root, c.main, c.head);
  const again = reviewsOf(p.dir).filter((v) => v.verdict === 'clean' && sameSha(v.head, c.head)).at(-1) ?? null;
  return { id, branch: c.branch, fixRepo: c.fix.name, head: c.head, base: c.base, merges: t.clean, conflict: t.files, reuses: again?.file ?? null };
}

// `k bug review <id> --detach`: the lock taken here, handed to a detached `k bug review` that does the work, its
// output in the log; returns at once. → { id, pid, log }.
export function detach({ ws, id, via = 'shell', home = ws.home, argv = [] }) {
  bugPaths(ws, id);
  const held = lock(home, id);
  try {
    preflight(ws, id, home);
    const log = logPath(home, id);
    mkdirSync(dirname(log), { recursive: true });
    appendFileSync(log, `\n--- Review & merge of ${id}, ${new Date().toISOString()} (via ${via})\n`);
    const fd = openSync(log, 'a');
    let child;
    try {
      child = spawn(process.execPath, [K, 'bug', 'review', id, '--via', via, ...argv], {
        detached: true, stdio: ['ignore', fd, fd], env: { ...process.env, KIRUNAK_HOME: home, [HANDOFF_ENV]: String(process.pid) },
      });
    } finally {
      closeSync(fd);
    }
    if (!child.pid) throw refuse(`the detached Review & merge of ${id} did not start; see ${log}`);
    // The lock is the working process's from here; it takes it over as its own once it runs.
    writeFileSync(reviewLockPath(home, id), JSON.stringify({ pid: child.pid, started: held.started }) + '\n');
    child.unref();
    return { id, pid: child.pid, started: held.started, log };
  } catch (e) {
    unlock(home, id, held.pid);
    throw e;
  }
}

// The refusals a detached run would only write in its log, made before it starts: no bug, no fix ready.
function preflight(ws, id, home) {
  inHand(ws, id, home);
}
