/**
 * Clubs and their home grounds: the first question a new tifo asks.
 *
 * A fan does not think "I want a 26,000-seat arena"; they think "I support Al
 * Hilal". So the start flow (ui/createProject.ts) asks for the club and puts
 * them in its home ground, in its colours, and only asks about grounds when
 * there is no club or the fan wants another one.
 *
 * Each ground here is in the catalogue (core/stadiumCatalog.ts), whose tags and
 * notes already say whose home it is; this list is that knowledge turned the
 * other way round. Colours come from core/clubs.ts, the same identities the
 * offline designer paints with, so a club's start and its "club tifo" agree.
 * A club with no entry there has no colours here either: its fans pick them,
 * rather than being handed a guess.
 *
 * Pure and DOM-free.
 */
import { matchClub } from './clubs';

export interface ClubStart {
  /** Stable id, for remembering the last club picked. */
  id: string;
  en: string;
  ar: string;
  /** The catalogue id of its home ground. */
  ground: string;
  /** The league tag the ground carries (stadiumCatalog LEAGUES). */
  league: string;
  /**
   * The word for the stand, when the full name is too long to read across a
   * bowl ("UNITED", not "MANCHESTER UNITED"). Defaults to the name.
   */
  word?: string;
}

/**
 * Saudi clubs first: they are most of the audience. Where two clubs share a
 * ground (Al Ahli and Al Ittihad), each is listed with it.
 */
export const CLUB_STARTS: ClubStart[] = [
  { id: 'hilal', en: 'Al Hilal', ar: 'الهلال', ground: 'kingdom-arena-26k-rb', league: 'saudi-pro-league' },
  { id: 'nassr', en: 'Al Nassr', ar: 'النصر', ground: 'alawwal-park-26k-rb', league: 'saudi-pro-league' },
  { id: 'ittihad', en: 'Al Ittihad', ar: 'الاتحاد', ground: 'jewel-jeddah-60k-rb', league: 'saudi-pro-league' },
  { id: 'ahli', en: 'Al Ahli', ar: 'الأهلي', ground: 'jewel-jeddah-60k-rb', league: 'saudi-pro-league' },
  { id: 'shabab', en: 'Al Shabab', ar: 'الشباب', ground: 'shg-arena-14k-rb', league: 'saudi-pro-league' },
  { id: 'ettifaq', en: 'Al Ettifaq', ar: 'الاتفاق', ground: 'ego-stadium-13k-rb', league: 'saudi-pro-league' },
  { id: 'fateh', en: 'Al Fateh', ar: 'الفتح', ground: 'alfateh-stadium-12k-rb', league: 'saudi-pro-league' },
  { id: 'qadsiah', en: 'Al Qadsiah', ar: 'القادسية', ground: 'pmbf-stadium-22k-rb', league: 'saudi-pro-league' },
  { id: 'khaleej', en: 'Al Khaleej', ar: 'الخليج', ground: 'pmbf-stadium-22k-rb', league: 'saudi-pro-league' },
  { id: 'taawoun', en: 'Al Taawoun', ar: 'التعاون', ground: 'buraidah-stadium-25k-rb', league: 'saudi-pro-league' },
  { id: 'riyadh', en: 'Al Riyadh', ar: 'الرياض', ground: 'pfbf-stadium-22k-rb', league: 'saudi-pro-league' },
  { id: 'neom', en: 'NEOM', ar: 'نيوم', ground: 'tabuk-stadium-12k-rb', league: 'saudi-pro-league' },
  { id: 'hazem', en: 'Al Hazem', ar: 'الحزم', ground: 'alhazem-stadium-8k-rb', league: 'saudi-pro-league' },
  { id: 'kholood', en: 'Al Kholood', ar: 'الخلود', ground: 'alhazem-stadium-8k-rb', league: 'saudi-pro-league' },
  { id: 'fayha', en: 'Al Fayha', ar: 'الفيحاء', ground: 'majmaah-stadium-7k-rb', league: 'saudi-pro-league' },

  { id: 'liverpool', en: 'Liverpool', ar: 'ليفربول', ground: 'anfield-61k', league: 'premier-league' },
  { id: 'man-united', en: 'Manchester United', ar: 'مانشستر يونايتد', ground: 'old-trafford-74k', league: 'premier-league', word: 'UNITED' },
  { id: 'man-city', en: 'Manchester City', ar: 'مانشستر سيتي', ground: 'etihad-61k', league: 'premier-league', word: 'CITY' },
  { id: 'arsenal', en: 'Arsenal', ar: 'أرسنال', ground: 'emirates-60k', league: 'premier-league' },
  { id: 'chelsea', en: 'Chelsea', ar: 'تشيلسي', ground: 'stamford-bridge-40k', league: 'premier-league' },
  { id: 'tottenham', en: 'Tottenham', ar: 'توتنهام', ground: 'tottenham-62k', league: 'premier-league', word: 'SPURS' },
  { id: 'real-madrid', en: 'Real Madrid', ar: 'ريال مدريد', ground: 'bernabeu-83k', league: 'laliga', word: 'HALA MADRID' },
  { id: 'barcelona', en: 'Barcelona', ar: 'برشلونة', ground: 'camp-nou-63k', league: 'laliga', word: 'BARÇA' },
  { id: 'atletico', en: 'Atlético Madrid', ar: 'أتلتيكو مدريد', ground: 'metropolitano-71k', league: 'laliga', word: 'ATLETI' },
  { id: 'sevilla', en: 'Sevilla', ar: 'إشبيلية', ground: 'sanchez-pizjuan-44k', league: 'laliga' },
  { id: 'psg', en: 'Paris Saint-Germain', ar: 'باريس سان جيرمان', ground: 'parc-des-princes-48k', league: 'ligue-1', word: 'PARIS' },
  { id: 'marseille', en: 'Marseille', ar: 'مارسيليا', ground: 'velodrome-67k', league: 'ligue-1' },
  { id: 'galatasaray', en: 'Galatasaray', ar: 'غلطة سراي', ground: 'rams-park-53k', league: 'super-lig' },
  { id: 'fenerbahce', en: 'Fenerbahçe', ar: 'فنربخشة', ground: 'sukru-saracoglu-47k', league: 'super-lig', word: 'FENER' },
];

