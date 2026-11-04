/**
 * The touchline LED boards' words, styled and moving (Pro, Match Day).
 *
 * A board is a page: one message on a panel of the board colour, or a
 * template's page (a sponsor board with the club's crest, a chant ticker, a
 * score line, a countdown). Every page is drawn once into one atlas canvas,
 * pages stacked, and each of the four board faces shows a page through its
 * own texture (clones share the atlas: one upload). So everything that moves
 * is a uniform, never a redraw:
 *
 *   - which page a face shows: the texture's vertical offset;
 *   - a scroll: its horizontal offset (the faces repeat whole panels);
 *   - a flash: the material's brightness.
 *
 * Match Day draws only when something changes (performance plan P2.12), and
 * the boards never change that: `LedShow` moves on only on frames that are
 * drawn anyway (the reveal, the camera gliding, a show, a recording), and
 * when everything else stops it finishes the change it was in the middle of
 * (under a second) and rests. Still, the faces show the messages side by side
 * round the ring, as they always have.
 *
 * Pure timing and canvas drawing; the meshes are render/simulator/pitchside.ts.
 */

export type LedTemplate = 'boards' | 'sponsor' | 'chant' | 'score' | 'countdown';
export const LED_TEMPLATES: readonly LedTemplate[] = ['boards', 'sponsor', 'chant', 'score', 'countdown'];

/** A picture a board can draw (a club kit's crest). */
export type LedPicture = CanvasImageSource & { width: number; height: number };

/** How the boards are styled, beyond their words and colour. */
export interface LedStyle {
  template: LedTemplate;
  /** The club's crest (sponsor boards, the score, the big screens); null for none. */
  crest: LedPicture | null;
  /** Score style: the two sides and the goals. */
  home: string;
  away: string;
  homeGoals: number;
  awayGoals: number;
}

export const DEFAULT_STYLE: LedStyle = { template: 'boards', crest: null, home: '', away: '', homeGoals: 0, awayGoals: 0 };

/** One page of the boards. */
export type LedPage =
  | { kind: 'text'; text: string; crest: boolean }
  | { kind: 'ticker'; text: string }
  | { kind: 'score'; home: string; away: string; homeGoals: number; awayGoals: number; crest: boolean }
  | { kind: 'count'; n: number };

/** A side's name on a score board: short, one line, as typed (the canvas only ever fills it as text). */
export function cleanSide(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return Array.from(raw.replace(/[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/g, ' ').replace(/\s+/g, ' ').trim()).slice(0, 16).join('').trim();
}

/** Goals: a whole number 0..99. */
export function cleanGoals(raw: unknown): number {
  const n = Math.round(Number(raw));
  return Number.isFinite(n) ? Math.max(0, Math.min(99, n)) : 0;
}

/**
 * The pages a style makes of these messages (pure). `boards`: one page a
 * message. `sponsor`: the same, each with the crest. `chant`: one ticker of
 * every message. `score`: the score line, then the messages. `countdown`:
 * 3, 2, 1, then the messages. Never empty when there is a message.
 */
export function pagesFor(messages: readonly string[], style: LedStyle): LedPage[] {
  const words = messages.filter(Boolean);
  const crest = !!style.crest;
  const texts = (withCrest: boolean): LedPage[] => words.map((text) => ({ kind: 'text', text, crest: withCrest }));
  switch (style.template) {
    case 'sponsor':
      return texts(crest);
    case 'chant':
      return words.length ? [{ kind: 'ticker', text: words.join('   •   ') }] : [];
    case 'score': {
      const home = cleanSide(style.home) || words[0] || '';
      const away = cleanSide(style.away);
      const score: LedPage = { kind: 'score', home, away, homeGoals: cleanGoals(style.homeGoals), awayGoals: cleanGoals(style.awayGoals), crest };
      return home || away ? [score, ...texts(false)] : texts(false);
    }
    case 'countdown':
      return words.length ? [{ kind: 'count', n: 3 }, { kind: 'count', n: 2 }, { kind: 'count', n: 1 }, ...texts(false)] : [];
    default:
      return texts(false);
  }
}

/** The pages that carry the words (what a still ring shows, side by side). */
export function restPages(pages: readonly LedPage[]): number[] {
  const out: number[] = [];
  pages.forEach((p, i) => { if (p.kind !== 'count') out.push(i); });
  return out.length ? out : [0];
}

// ---------------------------------------------------------------- drawing ---

/** One page: 2048 x 128, a 16:1 panel (about 12 m of board at its 0.77 m face). */
export const PAGE_W = 2048;
export const PAGE_H = 128;
/** A page's rows in the atlas: the page and a margin above and below, so filtering never reaches the next one. */
const SLOT_H = PAGE_H + 8;
/** The atlas holds at most this many pages (WebGL's 4096 limit and then some). */
export const MAX_PAGES = 12;

/** Anton and Noto Kufi Arabic (the "Condensed" voice): narrow, heavy, both scripts; the fallbacks cover a moment before they load. */
export const BOARD_FONT = '"TifoCondensed", "Noto Kufi Arabic", Impact, "Arial Black", sans-serif';

/** Right to left when the first strong letter is (what dir="auto" does). */
export function rtlFirst(s: string): boolean {
  for (const ch of s) {
    if (/[֐-ࣿיִ-﷿ﹰ-ﻼ]/.test(ch)) return true;
    if (/[A-Za-zÀ-ɏͰ-ϿЀ-ӿ]/.test(ch)) return false;
  }
  return false;
}

function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  const lin = (c: number): number => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
}

