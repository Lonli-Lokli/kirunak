#!/usr/bin/env node
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { kirunakHome } from '../lib/home.mjs';
import { TTL, updateSession } from '../lib/keeper.mjs';

// One line in the user's status line command (orchestrator.md §5), fed the same JSON on stdin (statusline.md): it
// writes the session's file, sessions/<session_id>.json, with the last call's context, the model's window, the cache's
// lifetime and expiry and the session's cost, and keeps what `k start` wrote there. It prints nothing, since the
// status line shows what the user's own command prints, and it never fails the status line.

const n = (x) => (Number.isFinite(Number(x)) ? Number(x) : 0);

// fromStatusline(input, now) → { session, patch } or null. The context is the last call's input, cache writes and
// cache reads (statusline.md's used_percentage formula); expires_at is in epoch seconds, and the last call was one
// lifetime before it, since each call that touches the cache starts its lifetime again.
export function fromStatusline(input, now = new Date()) {
  const session = input?.session_id;
  if (typeof session !== 'string' || !session) return null;
  const patch = { kind: 'interactive', seen: now.toISOString() };
  if (typeof input.transcript_path === 'string') patch.transcript = input.transcript_path;
  if (typeof input.model?.id === 'string') patch.model = input.model.id;
  // The model's window, which the compact hook reads before its own table (orchestrator.md §5, R2.4).
  if (Number.isFinite(input.context_window?.context_window_size)) patch.window = input.context_window.context_window_size;
  const u = input.context_window?.current_usage;
  if (u === null) patch.context = null;
  else if (u && typeof u === 'object') patch.context = n(u.input_tokens) + n(u.cache_creation_input_tokens) + n(u.cache_read_input_tokens);
  const pc = input.prompt_cache;
  if (pc && typeof pc === 'object') {
    patch.ttl = TTL[pc.ttl] ? pc.ttl : null;
    patch.warm = pc.warm === true;
    patch.expiresAt = Number.isFinite(pc.expires_at) ? new Date(pc.expires_at * 1000).toISOString() : null;
    if (patch.expiresAt && patch.ttl) patch.lastCall = new Date(pc.expires_at * 1000 - TTL[patch.ttl].minutes * 60000).toISOString();
    if (Number.isFinite(pc.hit_ratio)) patch.hitRatio = pc.hit_ratio;
  }
  if (Number.isFinite(input.cost?.total_cost_usd)) patch.cost = { total_cost_usd: input.cost.total_cost_usd };
  return { session, patch };
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const p = fromStatusline(JSON.parse(readFileSync(0, 'utf8')));
    if (p) updateSession(kirunakHome(), p.session, p.patch);
  } catch {}
  process.exit(0);
}
