/**
 * "Read a photo of the ground" in the Stadium panel's import block: the read,
 * and the line that says what it found.
 *
 * Its own module, loaded on the first photo, because the editor's start chunk
 * is at its ceiling of strings and the words this line needs (seats, straight
 * stands, a photo that is not of a ground) are only ever shown after a read.
 *
 * What comes back is a vote, not an answer, and the line says so: "Seats
 * (3 of 3 readings)" is a different claim from "the AI said", and it is the
 * only one that belongs in a panel built around saying where numbers came
 * from. The selects take what they can hold; the seats' colour, the shape of
 * the stands and open corners have no select, so they are handed back for
 * the build and shown here, the colour as a swatch.
 */
import { readGroundPhoto } from '../net/api';
import type { FactsVote, FieldVote, PhotoKnown } from '../core/photoFacts';
import { t, tv } from './i18n';

/** What the selects cannot hold, for the build. */
export type PhotoExtra = Pick<PhotoKnown, 'seatColours' | 'shape' | 'cornerCut'>;

export interface PhotoRead {
  /** Everything the readings agreed on: the selects take their share of it. */
  known: PhotoKnown;
  extra: PhotoExtra;
  /** The line under the button. */
  note: DocumentFragment;
}

// The reader names its fields after the questions it asks; the template names
// them after the fields they fill. One table, so the two never drift.
const PHOTO_FIELD: Record<string, string> = {
  tiers: 'tiers.length', roof: 'roof.coverage', track: 'track',
  lighting: 'lighting.style', facade: 'facade.style', openCorners: 'cornerCut',
  shape: 'plan.exponent',
};

/** A field's name as the provenance table prints it (ui/stadiumImport), raw if untranslated. */
function fieldLabel(field: string): string {
  const name = PHOTO_FIELD[field] ?? field;
  const label = t('si.f.' + name);
  return label === 'si.f.' + name ? field : label;
}

function agreed(v: FieldVote<unknown> | undefined): string {
  return v ? tv('si.photo.agree', { n: Math.round(v.agreement * v.answered), of: v.samples }) : '';
}

/** Read the photo; throws as readGroundPhoto does (status 429 when the allowance is used). */
export async function readStadiumPhoto(file: File): Promise<PhotoRead> {
  const r = await readGroundPhoto(file);
  const note = document.createDocumentFragment();
  if (r.noGround) {
    note.append(t('qp.noGround'));
    return { known: {}, extra: {}, note };
  }
  const v = r.vote as FactsVote;
  const k = r.known;
  const parts: Array<string | Node> = [];
  const add = (...bits: Array<string | Node>): void => {
    if (parts.length) parts.push(' · ');
    parts.push(...bits);
  };
  if (k.seatColours?.length) {
    const sw = document.createElement('span');
    sw.dataset.tm = 'osm-photo-seat';
    // The swatch IS the reading: the seats' own colour, not a theme colour.
    sw.style.cssText = `display:inline-block;width:9px;height:9px;border-radius:2px;vertical-align:-1px;margin-inline-end:3px;border:1px solid var(--line-1);background:${k.seatColours[0]};`;
    add(sw, `${t('qp.seats')} ${agreed(v.seatColours)}`);
  }
  if (k.shape) add(`${t(k.shape === 'square' ? 'qp.sides.square' : 'qp.sides.round')} ${agreed(v.shape)}`);
  if (k.cornerCut) add(`${fieldLabel('openCorners')} ${agreed(v.openCorners)}`);
  if (k.tiers) add(`${fieldLabel('tiers')} ${agreed(v.tiers)}`);
  if (k.roof) add(`${fieldLabel('roof')} ${agreed(v.roof)}`);
  if (k.hasTrack !== undefined) add(`${fieldLabel('track')} ${agreed(v.track)}`);
  if (k.lighting) add(`${fieldLabel('lighting')} ${agreed(v.lighting)}`);
  if (k.facade) add(`${fieldLabel('facade')} ${agreed(v.facade)}`);
  const unsure = r.dropped.map((d) => (d.field === 'seatColours' ? t('qp.seats') : fieldLabel(d.field)));
  if (parts.length) note.append(`${t('qp.fromPhoto')} `, ...parts);
  else note.append(t('si.photo.nothing'));
  if (unsure.length) note.append(` — ${t('si.photo.unsure')} ${unsure.join(', ')}`);
  return {
    known: k,
    extra: {
      ...(k.seatColours?.length ? { seatColours: k.seatColours } : {}),
      ...(k.shape ? { shape: k.shape } : {}),
      ...(k.cornerCut ? { cornerCut: k.cornerCut } : {}),
    },
    note,
  };
}
