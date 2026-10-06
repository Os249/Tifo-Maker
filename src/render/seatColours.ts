import type { SeatMap, StadiumTemplate } from '../core/types';
import { seatZones } from '../core/venueDetails';
import { seatLookMap } from './simulator/seatLook';

/**
 * What every seat looks like with nobody's card on it: the ground's own seat
 * colour, as you would see it on a non-match day.
 *
 * One RGB triple (0..255, sRGB) per seat, worked out once per ground. The
 * Stadium view paints its chairs from this; a seat that is part of the tifo
 * shows a card above its chair instead.
 *
 * The rules are Match Day's (MatchDaySimulator.colorFor with the tifo taken
 * off), in the same order, so a seat is the same colour in both views:
 *
 *   1. the old Jewel's gold royal tribune (al-manassa);
 *   2. premium zones: gold, silver and VIP cream leather;
 *   3. the template's own seatLook (club colour, mosaic, regions, letters);
 *   4. the grounds whose seats were set by hand before seatLook existed;
 *   5. anything else (a user's own stadium): a weathered charcoal mix, the
 *      commonest real seat there is.
 *
 * If Match Day's hand-set colours change, change them here too.
 */

const JEWEL_ID = 'jewel-jeddah-60k';
const KINGDOM_ID = 'kingdom-arena-26k';
const OLD_JEWEL_ID = 'community-jewel-jeddah-62k';
const OLD_ALAWWAL_ID = 'community-alawwal-park-25k';
const OLD_KINGDOM_ID = 'community-kingdom-arena-28k';

const ZONE_COLOURS = [
  [],
  [0xc9a13a, 0xd6b04a, 0xb88f2c], // gold
  [0x9ea4ad, 0x8e959f, 0xaeb4bc], // silver
  [0xe7d6b0, 0xdccaa2], // VIP cream leather
];
const JEWEL_TIERS = [
  [0xb3261e, 0xc8322a, 0x9e1f1a, 0xd04a2a, 0xbf2f24, 0xe0622e],
  [0xd4502a, 0xe0662e, 0xc9442a, 0xe8834a, 0xd95c30],
  [0xe8804a, 0xf09a60, 0xe36f3a, 0xf2b07a, 0xeb8e55],
];
const OLD_JEWEL = [0x8f2d2d, 0xb14a2a, 0xc98a4b, 0x6f2222, 0xd8b98a, 0xa33b2b];
const OLD_ALAWWAL = [0xf2c40f, 0xe8bd10, 0xf5cd2a, 0xd9ae0c, 0xf7d43a, 0xf2c40f, 0xefc200];
const OLD_ALAWWAL_BLUE = 0x15245e;
const KINGDOM_NAVY = [0x172046, 0x1b264f, 0x141c3e, 0x1f2d62, 0x182349, 0x24346f];
const OLD_KINGDOM = [0x1c2a5e, 0x2b4a9c, 0xe8ecf6, 0x24377a, 0xd8deea, 0x1c3a8a, 0x203a72];
const MANASSA = 0xc69a3a;
/** A user's own stadium: charcoal seats, a few lighter where the sun has had them. */
const FALLBACK = [0x3d424a, 0x434851, 0x393e45, 0x4a5059];

/** Match Day's pick: the same seat always draws the same entry. */
const pickOf = (i: number, n: number): number => (Math.imul(i, 2654435761) >>> 0) % n;

function put(out: Uint8Array, i: number, hex: number): void {
  out[i * 3] = (hex >> 16) & 255;
  out[i * 3 + 1] = (hex >> 8) & 255;
  out[i * 3 + 2] = hex & 255;
}

/** The old Jewel's royal tribune: West stand centre, the lower two tiers. */
function inManassa(map: SeatMap, i: number): boolean {
  const u = (((map.uv[i * 2] + 0.125) % 1) + 1) % 1;
  const s = u * 4;
  const stand = Math.floor(s);
  const frac = s - stand;
  return stand === 2 && map.tierOf[i] <= 1 && frac > 0.34 && frac < 0.66;
}

export function emptySeatColours(template: StadiumTemplate | null, map: SeatMap): Uint8Array {
  const n = map.count;
  const out = new Uint8Array(n * 3);
  if (!template) {
    for (let i = 0; i < n; i++) put(out, i, FALLBACK[pickOf(i, FALLBACK.length)]);
    return out;
  }
  const id = template.id;
  const zones = template.details?.zones?.length ? seatZones(map, template) : null;
  const look = seatLookMap(template, map);
  const lookHex = look ? look.colors.map((h) => parseInt(h.replace('#', ''), 16)) : [];
  for (let i = 0; i < n; i++) {
    if (id === OLD_JEWEL_ID && inManassa(map, i)) {
      put(out, i, MANASSA);
      continue;
    }
    const zone = zones ? zones[i] : 0;
    if (zone) {
      const zc = ZONE_COLOURS[zone];
      put(out, i, zc[pickOf(i, zc.length)]);
      continue;
    }
    if (look) {
      put(out, i, lookHex[look.index[i]]);
      continue;
    }
    let hex: number;
    if (id === JEWEL_ID) {
      const tc = JEWEL_TIERS[Math.min(map.tierOf[i], JEWEL_TIERS.length - 1)];
      hex = tc[pickOf(i, tc.length)];
    } else if (id === OLD_JEWEL_ID) hex = OLD_JEWEL[pickOf(i, OLD_JEWEL.length)];
    else if (id === OLD_ALAWWAL_ID) hex = map.rowOf[i] < 4 ? OLD_ALAWWAL_BLUE : OLD_ALAWWAL[pickOf(i, OLD_ALAWWAL.length)];
    else if (id === KINGDOM_ID) hex = KINGDOM_NAVY[pickOf(i, KINGDOM_NAVY.length)];
    else if (id === OLD_KINGDOM_ID) hex = OLD_KINGDOM[pickOf(i, OLD_KINGDOM.length)];
    else hex = FALLBACK[pickOf(i, FALLBACK.length)];
    put(out, i, hex);
  }
  return out;
}
