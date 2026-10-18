import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

// The state folder: $KIRUNAK_HOME, else ~/.kirunak (plugins.md §3, §4).
export function kirunakHome(env = process.env) {
  return env.KIRUNAK_HOME ? resolve(expandHome(env.KIRUNAK_HOME)) : join(homedir(), '.kirunak');
}

export function expandHome(path) {
  if (path === '~') return homedir();
  if (path.startsWith('~/')) return join(homedir(), path.slice(2));
  return path;
}
