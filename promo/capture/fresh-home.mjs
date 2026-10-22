#!/usr/bin/env node
// The fresh-home launcher and recorder (kirunak-docs-promo S-1 §1, §2): opens a login shell in a home that holds
// nothing of the machine's owner, under /usr/bin/script, and records every byte the terminal shows with its time.
//
//   node promo/capture/fresh-home.mjs open --home <dir> --capture <raw root> --name <NN-name>
//
// It refuses to open while the capture's newest session has no complete.json (read.mjs --check writes it), while the
// terminal is not 100 columns by 32 rows, and, for a numbered session (01-setup and on), while this checkout's branch
// is ahead of origin or has no upstream there (the filmed setup clones the pushed kirunak). When the shell exits it
// copies, from the fresh home, the Claude Code transcripts, the mod's dialogs and kirunak's events of the session's
// span.
import { execFileSync, spawn } from 'node:child_process';
import { appendFileSync, copyFileSync, createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const COLS = 100;
export const ROWS = 32;
const HERE = dirname(fileURLToPath(import.meta.url));

// Only what a newcomer's own shell would have: the fresh home's tools first, npm's global prefix inside it, a prompt
// with no user and no host.
export const ZSHRC = [
  'export PATH="$HOME/.local/bin:$HOME/.npm-global/bin:/usr/bin:/bin:/usr/sbin:/sbin"',
  'export npm_config_prefix="$HOME/.npm-global"',
  "PROMPT='%~ %# '",
  '',
].join('\n');

export function envOf(home) {
  return { HOME: home, USER: 'dev', LOGNAME: 'dev', SHELL: '/bin/zsh', TERM: 'xterm-256color', LANG: 'en_US.UTF-8', TMPDIR: join(home, '.tmp'), PATH: `${home}/.local/bin:${home}/.npm-global/bin:/usr/bin:/bin:/usr/sbin:/sbin` };
}

// Why the session may not open, or null.
export function refusal({ capture, name, cols, rows, ahead }) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) return `the name ${name} is not lower-case letters, digits and dashes`;
  if (cols !== COLS || rows !== ROWS) return `the terminal is ${cols}x${rows}; size it to ${COLS}x${ROWS} and do not resize it during the session`;
  if (existsSync(join(capture, name))) return `${join(capture, name)} exists already`;
  const done = existsSync(capture) ? readdirSync(capture).filter((f) => statSync(join(capture, f)).isDirectory()).sort() : [];
  const newest = done.at(-1);
  if (newest && !existsSync(join(capture, newest, 'complete.json'))) return `${newest} is not checked complete: run read.mjs ${join(capture, newest)} --out <public dir> --check first`;
  if (/^\d\d-/.test(name) && ahead) return `this checkout is not pushed (${ahead}); push it first, so the filmed setup clones the mod that ran`;
  return null;
}

