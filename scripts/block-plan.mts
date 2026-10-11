/**
 * Dev-only: a ground's blocks seen from above, to lay beside its published
 * block map or an aerial photograph.
 *
 *   npx tsx scripts/block-plan.mts <stadium-id> [out.png] [--side north|south|east|west]
 *     → preview-out/plans/<stadium-id>.png
 *
 * Every seat is a dot, coloured by block in turn so neighbouring blocks never
 * share a colour; each block is labelled at its middle with what the app calls
 * it (its real name, or stand, tier and number — core/blocks sectionInfo).
 * The pitch is drawn for scale, north (the stand opposite the main stand) at
 * the top. `--side` frames one stand, square on, the way a photograph of it is.
 */
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { templateById } from '../src/core/stadiumCatalog';
import { generateSeatMap } from '../src/core/seatmap';
import { sectionInfo } from '../src/core/blocks';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const id = args[0];
if (!id) throw new Error('usage: block-plan.mts <stadium-id> [out.png] [--side north|south|east|west]');
const sideArg = args.includes('--side') ? args[args.indexOf('--side') + 1] : '';
const outArg = args[1] && !args[1].startsWith('--') ? args[1] : '';
const OUT = resolve(ROOT, outArg || `preview-out/plans/${id}${sideArg ? '-' + sideArg : ''}.png`);
mkdirSync(dirname(OUT), { recursive: true });

const t = templateById(id);
if (!t) throw new Error(`no stadium ${id}`);
const m = generateSeatMap(t);
const info = sectionInfo(m, t);

// Seats as [x, z, block] with the block's colour index; labels at block centroids.
const seats: number[] = [];
const sums = new Map<number, { x: number; z: number; n: number }>();
for (let i = 0; i < m.count; i++) {
  const x = m.pos3[i * 3];
  const z = m.pos3[i * 3 + 2];
  const s = m.sectionOf[i];
  seats.push(Math.round(x * 10) / 10, Math.round(z * 10) / 10, s);
  const e = sums.get(s) ?? { x: 0, z: 0, n: 0 };
  e.x += x;
  e.z += z;
  e.n++;
  sums.set(s, e);
}
const labels = [...sums].map(([s, e]) => ({ s, x: e.x / e.n, z: e.z / e.n, t: info.get(s)?.short ?? String(s), n: e.n }));

const W = 1800;
const H = 1300;
const html = `<!doctype html><html><body style="margin:0;background:#fff"><canvas id="c" width="${W}" height="${H}"></canvas><script>
const seats = ${JSON.stringify(seats)};
const labels = ${JSON.stringify(labels)};
const side = ${JSON.stringify(sideArg)};
const c = document.getElementById('c'); const g = c.getContext('2d');
let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
for (let k = 0; k < seats.length; k += 3) {
  const x = seats[k], z = seats[k + 1];
  const keep = !side || (side === 'north' ? z > 0 && Math.abs(z) > Math.abs(x) * 0.5 : side === 'south' ? z < 0 && Math.abs(z) > Math.abs(x) * 0.5 : side === 'east' ? x > 0 && Math.abs(x) > Math.abs(z) : x < 0 && Math.abs(x) > Math.abs(z));
  if (!keep) continue;
  minX = Math.min(minX, x); maxX = Math.max(maxX, x); minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
}
// Square on to the stand: an end is turned so it runs left to right as seen from the pitch.
const rot = side === 'east' ? ([x, z]) => [-z, x] : side === 'west' ? ([x, z]) => [z, -x] : side === 'south' ? ([x, z]) => [-x, -z] : ([x, z]) => [x, z];
let bx0 = Infinity, bx1 = -Infinity, bz0 = Infinity, bz1 = -Infinity;
for (const [x, z] of [[minX, minZ], [minX, maxZ], [maxX, minZ], [maxX, maxZ]].map(rot)) { bx0 = Math.min(bx0, x); bx1 = Math.max(bx1, x); bz0 = Math.min(bz0, z); bz1 = Math.max(bz1, z); }
const pad = 40, sc = Math.min((${W} - 2 * pad) / (bx1 - bx0), (${H} - 2 * pad) / (bz1 - bz0));
// North (+z) at the top.
const P = (x, z) => { const [a, b] = rot([x, z]); return [pad + (a - bx0) * sc, ${H} - pad - (b - bz0) * sc]; };
const pal = ['#1f77b4', '#ff7f0e', '#2ca02c', '#d62728', '#9467bd', '#8c564b', '#e377c2', '#7f7f7f', '#bcbd22', '#17becf'];
if (!side) { g.strokeStyle = '#9c9'; g.lineWidth = 1; const a = P(-52.5, -34), b = P(52.5, 34); g.strokeRect(Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1])); }
const r = Math.max(0.6, sc * 0.22);
for (let k = 0; k < seats.length; k += 3) {
  const [px, pz] = P(seats[k], seats[k + 1]);
  if (px < 0 || px > ${W} || pz < 0 || pz > ${H}) continue;
  g.fillStyle = pal[(seats[k + 2] * 7) % pal.length];
  g.fillRect(px - r, pz - r, 2 * r, 2 * r);
}
g.font = 'bold ' + Math.max(10, Math.min(16, sc * 2.2)) + 'px sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
for (const l of labels) {
  const [px, pz] = P(l.x, l.z);
  if (px < 0 || px > ${W} || pz < 0 || pz > ${H}) continue;
  g.lineWidth = 3; g.strokeStyle = '#fff'; g.strokeText(l.t, px, pz); g.fillStyle = '#000'; g.fillText(l.t, px, pz);
}
g.fillStyle = '#000'; g.font = 'bold 18px sans-serif'; g.textAlign = 'left';
g.fillText(${JSON.stringify(`${t.name} · ${id} · ${m.count.toLocaleString()} seats · ${info.size} blocks`)} + (side ? ' · ' + side + ' stand' : ' · north at the top'), 12, 22);
</script></body></html>`;

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' }).catch(() => chromium.launch());
const page = await browser.newPage({ viewport: { width: W, height: H } });
await page.setContent(html);
await page.waitForTimeout(200);
await page.screenshot({ path: OUT });
await browser.close();
console.log(`${id}: ${m.count} seats, ${info.size} blocks → ${OUT}`);