/**
 * The colours a fan can pick for a club the app has no identity for (or for
 * no club at all). The words are the ones the offline designer reads (see
 * COLOR_WORDS in core/promptDesigner.ts), and the hex values are the ones it
 * paints with, so a swatch here is exactly the colour that lands in the stand.
 */
export const COLOUR_CHOICES: { word: string; hex: string }[] = [
  { word: 'red', hex: '#c8242c' },
  { word: 'maroon', hex: '#6e1423' },
  { word: 'orange', hex: '#e8731a' },
  { word: 'yellow', hex: '#f4d03f' },
  { word: 'gold', hex: '#e8b73a' },
  { word: 'green', hex: '#0f7a3d' },
  { word: 'sky blue', hex: '#5bc0eb' },
  { word: 'blue', hex: '#1c5fd9' },
  { word: 'navy', hex: '#10233f' },
  { word: 'purple', hex: '#6b2fb3' },
  { word: 'white', hex: '#f2f1ec' },
  { word: 'black', hex: '#16161a' },
];

export const EMPTY_SEAT = '#262a33';

function rgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.replace(/(.)/g, '$1$1') : h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** True when two colours would read as the same card from the stand. */
function near(a: string, b: string): boolean {
  const [r1, g1, b1] = rgb(a);
  const [r2, g2, b2] = rgb(b);
  return Math.abs(r1 - r2) + Math.abs(g1 - g2) + Math.abs(b1 - b2) < 48;
}

/**
 * A full tifo palette from the colours a club or a fan gives: the empty seat
 * first, then those colours, topped up to four entries (patterns use up to
 * index 3) with white, then near-black, then grey, whichever is not already
 * there. For those extras a nearly-identical colour counts as there: Al
 * Hilal's #ffffff is the white, so it does not also get the off-white.
 */
export function paletteFrom(colours: string[], emptySeat = EMPTY_SEAT): string[] {
  const out = [emptySeat];
  // The colours given are kept as given (yellow and gold are two colours to
  // a fan who picked both); only the extras are held back when near one.
  for (const c of colours) if (!out.slice(1).some((o) => o.toLowerCase() === c.toLowerCase())) out.push(c);
  for (const extra of ['#f2f1ec', '#16161a', '#7a7f8c']) {
    if (out.length >= 4) break;
    if (!out.slice(1).some((o) => near(o, extra))) out.push(extra);
  }
  return out;
}

/**
 * The club's tifo colours, empty seat first, at least four entries, or null
 * when the club has no known identity.
 */
export function clubPalette(club: Pick<ClubStart, 'en'>, emptySeat = EMPTY_SEAT): string[] | null {
  const id = matchClub(club.en.toLowerCase());
  if (!id || id.palette.length === 0) return null;
  return paletteFrom(id.palette, emptySeat);
}

/** The two colours to draw a club's scarf with, or null when it has none. */
export function clubColours(club: Pick<ClubStart, 'en'>): [string, string] | null {
  const id = matchClub(club.en.toLowerCase());
  if (!id || id.palette.length === 0) return null;
  return [id.palette[0], id.palette[1] ?? '#ffffff'];
}

export function clubById(id: string | null | undefined): ClubStart | undefined {
  return id ? CLUB_STARTS.find((c) => c.id === id) : undefined;
}

/** The clubs that call a ground home, for "Home of Al Ahli and Al Ittihad". */
export function clubsAt(groundId: string): ClubStart[] {
  return CLUB_STARTS.filter((c) => c.ground === groundId);
}

/**
 * The brief the free offline designer (core/promptDesigner.ts) gets for a
 * "club tifo". The club's name lets it find the club's identity and symbol;
 * the colour words cover a club it does not know; the quoted word is what it
 * prints across the stand, which without one is a generic "ULTRAS".
 *
 * Quote marks are stripped from the word, because the designer reads the
 * first quoted run and an apostrophe in a name would cut it short.
 */
export function clubBrief(name: string, word: string, colourWords: string[] = []): string {
  const clean = word.replace(/["“”'‘’]/g, '').trim().slice(0, 24);
  const colours = colourWords.length ? ` ${colourWords.join(' and ')}` : '';
  return `${name.replace(/["“”]/g, '')}${colours}${clean ? ` "${clean}"` : ''}`.slice(0, 120);
}