// What of the checkout's branch is not on origin, or null: commits ahead of it, or no upstream on origin at all (a new
// branch, a detached HEAD), which shows no `[ahead` and is just as unpushed (S-3 F-5).
export function aheadOf(checkout) {
  try {
    const head = execFileSync('git', ['-C', checkout, 'status', '-sb'], { encoding: 'utf8' }).split('\n')[0];
    if (!/\.\.\.origin\//.test(head)) return `${head.replace(/^## /, '')}, with no upstream on origin`;
    return /\[ahead \d+/.test(head) ? head.replace(/^## /, '') : null;
  } catch {
    return 'not a git checkout';
  }
}

const which = (tool) => realpathSync(execFileSync('/usr/bin/which', [tool], { encoding: 'utf8' }).trim());

export function prepare(home) {
  for (const d of ['.local/bin', '.npm-global', '.tmp']) mkdirSync(join(home, d), { recursive: true });
  for (const tool of ['node', 'npm', 'npx', 'claude']) {
    const link = join(home, '.local/bin', tool);
    rmSync(link, { force: true });
    symlinkSync(which(tool), link);
  }
  if (!existsSync(join(home, '.zshrc'))) writeFileSync(join(home, '.zshrc'), ZSHRC);
}

const jsonl = (file) => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const firstTime = (file) => {
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    try {
      const t = Date.parse(JSON.parse(line).timestamp);
      if (!Number.isNaN(t)) return t;
    } catch {
      // A partial line.
    }
  }
  return null;
};

// The fresh home's records of the span [start, end]: Claude Code's transcripts that began in it, the mod's dialogs and
// kirunak's events. Answers the id of the transcript that began last.
export function collect(home, raw, start, end) {
  const projects = join(home, '.claude/projects');
  const found = [];
  for (const p of existsSync(projects) ? readdirSync(projects) : []) {
    for (const f of readdirSync(join(projects, p)).filter((x) => x.endsWith('.jsonl'))) {
      const t = firstTime(join(projects, p, f));
      if (t !== null && t >= start && t <= end) found.push({ file: join(projects, p, f), id: f.replace(/\.jsonl$/, ''), t });
    }
  }
  mkdirSync(join(raw, 'transcripts'), { recursive: true });
  for (const x of found) copyFileSync(x.file, join(raw, 'transcripts', `${x.id}.jsonl`));
  const state = join(home, '.kirunak');
  const inSpan = (t) => t >= start && t <= end;
  // A dialog the mod logged with no time (its clock failed) is kept, so the reader reports it (S-3 F-2).
  const dialogs = jsonl(join(state, 'dialogs.jsonl')).filter((d) => d.t == null || inSpan(d.t));
  const events = jsonl(join(state, 'events.jsonl')).filter((e) => inSpan(Date.parse(e.time)));
  writeFileSync(join(raw, 'dialogs.jsonl'), dialogs.map((d) => JSON.stringify(d) + '\n').join(''));
  writeFileSync(join(raw, 'events.jsonl'), events.map((e) => JSON.stringify(e) + '\n').join(''));
  return found.sort((a, b) => a.t - b.t).at(-1)?.id ?? null;
}

// Records `argv` run under /usr/bin/script into `raw`: terminal.raw holds every byte, terminal.times.jsonl one line a
// chunk ({o, n, t}), a resize ({resize: [cols, rows], t}) and, last, the exit ({end: true, code, t}). script's -F and
// -t 0 flush after every write into the fifo this process reads, so each chunk is stamped as it arrives.
export function record(raw, argv, { env, cwd, stdio = 'inherit', size = () => null } = {}) {
  mkdirSync(raw, { recursive: true });
  const fifo = join(raw, '.fifo');
  execFileSync('mkfifo', [fifo]);
  const rawFile = join(raw, 'terminal.raw');
  const times = join(raw, 'terminal.times.jsonl');
  writeFileSync(rawFile, '');
  writeFileSync(times, '');
  let offset = 0;
  const reading = new Promise((done, fail) => {
    createReadStream(fifo)
      .on('data', (buf) => {
        const t = Date.now();
        appendFileSync(rawFile, buf);
        appendFileSync(times, JSON.stringify({ o: offset, n: buf.length, t }) + '\n');
        offset += buf.length;
      })
      .on('end', done)
      .on('error', fail);
  });
  const onResize = () => {
    const s = size();
    if (s && (s[0] !== COLS || s[1] !== ROWS)) appendFileSync(times, JSON.stringify({ resize: s, t: Date.now() }) + '\n');
  };
  process.stdout.on('resize', onResize);
  const child = spawn('/usr/bin/script', ['-q', '-F', '-t', '0', fifo, ...argv], { env, cwd, stdio });
  const ignore = () => undefined;
  process.on('SIGINT', ignore);
  return new Promise((done, fail) => {
    child.on('error', fail);
    child.on('exit', async (code) => {
      await reading;
      process.off('SIGINT', ignore);
      process.stdout.off('resize', onResize);
      appendFileSync(times, JSON.stringify({ end: true, code, t: Date.now() }) + '\n');
      rmSync(fifo, { force: true });
      done(code);
    });
  });
}

async function open(args) {
  const flag = (f) => (args.includes(f) ? args[args.indexOf(f) + 1] : null);
  const [home, capture, name] = [flag('--home'), flag('--capture'), flag('--name')];
  if (!home || !capture || !name) throw new Error('usage: fresh-home.mjs open --home <dir> --capture <raw root> --name <NN-name>');
  const why = refusal({ capture, name, cols: process.stdout.columns, rows: process.stdout.rows, ahead: aheadOf(join(HERE, '../..')) });
  if (why) throw new Error(`refused: ${why}`);
  prepare(home);
  const env = envOf(home);
  const raw = join(capture, name);
  let claudeVersion = null;
  try {
    claudeVersion = execFileSync(join(home, '.local/bin/claude'), ['--version'], { env, encoding: 'utf8' }).trim();
  } catch {
    // Recorded as unknown.
  }
  const start = Date.now();
  console.log(`Recording ${name} in ${home}. Type exit to end the session.`);
  const code = await record(raw, ['/bin/zsh', '-l'], { env, cwd: home, size: () => [process.stdout.columns, process.stdout.rows] });
  const end = Date.now();
  const sessionId = collect(home, raw, start, end);
  let kirunakCommit = null;
  try {
    kirunakCommit = execFileSync('git', ['-C', join(home, 'kirunak'), 'rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    // No clone in the fresh home yet.
  }
  writeFileSync(join(raw, 'manifest.json'), JSON.stringify({ name, start, end, cols: COLS, rows: ROWS, home, cwd: home, sessionId, claudeVersion, kirunakCommit, shell: '/bin/zsh', exitCode: code }, null, 2) + '\n');
  console.log(`Recorded ${raw}. Check it: node ${join(HERE, 'read.mjs')} ${raw} --out <public dir> --check`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [verb, ...args] = process.argv.slice(2);
  try {
    if (verb !== 'open') throw new Error('usage: fresh-home.mjs open --home <dir> --capture <raw root> --name <NN-name>');
    await open(args);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
