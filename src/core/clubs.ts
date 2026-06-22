/**
 * Club-identity presets — name → authentic palette (+ a crest symbol).
 *
 * Lets the offline designers pick a club's real colours deterministically (zero
 * tokens, zero model calls) instead of guessing from colour words. Matching is a
 * simple case-insensitive substring scan over each club's aliases; the first hit
 * wins, so list more specific aliases first. Pure and DOM-free.
 *
 * Palettes are the design colours only (index 0, the empty seat, is added by the
 * caller). Crests map to a drawable vector SYMBOL the engine can render.
 */

import type { SymbolName } from './tifoSpec';

export interface ClubIdentity {
  /** Lower-case aliases to match in a brief (most specific first). */
  aliases: string[];
  /** Design colours (hex), strongest first; empty seat is prepended by the caller. */
  palette: string[];
  /** A drawable crest symbol for this club. */
  crest: SymbolName;
}

export const CLUBS: ClubIdentity[] = [
  { aliases: ['barcelona', 'barça', 'barca', 'fc barcelona', 'fcb', 'blaugrana'], palette: ['#a50044', '#004d98', '#edbb00'], crest: 'shield' },
  { aliases: ['real madrid', 'madrid', 'los blancos'], palette: ['#febe10', '#00529f', '#ffffff'], crest: 'crown' },
  { aliases: ['atletico', 'atlético', 'atleti'], palette: ['#cb3524', '#ffffff', '#1b2845'], crest: 'shield' },
  { aliases: ['manchester united', 'man united', 'man utd', 'united', 'red devils'], palette: ['#da291c', '#16161a', '#fbe122'], crest: 'shield' },
  { aliases: ['manchester city', 'man city', 'mancity'], palette: ['#6cabdd', '#1c2c5b', '#ffffff'], crest: 'shield' },
  { aliases: ['liverpool', 'lfc', 'the reds'], palette: ['#c8102e', '#00b2a9', '#f6eb61'], crest: 'eagle' },
  { aliases: ['arsenal', 'gunners'], palette: ['#ef0107', '#ffffff', '#063672'], crest: 'shield' },
  { aliases: ['chelsea', 'the blues'], palette: ['#034694', '#ffffff', '#dba111'], crest: 'shield' },
  { aliases: ['tottenham', 'spurs'], palette: ['#ffffff', '#132257'], crest: 'shield' },
  { aliases: ['juventus', 'juve'], palette: ['#16161a', '#ffffff'], crest: 'shield' },
  { aliases: ['ac milan', 'a.c. milan', 'milan', 'rossoneri'], palette: ['#fb090b', '#16161a'], crest: 'shield' },
  { aliases: ['inter milan', 'internazionale', 'inter', 'nerazzurri'], palette: ['#0068a8', '#16161a'], crest: 'shield' },
  { aliases: ['napoli'], palette: ['#12a0d7', '#ffffff'], crest: 'shield' },
  { aliases: ['bayern munich', 'bayern', 'fc bayern'], palette: ['#dc052d', '#0066b2', '#ffffff'], crest: 'shield' },
  { aliases: ['borussia dortmund', 'dortmund', 'bvb'], palette: ['#fde100', '#16161a'], crest: 'shield' },
  { aliases: ['paris saint-germain', 'psg', 'paris'], palette: ['#004170', '#da291c', '#ffffff'], crest: 'shield' },
  { aliases: ['al hilal', 'hilal', 'الهلال'], palette: ['#0033a0', '#ffffff'], crest: 'crescent' },
  { aliases: ['al nassr', 'nassr', 'النصر'], palette: ['#f9d616', '#0d4ea6', '#ffffff'], crest: 'shield' },
  { aliases: ['al ittihad', 'ittihad', 'الاتحاد'], palette: ['#16161a', '#f9d616'], crest: 'shield' },
  { aliases: ['al ahly', 'ahly', 'الأهلي'], palette: ['#c8102e', '#ffffff'], crest: 'eagle' },
  { aliases: ['zamalek', 'الزمالك'], palette: ['#ffffff', '#c8102e'], crest: 'shield' },
];

/** First club whose alias appears in the (lower-cased) brief, or null. */
export function matchClub(lower: string): ClubIdentity | null {
  for (const club of CLUBS) {
    for (const alias of club.aliases) {
      if (lower.includes(alias)) return club;
    }
  }
  return null;
}
