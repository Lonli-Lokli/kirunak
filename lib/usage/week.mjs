// The limit week (gulnya/k-usage D-2): when the plan's weekly limit resets, as the workspace's `usage.weekStart`
// names it, a weekday and a wall-clock time in a time zone; and the `usage` block's keys, their defaults and check.

const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const DAY = 86_400_000;

// kirunak's own: the week starts Sunday 00:00 UTC, no review folder, no baseline, the limits log in $KIRUNAK_HOME
// (null here, set when the workspace loads), and the stale-session hook at 60 minutes past 150,000 of context.
export const DEFAULT_USAGE = Object.freeze({
  weekStart: Object.freeze({ day: 'sunday', time: '00:00', zone: 'UTC' }),
  reviews: null,
  baseline: null,
  limitsLog: null,
  stale: Object.freeze({ minutes: 60, context: 150_000 }),
});

const show = (v) => JSON.stringify(v) ?? String(v);
const isObject = (v) => v && typeof v === 'object' && !Array.isArray(v);

export function validZone(zone) {
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: zone });
    return typeof zone === 'string' && zone.length > 0;
  } catch {
    return false;
  }
}

// The workspace's `usage` block merged with the defaults: { ...DEFAULT_USAGE, ...own, weekStart, stale merged too }.
export function mergeUsage(own) {
  if (own === undefined) return { ...DEFAULT_USAGE };
  if (!isObject(own)) return own;
  return {
    ...DEFAULT_USAGE,
    ...own,
    weekStart: isObject(own.weekStart) ? { ...DEFAULT_USAGE.weekStart, ...own.weekStart } : own.weekStart ?? DEFAULT_USAGE.weekStart,
    stale: isObject(own.stale) ? { ...DEFAULT_USAGE.stale, ...own.stale } : own.stale ?? DEFAULT_USAGE.stale,
  };
}

// The problems of a merged `usage` block, [] when it passes.
export function checkUsage(u) {
  if (!isObject(u)) return [`usage must be an object such as { weekStart: { day: 'sunday', time: '15:00', zone: 'Europe/London' } }, not ${show(u)}`];
  const out = [];
  const w = u.weekStart;
  if (!isObject(w)) out.push(`usage.weekStart must be { day, time, zone }, not ${show(w)}`);
  else {
    if (!DAYS.includes(w.day)) out.push(`usage.weekStart.day must be one of ${DAYS.join(', ')}, not ${show(w.day)}`);
    if (typeof w.time !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(w.time)) out.push(`usage.weekStart.time must be HH:MM from 00:00 to 23:59, not ${show(w.time)}`);
    if (!validZone(w.zone)) out.push(`usage.weekStart.zone must be a time zone such as 'Europe/London' or 'UTC', not ${show(w.zone)}`);
  }
  for (const k of ['reviews', 'baseline', 'limitsLog']) {
    if (u[k] !== null && (typeof u[k] !== 'string' || !u[k].trim())) out.push(`usage.${k} must be a path or null, not ${show(u[k])}`);
  }
  const s = u.stale;
  if (!isObject(s)) out.push(`usage.stale must be { minutes, context }, not ${show(s)}`);
  else {
    if (typeof s.minutes !== 'number' || !(s.minutes > 0)) out.push(`usage.stale.minutes must be a number of minutes above 0, not ${show(s.minutes)}`);
    if (!Number.isInteger(s.context) || s.context <= 0) out.push(`usage.stale.context must be a whole number of tokens above 0, not ${show(s.context)}`);
  }
  return out;
}

const formats = new Map();
const formatOf = (zone) => {
  if (!formats.has(zone)) {
    formats.set(zone, new Intl.DateTimeFormat('en-GB', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }));
  }
  return formats.get(zone);
};
const partsOf = (t, zone) => Object.fromEntries(formatOf(zone).formatToParts(new Date(t)).map((x) => [x.type, x.value]));
// The zone's offset from UTC at an instant, in ms (to the minute).
const offsetAt = (t, zone) => {
  const p = partsOf(t, zone);
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute) - Math.floor(t / 60_000) * 60_000;
};

// A wall-clock time in a zone as an instant (ms). A time the clocks pass twice is the first of them; a time they skip
// is read with the offset before the change, as the scripts' London reading did (BST first, then GMT, else GMT).
export function zoned(day, hm, zone) {
  const [Y, M, D] = day.split('-').map(Number);
  const [h, m] = hm.split(':').map(Number);
  const guess = Date.UTC(Y, M - 1, D, h, m);
  const offsets = [...new Set([guess - DAY, guess, guess + DAY].map((t) => offsetAt(t, zone)))].sort((a, b) => b - a);
  for (const off of offsets) {
    const t = guess - off;
    const p = partsOf(t, zone);
    if (`${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}` === `${day} ${hm}`) return t;
  }
  return guess - offsetAt(guess - DAY, zone);
}

// The zone's calendar date of an instant, as YYYY-MM-DD.
export const dateIn = (t, zone) => {
  const p = partsOf(t, zone);
  return `${p.year}-${p.month}-${p.day}`;
};
const weekday = (day) => new Date(`${day}T00:00:00Z`).getUTCDay();
const plusDays = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);

// The last limit week finished at `now`: { from, to } as ISO instants, `to` the latest week start at or before now and
// `from` the same weekday and time a week of the zone's calendar before it (169 hours across an autumn clock change).
export function lastWeek(weekStart, now = Date.now()) {
  const { day, time, zone } = weekStart;
  const want = DAYS.indexOf(day);
  for (let i = 0; i < 8; i++) {
    const d = plusDays(dateIn(now, zone), -i);
    if (weekday(d) !== want) continue;
    const t = zoned(d, time, zone);
    if (t <= now) return { from: new Date(zoned(plusDays(d, -7), time, zone)).toISOString(), to: new Date(t).toISOString() };
  }
  throw new Error(`no ${day} ${time} ${zone} in the 8 days before ${new Date(now).toISOString()}`);
}

// The week ending at `to`: from the same weekday and time in the zone a week before.
export function weekTo(weekStart, to) {
  const { time, zone } = weekStart;
  return new Date(zoned(plusDays(dateIn(Date.parse(to), zone), -7), time, zone)).toISOString();
}

// The machine's own zone: kirunak stamps progress.md's step lines in local time (lib/steps.mjs).
export const localZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

// k usage's window from its flags, as weekly.mjs read its arguments: neither, the last finished week; --to alone, the
// week ending then; --from alone, from then to the last week start. Returns { from, to } as ISO instants, or a problem.
export function windowOf(weekStart, { from, to } = {}, now = Date.now()) {
  const iso = (v, flag) => {
    const t = typeof v === 'string' ? Date.parse(v) : NaN;
    if (Number.isNaN(t)) throw new Error(`${flag} must be an instant such as 2026-10-25T14:00:00Z, not ${JSON.stringify(v)}`);
    return new Date(t).toISOString();
  };
  const T = to !== undefined ? iso(to, '--to') : lastWeek(weekStart, now).to;
  const F = from !== undefined ? iso(from, '--from') : to !== undefined ? weekTo(weekStart, T) : lastWeek(weekStart, now).from;
  if (!(F < T)) throw new Error(`--from ${F} is not before --to ${T}`);
  return { from: F, to: T };
}
