import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const STOP = new URL('../lib/stop.mjs', import.meta.url).href;

// A child that runs `body` with onStop imported and `out` a file to append to, says ready, and stays up.
function child(body) {
  const out = join(mkdtempSync(join(tmpdir(), 'kirunak-stop-')), 'out.txt');
  const src = `import { appendFileSync } from 'node:fs'; import { onStop } from ${JSON.stringify(STOP)};
const out = ${JSON.stringify(out)}; const say = (l) => appendFileSync(out, l + '\\n');
${body}
setInterval(() => {}, 1000); process.stdout.write('ready\\n');`;
  const c = spawn(process.execPath, ['--input-type=module', '-e', src], { stdio: ['ignore', 'pipe', 'pipe'] });
  let err = '';
  c.stderr.on('data', (b) => (err += b));
  const ready = new Promise((r) => c.stdout.on('data', (b) => String(b).includes('ready') && r()));
  const exited = new Promise((r) => c.on('exit', (code, signal) => r({ code, signal })));
  const lines = () => (existsSync(out) ? readFileSync(out, 'utf8').trim().split('\n') : []);
  return { c, ready, exited, lines, err: () => err };
}

for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 129]]) {
  test(`${signal}: every registered callback runs, then the process exits with ${code}`, async () => {
    const k = child(`onStop((s) => say('one ' + s)); onStop((s) => say('two ' + s));`);
    await k.ready;
    k.c.kill(signal);
    assert.deepEqual(await k.exited, { code, signal: null });
    assert.deepEqual(k.lines(), [`one ${signal}`, `two ${signal}`]);
  });
}

test('with no callback registered, or the last one unregistered, a signal keeps its default', async () => {
  for (const body of ['', `const off = onStop(() => say('ran')); off();`]) {
    const k = child(body);
    await k.ready;
    k.c.kill('SIGINT');
    assert.deepEqual(await k.exited, { code: null, signal: 'SIGINT' });
    assert.deepEqual(k.lines(), []);
  }
});

test('a callback\'s promise is awaited before the exit; a callback that throws does not stop the others', async () => {
  const k = child(`onStop(() => { throw new Error('boom'); });
onStop(() => new Promise((r) => setTimeout(() => { say('cleaned'); r(); }, 100)));`);
  await k.ready;
  k.c.kill('SIGTERM');
  assert.deepEqual(await k.exited, { code: 143, signal: null });
  assert.deepEqual(k.lines(), ['cleaned']);
  assert.match(k.err(), /while stopping: boom/);
});

test('a second signal while stopping exits at once', async () => {
  const k = child(`onStop(() => { say('stopping'); return new Promise(() => {}); });`);
  await k.ready;
  k.c.kill('SIGTERM');
  while (!k.lines().length) await new Promise((r) => setTimeout(r, 10));
  const t0 = Date.now();
  k.c.kill('SIGINT');
  assert.deepEqual(await k.exited, { code: 130, signal: null });
  assert.ok(Date.now() - t0 < 2000);
});
