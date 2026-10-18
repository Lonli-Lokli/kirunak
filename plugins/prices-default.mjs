// The core's default `prices` (plugins.md §2): a token's weight in units of one base input token of the reference
// model (Opus). Evidence for the cache ratios: prompt-caching.md (a read 0.1 times the input price, a 5-minute write
// 1.25, a 1-hour write 2). Judgement: output 5 and the model multipliers are the API list prices when this was written.

export const BASE = { input: 1, cacheRead: 0.1, write5m: 1.25, write1h: 2, output: 5 };
export const MULTIPLIERS = [['fable', 2.5], ['opus', 1], ['sonnet', 0.6], ['haiku', 0.2]];

// A model's multiplier, by the family its alias or full name names; 1, the reference, for a name it does not know.
export function multiplier(model) {
  const name = String(model || '').toLowerCase();
  const hit = MULTIPLIERS.find(([family]) => name.includes(family));
  return hit ? hit[1] : 1;
}

export default function pricesDefault() {
  return {
    name: 'prices-default',
    version: '1',
    provides: {
      prices: {
        weights(model) {
          const k = multiplier(model);
          return Object.fromEntries(Object.entries(BASE).map(([field, w]) => [field, w * k]));
        },
      },
    },
  };
}
