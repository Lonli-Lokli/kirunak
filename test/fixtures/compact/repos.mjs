import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { gitCommitAll, gitInit, sh } from '../../helpers.mjs';

export const writeJson = (path, value) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
};

// A scratch folder for the compaction hook's tests: a git repo `app` whose own
// .claude/settings.local.json sets the handover window, its subdirectory `app/sub`, a worktree `app-wt` of it (a
// `.git` file), a repo `other` with a window of its own that is no workspace repo, a folder `plain` outside git, and
// the user's config folder `claude` with `user` as its settings.json (null: no file). Real paths, as k install
// writes the roots.
export function makeRepos({ window = 183000, user = { autoCompactWindow: 500000 } } = {}) {
  const top = realpathSync(mkdtempSync(join(tmpdir(), 'kirunak-compact-')));
  const repo = (name) => {
    const root = join(top, name);
    mkdirSync(join(root, 'sub'), { recursive: true });
    writeFileSync(join(root, 'README'), `${name}\n`);
    gitInit(root);
    gitCommitAll(root);
    return root;
  };
  const app = repo('app');
  writeJson(join(app, '.claude', 'settings.local.json'), { autoCompactWindow: window });
  sh(app, 'git', ['worktree', 'add', '-q', join(top, 'app-wt')]);
  const other = repo('other');
  writeJson(join(other, '.claude', 'settings.local.json'), { autoCompactWindow: 250000 });
  mkdirSync(join(top, 'plain'));
  mkdirSync(join(top, 'claude'));
  if (user) writeJson(join(top, 'claude', 'settings.json'), user);
  return { top, app, sub: join(app, 'sub'), worktree: join(top, 'app-wt'), other, plain: join(top, 'plain'), configDir: join(top, 'claude') };
}
