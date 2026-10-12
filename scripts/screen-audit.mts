/**
 * Dev-only: where every big screen of every ground stands, and whether it is
 * clear of the seats and can be seen from the pitch.
 *
 *   npx tsx scripts/screen-audit.mts [id ...]   → a table, one line a screen
 *
 * The screen is placed exactly as render/simulator/venue.ts places it
 * (core/screens.ts screenPlacements). Any seat under its footprint is a clash
 * (a screen on a frame stands on legs, so a seat anywhere under it is one);
 * and a screen is hidden when the stand in front of it covers its face as
 * seen from the centre spot.
 */
import { STADIUM_CATALOG, LEGACY_STADIUMS } from '../src/core/stadiumCatalog';
import { generateSeatMap } from '../src/core/seatmap';
import { screenPlacements, screenClearance } from '../src/core/screens';

const want = process.argv.slice(2);
const entries = [...STADIUM_CATALOG, ...LEGACY_STADIUMS].filter((e) => !want.length || want.includes(e.id));
let bad = 0;
for (const e of entries) {
  const t = e.template;
  const boxes = screenPlacements(t);
  if (!boxes.length) continue;
  const m = generateSeatMap(t);
  for (const b of boxes) {
    const c = screenClearance(t, m, b);
    const flag = c.clash > 0 || c.hidden > 0.25 ? 'BAD ' : '    ';
    if (flag.trim()) bad++;
    console.log(
      `${flag}${e.id.padEnd(34)} ${b.kind.padEnd(5)} u=${b.u.toFixed(3)} at (${b.x.toFixed(1)}, ${b.y.toFixed(1)}, ${b.z.toFixed(1)}) ${b.w}x${b.h}` +
        `  seatsUnder=${c.clash} nearest=${c.nearest.toFixed(1)}m hidden=${(c.hidden * 100).toFixed(0)}%${e.meta.supersededBy ? '  (earlier layout)' : ''}`,
    );
  }
}
console.log(bad ? `${bad} screen(s) need fixing` : 'every screen clear');
