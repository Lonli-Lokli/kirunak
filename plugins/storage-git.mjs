import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import * as g from '../lib/git.mjs';

// The default `storage` (plugins.md §2): files on disk, git for commit, hash and diff.
// The core builds it from the loaded workspace, since repos and the queue are the config's.
export default function storageGit(ws) {
  return {
    name: 'storage-git',
    version: '1',
    provides: {
      storage: {
        repos: () => ws.repos.map(({ name, root }) => ({ name, root })),
        queuePath: () => ws.queue,
        read: (path) => readFileSync(path, 'utf8'),
        write: (path, text) => {
          mkdirSync(dirname(path), { recursive: true });
          writeFileSync(path, text);
        },
        exists: (path) => existsSync(path),
        hash: (path) => 'sha256:' + createHash('sha256').update(readFileSync(path)).digest('hex'),
        commit: (root, paths, message, env) => g.commit(root, paths, message, env),
        head: (root) => g.head(root),
        diff: (root, base, head, exclude) => g.diff(root, base, head, exclude),
        changedSince: (root, sha) => g.changedSince(root, sha),
      },
    },
  };
}
