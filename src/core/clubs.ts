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
  // ---- Saudi Pro League (listed first — primary audience) ----
  { aliases: ['al hilal', 'alhilal', 'hilal', 'الهلال', 'الزعيم', 'الأزرق'], palette: ['#0033a0', '#ffffff'], crest: 'crescent' },
  { aliases: ['al nassr', 'alnassr', 'nassr', 'النصر', 'العالمي'], palette: ['#f9d616', '#0d4ea6', '#ffffff'], crest: 'shield' },
  { aliases: ['al ittihad', 'alittihad', 'ittihad', 'الاتحاد', 'العميد', 'النمور'], palette: ['#16161a', '#f9d616'], crest: 'shield' },
  { aliases: ['al ahli saudi', 'al ahli', 'ahli jeddah', 'أهلي جدة', 'الأهلي السعودي', 'الأهلي', 'الراقي'], palette: ['#0a7d3e', '#ffffff'], crest: 'shield' },
  { aliases: ['al shabab', 'alshabab', 'shabab', 'الشباب'], palette: ['#ffffff', '#16161a', '#d4af37'], crest: 'shield' },
  { aliases: ['al ettifaq', 'ettifaq', 'الاتفاق'], palette: ['#0a8a3f', '#ffffff'], crest: 'shield' },
  { aliases: ['al fateh', 'الفتح'], palette: ['#7a1f3d', '#ffffff'], crest: 'shield' },
  // ---- Gulf / Arab ----
  { aliases: ['al ain', 'alain', 'العين'], palette: ['#6a1b9a', '#ffffff'], crest: 'shield' },
  { aliases: ['al sadd', 'alsadd', 'السد'], palette: ['#7a1f3d', '#ffffff'], crest: 'shield' },
  { aliases: ['al ahly', 'ahly egypt', 'الأهلي المصري'], palette: ['#c8102e', '#ffffff'], crest: 'eagle' },
  { aliases: ['zamalek', 'الزمالك'], palette: ['#ffffff', '#c8102e'], crest: 'shield' },
  // ---- Europe ----
  { aliases: ['barcelona', 'barça', 'barca', 'fc barcelona', 'fcb', 'blaugrana', 'برشلونة'], palette: ['#a50044', '#004d98', '#edbb00'], crest: 'shield' },
  { aliases: ['real madrid', 'madrid', 'los blancos', 'ريال مدريد'], palette: ['#febe10', '#00529f', '#ffffff'], crest: 'crown' },
  { aliases: ['atletico', 'atlético', 'atleti', 'أتلتيكو'], palette: ['#cb3524', '#ffffff', '#1b2845'], crest: 'shield' },
  { aliases: ['manchester united', 'man united', 'man utd', 'man u', 'red devils', 'مانشستر يونايتد', 'يونايتد'], palette: ['#da291c', '#16161a', '#fbe122'], crest: 'shield' },
  { aliases: ['manchester city', 'man city', 'mancity', 'مانشستر سيتي', 'السيتي'], palette: ['#6cabdd', '#1c2c5b', '#ffffff'], crest: 'shield' },
  { aliases: ['liverpool', 'lfc', 'the reds', 'ليفربول'], palette: ['#c8102e', '#00b2a9', '#f6eb61'], crest: 'eagle' },
  { aliases: ['arsenal', 'gunners', 'أرسنال'], palette: ['#ef0107', '#ffffff', '#063672'], crest: 'shield' },
  { aliases: ['chelsea', 'the blues', 'تشيلسي'], palette: ['#034694', '#ffffff', '#dba111'], crest: 'shield' },
  { aliases: ['tottenham', 'spurs', 'توتنهام'], palette: ['#ffffff', '#132257'], crest: 'shield' },
  { aliases: ['juventus', 'juve', 'يوفنتوس'], palette: ['#16161a', '#ffffff'], crest: 'shield' },
  { aliases: ['ac milan', 'a.c. milan', 'milan', 'rossoneri', 'ميلان'], palette: ['#fb090b', '#16161a'], crest: 'shield' },
  { aliases: ['inter milan', 'internazionale', 'inter', 'nerazzurri', 'انتر'], palette: ['#0068a8', '#16161a'], crest: 'shield' },
  { aliases: ['napoli', 'نابولي'], palette: ['#12a0d7', '#ffffff'], crest: 'shield' },
  { aliases: ['as roma', 'roma', 'روما'], palette: ['#7a1f3d', '#e8a13a'], crest: 'shield' },
  { aliases: ['bayern munich', 'bayern', 'fc bayern', 'بايرن'], palette: ['#dc052d', '#0066b2', '#ffffff'], crest: 'shield' },
  { aliases: ['borussia dortmund', 'dortmund', 'bvb', 'دورتموند'], palette: ['#fde100', '#16161a'], crest: 'shield' },
  { aliases: ['paris saint-germain', 'psg', 'باريس', 'سان جيرمان'], palette: ['#004170', '#da291c', '#ffffff'], crest: 'shield' },
  { aliases: ['ajax', 'اياكس'], palette: ['#c8102e', '#ffffff'], crest: 'shield' },
  { aliases: ['olympique marseille', 'marseille', 'مارسيليا'], palette: ['#2faee0', '#ffffff'], crest: 'shield' },
  { aliases: ['galatasaray', 'galatasary', 'غلطة سراي', 'غلطة'], palette: ['#c8102e', '#f4d03f'], crest: 'shield' },
  { aliases: ['fenerbahce', 'fenerbahçe', 'فنربخشة'], palette: ['#f4d03f', '#10233f'], crest: 'shield' },
  { aliases: ['benfica', 'بنفيكا'], palette: ['#c8102e', '#ffffff'], crest: 'eagle' },
  { aliases: ['fc porto', 'porto', 'بورتو'], palette: ['#0046ad', '#ffffff'], crest: 'shield' },
  { aliases: ['celtic', 'سيلتيك'], palette: ['#018749', '#ffffff'], crest: 'shield' },
  { aliases: ['sevilla', 'إشبيلية'], palette: ['#d81e2c', '#ffffff'], crest: 'shield' },
  // ---- Americas ----
  { aliases: ['boca juniors', 'boca', 'بوكا'], palette: ['#0a3a82', '#f4d03f'], crest: 'shield' },
  { aliases: ['river plate', 'ريفر بليت', 'ريفر'], palette: ['#ffffff', '#c8102e'], crest: 'shield' },
  { aliases: ['flamengo', 'فلامنغو'], palette: ['#c8102e', '#16161a'], crest: 'shield' },
];

