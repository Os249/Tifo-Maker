/**
 * Dev-only: the numbers to check a real ground against its photographs,
 * straight from the seat generator, in a second (no browser).
 *
 *   npx tsx scripts/ground-probe.mts <stadium-id> [rows]
 *
 * Prints the FROZEN fingerprint as verify.mts takes it, the seat count
 * (whole ground and per tier), the number of sections, and for a few rows
 * of each tier the run of seats between gaps along each side - i.e. the
 * seats across every block, as you would count them on a photograph.
 * `rows` is a comma list of tier-local rows (default: first, middle, last).
 * The side split is by the seats' bounding box, so it suits straight
 * stands; on a bowl read the runs as arcs between aisles.
 */
import { createHash } from 'node:crypto';
import { templateById } from '../src/core/stadiumCatalog';
import { generateSeatMap } from '../src/core/seatmap';

const id = process.argv[2];
if (!id) throw new Error('usage: ground-probe.mts <stadium-id> [rows]');
const t = templateById(id);
if (!t) throw new Error(`no such ground: ${id}`);
const m = generateSeatMap(t);

const h = createHash('sha1');
for (const a of [m.xy, m.uv, m.tierOf, m.rowOf, m.sectionOf, m.neighbors, m.mirrorOf]) h.update(Buffer.from(a.buffer, a.byteOffset, a.byteLength));
console.log(`fingerprint  ${m.count}:${h.digest('hex').slice(0, 16)}`);

const perTier = t.tiers.map(() => 0);
let sections = 0;
let maxX = 0;
let maxZ = 0;
let maxY = 0;
for (let i = 0; i < m.count; i++) {
  perTier[m.tierOf[i]]++;
  sections = Math.max(sections, m.sectionOf[i] + 1);
  maxX = Math.max(maxX, Math.abs(m.pos3[i * 3]));
  maxY = Math.max(maxY, m.pos3[i * 3 + 1]);
  maxZ = Math.max(maxZ, Math.abs(m.pos3[i * 3 + 2]));
}
console.log(`seats        ${m.count}  per tier ${perTier.join(' / ')}  sections ${sections}`);
console.log(`extent       x ±${maxX.toFixed(1)}  z ±${maxZ.toFixed(1)}  top seat ${maxY.toFixed(1)} m`);

const before: number[] = [];
let acc = 0;
for (const tier of t.tiers) {
  before.push(acc);
  acc += tier.rows;
}
const sides = [
  ['south', (x: number, z: number) => z < 0 && Math.abs(z) / maxZ > Math.abs(x) / maxX, 0],
  ['north', (x: number, z: number) => z > 0 && Math.abs(z) / maxZ > Math.abs(x) / maxX, 0],
  ['east', (x: number, z: number) => x > 0 && Math.abs(x) / maxX >= Math.abs(z) / maxZ, 2],
  ['west', (x: number, z: number) => x < 0 && Math.abs(x) / maxX >= Math.abs(z) / maxZ, 2],
] as const;
t.tiers.forEach((tier, ti) => {
  const rows = process.argv[3] ? process.argv[3].split(',').map(Number) : [0, Math.floor(tier.rows / 2), tier.rows - 1];
  for (const [name, pick, axis] of sides) {
    for (const row of rows) {
      const xs: number[] = [];
      for (let i = 0; i < m.count; i++) {
        if (m.tierOf[i] !== ti || m.rowOf[i] - before[ti] !== row) continue;
        if (pick(m.pos3[i * 3], m.pos3[i * 3 + 2])) xs.push(m.pos3[i * 3 + axis]);
      }
      if (xs.length < 2) continue;
      xs.sort((a, b) => a - b);
      const gap = tier.seatPitch * 1.6;
      const runs: number[] = [];
      let n = 1;
      for (let k = 1; k < xs.length; k++) {
        if (xs[k] - xs[k - 1] > gap) {
          runs.push(n);
          n = 1;
        } else n++;
      }
      runs.push(n);
      console.log(`tier ${ti} ${name.padEnd(5)} row ${String(row).padStart(2)}  ${runs.join(' | ')}`);
    }
  }
});