/** The letters' colour on a board of `colour`: dark on a light board, white on a dark one. */
export function inkOn(colour: string): string {
  return luminance(colour) > 0.4 ? '#0b0f18' : '#ffffff';
}

/** Words at most `maxW` wide at `px`, centred on (x, y): long ones are drawn a little smaller rather than cut. */
function fitText(g: CanvasRenderingContext2D, text: string, x: number, y: number, maxW: number, px: number): void {
  g.font = `${px}px ${BOARD_FONT}`;
  const w = g.measureText(text).width;
  if (w > maxW) g.font = `${Math.max(24, Math.floor((px * maxW) / w))}px ${BOARD_FONT}`;
  g.direction = rtlFirst(text) ? 'rtl' : 'ltr';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(text, x, y, maxW);
}

/** A crest in a box `h` tall at (x, y), keeping its shape. */
function drawCrest(g: CanvasRenderingContext2D, crest: LedPicture, cx: number, cy: number, h: number): number {
  const k = h / Math.max(1, crest.height);
  const w = Math.min(h * 1.6, crest.width * k);
  const hh = (w / Math.max(1, crest.width)) * crest.height;
  g.drawImage(crest, cx - w / 2, cy - hh / 2, w, hh);
  return w;
}

/** Draw one page at (0, y0) of the atlas. */
function drawPage(g: CanvasRenderingContext2D, page: LedPage, y0: number, colour: string, crest: LedPicture | null): void {
  const ink = inkOn(colour);
  g.save();
  g.translate(0, y0);
  g.fillStyle = colour;
  g.fillRect(0, -4, PAGE_W, PAGE_H + 8);
  // A soft top-to-bottom shade, the way a panel catches the floodlights.
  const shade = g.createLinearGradient(0, 0, 0, PAGE_H);
  shade.addColorStop(0, 'rgba(255,255,255,0.10)');
  shade.addColorStop(0.5, 'rgba(255,255,255,0)');
  shade.addColorStop(1, 'rgba(0,0,0,0.16)');
  g.fillStyle = shade;
  g.fillRect(0, 0, PAGE_W, PAGE_H);
  g.fillStyle = ink;
  const mid = PAGE_H * 0.54;
  const px = Math.round(PAGE_H * 0.6);
  switch (page.kind) {
    case 'text': {
      if (page.crest && crest) {
        // A sponsor board: the crest, then the words, as one centred lock-up.
        const cw = drawCrest(g, crest, PAGE_W * 0.16, PAGE_H / 2, PAGE_H * 0.8);
        fitText(g, page.text, PAGE_W * 0.58, mid, PAGE_W * 0.78 - cw * 0.2, px);
      } else {
        fitText(g, page.text, PAGE_W / 2, mid, PAGE_W * 0.9, px);
      }
      break;
    }
    case 'ticker':
      // The whole chant across the panel, smaller: it moves past, it is not read at a glance.
      fitText(g, page.text, PAGE_W / 2, mid, PAGE_W * 0.96, Math.round(PAGE_H * 0.52));
      break;
    case 'score': {
      // HOME [2–0] AWAY: the score in a box of the letters' colour.
      const boxW = PAGE_H * 2.1;
      const left = page.crest && crest ? PAGE_W * 0.08 : 0;
      if (left) drawCrest(g, crest!, left, PAGE_H / 2, PAGE_H * 0.78);
      const side = (PAGE_W - boxW - left * 2) / 2 - PAGE_H * 0.3;
      fitText(g, page.home.toUpperCase(), left * 2 + side / 2 + PAGE_H * 0.1, mid, side, px);
      fitText(g, page.away.toUpperCase(), PAGE_W - side / 2 - PAGE_H * 0.1, mid, side, px);
      g.fillRect((PAGE_W - boxW) / 2, PAGE_H * 0.12, boxW, PAGE_H * 0.76);
      g.fillStyle = colour;
      fitText(g, `${page.homeGoals}–${page.awayGoals}`, PAGE_W / 2, mid, boxW * 0.9, px);
      break;
    }
    case 'count':
      // The countdown before the reveal: one big digit, repeated down the panel.
      for (let i = 0; i < 5; i++) fitText(g, String(page.n), PAGE_W * (0.1 + i * 0.2), mid, PAGE_H * 1.5, Math.round(PAGE_H * 0.82));
      break;
  }
  // The seam between two panels.
  g.fillStyle = 'rgba(0,0,0,0.6)';
  g.fillRect(PAGE_W - 3, 0, 3, PAGE_H);
  g.restore();
}

