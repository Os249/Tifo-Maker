/**
 * Tiny debug logger for the Match Day Simulator.
 *
 * On by default during this debugging phase so the console shows what's
 * happening (mount settings, wet-pitch toggles, panel scroll metrics, asset
 * add/remove). Silence it anytime with: localStorage.setItem('mds_debug','0')
 * then reload. All logs are prefixed [MDS] so they're easy to filter.
 */

let on = true;
try {
  if (typeof localStorage !== 'undefined' && localStorage.getItem('mds_debug') === '0') on = false;
} catch {
  /* storage unavailable — keep logging */
}

export function dbg(...args: unknown[]): void {
  if (on) console.log('%c[MDS]', 'color:#3fb950;font-weight:bold', ...args);
}

export function setDebug(v: boolean): void {
  on = v;
}
