import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { blockLines } from '../hooks/escalate-state.mjs';
import { decide } from '../hooks/kirunak-freeze.mjs';

// D7: the PreToolUse hook refuses the model's writes to what only the owner's commands write (approval.md §2).

const HOOK = fileURLToPath(new URL('../hooks/kirunak-freeze.mjs', import.meta.url));
const FROZEN = 'offline-forecast';
const DRAFT = 'radar-tiles';
const ID = 'weather/offline-forecast';

// A repo named `weather` holding a frozen task (with its approval record) and a draft.
function makeRepo() {
  const top = mkdtempSync(join(tmpdir(), 'kirunak-freeze-'));
  const repo = join(top, 'weather');
  for (const slug of [FROZEN, DRAFT]) {
    const dir = join(repo, 'kirunak', 'tasks', slug);
    mkdirSync(join(dir, 'amendments'), { recursive: true });
    writeFileSync(join(dir, 'task.md'), `# ${slug}\n\n## Goal\nG-1: something. [owner 2026-11-02]\n`);
    writeFileSync(join(dir, 'intake.md'), '# Intake\n\nQ-1 (2026-11-02): which data?\n');
    writeFileSync(join(dir, 'checklist.md'), '# Checklist\n\n- [ ] AC-1 works offline\n- [ ] AC-2 shows the age\n');
    writeFileSync(join(dir, 'amendments', 'A-1.md'), `---\ntask: weather/${slug}\nproposed: 2026-11-04\n---\n\n## Why\nx\n`);
  }
  mkdirSync(join(repo, 'kirunak', 'approvals'), { recursive: true });
  writeFileSync(join(repo, 'kirunak', 'approvals', `${FROZEN}.json`), JSON.stringify({
    task: ID, hash: 'sha256:00', approved: '2026-11-05T09:12:00+01:00', by: 'owner', via: 'shell', commit: '7c1d2e3', history: [],
  }, null, 2) + '\n');
  const home = join(top, 'home');
  return { top, repo, home, task: (slug, file) => join(repo, 'kirunak', 'tasks', slug, file) };
}

function cleanEnv(extra = {}) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('KIRUNAK_')) env[k] = v;
  return { ...env, ...extra };
}

// Runs the hook as Claude Code does: the JSON on stdin, the decision on stdout.
function run(input, home, env = {}) {
  const r = spawnSync(process.execPath, [HOOK], {
    input: typeof input === 'string' ? input : JSON.stringify(input),
    env: cleanEnv({ KIRUNAK_HOME: home, ...env }),
    encoding: 'utf8',
  });
  const out = r.stdout.trim() ? JSON.parse(r.stdout) : null;
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, reason: out?.hookSpecificOutput?.permissionDecisionReason ?? null, out };
}

