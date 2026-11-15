/**
 * "Without the tifomaker.org mark", for a Pro member: on until they say
 * otherwise.
 *
 * Found on 14 Nov 2026 by exporting as a member: every "without the mark"
 * tick (the stadium export, Post it, Match Day) started unticked, so a member
 * who had paid for "no mark on any export" got the mark on their first video
 * unless they found a small checkbox, and again on every visit. A perk a
 * member has to switch on each time is a perk half delivered.
 *
 * So while Pro runs (a month of Pro, or the gift running) the ticks start
 * ticked, and a member who wants the mark back unticks it once: that choice
 * is kept in this browser and holds for all three places. An account without
 * Pro is what it always was: unticked, free to try, the export sheet at
 * export; nothing is remembered for it.
 *
 * Like the rest of Pro in the interface this shows and asks; it decides
 * nothing that costs money. No strings of its own.
 */
const KEY = 'tifo_pro_nomark_v1';

/** Whether a tick should start ticked: Pro is running and the member has not asked for the mark back. */
export function cleanByDefault(running: boolean): boolean {
  if (!running) return false;
  try {
    return localStorage.getItem(KEY) !== '0';
  } catch {
    return true;
  }
}

/** A member ticked or unticked it: the same in the other two places, and next time. */
export function rememberClean(running: boolean, clean: boolean): void {
  if (!running) return;
  try {
    localStorage.setItem(KEY, clean ? '1' : '0');
  } catch {
    /* private mode: the choice lasts the visit */
  }
}

/** Whether /api/pro's answer is a member's: Pro on for the account, and a plan that is not free. */
export function proIsRunning(st: { live?: boolean; plan?: string | null } | null | undefined): boolean {
  return !!st?.live && !!st.plan && st.plan !== 'free';
}
