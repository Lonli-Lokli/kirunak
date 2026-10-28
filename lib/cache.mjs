// The workspace's `cache` block (gulnya/k-usage D-6, E-2): the prompt-cache settings settings.json should hold, each
// checked by k doctor only when the block names it. A value is what settings.json must say; null, that the key must be
// absent from it. No block, no check.

// The keys a `cache` block may name, each with the type its value takes.
export const CACHE_KEYS = { promptCacheTtl: 'string', subagentPromptCacheTtl: 'string', syncClaudeAiSkills: 'boolean' };

const show = (v) => JSON.stringify(v) ?? String(v);
const isObject = (v) => v && typeof v === 'object' && !Array.isArray(v);

// The problems of a `cache` block, [] when it passes (undefined and null pass: no block).
export function checkCache(c) {
  if (c === undefined || c === null) return [];
  if (!isObject(c)) return [`cache must be an object such as { promptCacheTtl: '1h', syncClaudeAiSkills: false }, not ${show(c)}`];
  const out = [];
  for (const [key, value] of Object.entries(c)) {
    const type = CACHE_KEYS[key];
    if (!type) out.push(`cache.${key} is not a key kirunak checks (it checks ${Object.keys(CACHE_KEYS).join(', ')})`);
    else if (value !== null && (typeof value !== type || (type === 'string' && !value.trim()))) {
      out.push(`cache.${key} must be a ${type === 'string' ? 'non-empty string' : type} or null (absent from settings.json), not ${show(value)}`);
    }
  }
  return out;
}
