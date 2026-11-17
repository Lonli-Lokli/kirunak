import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// lib/os.mjs is the one file that runs a platform's own process tools or names a shell
// (asilak/kirunak-cross-platform AC-1, AC-2): anywhere else, such a call is a fault on some platform.

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const OS = 'lib/os.mjs';

// A program named as a string ('ps', "lsof", `caffeinate`, '/bin/sh'), or a kill of a negative pid. Comment lines are
// read as prose, never as calls.
const CALLS = [
  [/(['"`])(ps|lsof|caffeinate|\/bin\/sh)\1/, (m) => `runs ${m[2]}`],
  [/\bkill\(\s*-/, () => 'kills a negative pid (a process group)'],
];

function violations(text) {
  const found = [];
  text.split('\n').forEach((line, i) => {
    if (/^\s*(\/\/|\*)/.test(line)) return;
    for (const [re, what] of CALLS) {
      const m = re.exec(line);
      if (m) found.push({ line: i + 1, what: what(m) });
    }
  });
  return found;
}

function* files(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* files(path);
    else if (/\.(mjs|js)$/.test(name)) yield path;
  }
}

test('the check sees each kind of call, and passes over comments and a hook script\'s #!/bin/sh line', () => {
  assert.deepEqual(violations("spawnSync('ps', ['-o', 'etime='])").map((v) => v.what), ['runs ps']);
  assert.deepEqual(violations('run("lsof", [])').map((v) => v.what), ['runs lsof']);
  assert.deepEqual(violations('spawn(`caffeinate`, [])').map((v) => v.what), ['runs caffeinate']);
  assert.deepEqual(violations("spawn('/bin/sh', ['-c', c])").map((v) => v.what), ['runs /bin/sh']);
  assert.deepEqual(violations('process.kill(-pid, signal)').map((v) => v.what), ['kills a negative pid (a process group)']);
  assert.deepEqual(violations("// ps -o etime= as it was\n  * caffeinate on macOS\nconst hook = '#!/bin/sh\\n';"), []);
});

test('no file of lib, plugins, hooks or bin but lib/os.mjs runs ps, lsof, caffeinate or /bin/sh, or kills a negative pid (AC-2)', () => {
  const found = [];
  for (const top of ['lib', 'plugins', 'hooks', 'bin']) {
    for (const path of files(join(ROOT, top))) {
      const rel = relative(ROOT, path).replaceAll('\\', '/');
      if (rel === OS) continue;
      for (const v of violations(readFileSync(path, 'utf8'))) found.push(`${rel}:${v.line} ${v.what}`);
    }
  }
  assert.deepEqual(found, [], `only ${OS} may make these calls:\n${found.join('\n')}`);
});

test('lib/os.mjs makes them, so the check has something to keep in one place', () => {
  const own = violations(readFileSync(join(ROOT, OS), 'utf8')).map((v) => v.what);
  for (const what of ['runs ps', 'runs lsof', 'runs caffeinate', 'runs /bin/sh', 'kills a negative pid (a process group)']) {
    assert.ok(own.includes(what), `${OS} ${what}`);
  }
});
