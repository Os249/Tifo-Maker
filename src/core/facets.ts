import { colorFamily } from './production';
import { CLUBS, matchClub } from './clubs';

/**
 * The things people actually want to filter a feed by.
 *
 * None of them is stored on a design. A design knows its palette and its title;
 * "it is blue" and "it is an Al Hilal tifo" are derived from those, and derived
 * the same way everywhere — which is the whole reason this is one module rather
 * than a rule in the Postgres repo and a different rule in the memory one.
 *
 * Pure, so the same function fills the column on write, backfills the old rows,
 * answers in the in-memory repo, and can be checked in a test.
 */

/**
 * The colour families a filter chip can offer.
 *
 * Coarser than `colorFamily`, deliberately. That returns 'Dark blue', 'Blue' and
 * 'Light blue' as three different answers, which is right for a printing
 * manifest and wrong for a filter: somebody looking for blue tifos wants all
 * three. The shade is dropped and the hue kept.
 */
export const COLOUR_FAMILIES = [
  'red', 'orange', 'yellow', 'green', 'cyan', 'blue', 'purple', 'pink', 'white', 'black', 'grey',
] as const;
export type ColourFamily = (typeof COLOUR_FAMILIES)[number];

/** 'Dark blue' -> 'blue', 'Light grey' -> 'grey'. */
export function colourSlug(family: string): ColourFamily | null {
  const base = family.toLowerCase().replace(/^(dark|light)\s+/, '');
  return (COLOUR_FAMILIES as readonly string[]).includes(base) ? (base as ColourFamily) : null;
}

/**
 * Which colours a design reads as.
 *
 * Index 0 is skipped: it is the empty seat, not a colour anybody chose, and
 * every design in the catalogue would otherwise be tagged dark grey.
 */
export function paletteColours(palette: readonly string[]): ColourFamily[] {
  const out = new Set<ColourFamily>();
  for (let i = 1; i < palette.length; i++) {
    const hex = palette[i];
    if (typeof hex !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(hex)) continue;
    const slug = colourSlug(colorFamily(hex));
    if (slug) out.add(slug);
  }
  // Stable order, so a stored array is comparable and a chip row does not
  // reshuffle between two designs that carry the same colours.
  return COLOUR_FAMILIES.filter((c) => out.has(c));
}

/**
 * A club's stable id: a slug of its first alias, which clubs.ts documents as the
 * canonical name. scripts/verify.mts checks these stay unique, because two clubs
 * sharing an id would silently merge in every filter that uses one.
 */
export function clubId(aliases: readonly string[]): string {
  return aliases[0].normalize('NFKD').replace(/[^a-z0-9؀-ۿ]+/gi, '-').replace(/^-|-$/g, '').toLowerCase();
}

/** Arabic letters, for telling which aliases are the Arabic name. */
const ARABIC = /[\u0600-\u06ff]/;

/**
 * A club's display name, per language.
 *
 * The alias list is a matching vocabulary, not a label: it starts with the Latin
 * canonical name in lower case and carries nicknames in both languages. So the
 * English label is the first alias title-cased, and the Arabic one is the first
 * alias actually written in Arabic — which every club in the list has, and which
 * is the whole reason a reader in Arabic should not be handed "al shabab".
 */
export function clubNames(aliases: readonly string[]): { name: string; nameAr: string } {
  const latin = aliases.find((a) => !ARABIC.test(a)) ?? aliases[0];
  return {
    name: latin.replace(/\b[a-z]/g, (c) => c.toUpperCase()),
    nameAr: aliases.find((a) => ARABIC.test(a)) ?? latin,
  };
}

/** Every club that can be filtered on, in catalogue order. */
export function clubFilterOptions(): { id: string; name: string; nameAr: string; palette: string[] }[] {
  return CLUBS.map((c) => ({ id: clubId(c.aliases), ...clubNames(c.aliases), palette: c.palette }));
}

/**
 * Which club a design is for, from its title.
 *
 * The title is the only honest signal. The library's titles name the club
 * outright ("الاتحاد · أسهم"); a design somebody made and called "derby night"
 * will match nothing, and matching nothing is the correct answer rather than a
 * guess from the palette — half the clubs in the list are blue and white.
 */
export function clubOfTitle(title: string | null | undefined): string | null {
  if (!title) return null;
  const club = matchClub(title.toLowerCase());
  return club ? clubId(club.aliases) : null;
}

export interface DesignFacets {
  colors: ColourFamily[];
  clubId: string | null;
}

export function designFacets(d: { title?: string | null; titleAr?: string | null; palette: readonly string[] }): DesignFacets {
  // Either title may carry the club: the library writes an English title and an
  // Arabic one, and a reader filtering in Arabic should find the same designs.
  return {
    colors: paletteColours(d.palette),
    clubId: clubOfTitle(d.title) ?? clubOfTitle(d.titleAr),
  };
}