/** The atlas: every page, stacked, PAGE_W wide. */
export function drawAtlas(pages: readonly LedPage[], colour: string, crest: LedPicture | null): HTMLCanvasElement {
  const c = document.createElement('canvas');
  const n = Math.max(1, Math.min(MAX_PAGES, pages.length));
  c.width = PAGE_W;
  c.height = n * SLOT_H;
  const g = c.getContext('2d');
  if (!g) return c;
  pages.slice(0, n).forEach((p, i) => drawPage(g, p, i * SLOT_H + 4, colour, crest));
  return c;
}

/** Where page `i` of `n` is in the atlas, as a texture's repeat and offset in v (three.js flips y). */
export function pageUv(i: number, n: number): { repeat: number; offset: number } {
  const slots = Math.max(1, Math.min(MAX_PAGES, n));
  const h = slots * SLOT_H;
  const top = i * SLOT_H + 4;
  return { repeat: PAGE_H / h, offset: 1 - (top + PAGE_H) / h };
}

/**
 * A page on a big screen (w x h, about 2.7:1): the same words and crest as
 * the boards, laid out for a screen rather than a 16:1 strip. The screens'
 * LED grid is drawn over it by render/simulator/screenPicture.ts.
 */
export function drawScreenPage(g: CanvasRenderingContext2D, w: number, h: number, page: LedPage, colour: string, crest: LedPicture | null): void {
  const ink = inkOn(colour);
  g.fillStyle = colour;
  g.fillRect(0, 0, w, h);
  const shade = g.createLinearGradient(0, 0, 0, h);
  shade.addColorStop(0, 'rgba(255,255,255,0.08)');
  shade.addColorStop(1, 'rgba(0,0,0,0.22)');
  g.fillStyle = shade;
  g.fillRect(0, 0, w, h);
  g.fillStyle = ink;
  switch (page.kind) {
    case 'text':
    case 'ticker': {
      // A screen has room: the crest beside the words whenever there is one.
      if (crest) {
        drawCrest(g, crest, w * 0.18, h / 2, h * 0.7);
        fitText(g, page.text, w * 0.62, h * 0.53, w * 0.68, Math.round(h * 0.36));
      } else {
        fitText(g, page.text, w / 2, h * 0.53, w * 0.9, Math.round(h * 0.42));
      }
      break;
    }
    case 'score': {
      if (crest && page.crest) drawCrest(g, crest, w / 2, h * 0.22, h * 0.3);
      const top = crest && page.crest ? h * 0.66 : h * 0.53;
      fitText(g, page.home.toUpperCase(), w * 0.2, top, w * 0.34, Math.round(h * 0.2));
      fitText(g, page.away.toUpperCase(), w * 0.8, top, w * 0.34, Math.round(h * 0.2));
      fitText(g, `${page.homeGoals}\u2013${page.awayGoals}`, w / 2, top, w * 0.26, Math.round(h * 0.36));
      break;
    }
    case 'count':
      fitText(g, String(page.n), w / 2, h * 0.55, w * 0.5, Math.round(h * 0.8));
      break;
  }
}

// ----------------------------------------------------------------- timing ---

/** What the four faces show this frame. */
export interface LedFrame {
  /** Page shown on each face (four). */
  pages: number[];
  /** Horizontal offset of every face, in panels. */
  scroll: number;
  /** Brightness, 1 as drawn. */
  glow: number;
}

/** How long a page holds while the scene moves, and how long a change takes (seconds). */
const HOLD = 3.2;
const CHANGE = 0.7;
/** The chant ticker's speed, panels a second. */
const TICKER = 0.12;
/** The countdown: a digit a beat. */
const COUNT_BEAT = 0.8;

/**
 * The boards' clock. `step` is called once per frame Match Day draws, with
 * `moving` (the scene moves for something else) and `revealing` (a reveal is
 * playing). It returns what to show and whether it is in the middle of a
 * change that has to finish (`busy`): the only frames the boards ever ask
 * for themselves, under a second's worth.
 */
