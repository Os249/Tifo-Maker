/**
 * Reading numbers out of the environment, safely.
 *
 * Number('"45000"') is NaN, and a quoted value is exactly what a raw env editor
 * invites you to write. NaN then poisons whatever it touches WITHOUT ever
 * looking like a configuration error — the worst kind of bug, because nothing
 * reports it:
 *
 *   setTimeout(abort, NaN)  fires on the next tick, so every model call aborts
 *                           instantly and is reported as a timeout, which the
 *                           user sees as "premium is busy" forever;
 *   count >= NaN            is always false, so a budget cap silently never
 *                           trips;
 *   listen(NaN)             picks an arbitrary port.
 *
 * Every number that comes from the environment goes through here.
 */
export function envNum(name: string, fallback: number, min = 1, max = Number.MAX_SAFE_INTEGER): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  // Tolerate a value the operator quoted; it is unambiguous what they meant.
  const n = Number(raw.trim().replace(/^['"]|['"]$/g, '').trim());
  if (!Number.isFinite(n) || n < min || n > max) return fallback;
  return n;
}
