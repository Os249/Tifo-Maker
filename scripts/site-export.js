/**
 * Dev-only, run in a browser console on https://overpass-api.de/ (same origin,
 * so the query needs no CORS): fetches one real ground's OpenStreetMap
 * neighbourhood and returns the raw file scripts/site-import.mts reads.
 *
 *   await SITE_EXPORT({ key: 'alawwal', template: 'alawwal-park-26k',
 *                       lat: 24.72929, lon: 46.62372, main: 265, radius: 520 })
 *
 * `lat`/`lon` is the centre spot and `main` the bearing (degrees clockwise
 * from north) from it to the main stand. Coordinates come back as metres east
 * and north of the centre spot, in decimetres. The data is © OpenStreetMap
 * contributors, under the ODbL.
 */
window.SITE_EXPORT = async ({ key, template, lat, lon, main, radius = 520, twist, shift, style }) => {
  const R = radius + 40;
  const q = `[out:json][timeout:120];(
    way["highway"](around:${R},${lat},${lon});
    way["building"](around:${R},${lat},${lon});
    way["amenity"="parking"](around:${R},${lat},${lon});
    way["leisure"~"^(pitch|park|garden|playground|track|swimming_pool)$"](around:${R},${lat},${lon});
    way["landuse"~"^(grass|meadow|recreation_ground|farmland|orchard|plant_nursery|construction|brownfield|village_green)$"](around:${R},${lat},${lon});
    way["landuse"="residential"](around:${R},${lat},${lon});
    way["natural"~"^(water|sand|bare_rock|scrub|wood|tree_row)$"](around:${R},${lat},${lon});
    way["place"="square"](around:${R},${lat},${lon});
    way["barrier"~"^(wall|fence)$"](around:${R},${lat},${lon});
    node["natural"="tree"](around:${R},${lat},${lon});
    node["amenity"="place_of_worship"](around:${R},${lat},${lon});
  );out tags geom;`;
  let j = null;
  for (let k = 0; k < 6 && !j; k++) {
    const r = await fetch('/api/interpreter', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'data=' + encodeURIComponent(q) });
    const t = await r.text();
    if (t[0] === '{') j = JSON.parse(t);
    else for (let w = 0; w < 8; w++) await fetch('/api/status');
  }
  if (!j) throw new Error('overpass failed');
  const kx = 111320 * Math.cos((lat * Math.PI) / 180);
  const ky = 110574;
  const en = (g) => [Math.round((g.lon - lon) * kx * 10), Math.round((g.lat - lat) * ky * 10)];
  const KEEP = ['highway', 'lanes', 'width', 'oneway', 'area', 'tunnel', 'indoor', 'building', 'building:levels', 'height', 'amenity', 'religion', 'leisure', 'sport', 'landuse', 'natural', 'water', 'place', 'barrier'];
  const f = [];
  for (const e of j.elements) {
    const tags = {};
    for (const k of KEEP) if (e.tags && e.tags[k] !== undefined) tags[k] = e.tags[k];
    if (e.type === 'node') {
      f.push([e.tags.natural === 'tree' ? 't' : 'm', tags, en(e)]);
      continue;
    }
    if (!e.geometry) continue;
    // Dense English streets: drop the vertices a building does not need
    // (closer than 0.4 m to the line through its neighbours), which halves
    // the file without moving a wall.
    let geom = e.geometry;
    if (style === 'uk' && geom.length > 4) {
      const pts = geom.map(en);
      const keep = [pts[0]];
      for (let i = 1; i < pts.length - 1; i++) {
        const [ax, ay] = keep[keep.length - 1];
        const [bx, by] = pts[i + 1];
        const [px, py] = pts[i];
        const L = Math.hypot(bx - ax, by - ay) || 1;
        if (Math.abs((bx - ax) * (ay - py) - (ax - px) * (by - ay)) / L > 4) keep.push(pts[i]);
      }
      keep.push(pts[pts.length - 1]);
      f.push([e.tags.highway && !e.tags.building ? 'h' : e.tags.building ? 'b' : e.tags.amenity === 'parking' ? 'p' : e.tags.landuse === 'residential' ? 'lr' : e.tags.barrier || e.tags.natural === 'tree_row' ? (e.tags.natural === 'tree_row' ? 'tr' : 'w') : 'a', Object.fromEntries(KEEP.filter((k) => e.tags[k] !== undefined).map((k) => [k, e.tags[k]])), keep.flat()]);
      continue;
    }
    const flat = geom.flatMap(en);
    const t = e.tags;
    const kind = t.highway && !t.building ? 'h'
      : t.building ? 'b'
      : t.amenity === 'parking' ? 'p'
      : t.landuse === 'residential' ? 'lr'
      : t.barrier || t.natural === 'tree_row' ? (t.natural === 'tree_row' ? 'tr' : 'w')
      : 'a';
    f.push([kind, tags, flat]);
  }
  return { key, template, main, twist, shift, radius, ...(style ? { style } : {}), date: new Date().toISOString().slice(0, 10), f };
};
