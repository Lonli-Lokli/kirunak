// An invented checklist: what the weather workspace's rules ask of every change.
const aspects = [
  {
    id: 'platforms',
    title: 'Every platform the app ships on',
    question: 'Does this change behave the same on every platform the app ships on?',
    edgeCases: ['An API missing on the oldest supported version'],
    sources: ['docs/platforms.md'],
    appliesWhen: () => true,
  },
  {
    id: 'large-text',
    title: 'The largest system text size',
    question: 'Does this change touch a screen that must hold at the largest text size?',
    edgeCases: ['A row that clips', 'A button under the touch-target minimum'],
    sources: ['docs/accessibility.md'],
    appliesWhen: (task) => /screen|button|row/i.test(task?.text || ''),
  },
  {
    id: 'offline',
    title: 'Works with no network',
    question: 'Does this change keep working with no network?',
    edgeCases: ['A feature that reaches a server'],
    sources: ['docs/offline.md'],
  },
];

export default { name: 'weather-checklist', version: '1', provides: { checklist: { aspects: () => aspects } } };
