/**
 * Dev-only, for the Pro film and poster shot harnesses: a test tifo the way
 * a real one is drawn (a field, a sash, a disc and a word), on ONE stand of a
 * ground as a fan sees it: behind a goal (0 east, 2 west) or along a side
 * (1 north, 3 south), by where the seats are, so a tifo never wraps round a
 * corner into the next stand. Read left to right from across the pitch.
 *
 *   small   the middle third of the stand, its middle rows, the word "GO";
 *   medium  the middle two thirds, every row, "FORZA";
 *   large   the whole stand, "FORZA".
 */
export function paintTifo(map, stand, size) {
  const span = size === 'small' ? [0.34, 0.66] : size === 'medium' ? [0.17, 0.83] : [0.02, 0.98];
  const rows = size === 'small' ? [0.25, 0.85] : [0, 1];
  const word = document.createElement('canvas');
  word.width = 400;
  word.height = 200;
  const g = word.getContext('2d');
  g.fillStyle = '#000';
  g.fillRect(0, 0, 400, 200);
  g.fillStyle = '#fff';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  const text = size === 'small' ? 'GO' : 'FORZA';
  g.font = '900 120px Arial Black, sans-serif';
  // Inside the tifo, with a margin: a word cut by its own edges reads as a framing fault.
  const fitW = g.measureText(text).width;
  if (fitW > 340) g.font = `900 ${Math.floor((120 * 340) / fitW)}px Arial Black, sans-serif`;
  g.fillText(text, 200, 108);
  const px = g.getImageData(0, 0, 400, 200).data;
  // Which stand a seat is in, and how far across it (left to right from the far side).
  const where = (i) => {
    const x = map.pos3[i * 3];
    const z = map.pos3[i * 3 + 2];
    // Behind a goal: past the goal line, and between the corner flags' lines.
    if (Math.abs(x) > 54 && Math.abs(z) < 38) return stand === 0 && x > 0 ? z : stand === 2 && x < 0 ? -z : null;
    // Along a side: past the touchline, and between the goal lines.
    if (Math.abs(z) > 35 && Math.abs(x) < 52) return stand === 1 && z > 0 ? -x : stand === 3 && z < 0 ? x : null;
    return null;
  };
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < map.count; i++) {
    const a = where(i);
    if (a === null) continue;
    lo = Math.min(lo, a);
    hi = Math.max(hi, a);
  }
  const cells = new Uint8Array(map.count);
  for (let i = 0; i < map.count; i++) {
    const a = where(i);
    if (a === null) continue;
    const across = (a - lo) / (hi - lo);
    if (across < span[0] || across > span[1]) continue;
    const v = map.uv[i * 2 + 1];
    if (v < rows[0] || v > rows[1]) continue;
    const x = (across - span[0]) / (span[1] - span[0]);
    const y = 1 - (v - rows[0]) / (rows[1] - rows[0]);
    let c = 1;
    if (Math.abs(x - y) < 0.12) c = 3;
    const dx = (x - 0.5) * 2;
    const dy = (y - 0.5) * 2 * 0.6;
    if (dx * dx + dy * dy < 0.18) c = 4;
    if (px[(Math.floor(y * 199) * 400 + Math.floor(x * 399)) * 4] > 128) c = 2;
    cells[i] = c;
  }
  return cells;
}
