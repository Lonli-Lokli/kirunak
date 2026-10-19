// cost.md (orchestrator.md §6): the rendering of done.json's `cost`, the numbers k accept recorded, and of nothing
// else, so one done.json always gives one file. `k cost <id> --write` writes it; the git hook refuses any other text.
// No imports: the pre-commit hook loads this file.

export const big = (x) => (x >= 1e4 ? x.toExponential(2).replace('e+', 'e') : String(Math.round(x)));
export const tokens = (x) => (x == null ? '-' : Math.round(x).toLocaleString('en-US'));
export const usd = (x) => x.toFixed(2);

export function costMarkdown(id, cost) {
  const out = [`# Cost of ${id}`, ''];
  if (cost?.error != null) return [...out, `The cost could not be read when the task was accepted: ${cost.error}`, ''].join('\n');
  out.push(`Generated from done.json's \`cost\`, the numbers \`k cost ${id}\` read from the run records when the task was accepted (\`k cost ${id} --write\` writes this file again). Weight is in base input tokens of the reference model, money at list price.`, '');
  const row = (name, x) => `| ${name} | ${big(x.weight)} | ${usd(x.usd)} | ${x.calls} | ${x.runs} | ${tokens(x.medianContext)} |`;
  if (cost.steps.length) {
    out.push('| Step | Weight | USD | Calls | Runs | Median context |', '| --- | ---: | ---: | ---: | ---: | ---: |');
    for (const s of cost.steps) out.push(row(s.step, s));
    out.push(row('All', cost.total));
  } else out.push('No run record was found.');
  out.push('', `Keep-alives ${cost.keeper.keepalives}, misses ${cost.keeper.misses}.`);
  if (cost.interactive.sessions) out.push(`Interactive sessions ${cost.interactive.sessions}, ${usd(cost.interactive.usd)} USD.`);
  if (cost.comparisons.length) out.push('', '## Against the baseline', '', ...cost.comparisons.map((x) => `- ${x}`));
  return out.join('\n') + '\n';
}
