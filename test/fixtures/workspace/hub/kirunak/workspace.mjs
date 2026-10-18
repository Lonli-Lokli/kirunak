// An invented workspace: a weather app and the hub repo that holds the queue.
export default {
  repos: [{ name: 'weather', root: '../../weather' }, { name: 'hub', root: '..' }],
  queue: './queue.md',
  plugins: ['./plugins/checklist.mjs'],
};
