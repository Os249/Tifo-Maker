/**
 * The fan's own credit line (Pro): their handle or group name, small, in a
 * bottom corner of what they export, so a tifo posted without the
 * tifomaker.org mark still says whose it is. Every export that can carry it
 * draws it with drawCreditLine(), so it looks the same on a stadium video, a
 * GIF, the 4K poster, a Post it picture and a Match Day snapshot or clip.
 *
 * How it looks, and why:
 *  - a dark, rounded pill with a hairline and the credit in white: legible on
 *    a floodlit white stand, a night sky and a crowd alike, without a box
 *    that shouts;
 *  - a short stripe at the start of the pill, in the kit's colour when the
 *    caller has one (the club's), in white otherwise;
 *  - sized to the picture's area, not its height, so a vertical 9:16 clip and
 *    a landscape one carry the same size of credit; never smaller than 12 px,
 *    never more than 45% of the picture's width;
 *  - in the corner the text starts from: an Arabic credit sits bottom right
 *    and reads right to left, a Latin one bottom left, unless the site's mark
 *    is in that corner, when it takes the other one.
 *
 * Nothing here decides whether a credit may go out: what Pro decides is the
 * export (ui/proGate.ts), and the callers pass '' for the free version. This
 * module carries no strings and no network, so anything that draws an export
 * can import it.
 */
import { cleanCredit } from '../core/kitRules';

export interface CreditLineOpts {
  /** Where the site's mark is, which the credit leaves to it. null or absent: no mark. */
  avoid?: 'left' | 'right' | null;
  /** 'auto' (the default): the corner the credit's own text starts from. */
  corner?: 'auto' | 'left' | 'right';
  /** The stripe's colour (#rrggbb), e.g. the active kit's first colour. */
  accent?: string;
  /** Pixels between the picture's bottom edge and the pill; the default is the pill's own margin. */
  bottom?: number;
  /** A size other than the standard one, as a multiple of it. */
  scale?: number;
}

/** Strong right-to-left letters (Hebrew, Arabic and their presentation forms). */
const RTL = /[֐-ࣿיִ-﷿ﹰ-ﻼ]/;
const LTR = /[A-Za-zÀ-ɏͰ-ϿЀ-ӿ]/;
const HEX = /^#[0-9a-f]{6}$/i;
const FONT = 'Inter, Almarai, system-ui, -apple-system, "Segoe UI", Tahoma, Arial, sans-serif';

/** Whether the credit reads right to left: its first strong letter decides, as `dir="auto"` does. */
export function creditIsRtl(text: string): boolean {
  for (const ch of text) {
    if (RTL.test(ch)) return true;
    if (LTR.test(ch)) return false;
  }
  return false;
}

/** The credit's font size for a picture of this size. */
export function creditFontPx(width: number, height: number, scale = 1): number {
  return Math.round(Math.max(12, Math.min(72, Math.sqrt(Math.max(1, width) * Math.max(1, height)) * 0.021 * scale)));
}

/** The box drawCreditLine fills, for tests and for callers that place other things around it. */
export interface CreditBox {
  x: number;
  y: number;
  w: number;
  h: number;
  corner: 'left' | 'right';
  rtl: boolean;
  text: string;
}

