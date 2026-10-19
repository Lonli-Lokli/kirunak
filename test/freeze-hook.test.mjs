import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';
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
  assert.match(res.reason, /`k amend new weather\/offline-forecast`/);
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
  for (const skill of ['k-intake', 'k-done', 'anything']) {
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
  ]) {
    assert.equal(denies(r, command), `kirunak: \`k ${verb}\` is the owner's: it runs only from the owner's own prompt (\`!\`) or the mod`, command);
  }
  for (const command of [
    'git commit -m "k approve later"',
    "echo 'run k approve x when ready'",
    'k approve x --dry-run',
    'k amend decline x A-1 --dry-run',
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
