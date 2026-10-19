#!/usr/bin/env node
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { kirunakHome } from '../lib/home.mjs';
import { readSession, record } from '../lib/keeper.mjs';

// SessionStart on `resume` (orchestrator.md §5, hooks.md): the first request of a resumed interactive session reads
// its cache or writes it again, and this hook records which in keeper.jsonl, from prompt_cache_likely_expired,
// context_tokens and estimated_cache_write_usd. It prints nothing, since a SessionStart hook's output enters the
// conversation, and it never stops a session. Its weight is left to `k keeper report`, which has the prices seam.
// A headless step's resume (a keep-alive, k run's resume) is k run's to record from its run record, so the hook
// records nothing when the step's env names a step or the session's file is a headless one.

// lineFrom(input, known, now) → the keeper.jsonl line, or null for anything but a resume that carries those fields
// (they come only when the transcript holds a response). `known` is the session's file, for its task and lifetime.
export function lineFrom(input, known = null, now = new Date(), env = {}) {
  if (env.KIRUNAK_STEP || known?.kind === 'headless') return null;
  if (input?.source !== 'resume' || typeof input.session_id !== 'string' || !input.session_id) return null;
  if (typeof input.prompt_cache_likely_expired !== 'boolean' || !Number.isFinite(input.context_tokens)) return null;
  const after = Number.isFinite(input.seconds_since_last_response) ? ` ${Math.round(input.seconds_since_last_response / 60)} min after its last response` : '';
  return {
    ts: now.toISOString(),
    session: input.session_id,
    task: known?.task ?? null,
    step: known?.step ?? null,
    kind: input.prompt_cache_likely_expired ? 'miss' : 'hit',
    context: input.context_tokens,
    ttl: known?.ttl ?? null,
    expectedWaitMin: null,
    reason: `resumed${after}`,
    costWeight: null,
    model: typeof input.model === 'string' ? input.model : known?.model ?? null,
    estimatedCacheWriteUsd: Number.isFinite(input.estimated_cache_write_usd) ? input.estimated_cache_write_usd : null,
  };
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const input = JSON.parse(readFileSync(0, 'utf8'));
    const home = kirunakHome();
    const line = lineFrom(input, readSession(home, input?.session_id), new Date(), process.env);
    if (line) record(home, line);
  } catch {}
  process.exit(0);
}
