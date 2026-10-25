/**
 * The home page opens on a different club on each visit.
 *
 * The page is for every fan, not one club's, so the hero is not fixed to one:
 * this makes one version of landing.html per hero club, once, at boot, and
 * the home page route sends one of them at random. In each, the club is the
 * same everywhere the page names it before any script runs: the still picture
 * (/hero/<club>.webp and its 640 px copy, scripts/hero-still.mts), the frame's
 * data-club (where src/heroStadium.ts starts the live stadium), the caption
 * (its text, and the keys the page's script re-says it from), the pressed chip
 * and the "Make this tifo" link.
 *
 * It runs once per language (performance plan P3.3): the Arabic home page at
 * /ar/ is built with its words already in Arabic and its links under /ar/, so
 * its caption is written in Arabic here too, never the English title.
 *
 * Every rewrite must match exactly as often as the page has that part. A page
 * that does not (a test build without the hero, or a landing.html changed so
 * that these no longer fit) gets no versions, and is then served as it is,
 * never half rewritten. A club whose caption cannot be said is left out.
 *
 * Pure: strings in, strings out.
 */

export interface HeroClub {
  /** The club id, as the chips' data-club and the start flow know it. */
  club: string;
  /** The caption in English ("Al Hilal at Kingdom Arena"). */
  title: string;
  /** The label key of the club's ground (src/heroGrounds.ts), for the caption's keys. */
  ground?: string;
}

/**
 * Says the caption in the page's language from the chip's club key and the
 * ground's key; absent for English, which uses each club's own title.
 */
export type SayCaption = (clubKey: string, groundKey: string) => string;

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const FRAME = /(<div class="hero-3d still" id="hero-3d") data-club="[a-z0-9-]+"/g;
const STILL = /\/hero\/[a-z0-9-]+?(-640)?\.webp/g;
// The span may carry the keys the page's script re-says it from (P3.3).
const CAPTION = /(<span class="hero-cap-text" id="hero-cap-text"[^>]*>)[^<]*(<\/span>)/g;
const CAPTION_VARS = /data-i18n-vars="club:club\.[A-Za-z0-9]+,ground:stad\.[A-Za-z0-9]+"/;
// The link is /projects on the English page and /ar/projects on the Arabic one.
const MAKE = /(<a class="hero-make" id="hero-make" href="(?:\/ar)?\/projects\?new=1&amp;club=)[a-z0-9-]+"/g;
const CHIP = /<button type="button" class="hero-club(?: on)?" data-club="([a-z0-9-]+)" aria-pressed="(?:true|false)"/g;
const CHIP_KEY = /<button type="button" class="hero-club(?: on)?" data-club="([a-z0-9-]+)" aria-pressed="(?:true|false)" data-i18n="(club\.[A-Za-z0-9]+)"/g;

const count = (html: string, re: RegExp): number => html.match(re)?.length ?? 0;

/**
 * One page per club that both has a hero tifo and a chip on the page, keyed by
 * club. Empty when the page does not have the hero as expected. `say` gives
 * the caption in a language other than English.
 */
export function heroPages(html: string, clubs: readonly HeroClub[], say?: SayCaption): Map<string, string> {
  const out = new Map<string, string>();
  if (count(html, FRAME) !== 1 || count(html, STILL) !== 3 || count(html, CAPTION) !== 1 || count(html, MAKE) !== 1) return out;
  const chips = [...html.matchAll(CHIP)].map((m) => m[1]!);
  if (!chips.length) return out;
  const chipKeys = new Map([...html.matchAll(CHIP_KEY)].map((m) => [m[1]!, m[2]!] as const));
  const captionOpen = html.match(CAPTION)![0];
  const hasVars = CAPTION_VARS.test(captionOpen);
  for (const { club, title, ground } of clubs) {
    if (!/^[a-z0-9-]+$/.test(club) || !chips.includes(club) || out.has(club)) continue;
    const clubKey = chipKeys.get(club);
    const groundKey = ground && /^stad\.[A-Za-z0-9]+$/.test(ground) ? ground : undefined;
    // The keys the script re-says the caption from must name this club, and
    // a page in another language needs them to say it at all.
    if ((hasVars || say) && (!clubKey || !groundKey)) continue;
    let caption = title;
    if (say) {
      try {
        caption = say(clubKey!, groundKey!);
      } catch {
        continue;
      }
      if (!caption.trim()) continue;
    }
    const page = html
      .replace(FRAME, `$1 data-club="${club}"`)
      .replace(STILL, (_m, small: string | undefined) => `/hero/${club}${small ?? ''}.webp`)
      .replace(CAPTION, (_m, open: string, close: string) => {
        const tag = hasVars ? open.replace(CAPTION_VARS, `data-i18n-vars="club:${clubKey},ground:${groundKey}"`) : open;
        return `${tag}${esc(caption)}${close}`;
      })
      .replace(MAKE, `$1${club}"`)
      .replace(CHIP, (_m, id: string) =>
        id === club
          ? `<button type="button" class="hero-club on" data-club="${id}" aria-pressed="true"`
          : `<button type="button" class="hero-club" data-club="${id}" aria-pressed="false"`,
      );
    out.set(club, page);
  }
  return out;
}

/** One of the pages at random, or the page as it is when there are none. */
export function pickHeroPage(pages: Map<string, string>, fallback: string, random: () => number = Math.random): string {
  if (!pages.size) return fallback;
  const all = [...pages.values()];
  return all[Math.min(all.length - 1, Math.floor(random() * all.length))]!;
}
