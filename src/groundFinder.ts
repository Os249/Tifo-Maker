/**
 * The landing's "Is your club's ground here?" search: clubs first (a club is
 * what a fan types), then grounds, each straight into the start flow on that
 * club or ground.
 *
 * Its own module, loaded the first time the box is focused or typed in, with
 * the stadium index it searches (performance plan P2.7). It is the only thing on the landing that names
 * every ground (tl()), so the ground-name labels and the label map, about
 * 7 KB gz of the landing's strings, now arrive with it instead of with the
 * page (performance plan P2.6).
 */
import { CLUB_STARTS, clubColours } from './core/clubGrounds';
import { STADIUM_INDEX } from './core/stadiumIndex';
import { getLang, tl, tv } from './ui/i18n';

export type GroundHit = { href: string; name: string; sub: string; kind: 'club' | 'ground'; colours?: [string, string] | null };

/** Up to five clubs and six grounds matching a lower-cased query. */
export function findGrounds(q: string): GroundHit[] {
  const ar = getLang() === 'ar';
  const short = (id: string): string => tl(id).replace(/\s*[(（][^)）]*[)）]\s*$/, '');
  const clubs: GroundHit[] = CLUB_STARTS.filter((c) => `${c.en} ${c.ar}`.toLowerCase().includes(q)).map((c) => ({
    href: `/projects?new=1&club=${encodeURIComponent(c.id)}`,
    name: ar ? c.ar : c.en,
    sub: short(c.ground),
    kind: 'club',
    colours: clubColours(c),
  }));
  const grounds: GroundHit[] = STADIUM_INDEX.filter(
    (e) => e.meta.source === 'builtin' && `${tl(e.id)} ${e.meta.name} ${(e.meta.tags ?? []).join(' ')} ${e.meta.country ?? ''}`.toLowerCase().includes(q),
  ).map((e) => ({
    href: `/projects?new=1&ground=${encodeURIComponent(e.id)}`,
    name: tl(e.id),
    sub: tv('np.seats', { seats: (e.meta.capacity ?? 0).toLocaleString('en-US') }),
    kind: 'ground',
  }));
  return [...clubs.slice(0, 5), ...grounds.slice(0, 6)];
}
