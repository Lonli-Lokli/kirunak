// The command line's words, as bin/k.mjs reads them and the freeze hook must read them too: a flag in BOOLEAN stands
// alone, any other takes the next word (or its `=` part) as its value, so `k --via mod approve x` runs approve.
import { usage } from './errors.mjs';

export const BOOLEAN = new Set(['json', 'dry-run', 'first', 'last', 'all', 'print', 'no-queue', 'no-open', 'markdown', 'brief', 'staged', 'baseline', 'once', 'watch', 'write', 'replace-agents', 'no-commit', 'detach', 'status', 'summary', 'progress', 'stop']);

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
