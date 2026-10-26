// The seams (plugins.md §2): the functions an implementation must have, and how many may load.
// `one`: a second implementation is an error naming both modules. `many`: merged in load order.
export const SEAMS = {
  checklist: { functions: ['aspects'], policy: 'many' },
  storage: {
    functions: ['repos', 'queuePath', 'read', 'write', 'exists', 'hash', 'commit', 'head', 'diff', 'changedSince'],
    policy: 'one',
  },
  resourceGuard: { functions: ['run', 'status', 'claim', 'release', 'resources'], policy: 'one' },
  machineGuard: { functions: ['limits', 'running'], policy: 'one' },
  runner: { functions: ['start', 'keepAlive'], policy: 'one' },
  handoff: { functions: ['targets', 'release'], policy: 'many' },
  frontend: { functions: ['onChange'], policy: 'many' },
  tracker: { functions: ['push', 'pull'], policy: 'many' },
  sync: { functions: ['pushTask', 'pullTask', 'watch'], policy: 'one' },
  prices: { functions: ['weights'], policy: 'one' },
  worktrees: { functions: ['repos', 'candidates', 'buildOutput'], policy: 'many' },
};
