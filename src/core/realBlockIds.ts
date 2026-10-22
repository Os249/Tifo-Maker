/**
 * Which grounds were rebuilt in their real blocks, as plain data: old ground id
 * -> the id of its real-blocks layout (core/realBlocksSaudi.ts).
 *
 * i18n labels both ids with the ground's name, and marks the old one as the
 * earlier layout. It used to read this off SAUDI_REAL_BLOCKS itself, which
 * pulled the geometry builders (realBlocksSaudi, blocks, realBlocks, planCurve
 * and friends, about 47 KB raw) into the translation chunk that every page
 * loads, /legal and /reset included (performance plan P1.15).
 *
 * Kept by hand, so the build checks it: vite.config.ts fails the build when this
 * and SAUDI_REAL_BLOCKS disagree.
 */
export const REAL_BLOCK_IDS: Readonly<Record<string, string>> = {
  'jewel-jeddah-60k': 'jewel-jeddah-60k-rb',
  'alawwal-park-26k': 'alawwal-park-26k-rb',
  'kingdom-arena-26k': 'kingdom-arena-26k-rb',
  'pmbf-stadium-22k': 'pmbf-stadium-22k-rb',
  'pfbf-stadium-22k': 'pfbf-stadium-22k-rb',
  'buraidah-stadium-25k': 'buraidah-stadium-25k-rb',
  'shg-arena-14k': 'shg-arena-14k-rb',
  'ego-stadium-13k': 'ego-stadium-13k-rb',
  'alfateh-stadium-12k': 'alfateh-stadium-12k-rb',
  'abha-stadium-20k': 'abha-stadium-20k-rb',
  'alhazem-stadium-8k': 'alhazem-stadium-8k-rb',
  'tabuk-stadium-12k': 'tabuk-stadium-12k-rb',
  'majmaah-stadium-7k': 'majmaah-stadium-7k-rb',
};