const lines = (file) => (existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

const edit = (file, oldString, newString, extra = {}) => ({
  session_id: 's1', transcript_path: '/dev/null', hook_event_name: 'PreToolUse', tool_use_id: 't1',
  tool_name: 'Edit', tool_input: { file_path: file, old_string: oldString, new_string: newString }, ...extra,
});
const write = (file, content) => ({ session_id: 's1', tool_name: 'Write', tool_input: { file_path: file, content } });
const bash = (command, cwd) => ({ session_id: 's1', tool_name: 'Bash', tool_input: { command }, cwd });

test('an Edit of a frozen task.md is denied with the amendment instruction, and logged', () => {
  const r = makeRepo();
  const res = run(edit(r.task(FROZEN, 'task.md'), 'something', 'something else'), r.home);
  assert.equal(res.status, 0);
  assert.equal(res.out.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(res.out.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(res.reason, /^kirunak: /);
  assert.match(res.reason, /frozen since 2026-11-05/);
  assert.match(res.reason, /kirunak\/tasks\/offline-forecast\/amendments\/A-<n>\.md/);
  assert.match(res.reason, /`k amend new weather\/offline-forecast --title "<a few words>"`/);
  assert.match(res.reason, /`k approve weather\/offline-forecast --amendment A-<n>`/);
  const log = lines(join(r.home, 'freeze.log'));
  assert.equal(log.length, 1);
  assert.equal(log[0].kind, 'refusal');
  assert.equal(log[0].tool, 'Edit');
  assert.equal(log[0].reason, res.reason);
  const events = lines(join(r.home, 'events.jsonl'));
  assert.deepEqual(Object.keys(events[0]).sort(), ['kind', 'reason', 'time', 'tool']);
  assert.equal(events[0].kind, 'refusal');
});

test('an Edit or Write of a draft task.md is allowed', () => {
  const r = makeRepo();
  for (const input of [edit(r.task(DRAFT, 'task.md'), 'something', 'else'), write(r.task(DRAFT, 'task.md'), '# new\n')]) {
    const res = run(input, r.home);
    assert.equal(res.status, 0);
    assert.equal(res.stdout, '');
  }
  assert.equal(existsSync(join(r.home, 'freeze.log')), false);
});

test('a MultiEdit of a frozen task.md is denied', () => {
  const r = makeRepo();
  const res = run({ tool_name: 'MultiEdit', tool_input: { file_path: r.task(FROZEN, 'task.md'), edits: [{ old_string: 'a', new_string: 'b' }] } }, r.home);
  assert.match(res.reason, /frozen since/);
});

test('any Write under approvals/, to done.json or hold.md is denied as the owner\'s', () => {
  const r = makeRepo();
  for (const file of [join(r.repo, 'kirunak', 'approvals', `${DRAFT}.json`), join(r.repo, 'kirunak', 'approvals', `${FROZEN}.json`),
    r.task(DRAFT, 'done.json'), r.task(FROZEN, 'hold.md')]) {
    const res = run(write(file, '{}\n'), r.home);
    assert.match(res.reason, /^kirunak: only the owner's own command writes this: ask them to type `! k approve /, file);
  }
  assert.equal(lines(join(r.home, 'freeze.log')).length, 4);
});

test('a Write, an Edit or a shell write of cost.md is denied: it is generated from done.json', () => {
  const r = makeRepo();
  const file = r.task(FROZEN, 'cost.md');
  for (const input of [write(file, '# Cost\n'), { tool_name: 'Edit', tool_input: { file_path: file, old_string: 'a', new_string: 'b' } }, { tool_name: 'Bash', tool_input: { command: `echo x > ${file}` } }]) {
    const res = run(input, r.home);
    assert.match(res.reason ?? '', /^kirunak: cost\.md is generated from done\.json's cost, which only `k accept` records: `k cost .+ --write` writes it again$/, JSON.stringify(input));
  }
});

test('a `- [x]` tick in checklist.md is denied; other checklist edits are allowed', () => {
  const r = makeRepo();
  const file = r.task(FROZEN, 'checklist.md');
  assert.match(run(edit(file, '- [ ] AC-1 works offline', '- [x] AC-1 works offline'), r.home).reason, /the owner ticks the checklist/);
  assert.match(run(write(file, '# Checklist\n\n- [x] AC-1 works offline\n'), r.home).reason, /the owner ticks the checklist/);
  assert.equal(run(edit(file, 'AC-2 shows the age', 'AC-2 shows the forecast age'), r.home).stdout, '');
  assert.equal(run(write(file, '# Checklist\n\n- [ ] AC-1 works offline\n'), r.home).stdout, '');
});

test('an Edit or Write of intake.md is denied', () => {
  const r = makeRepo();
  const file = r.task(DRAFT, 'intake.md');
  assert.match(run(edit(file, 'which data?', 'which data, and how old?'), r.home).reason, /`k intake question\|answer`/);
  assert.match(run(write(file, '# Intake\n'), r.home).reason, /`k intake question\|answer`/);
});

test('an amendment\'s applied:/declined: stamp is denied; a new amendment without one is allowed', () => {
  const r = makeRepo();
  const a1 = r.task(FROZEN, 'amendments/A-1.md');
  const a2 = r.task(FROZEN, 'amendments/A-2.md');
  assert.equal(run(write(a2, '---\ntask: weather/offline-forecast\nproposed: 2026-11-06\n---\n\n## Why\ny\n'), r.home).stdout, '');
  assert.match(run(write(a2, '---\ntask: weather/offline-forecast\napplied: 2026-11-06\n---\n'), r.home).reason, /only the owner's own command/);
  assert.match(run(edit(a1, 'proposed: 2026-11-04\n', 'proposed: 2026-11-04\ndeclined: 2026-11-06 not now\n'), r.home).reason,
    /only the owner's own command/);
  assert.equal(run(edit(a1, '## Why\nx', '## Why\nx, and y'), r.home).stdout, '');
});

test('Bash: the owner\'s verbs and writes into protected files are denied', () => {
  const r = makeRepo();
  assert.match(run(bash('k approve weather/offline-forecast', r.repo), r.home).reason,
    /^kirunak: `k approve` is the owner's: it runs only from the owner's own prompt \(`!`\) or the mod$/);
  assert.match(run(bash(`echo '{}' >> kirunak/approvals/${DRAFT}.json`, r.repo), r.home).reason, /only the owner's own command/);
  assert.match(run(bash(`sed -i '' 's/something/other/' kirunak/tasks/${FROZEN}/task.md`, r.repo), r.home).reason, /frozen since 2026-11-05/);
});

test('Bash: k check, k intake answer, k handoff, cat and git log are allowed', () => {
  const r = makeRepo();
  for (const command of ['k check weather/offline-forecast', 'k intake answer weather/radar-tiles Q-1 "hourly, three days"',
    'k handoff weather/offline-forecast', `cat kirunak/approvals/${FROZEN}.json`, 'git log --oneline -- kirunak/']) {
    const res = run(bash(command, r.repo), r.home);
    assert.equal(res.status, 0, command);
    assert.equal(res.stdout, '', command);
  }
});

// kirunak-drafts O-3: a draft is not the owner's, so its verbs and its file are an agent's to run and write.
test('Bash: k draft new, check and drop, k drafts, and writes to kirunak/drafts/ are allowed', () => {
  const r = makeRepo();
  const draft = join(r.repo, 'kirunak', 'drafts', 'wind-alerts.md');
  for (const command of ['k draft new weather/wind-alerts --title "Wind alerts"', 'k draft check weather/wind-alerts',
    'k draft drop weather/wind-alerts --why "folded into offline-forecast"', 'k drafts', 'k drafts --json',
    'node bin/k.mjs draft drop weather/wind-alerts --why "a duplicate"', 'git add kirunak/drafts/wind-alerts.md && git commit -m "a draft"',
    'git rm kirunak/drafts/wind-alerts.md', 'rm kirunak/drafts/wind-alerts.md', 'echo "1. Which?" >> kirunak/drafts/wind-alerts.md']) {
    const res = run(bash(command, r.repo), r.home);
    assert.equal(res.status, 0, command);
    assert.equal(res.stdout, '', command);
  }
  for (const input of [write(draft, '---\nid: weather/wind-alerts\n---\n'), edit(draft, '## Why\n', '## Why\nCyclists asked.\n')]) {
    assert.equal(run(input, r.home).stdout, '', input.tool_name);
  }
});

// gulnya/kirunak-bugs: a bug is not the owner's either, so its verbs and its files are an agent's to run and write.
test('Bash: k bug new, check, drop and from, k bugs, and writes to kirunak/bugs/ are allowed', () => {
  const r = makeRepo();
  const bug = join(r.repo, 'kirunak', 'bugs', 'stale-tiles.md');
  for (const command of ['k bug new weather/stale-tiles --title "Stale tiles" --bug-of weather/offline-forecast',
    'k bug new weather/stale-tiles --title "Stale tiles" --fix-repo kirunak', 'k bug check weather/stale-tiles',
    'k bug drop weather/stale-tiles --why "fixed by offline-forecast"', `k bug from weather/${DRAFT}`, `k bug from weather/${DRAFT} --no-commit`,
    'k bugs', 'k bugs --json', 'node bin/k.mjs bug from weather/wind-alerts --dry-run',
    'git add kirunak/bugs/stale-tiles.md && git commit -m "a bug"', 'git rm -r kirunak/bugs/stale-tiles', 'git branch -m draft/stale-tiles bug/stale-tiles',
    'echo "   Proposed: hourly" >> kirunak/bugs/stale-tiles.md']) {
    const res = run(bash(command, r.repo), r.home);
    assert.equal(res.status, 0, command);
    assert.equal(res.stdout, '', command);
  }
  for (const input of [write(bug, '---\nid: weather/stale-tiles\n---\n'), edit(bug, '## Why\n', '## Why\nThe tiles stay.\n'),
    write(join(r.repo, 'kirunak', 'bugs', 'stale-tiles', 'review-1.md'), 'verdict: clean\n')]) {
    assert.equal(run(input, r.home).stdout, '', input.tool_name);
  }
});

test('a subagent\'s input (agent_id, agent_type) is treated the same', () => {
  const r = makeRepo();
  const res = run(edit(r.task(FROZEN, 'task.md'), 'something', 'else', { agent_id: 'a1b2', agent_type: 'general-purpose' }), r.home);
  assert.match(res.reason, /frozen since/);
  assert.equal(lines(join(r.home, 'freeze.log'))[0].agent, 'general-purpose');
  assert.match(run({ ...bash('k accept weather/offline-forecast', r.repo), agent_id: 'a1b2', agent_type: 'Explore' }, r.home).reason,
    /`k accept` is the owner's/);
});

test('bad input fails open: exit 0, no output', () => {
  const r = makeRepo();
  for (const input of ['not json', '', '{', 'null', '42', '{"tool_name":"Edit"}', '{"tool_name":"Bash","tool_input":{}}']) {
    const res = run(input, r.home);
    assert.equal(res.status, 0, input);
    assert.equal(res.stdout, '', input);
  }
});

test('KIRUNAK_FREEZE_OFF=1 allows and logs', () => {
  const r = makeRepo();
  const res = run(edit(r.task(FROZEN, 'task.md'), 'something', 'else'), r.home, { KIRUNAK_FREEZE_OFF: '1' });
  assert.equal(res.status, 0);
  assert.equal(res.stdout, '');
  const log = lines(join(r.home, 'freeze.log'));
  assert.equal(log.length, 1);
  assert.equal(log[0].kind, 'allowed');
  assert.equal(log[0].why, 'KIRUNAK_FREEZE_OFF=1');
  assert.match(log[0].reason, /frozen since/);
  assert.equal(lines(join(r.home, 'events.jsonl')).length, 0);
});

test('the Skill tool: the owner\'s command names are denied, every other skill allowed', () => {
  const r = makeRepo();
  for (const skill of ['k-approve', 'k-accept', 'k-hold', 'k-resume', 'someplugin:k-approve']) {
    assert.match(run({ tool_name: 'Skill', tool_input: { skill } }, r.home).reason, /is the owner's/, skill);
  }
  for (const skill of ['k-intake', 'k-done', 'k-board-page', 'anything']) {
    assert.equal(run({ tool_name: 'Skill', tool_input: { skill } }, r.home).stdout, '', skill);
  }
});

test('an unwritable KIRUNAK_HOME never stops the refusal', () => {
  const r = makeRepo();
  writeFileSync(join(r.top, 'a-file'), '');
  const res = run(edit(r.task(FROZEN, 'task.md'), 'a', 'b'), join(r.top, 'a-file', 'home'));
  assert.match(res.reason, /frozen since/);
});

// ---- decide, directly: the Bash segment parser ----

function denies(r, command, cwd = r.repo) {
  return decide(bash(command, cwd));
}

test('decide: redirection, tee and sed -i into protected files', () => {
  const r = makeRepo();
  for (const command of [
    `echo '{}' > kirunak/approvals/${DRAFT}.json`,
    `echo x >>kirunak/approvals/new.json`,
    `printf x 2>&1 1>kirunak/tasks/${DRAFT}/done.json`,
    `echo x &> kirunak/tasks/${DRAFT}/hold.md`,
    `echo x | tee -a kirunak/tasks/${DRAFT}/done.json`,
    `sed -i -e 's/a/b/' kirunak/tasks/${FROZEN}/task.md`,
    `perl -pi -e 's/a/b/' kirunak/tasks/${FROZEN}/task.md`,
    `sed -i '' s/a/b/ kirunak/tasks/*/task.md`,
    `cat > kirunak/approvals/${DRAFT}.json <<'EOF'\n{}\nEOF`,
    `node -e "require('fs').writeFileSync('kirunak/approvals/x.json', '{}')"`,
    `touch kirunak/tasks/${DRAFT}/done.json`,
  ]) {
    assert.ok(denies(r, command), command);
  }
  for (const command of [
    `sed -i '' s/a/b/ kirunak/tasks/${DRAFT}/task.md`,
    `sed 's/a/b/' kirunak/tasks/${FROZEN}/task.md`,
    `echo x > kirunak/tasks/${DRAFT}/notes.md`,
    `echo x >> kirunak/tasks/${FROZEN}/progress.md 2>&1`,
    `cat kirunak/approvals/${FROZEN}.json | grep hash > /dev/null`,
    `cat <<'EOF'\nk approve x\necho > kirunak/approvals/x.json\nEOF`,
  ]) {
    assert.equal(denies(r, command), null, command);
  }
});

test('decide: cp, mv and rm into approvals, done.json and a frozen task', () => {
  const r = makeRepo();
  for (const command of [
    `cp /tmp/x.json kirunak/approvals/`,
    `cp /tmp/x.json kirunak/approvals/${DRAFT}.json`,
    `cp /tmp/task.md kirunak/tasks/${FROZEN}/`,
    `mv kirunak/approvals/${FROZEN}.json /tmp/`,
    `mv /tmp/done.json kirunak/tasks/${DRAFT}/done.json`,
    `rm kirunak/approvals/${FROZEN}.json`,
    `rm -f kirunak/approvals/*.json`,
    `rm -rf kirunak/approvals`,
    `rm -rf kirunak/tasks/${FROZEN}`,
    `rm -rf kirunak`,
    `rm kirunak/tasks/${FROZEN}/task.md`,
  ]) {
    assert.ok(denies(r, command), command);
  }
  for (const command of [
    `cp kirunak/approvals/${FROZEN}.json /tmp/`,
    `cp /tmp/notes.md kirunak/tasks/${FROZEN}/`,
    `rm -rf kirunak/tasks/${DRAFT}`,
    `mv kirunak/tasks/${FROZEN}/notes.md /tmp/`,
  ]) {
    assert.equal(denies(r, command), null, command);
  }
});

test('decide: git checkout and git restore of a frozen task or a record', () => {
  const r = makeRepo();
  for (const command of [
    `git checkout -- kirunak/tasks/${FROZEN}/task.md`,
    `git checkout HEAD~1 -- kirunak/tasks/${FROZEN}/task.md`,
    `git restore --source HEAD~1 kirunak/tasks/${FROZEN}/task.md`,
    `git -C ${r.repo} restore kirunak/approvals/${FROZEN}.json`,
    `git rm kirunak/approvals/${FROZEN}.json`,
  ]) {
    assert.ok(denies(r, command, command.includes('-C') ? r.top : r.repo), command);
  }
  for (const command of ['git checkout -b feature', `git restore kirunak/tasks/${DRAFT}/task.md`, 'git add kirunak/',
    'git commit -m "kirunak: plan for offline-forecast"', `git diff -- kirunak/tasks/${FROZEN}/task.md`]) {
    assert.equal(denies(r, command), null, command);
  }
});

test('decide: paths resolve against cwd, cd, ~ and absolute paths', () => {
  const r = makeRepo();
  const taskDir = join(r.repo, 'kirunak', 'tasks', FROZEN);
  assert.ok(denies(r, "sed -i '' s/a/b/ task.md", taskDir));
  assert.ok(denies(r, `sed -i '' s/a/b/ ${r.task(FROZEN, 'task.md')}`, tmpdir()));
  assert.ok(denies(r, `cd ${r.repo} && echo x > kirunak/approvals/x.json`, tmpdir()));
  assert.equal(denies(r, "sed -i '' s/a/b/ task.md", join(r.repo, 'kirunak', 'tasks', DRAFT)), null);
  const home = process.env.HOME;
  process.env.HOME = r.top;
  try {
    assert.ok(denies(r, `sed -i '' s/a/b/ ~/weather/kirunak/tasks/${FROZEN}/task.md`, tmpdir()));
    assert.ok(denies(r, `echo x > $HOME/weather/kirunak/approvals/x.json`, tmpdir()));
  } finally {
    process.env.HOME = home;
  }
  assert.equal(denies(r, `echo x > ${join(r.top, 'approvals.json')}`, r.repo), null);
});

test('decide: the owner\'s verbs however k is invoked, never in a quoted mention or with --dry-run', () => {
  const r = makeRepo();
  for (const [command, verb] of [
    ['k approve weather/offline-forecast', 'approve'],
    ['cd weather && k approve weather/offline-forecast', 'approve'],
    ['k approve x; echo done', 'approve'],
    ['k check x && k approve x --first', 'approve'],
    ['node /opt/kirunak/bin/k.mjs accept weather/offline-forecast', 'accept'],
    ['node bin/k.mjs hold x "waiting for data"', 'hold'],
    ['./bin/k.mjs resume x', 'resume'],
    ['k.mjs resume x', 'resume'],
    ['npx k hold x', 'hold'],
    ['npx --yes k accept x', 'accept'],
    ['KIRUNAK_APPROVING=x k queue move x --first', 'queue'],
    ['k queue remove x', 'queue'],
    ['k amend decline x A-1 "not now"', 'amend decline'],
    ['if true; then k approve x; fi', 'approve'],
    ['echo y | k approve x', 'approve'],
    ['k approve x 2>&1 | tail -1', 'approve'],
    ['k bug review weather/stale-tiles', 'bug review'],
    ['k bug review weather/stale-tiles --detach --json', 'bug review'],
    ['node bin/k.mjs bug review weather/stale-tiles --via mod', 'bug review'],
  ]) {
    assert.equal(denies(r, command), `kirunak: \`k ${verb}\` is the owner's: it runs only from the owner's own prompt (\`!\`) or the mod`, command);
  }
  for (const command of [
    'git commit -m "k approve later"',
    "echo 'run k approve x when ready'",
    'k approve x --dry-run',
    'k amend decline x A-1 --dry-run',
    'k bug review weather/stale-tiles --dry-run',
    'k queue add x --dry-run',
    'k queue show',
    'k amend new weather/offline-forecast',
    'k amend check weather/offline-forecast A-1',
    'k intake question x data "which data?"',
    'k list',
    'k board',
    'k start x',
    'k verify x',
    'grep -n "k approve" design/approval.md',
    'echo k approve x # k approve x',
    'ls k',
  ]) {
    assert.equal(denies(r, command), null, command);
  }
});

test('decide: tools it does not guard, and files outside kirunak/, are allowed', () => {
  const r = makeRepo();
  assert.equal(decide({ tool_name: 'Read', tool_input: { file_path: r.task(FROZEN, 'task.md') } }), null);
  assert.equal(decide(edit(join(r.repo, 'src', 'main.kt'), 'a', 'b')), null);
  assert.equal(decide(edit(r.task(FROZEN, 'plan.md'), 'a', 'b')), null);
  assert.equal(decide(write(r.task(FROZEN, 'evidence/report.md'), '- [x] measured\n')), null);
  assert.equal(decide(null), null);
});

// ---- R23: a repo's .slapignore and its approvals are the owner's ----

test('an Edit or Write of any .slapignore, and of the approvals record, is denied', () => {
  const r = makeRepo();
  const owner = /^kirunak: \.slapignore is the owner's \(R23\): say which pattern to add or remove and why/;
  assert.match(run(edit(join(r.repo, '.slapignore'), '*.md', '*.md\n*.kt'), r.home).reason, owner);
  assert.match(run(write(join(r.top, 'elsewhere', '.slapignore'), '*\n'), r.home).reason, owner);
  assert.match(run(write(join(r.home, 'slapignore.json'), '{}'), r.home).reason, /only the owner's own command writes the \.slapignore approvals/);
  assert.equal(run(write(join(r.repo, '.slapignore.bak'), 'x'), r.home).reason, null);
  assert.equal(run(write(join(r.repo, 'src', 'slapignore.kt'), 'x'), r.home).reason, null);
});

test('Bash: writes to .slapignore and `k slapignore approve` are denied; reading and committing it are not', () => {
  const r = makeRepo();
  for (const command of [
    "echo '*.kt' >> .slapignore", "sed -i '' 's/md/kt/' .slapignore", 'rm .slapignore', 'cp /tmp/x .slapignore',
    'git checkout HEAD~1 -- .slapignore', `node -e "require('fs').appendFileSync('.slapignore', '*.kt')"`,
  ]) {
    assert.match(run(bash(command, r.repo), r.home).reason ?? '', /\.slapignore is the owner's/, command);
  }
  assert.match(run(bash(`echo '{}' > ${join(r.home, 'slapignore.json')}`, r.repo), r.home).reason, /\.slapignore approvals/);
  for (const command of ['k slapignore approve --all', 'k slapignore approve .', 'node bin/k.mjs slapignore approve ~/repo']) {
    assert.match(run(bash(command, r.repo), r.home).reason, /`k slapignore approve` is the owner's/, command);
  }
  for (const command of ['cat .slapignore', 'git add .slapignore && git commit -m "Add the starter"', 'k slapignore status',
    'k slapignore approve --all --dry-run', 'k slap --staged', 'git diff -- .slapignore']) {
    assert.equal(run(bash(command, r.repo), r.home).reason, null, command);
  }
});

// ---- The escalation hook's block, and what lifts it kept from the model (design/approval.md §7) ----

const fitsPhone = (reason) => {
  const ls = reason.split('\n');
  assert.ok(ls.length <= 3 && ls.every((l) => l.length <= 80), reason);
};

// A home whose session s1 is blocked as the escalation hook leaves it, with config.json as k install writes it.
function blockedHome({ hook = {}, lifted = null } = {}) {
  const home = join(mkdtempSync(join(tmpdir(), 'kirunak-freeze-block-')), 'home');
  mkdirSync(join(home, 'escalate'), { recursive: true });
  writeFileSync(join(home, 'escalate', 'config.json'), JSON.stringify({ hook: { enabled: true, block: true, repeats: 2, commands: [], ...hook } }));
  const rung = { from: 'claude-opus-5-5', up: 'fable', agents: ['fable-step', 'domain-deep'] };
  const task = { id: 'hub/escalation-by-failures', title: 'Escalation follows measured failures, not self-assessment' };
  const lines = (subagent) => blockLines({ label: 'climbs one rung', task, rung, subagent }).join('\n');
  writeFileSync(join(home, 'escalate', 's1.json'), JSON.stringify({
    session: 's1', failures: {}, agents: {},
    block: { hash: 'h1', label: 'climbs one rung', at: '2026-10-25T21:00:00.000Z', rung: { ...rung, to: 'fable' }, reason: lines(false), subagentReason: lines(true), lifted },
  }));
  return home;
}

test('a block in force denies Edit, Write, MultiEdit and NotebookEdit with three lines; Read, Bash, Agent and other skills go on (E-10)', () => {
  const home = blockedHome();
  const want = [
    'kirunak: edits blocked: climbs one rung failed again.',
    'Task: Escalation follows measured failures, not s… (hub/escalation-by-failures).',
    'Launch fable-step (or domain-deep) on this step; the owner can type /k-go-on.',
  ];
  const nb = { session_id: 's1', tool_name: 'NotebookEdit', tool_input: { notebook_path: '/tmp/a.ipynb', new_source: 'x' } };
  const multi = { session_id: 's1', tool_name: 'MultiEdit', tool_input: { file_path: '/tmp/a.mjs', edits: [{ old_string: 'a', new_string: 'b' }] } };
  for (const input of [edit('/tmp/a.mjs', 'a', 'b'), write('/tmp/a.mjs', 'x'), multi, nb]) {
    assert.deepEqual(run(input, home).reason?.split('\n'), want, input.tool_name);
  }
  assert.equal(lines(join(home, 'freeze.log')).length, 4, 'each refusal logged');
  for (const input of [
    { tool_name: 'Read', tool_input: { file_path: '/tmp/a.mjs' } },
    { tool_name: 'Bash', tool_input: { command: 'npm test' } },
    { tool_name: 'Agent', tool_input: { subagent_type: 'fable-step', prompt: 'the failure and what was tried' } },
    { tool_name: 'Skill', tool_input: { skill: 'k-draft' } },
  ]) assert.equal(run({ session_id: 's1', ...input }, home).stdout, '', input.tool_name);
  assert.match(run({ ...write('/tmp/a.mjs', 'x'), agent_id: 'a1', agent_type: 'opus-step' }, home).reason, /\nStop and return to your caller marked NEEDS-FABLE; the owner can type \/k-go-on\.$/);
});

test('no deny when the block is lifted or off, the hook is off, config.json is gone, another session edits, or a k run step runs', () => {
  const cases = [
    [blockedHome({ lifted: { by: 'override', at: '2026-10-25T21:05:00.000Z' } }), {}],
    [blockedHome({ hook: { block: false } }), {}],
    [blockedHome({ hook: { enabled: false } }), {}],
    [blockedHome(), { KIRUNAK_STEP: 'S-3' }],
  ];
  for (const [home, env] of cases) assert.equal(run(write('/tmp/a.mjs', 'x'), home, env).stdout, '', JSON.stringify(env));
  const other = blockedHome();
  assert.equal(run({ ...write('/tmp/a.mjs', 'x'), session_id: 's2' }, other).stdout, '');
  const bare = blockedHome();
  rmSync(join(bare, 'escalate', 'config.json'));
  assert.equal(run(write('/tmp/a.mjs', 'x'), bare).stdout, '');
});

test('decide: the Skill call of k-go-on, a prompt or message carrying /k-go-on, and a claude run that could type it are refused (R5.2)', () => {
  const refused = (input) => decide({ cwd: '/tmp', ...input });
  for (const skill of ['k-go-on', 'kirunak:k-go-on']) assert.match(refused({ tool_name: 'Skill', tool_input: { skill } }), /\/k-go-on is the owner's/);
  const prompts = [
    ['CronCreate', { cron: '44 19 25 10 *', prompt: '/k-go-on', recurring: false }],
    ['CronCreate', { cron: '*/5 * * * *', prompt: '  /K-GO-ON now' }],
    ['ScheduleWakeup', { delaySeconds: 60, prompt: '/k-go-on', reason: 'go on' }],
    ['SendMessage', { to: 'main', message: 'Done. Please run /k-go-on' }],
    ['Agent', { description: 'go on', subagent_type: 'general-purpose', prompt: '/k-go-on' }],
    ['Agent', { description: 'go on', prompt: '  /K-GO-ON please' }],
  ];
  for (const [tool, ti] of prompts) assert.match(refused({ tool_name: tool, tool_input: ti }), /\/k-go-on is the owner's/, tool);
  // A brief that quotes the block's reason, which names /k-go-on, still reaches the agent that lifts the block (S-10 S-4).
  const brief = 'kirunak: edits blocked: climbs one rung failed again.\nLaunch fable-step on this step; the owner can type /k-go-on.';
  for (const [tool, ti] of [
    ['CronCreate', { cron: '0 9 * * *', prompt: 'run the tests' }], ['SendMessage', { to: 'main', message: 'tests pass' }],
    ['Agent', { description: 'take the step', subagent_type: 'fable-step', prompt: brief }],
  ]) {
    assert.equal(refused({ tool_name: tool, tool_input: ti }), null, tool);
  }
  for (const command of [
    'claude -p "/k-go-on"', 'cd ~/sources/x && npx claude -p /k-go-on', 'claude --resume 80b2e863 -p "go on"', 'claude -c -p < prompt.txt',
    'claude --continue', 'claude -r', 'claude --session-id=80b2e863 -p hi', 'echo /k-go-on > p.txt; claude -p < p.txt',
  ]) {
    const reason = refused({ tool_name: 'Bash', tool_input: { command } });
    assert.match(reason ?? '', /a claude run that resumes a session or types \/k-go-on is refused/, command);
    assert.equal(refused({ tool_name: 'Monitor', tool_input: { command } }), reason, `Monitor: ${command}`);
  }
  for (const command of ['claude -p "summarise this diff"', 'claude --version', 'grep -rn "/k-go-on" skills', 'tail -f build.log']) {
    assert.equal(refused({ tool_name: 'Bash', tool_input: { command } }), null, command);
  }
});

test('decide: the escalation hook\'s state files and log are refused to every edit tool and to shell writes (R5.2)', () => {
  const home = join(mkdtempSync(join(tmpdir(), 'kirunak-freeze-state-')), 'home');
  const was = process.env.KIRUNAK_HOME;
  process.env.KIRUNAK_HOME = home;
  try {
    const state = join(home, 'escalate', 's1.json');
    const log = join(home, 'escalate.log');
    const tools = [
      edit(state, '"lifted":null', '"lifted":{}'), write(join(home, 'escalate', 'config.json'), '{}'), write(log, ''),
      { tool_name: 'MultiEdit', tool_input: { file_path: state, edits: [] } }, { tool_name: 'NotebookEdit', tool_input: { notebook_path: join(home, 'escalate', 'x.ipynb') } },
    ];
    for (const input of tools) assert.match(decide(input) ?? '', /escalation hook's state and log are its own/, input.tool_name);
    for (const command of [
      `echo '{}' > ${state}`, `rm ${state}`, `rm -rf ${home}`, `mv ${join(home, 'escalate')} /tmp/x`, `sed -i '' s/null/1/ ${log}`,
      `cd ${home} && rm -r escalate`, `cp /tmp/x.json ${join(home, 'escalate')}/`, `node -e "require('fs').writeFileSync('${state}', '{}')"`,
    ]) assert.match(decide({ tool_name: 'Bash', tool_input: { command }, cwd: '/tmp' }) ?? '', /escalation hook's state/, command);
    for (const command of [`cat ${state}`, `ls ${join(home, 'escalate')}`, `tail -5 ${log}`, `echo x > ${join(home, 'escalate-notes.txt')}`]) {
      assert.equal(decide({ tool_name: 'Bash', tool_input: { command }, cwd: '/tmp' }), null, command);
    }
    assert.equal(decide(write(join(home, 'escalate-notes.txt'), 'x')), null);
    const reasons = [decide(write(log, '')), decide({ tool_name: 'Skill', tool_input: { skill: 'k-go-on' } }), decide({ tool_name: 'Bash', tool_input: { command: 'claude -c' } })];
    reasons.forEach(fitsPhone);
  } finally {
    if (was === undefined) delete process.env.KIRUNAK_HOME;
    else process.env.KIRUNAK_HOME = was;
  }
});

test('decide: a shell that runs the escalation hook\'s scripts is refused; reading them and node --test are not (S-17)', () => {
  const bashOf = (command) => decide({ tool_name: 'Bash', tool_input: { command }, cwd: '/tmp' });
  const event = '{"hook_event_name":"UserPromptExpansion","command_name":"k-go-on","session_id":"s1"}';
  for (const command of [
    `echo '${event}' | node hooks/kirunak-escalate.mjs`, 'node /home/someone/kirunak/hooks/kirunak-escalate.mjs < f',
    'cat stop.json | KIRUNAK_HOME=/tmp/h nice node ~/kirunak/hooks/kirunak-escalate.mjs', './hooks/kirunak-escalate.mjs < f',
    `node -e "import('./hooks/escalate-state.mjs').then((m) => m.writeState())"`, 'node < hooks/kirunak-escalate.mjs',
  ]) {
    const reason = bashOf(command);
    assert.match(reason ?? '', /escalation hook's events come from Claude Code, not from a shell/, command);
    assert.equal(decide({ tool_name: 'Monitor', tool_input: { command }, cwd: '/tmp' }), reason, `Monitor: ${command}`);
  }
  for (const command of [
    'cat hooks/kirunak-escalate.mjs', 'grep -n x hooks/escalate-state.mjs', 'sed -n 1,40p hooks/kirunak-escalate.mjs',
    'head -20 hooks/escalate-state.mjs | less', 'node --test test/escalate-hook.test.mjs', 'git log -- hooks/kirunak-escalate.mjs',
  ]) assert.equal(bashOf(command), null, command);
  fitsPhone(bashOf('node hooks/kirunak-escalate.mjs'));
  const r = makeRepo();
  assert.match(run(bash(`echo '${event}' | node hooks/kirunak-escalate.mjs`, '/tmp'), r.home).reason ?? '', /not from a shell/);
});

// ---- A k run started in the background is noted, so its end's push is found (design/approval.md §7) ----

test('a background k run is noted under its description, however k is invoked; one in the foreground, a k list, or a k run in a k run step is not', () => {
  const home = blockedHome({ lifted: { by: 'override', at: '2026-10-25T21:05:00.000Z' } });
  const state = () => JSON.parse(readFileSync(join(home, 'escalate', 's1.json'), 'utf8')).background ?? {};
  const bg = (command, description) => ({ session_id: 's1', tool_name: 'Bash', tool_input: { command, description, run_in_background: true }, cwd: '/tmp' });
  for (const input of [bg('k list', 'List the tasks'), bash('k run weather/offline-forecast --watch', '/tmp')]) assert.equal(run(input, home).stdout, '');
  assert.equal(run(bg('k run weather/offline-forecast --watch', 'Run the task in a step'), home, { KIRUNAK_STEP: 'S-1' }).stdout, '');
  assert.deepEqual(state(), {}, 'nothing noted');
  assert.equal(run(bg('cd ~/sources/weather && k run weather/offline-forecast --watch 2>&1', 'Run the weather task'), home).stdout, '');
  assert.equal(run(bg('node ~/sources/kirunak/bin/k.mjs run weather/radar-tiles', 'Run the radar task'), home).stdout, '');
  const notes = state();
  assert.deepEqual(Object.keys(notes), ['Run the weather task', 'Run the radar task']);
  assert.deepEqual(Object.values(notes).map(({ command, run: kRun }) => [command, kRun]), [['k run weather/offline-forecast', true], ['k run weather/radar-tiles', true]]);
  assert.ok(Object.values(notes).every((n) => Date.parse(n.at)));
});