/**
 * Latin aliases must sit on word boundaries, so 'inter' stops matching
 * "international friendly". Arabic aliases are matched bare on purpose: Arabic
 * glues prefixes and suffixes straight onto the word (بالهلال, الهلالي), so a
 * boundary rule there would lose real matches rather than false ones.
 */
const ASCII_ONLY = /^[\x00-\x7f]+$/;
const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;
function boundaryOk(lower: string, alias: string, at: number): boolean {
  if (!ASCII_ONLY.test(alias)) return true;
  return !LETTER_OR_DIGIT.test(lower[at - 1] ?? ' ') && !LETTER_OR_DIGIT.test(lower[at + alias.length] ?? ' ');
}

/**
 * The club a (lower-cased) brief names, or null.
 *
 * Ranked over EVERY alias rather than first-club-wins, because alias
 * specificity is what actually decides the answer:
 *   1. earliest position in the brief — "inter milan" beats "milan"
 *   2. then the longest alias         — "الأهلي المصري" beats "الأهلي"
 *
 * The old club-major loop returned the first hit, so a club's position in CLUBS
 * silently decided ties: "inter milan" resolved to AC Milan, "atletico madrid"
 * to Real Madrid, and Egyptian Al Ahly could never win against Saudi Al Ahli.
 * Ranking means adding a club can no longer steal another club's briefs.
 */
export function matchClub(lower: string): ClubIdentity | null {
  let best: ClubIdentity | null = null;
  let bestAt = Infinity;
  let bestLen = 0;
  for (const club of CLUBS) {
    for (const alias of club.aliases) {
      const at = lower.indexOf(alias);
      if (at < 0 || !boundaryOk(lower, alias, at)) continue;
      if (at < bestAt || (at === bestAt && alias.length > bestLen)) {
        best = club;
        bestAt = at;
        bestLen = alias.length;
      }
    }
  }
  return best;
}
