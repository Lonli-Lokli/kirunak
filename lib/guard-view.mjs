// What the workspace's resourceGuard seam says of the machine, for k status, k list and the boards (gulnya/
// one-machine-lock AC-2, AC-4): its status() for the holder and the queue, its resources() for the claims. Whatever
// guard is loaded answers, kirunak's default one or a workspace's own, so these never read a guard's files. A seam that
// does not answer gives nothing invented: no lock, no queue, no claims, and `unanswered` says which call failed and why.
//
// guardView(ws) → { lock, queue, claims, unanswered? }: lock { session, what, since } or null, queue [{ session, what,
// since }] in turn, claims [{ resource, name, state, by?, why? }] of the resources not free.
export async function guardView(ws) {
  const g = ws.seams?.resourceGuard;
  const unanswered = [];
  const ask = async (fn) => {
    try {
      if (typeof g?.[fn] !== 'function') throw new Error('the seam has no such function');
      return await g[fn]();
    } catch (e) {
      unanswered.push(`${fn}(): ${String(e?.message ?? e).split('\n')[0]}`);
      return null;
    }
  };
  const st = await ask('status');
  const res = await ask('resources');
  const out = {
    lock: st?.held ?? null,
    queue: Array.isArray(st?.queued) ? st.queued : [],
    claims: (Array.isArray(res) ? res : []).filter((r) => r && r.state !== 'free').map(({ id, name, state, by, why }) => ({
      resource: id, name: name ?? id, state, ...(by ? { by } : {}), ...(why ? { why } : {}),
    })),
  };
  if (unanswered.length) out.unanswered = `the resource guard did not answer: ${unanswered.join('; ')}`;
  return out;
}