export class LedShow {
  private pages: LedPage[] = [];
  private rest: number[] = [0];
  private live: number[] = [0];
  private cursor = 0;
  private hold = 0;
  /** Seconds into a change (scroll out, cut, scroll in), or -1. */
  private change = -1;
  private next = 0;
  private ticker = 0;
  private wasRevealing = false;
  /** Seconds since the reveal started, while it plays. */
  private revealT = 0;
  /** Bumped whenever the page on show changes (the big screens follow it). */
  seq = 0;

  setPages(pages: LedPage[]): void {
    this.pages = pages;
    this.rest = restPages(pages);
    this.live = pages.map((_, i) => i);
    this.cursor = 0;
    this.hold = 0;
    this.change = -1;
    this.ticker = 0;
    this.seq++;
  }

  /** The page the boards are showing now (the big screens show it too): at rest, the first message. */
  current(): number {
    return this.resting ? this.rest[0] : this.cursor;
  }

  private resting = true;

  /** At rest: every face its own message, round the ring, as the boards always were. */
  private still(): LedFrame {
    this.resting = true;
    const r = this.rest;
    return { pages: [0, 1, 2, 3].map((k) => r[k % r.length]), scroll: this.ticker, glow: 1 };
  }

  step(dt: number, moving: boolean, revealing: boolean): LedFrame & { busy: boolean } {
    const n = this.pages.length;
    if (n === 0) return { pages: [0, 0, 0, 0], scroll: 0, glow: 1, busy: false };
    // A slow device draws few frames: the boards keep time with the scene
    // (whose clock starts again after a still spell), up to a second a frame.
    const t = Math.min(1, Math.max(0, dt));
    if (revealing && !this.wasRevealing) {
      // The reveal starts: the countdown from its first page, and the flash.
      this.revealT = 0;
      this.cursor = this.pages[0].kind === 'count' ? 0 : this.cursor;
      this.hold = 0;
      this.change = -1;
      this.seq++;
    }
    this.wasRevealing = revealing;
    const ticker = this.pages.some((p) => p.kind === 'ticker');
    // Nothing else moves and no change is under way: rest.
    if (!moving && !revealing && this.change < 0) {
      if (this.cursor !== 0 || this.hold !== 0) {
        this.cursor = 0;
        this.hold = 0;
        this.seq++;
      }
      return { ...this.still(), busy: false };
    }
    if (this.resting) { this.resting = false; this.seq++; }
    if (revealing) this.revealT += t;
    if (ticker) {
      this.ticker = (this.ticker + t * TICKER * (revealing ? 2 : 1)) % 1;
      return { pages: [0, 0, 0, 0], scroll: this.ticker, glow: this.flash(revealing), busy: false };
    }
    // A countdown in a reveal: a digit a beat, then the words, flashing.
    if (revealing && this.pages[this.cursor]?.kind === 'count') {
      const beat = Math.floor(this.revealT / COUNT_BEAT);
      const at = Math.min(beat, this.live.length - 1);
      if (at !== this.cursor) { this.cursor = at; this.seq++; }
      const all = [this.cursor, this.cursor, this.cursor, this.cursor];
      return { pages: all, scroll: 0, glow: this.flash(revealing), busy: false };
    }
    let scroll = 0;
    if (this.change >= 0) {
      this.change += t;
      const p = Math.min(1, this.change / CHANGE);
      // Out to the left with the old page, in from the right with the new one.
      if (p < 0.5) scroll = this.ease(p * 2) * 0.5;
      else {
        if (this.cursor !== this.next) { this.cursor = this.next; this.seq++; }
        scroll = -0.5 + this.ease((p - 0.5) * 2) * 0.5;
      }
      if (p >= 1) { this.change = -1; scroll = 0; this.hold = 0; }
    } else if (n > 1) {
      this.hold += t;
      if (this.hold >= (revealing ? HOLD * 0.6 : HOLD)) {
        // The next page, skipping the countdown's digits outside a reveal.
        let k = this.cursor;
        do k = (k + 1) % n; while (this.pages[k].kind === 'count' && k !== this.cursor);
        this.next = k;
        this.change = 0;
      }
    }
    const shown = this.cursor;
    return { pages: [shown, shown, shown, shown], scroll, glow: this.flash(revealing), busy: this.change >= 0 };
  }

  /** Three quick flashes as the cards go up, then steady. */
  private flash(revealing: boolean): number {
    if (!revealing) return 1;
    const t = this.revealT;
    const start = this.pages[0]?.kind === 'count' ? COUNT_BEAT * 3 : 0;
    const f = t - start;
    if (f < 0 || f > 1.5) return 1;
    return Math.floor(f / 0.25) % 2 === 0 ? 1.6 : 0.35;
  }

  private ease(x: number): number {
    return x * x * (3 - 2 * x);
  }
}
