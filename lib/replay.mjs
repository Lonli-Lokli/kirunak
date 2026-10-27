import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { kept } from './records.mjs';

// What a commit made inside a replay stages of its own, for AC-8 (approval.md §3; the task
// gulnya/kirunak-accept-shared-repo, steps/S-16/design.md §1, measured on git 2.54). A merge's own change is the staged
// tree against the join git alone makes; a pick git is making, with git's message, owns what it stages beyond the pick
// git alone makes. Anything else made while a replay is in progress (`-n`, a revert, a squash or fixup, an edit stop,
// a squash merge, a stale MERGE_MSG) is the user's commit, judged whole. An ordinary commit pays a few file reads here
// and no git call.

const read = (file) => {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
};

// The replay in progress in a worktree's git folder: { mergeHeads, pick, gitMessage }. mergeHeads is MERGE_HEAD's
// lines (two or more: an octopus), null with no merge; pick is CHERRY_PICK_HEAD (git's pick, a rebase's among them),
// else a rebase stopped on a conflict (`rebase-merge/stopped-sha` beside MERGE_MSG, without the `amend` an edit stop
// leaves), null with none; gitMessage is the message git wrote for it, MERGE_MSG, else `rebase-merge/message`.
export function replayState(gitDir) {
  const merge = read(join(gitDir, 'MERGE_HEAD'));
  const mergeHeads = merge ? merge.split('\n').map((l) => l.trim()).filter(Boolean) : null;
  let pick = read(join(gitDir, 'CHERRY_PICK_HEAD'))?.trim() || null;
  if (!pick && !mergeHeads && existsSync(join(gitDir, 'rebase-merge', 'stopped-sha')) && existsSync(join(gitDir, 'MERGE_MSG')) &&
    !existsSync(join(gitDir, 'rebase-merge', 'amend'))) pick = read(join(gitDir, 'rebase-merge', 'stopped-sha'))?.trim() || null;
  const gitMessage = mergeHeads?.length || pick ? read(join(gitDir, 'MERGE_MSG')) ?? read(join(gitDir, 'rebase-merge', 'message')) : null;
  return { mergeHeads: mergeHeads?.length ? mergeHeads : null, pick, gitMessage };
}

// Whether `message` is the one git wrote: both read as git's strip cleanup reads them whatever commit.cleanup says,
// since the editor's status block and a conflict's `# Conflicts:` lines are git's words too (`cfg` is commitConfig's).
export function sameAsGit(message, gitMessage, cfg = {}) {
  if (gitMessage == null) return false;
  const text = (t) => kept(t, {}, { ...cfg, cleanup: 'strip' }).split('\n').map((l) => l.trimEnd()).join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return text(message) === text(gitMessage);
}

// The tree `git merge-tree --write-tree <args>` makes in the repo at `top`; null on a conflict (exit 1) or when it
// fails, such as a git older than 2.38.
export function mergeTree(top, args) {
  try {
    const out = execFileSync('git', ['merge-tree', '--write-tree', ...args], { cwd: top, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return /^[0-9a-f]{40,64}$/.test(out.split('\n')[0]) ? out.split('\n')[0] : null;
  } catch {
    return null;
  }
}

// The join git alone makes of HEAD and the merge heads: for one, merge-tree's; for an octopus, each head joined in turn
// onto the join so far, as git's octopus strategy does, each join but the last made a commit (`git commit-tree`, left
// dangling for git's gc) so the next one finds its merge base (gulnya/accept-merge-gaps). Null on any conflict, where
// git's octopus stops too, or when a call fails.
function joinTree(top, heads) {
  let at = 'HEAD';
  for (const [i, h] of heads.entries()) {
    const tree = mergeTree(top, [at, h]);
    if (!tree || i === heads.length - 1) return tree;
    try {
      at = execFileSync('git', ['commit-tree', '--no-gpg-sign', tree, '-p', at, '-p', h, '-m', 'kirunak: a join of an octopus'], { cwd: top, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, ...JOIN_IDENT } }).trim();
    } catch {
      return null;
    }
  }
  return null;
}
// The join commits' author and committer, so they need no identity of the user's and the same join is the same object.
const JOIN_IDENT = { GIT_AUTHOR_NAME: 'kirunak', GIT_AUTHOR_EMAIL: 'kirunak@localhost', GIT_AUTHOR_DATE: '@0 +0000', GIT_COMMITTER_NAME: 'kirunak', GIT_COMMITTER_EMAIL: 'kirunak@localhost', GIT_COMMITTER_DATE: '@0 +0000' };

// What the commit's paths are judged against (S-16 design §1.3): for a merge, the join git alone makes of HEAD and its
// heads, an octopus's too; for git's pick with git's message, the pick of `<sha>^..<sha>` onto HEAD; else `whole`, the
// base an ordinary commit has. Null when nothing can be verified (a conflict, an old git): the commit passes AC-8.
export function ownBase(info, message, whole, cfg = {}, state = replayState(info.gitDir)) {
  if (state.mergeHeads) return joinTree(info.top, state.mergeHeads);
  if (state.pick && sameAsGit(message, state.gitMessage, cfg)) return mergeTree(info.top, ['--merge-base', `${state.pick}^`, 'HEAD', state.pick]);
  return whole;
}
