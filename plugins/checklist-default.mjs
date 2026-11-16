// The core's default `checklist` (plugins.md §2, intake.md §3): what any change to any software can be asked, for a
// workspace whose plugins supply no checklist of their own. Loaded only then (lib/workspace.mjs, `fallback`), so a
// workspace's own aspects are never mixed with these (asilak/kirunak-checklist-default).

const SOURCE = "design/intake.md §3, kirunak's default checklist";

export const ASPECTS = [
  {
    id: 'platforms',
    title: 'Every platform it runs on',
    question: 'Does this change behave the same on every OS, device or runtime the project runs on?',
    edgeCases: [
      'A command, call or signal that one platform does not have',
      'Paths: either separator, letter case, spaces',
      'Line endings: a file checked out with CRLF',
    ],
  },
  {
    id: 'tests',
    title: 'A test that shows it',
    question: 'Which test fails without this change and passes with it, and does it run on every platform?',
    edgeCases: ['A test that never runs on one platform', 'A suite that runs no test and still passes'],
  },
  {
    id: 'data-kept',
    title: 'What the version before wrote',
    question: 'Does everything the version before wrote (files, settings, records) still read after this change?',
    edgeCases: ['A file written by an older version', 'A setting or field the new code no longer knows'],
  },
  {
    id: 'failures',
    title: 'What it relies on fails',
    question: 'What happens when something this change relies on fails or is slow: the network, the disk, another process, a permission?',
    edgeCases: ['A timeout', 'A write cut off halfway', 'A command or permission denied'],
  },
  {
    id: 'concurrency',
    title: 'Two at once',
    question: 'What happens when two run at once: two sessions, processes or users?',
    edgeCases: ['Two writers of one file', 'A holder that died still holding a lock'],
  },
  {
    id: 'security',
    title: 'Secrets, personal data and outside input',
    question: 'Does this change touch secrets, personal data or input that comes from outside?',
    edgeCases: ['A secret written to a log or a commit', 'Outside input run as a command or a path'],
  },
  {
    id: 'docs',
    title: 'What the change makes untrue',
    question: 'Which docs, help text and messages does this change make untrue?',
    edgeCases: ['A doc that still describes the old behaviour', 'An error that names no way out'],
  },
].map((a) => ({ ...a, sources: [SOURCE] }));

export default function checklistDefault() {
  return { name: 'checklist-default', version: '1', provides: { checklist: { aspects: () => ASPECTS } } };
}
