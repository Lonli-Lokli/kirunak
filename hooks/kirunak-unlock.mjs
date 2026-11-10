#!/usr/bin/env node
import { releaseAll } from '../lib/worktree-lock.mjs';

// SessionEnd, on every end, /clear included (approval.md §4): every worktree of the workspace's repos whose lock names
// the ending session is unlocked, so the next acceptance's removal finds it free. Prints nothing and fails open: a
// lock left behind is lifted once its lease ends.

async function main() {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    return;
  }
  if (typeof input?.session_id === 'string') await releaseAll({ session: input.session_id });
}

main().catch(() => {
  process.exitCode = 0;
});