function rounded(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/**
 * Draw the credit line into a picture `width` x `height`. Does nothing for an
 * empty credit; cleans it first (one line, at most 32 characters), and
 * shortens it with an ellipsis if it would pass 45% of the width. Returns
 * where it went, or null.
 */
export function drawCreditLine(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  text: string,
  opts: CreditLineOpts = {},
): CreditBox | null {
  const credit = cleanCredit(text);
  if (!credit || width < 40 || height < 24) return null;
  const rtl = creditIsRtl(credit);
  const own: 'left' | 'right' = rtl ? 'right' : 'left';
  const asked = opts.corner && opts.corner !== 'auto' ? opts.corner : own;
  const corner: 'left' | 'right' = opts.avoid && asked === opts.avoid ? (asked === 'left' ? 'right' : 'left') : asked;
  const fs = creditFontPx(width, height, opts.scale);
  const padX = Math.round(fs * 0.62);
  const padY = Math.round(fs * 0.36);
  const margin = Math.round(fs * 0.7);
  const stripe = Math.max(2, Math.round(fs * 0.16));
  const gap = Math.round(fs * 0.42);
  ctx.save();
  ctx.font = `600 ${fs}px ${FONT}`;
  ctx.direction = rtl ? 'rtl' : 'ltr';
  ctx.textBaseline = 'middle';
  const maxText = Math.max(fs, width * 0.45 - padX * 2 - stripe - gap);
  let shown = credit;
  if (ctx.measureText(shown).width > maxText) {
    while (shown.length > 1 && ctx.measureText(`${shown}…`).width > maxText) shown = Array.from(shown).slice(0, -1).join('');
    shown = `${shown.trimEnd()}…`;
  }
  // A handle keeps its "@" in front inside an Arabic credit: each @handle is its own left-to-right run.
  shown = rtl ? shown.replace(/@[\w.]+/g, (m) => `\u2066${m}\u2069`) : shown;
  const tw = Math.ceil(ctx.measureText(shown).width);
  const w = tw + padX * 2 + stripe + gap;
  const h = Math.round(fs + padY * 2);
  const x = corner === 'left' ? margin : width - margin - w;
  const y = height - (opts.bottom ?? margin) - h;
  // The pill: dark enough for a white stand, with a hairline for a black sky.
  ctx.shadowColor = 'rgba(0,0,0,0.35)';
  ctx.shadowBlur = Math.round(fs * 0.5);
  ctx.fillStyle = 'rgba(10,12,17,0.62)';
  rounded(ctx, x, y, w, h, Math.round(h / 2));
  ctx.fill();
  ctx.shadowColor = 'transparent';
  ctx.shadowBlur = 0;
  ctx.lineWidth = Math.max(1, Math.round(fs / 22));
  ctx.strokeStyle = 'rgba(255,255,255,0.16)';
  ctx.stroke();
  // The stripe, where the text starts reading.
  const sx = rtl ? x + w - padX - stripe : x + padX;
  ctx.fillStyle = opts.accent && HEX.test(opts.accent) ? opts.accent : 'rgba(255,255,255,0.78)';
  rounded(ctx, sx, y + padY, stripe, h - padY * 2, stripe / 2);
  ctx.fill();
  if (opts.accent && HEX.test(opts.accent)) {
    // A dark kit colour on the dark pill still shows its edge.
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.lineWidth = 1;
    ctx.stroke();
  }
  ctx.fillStyle = 'rgba(255,255,255,0.96)';
  ctx.textAlign = rtl ? 'right' : 'left';
  const tx = rtl ? sx - gap : sx + stripe + gap;
  ctx.fillText(shown, tx, y + h / 2 + Math.round(fs * 0.04));
  ctx.restore();
  return { x, y, w, h, corner, rtl, text: shown.replace(/[\u2066\u2069]/g, '') };
}

/**
 * The credit line for the export being made right now: set by the Pro tools
 * (ui/proCredit.ts) while Pro is on for the account, '' otherwise. Exports
 * read it only for their Pro version; the free version passes ''.
 */
export interface Credit {
  /** The credit as typed (cleaned when drawn); '' for none. */
  text: string;
  /** The stripe's colour: the kit in use in this project, if any. */
  accent?: string;
  /** Its name among the Pro items an export carries ("Your credit line"). */
  label?: string;
}

export const creditSource: { current: (() => Credit) | null } = { current: null };

export function currentCredit(): Credit {
  try {
    return creditSource.current?.() ?? { text: '' };
  } catch {
    return { text: '' };
  }
}
