/**
 * The ultras' grounds of six more countries, as one module: France, Turkey,
 * Morocco, Algeria and Thailand (October 2026, 23 grounds) and Iraq
 * (November 2026, Al-Zawraa's ground, asked for by the club's own ultras),
 * each laid out in its real blocks from the start.
 *
 * One module so the build makes them one script (performance plan P2.7): the
 * editor loads every league, and five scripts of 2-4 KB each cost it more
 * requests than they save a page that shows one of these grounds.
 */
export { LIGUE_1 } from './ligue1';
export { SUPER_LIG } from './superLig';
export { BOTOLA } from './botola';
export { ALGERIA_LIGUE_1 } from './algeriaLigue1';
export { THAI_LEAGUE } from './thaiLeague';
export { IRAQ_STARS_LEAGUE } from './iraqStarsLeague';
