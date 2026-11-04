/**
 * What a club kit and a credit line may hold, in one place for the browser
 * (ui/clubKitStore.ts, ui/creditLine.ts) and the server (server/src/kitRoutes.ts),
 * so the two can never disagree about what is a name, a colour or a credit.
 *
 * Pure: no DOM, no Node. Everything here cleans rather than refuses, except
 * where noted: a name with a control character in it is the same name without
 * it, which is what a person who pasted it meant.
 */

export const MAX_KITS = 3;
export const MAX_KIT_LOGOS = 4;
/** A logo's long side is at most this many pixels when it is kept. */
export const KIT_LOGO_EDGE = 512;
export const KIT_NAME_MAX = 40;
/** The palette holds 256, and index 0 is the empty seat. */
export const MAX_KIT_COLOURS = 255;
/**
 * A logo's PNG on the account is at most this many bytes. A 512 px crest is
 * 20 to 150 KB; a photo-like one that is larger is drawn again smaller by the
 * browser before it is sent (ui/clubKitStore.ts), so nothing a fan made is
 * refused for its size.
 */
export const KIT_LOGO_MAX_BYTES = 400_000;
/** A credit line is a handle or a group's name: at most this many characters. */
export const CREDIT_MAX = 32;

export const KIT_ID = /^k[0-9a-z]{8,32}$/;
const HEX = /^#[0-9a-f]{6}$/i;
/**
 * C0 and C1 controls, zero-width characters, the bidi embeddings, overrides and
 * isolates, and the byte-order mark: nothing a name needs, and the overrides
 * can make a name read backwards beside somebody else's.
 */
const INVISIBLE = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁩﻿]/g;

/** One line of plain text, at most `max` characters (by code point). */
function cleanLine(v: unknown, max: number): string {
  if (typeof v !== 'string') return '';
  const flat = v.replace(INVISIBLE, '').replace(/\s+/g, ' ').trim();
  return Array.from(flat).slice(0, max).join('').trim();
}

/** A kit's name: text only, no control or direction-override characters, one line, at most 40. */
export function cleanName(v: unknown): string {
  return cleanLine(v, KIT_NAME_MAX);
}

/** Valid #rrggbb colours, lower-cased, once each, at most 255. */
export function cleanColours(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const c of v) {
    if (typeof c !== 'string' || !HEX.test(c)) continue;
    const hex = c.toLowerCase();
    if (!out.includes(hex)) out.push(hex);
    if (out.length >= MAX_KIT_COLOURS) break;
  }
  return out;
}

/**
 * A credit line: the fan's handle or group name, as it goes in the corner of
 * an export. One line of text, at most 32 characters, nothing invisible.
 * Angle brackets go too: it is drawn, never parsed, but a credit that reads
 * as markup is not one anybody meant.
 */
export function cleanCredit(v: unknown): string {
  return cleanLine(typeof v === 'string' ? v.replace(/[<>]/g, '') : v, CREDIT_MAX);
}

/** A font id as a kit keeps it: one the pickers know (the caller says which), or ''. */
export function cleanFontId(v: unknown, known: (id: string) => boolean): string {
  return typeof v === 'string' && /^[a-z0-9-]{1,32}$/.test(v) && !v.startsWith('tifo-custom-') && known(v) ? v : '';
}
