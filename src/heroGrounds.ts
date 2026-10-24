/**
 * The label key of each landing-hero tifo's ground (src/data/heroTifos.json).
 *
 * The caption under the hero names the ground. With tl() that meant the whole
 * ground-name map and every ground's name in two languages at the landing's
 * start, about 6.5 KB gz, for the five grounds the hero can show. Naming their
 * keys here brings only those strings (performance plan P2.6). The build checks
 * this against ui/i18n/maps.ts for every tifo in heroTifos.json (vite.config.ts),
 * so a new hero tifo or a renamed ground cannot leave a caption untranslated.
 */
export const HERO_GROUND_KEYS: Readonly<Record<string, string>> = {
  'jewel-jeddah-60k-rb': 'stad.jewelJeddah',
  'kingdom-arena-26k-rb': 'stad.kingdomArena',
  'alawwal-park-26k-rb': 'stad.alAwwal',
  'bernabeu-83k': 'stad.bernabeu',
  'anfield-61k': 'stad.anfield',
};
