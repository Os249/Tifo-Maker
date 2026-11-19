/**
 * The proposal sheet: one A4 page to send the club or the group.
 *
 * "Here is what we want to do on the 20th": the tifo in its ground from two
 * cameras (across the ground, and from the pitch), its colours with how many
 * cards each takes, how much of the ground it covers, a note in the fan's
 * own words and who to answer. A tifo is approved by people who were not in
 * the editor; this is the page they are sent.
 *
 * Drawn on a canvas at A4, 300 dots an inch (2480 × 3508), so an Arabic
 * line and the pictures come out exactly as the preview shows them, and
 * saved as a one-page PDF (core/pdfImage.ts) or a PNG. The pictures are
 * Match Day's (simulator/film.ts), in the film's light.
 *
 * Free to try: the preview is drawn for anyone Pro is on for. The download
 * is a Pro item and asks once (proGate.ts). The distribution PDF and the
 * seat CSV beside it stay free; nothing here replaces them.
 *
 * Loaded when the sheet first opens; its words come with it.
 */
import './proPoster.css';
import './proProposal.css';
import { escapeHtml } from '../core/escape';
import { pdfFromJpeg } from '../core/pdfImage';
import { TIFO_FONTS, fontCssOf } from '../core/text';
import type { MatchDaySimulator } from '../render/simulator/index';
import { loadTifoFonts } from '../core/tifoFonts';
import { containDialog } from './dialogFocus';
import { getLang, t, tl, tv } from './i18n';
import { matchDayDeps } from './matchDayDeps';
import { CROWN_SVG } from './pro';
import { exportGate } from './proGate';
import { offscreenMatchDay } from './proFilm';
import { chosenSeats, focusPicker, type FocusPicker } from './tifoFocus';

export interface ProposalSheetDeps {
  title(): string;
  /** Without the tifomaker.org line at the foot (a member's default). */
  clean(): boolean;
  designItems(): string[];
  say(msg: string): void;
}

/** A4 at 300 dpi, and in points. */
const PAGE = { w: 2480, h: 3508, wPt: 595.28, hPt: 841.89 };
const INK = '#0d1320';
const MUTED = '#5b6478';
const LINE = '#d9deea';

export interface ProposalData {
  title: string;
  when: string;
  ground: string;
  note: string;
  contact: string;
  /** The colours in use, most cards first. */
  colours: { hex: string; cards: number }[];
  cards: number;
  seats: number;
  rtl: boolean;
  mark: boolean;
  display: string;
  body: string;
  labels: Record<'eyebrow' | 'viewA' | 'viewB' | 'colours' | 'other' | 'total' | 'seats' | 'share' | 'note' | 'cards', string>;
}

const nf = new Intl.NumberFormat('en');
const ARABIC = /[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]/;

function wrap(g: CanvasRenderingContext2D, text: string, max: number, rows: number): string[] {
  const out: string[] = [];
  for (const para of text.split(/\n/)) {
    let line = '';
    for (const w of para.split(/\s+/).filter(Boolean)) {
      const next = line ? `${line} ${w}` : w;
      if (line && g.measureText(next).width > max) {
        out.push(line);
        line = w;
      } else line = next;
    }
    if (line) out.push(line);
  }
  if (out.length > rows) {
    out.length = rows;
    out[rows - 1] = `${out[rows - 1].replace(/\s+\S*$/, '')}…`;
  }
  return out;
}

/** Draw the page. `a` and `b` are the two pictures (null: its frame is left empty). */
export function drawProposal(g: CanvasRenderingContext2D, d: ProposalData, a: CanvasImageSource | null, b: CanvasImageSource | null): void {
  const { w: W, h: H } = PAGE;
  const m = 150;
  const rtl = d.rtl;
  /** A box's left edge, mirrored on an Arabic page. */
  const X = (x: number, w: number): number => (rtl ? W - x - w : x);
  /** Text starting at the reading edge of a box x..x+w. */
  const text = (s0: string, x: number, w: number, y: number, font: string, colour: string, end = false): void => {
    let s = s0;
    g.font = font;
    g.fillStyle = colour;
    g.direction = ARABIC.test(s) ? 'rtl' : 'ltr';
    // A handle or an address keeps its @ where it was typed inside an Arabic line.
    s = s.replace(/[w.+-]*@[w.-]+/g, '⁦$&⁩');
    // From the box's reading edge, or (`end`) up to its far edge; mirrored on an Arabic page.
    g.textAlign = end === rtl ? 'left' : 'right';
    const px = rtl ? (end ? W - x - w : W - x) : end ? x + w : x;
    g.fillText(s, px, y, w);
  };
  const picture = (img: CanvasImageSource | null, x: number, y: number, w: number, h: number): void => {
    const px = X(x, w);
    g.save();
    g.beginPath();
    g.roundRect(px, y, w, h, 28);
    g.clip();
    g.fillStyle = '#0b1220';
    g.fillRect(px, y, w, h);
    if (img) {
      // Covered, not squeezed: the middle of the picture at the frame's shape.
      const iw = (img as HTMLCanvasElement).width;
      const ih = (img as HTMLCanvasElement).height;
      const k = Math.max(w / iw, h / ih);
      const sw = w / k;
      const sh = h / k;
      g.drawImage(img, (iw - sw) / 2, (ih - sh) / 2, sw, sh, px, y, w, h);
    }
    g.restore();
  };
  const fit = (s: string, font: (px: number) => string, max: number, big: number, small: number): number => {
    let px = big;
    for (;;) {
      g.font = font(px);
      if (g.measureText(s).width <= max || px <= small) return px;
      px = Math.max(small, px * 0.94);
    }
  };

  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, W, H);
  g.textBaseline = 'alphabetic';
  // The tifo's own colours along the top edge, widest first.
  let cx = 0;
  const band = d.colours.slice(0, 6);
  const sum = band.reduce((n, c) => n + c.cards, 0) || 1;
  for (const c of band) {
    const bw = (c.cards / sum) * W;
    g.fillStyle = c.hex;
    g.fillRect(rtl ? W - cx - bw : cx, 0, bw + 1, 44);
    cx += bw;
  }

  const full = W - m * 2;
  text(d.labels.eyebrow.toUpperCase(), m, full, 250, `700 46px ${d.body}`, MUTED);
  const ts = fit(d.title || ' ', (px) => `${Math.round(px)}px ${d.display}`, full, 190, 96);
  text(d.title, m, full, 250 + ts * 1.02, `${Math.round(ts)}px ${d.display}`, INK);
  const sub = [d.ground, d.when].filter(Boolean).join('  ·  ');
  // Under the title's descenders (an Arabic title hangs well below its line).
  const subY = 250 + ts * 1.4 + 70;
  text(sub, m, full, subY, `500 58px ${d.body}`, MUTED);

  // The two pictures.
  const ay = subY + 80;
  const ah = Math.round(full * 0.48);
  picture(a, m, ay, full, ah);
  text(d.labels.viewA, m, full, ay + ah + 62, `500 40px ${d.body}`, MUTED);
  const by = ay + ah + 130;
  const half = Math.round((full - 80) / 2);
  const bh = Math.round((half * 9) / 16);
  picture(b, m, by, half, bh);
  text(d.labels.viewB, m, half, by + bh + 62, `500 40px ${d.body}`, MUTED);

  // The colours and their cards, beside the second picture.
  const tx = m + half + 80;
  text(d.labels.colours, tx, half, by + 52, `700 54px ${d.body}`, INK);
  const shown = d.colours.slice(0, 7);
  const rest = d.colours.slice(7).reduce((n, c) => n + c.cards, 0);
  const rowH = 78;
  let ry = by + 120;
  const row = (hex: string | null, label: string, cards: number): void => {
    const sw = 52;
    if (hex) {
      g.fillStyle = hex;
      g.beginPath();
      g.roundRect(X(tx, sw), ry, sw, sw, 10);
      g.fill();
      g.strokeStyle = LINE;
      g.lineWidth = 2;
      g.stroke();
    }
    text(label, tx + sw + 28, half - sw - 28 - 330, ry + 40, `500 44px ${d.body}`, INK);
    text(d.labels.cards.replace('{n}', nf.format(cards)), tx, half, ry + 40, `600 44px ${d.body}`, INK, true);
    ry += rowH;
  };
  for (const c of shown) row(c.hex, c.hex.toUpperCase(), c.cards);
  if (rest) row(null, d.labels.other, rest);
  g.fillStyle = LINE;
  g.fillRect(X(tx, half), ry + 2, half, 3);
  ry += 30;
  text(d.labels.total, tx, half - 330, ry + 44, `700 46px ${d.body}`, INK);
  text(nf.format(d.cards), tx, half, ry + 44, `700 46px ${d.body}`, INK, true);

  // The facts and the note, across the page.
  let y = Math.max(by + bh + 120, ry + 120);
  const facts: [string, string][] = [
    [d.labels.total, nf.format(d.cards)],
    [d.labels.seats, nf.format(d.seats)],
    [d.labels.share, `${d.seats ? Math.round((d.cards / d.seats) * 100) : 0}%`],
  ];
  const fw = Math.round((full - 80) / 3);
  facts.forEach(([k, v], i) => {
    const fx = m + i * (fw + 40);
    g.fillStyle = '#f3f5fa';
    g.beginPath();
    g.roundRect(X(fx, fw), y, fw, 180, 24);
    g.fill();
    text(v, fx + 40, fw - 80, y + 96, `700 76px ${d.body}`, INK);
    text(k, fx + 40, fw - 80, y + 150, `500 38px ${d.body}`, MUTED);
  });
  y += 262;
  if (d.note.trim()) {
    text(d.labels.note, m, full, y, `700 46px ${d.body}`, INK);
    g.font = `400 50px ${d.body}`;
    const lines = wrap(g, d.note.trim(), full, Math.max(1, Math.floor((H - 300 - y) / 70)));
    lines.forEach((l, i) => text(l, m, full, y + 80 + i * 70, `400 48px ${d.body}`, INK));
  }

  // The foot: who to answer, and where it was made.
  g.fillStyle = LINE;
  g.fillRect(m, H - 230, full, 3);
  if (d.contact.trim()) text(d.contact.trim(), m, full - 500, H - 140, `600 46px ${d.body}`, INK);
  if (d.mark) text('tifomaker.org', m, full, H - 140, `600 42px ${d.body}`, MUTED, true);
}

interface Fields {
  title: string;
  when: string;
  note: string;
  contact: string;
}
let keptFields: Partial<Fields> = {};

export async function openProposalSheet(deps: ProposalSheetDeps): Promise<void> {
  const md = matchDayDeps();
  if (!md) return;
  const lang: 'en' | 'ar' = getLang() === 'ar' ? 'ar' : 'en';
  const f: Fields = { title: deps.title(), when: '', note: '', contact: '', ...keptFields };

  const root = document.createElement('div');
  root.className = 'pro-sheet-backdrop qv-poster-backdrop';
  root.dir = lang === 'ar' ? 'rtl' : 'ltr';
  const input = (k: keyof Fields, max: number, ph = ''): string =>
    `<label class="qv-field qv-prop-wide"><span>${escapeHtml(t(`prop.f.${k}`))}</span>` +
    (k === 'note'
      ? `<textarea name="prop-${k}" maxlength="${max}" rows="4" dir="auto" placeholder="${escapeHtml(ph)}">${escapeHtml(f[k])}</textarea>`
      : `<input type="text" name="prop-${k}" maxlength="${max}" dir="auto" value="${escapeHtml(f[k])}" placeholder="${escapeHtml(ph)}" />`) +
    `</label>`;
  root.innerHTML =
    `<div class="pro-sheet qv-poster qv-prop" role="dialog" aria-modal="true" aria-labelledby="qv-o-title">` +
    `<button type="button" class="pro-sheet-close" aria-label="${escapeHtml(t('common.close'))}">&times;</button>` +
    `<div class="qv-poster-head"><span class="pro-sheet-mark" aria-hidden="true">${CROWN_SVG}</span>` +
    `<div><h2 id="qv-o-title">${escapeHtml(t('prop.title'))}</h2><p class="qv-lead">${escapeHtml(t('prop.lead'))}</p></div></div>` +
    `<div class="qv-poster-body">` +
    `<div class="qv-preview"><canvas role="img" data-shape="portrait" aria-label="${escapeHtml(t('prop.preview'))}"></canvas><p class="qv-wait" role="status" aria-live="polite"></p></div>` +
    `<div class="qv-form">` +
    `<div class="qv-part"></div>` +
    input('title', 60) + input('when', 60, t('prop.whenPh')) + input('note', 400, t('prop.notePh')) + input('contact', 80, t('prop.contactPh')) +
    `<div class="pro-actions"><button type="button" class="pro-btn qv-download" data-get="pdf">${CROWN_SVG}<span>${escapeHtml(t('prop.pdf'))}</span></button>` +
    `<button type="button" class="pro-alt" data-get="png">${escapeHtml(t('prop.png'))}</button></div>` +
    `<p class="qv-status" role="status" aria-live="polite"></p>` +
    `</div></div></div>`;
  const $ = <T extends HTMLElement>(s: string): T => root.querySelector(s) as T;
  const canvas = $<HTMLCanvasElement>('.qv-preview canvas');
  const wait = $('.qv-wait');
  const status = $('.qv-status');
  const buttons = [...root.querySelectorAll<HTMLButtonElement>('[data-get]')];
  document.body.appendChild(root);

  let part: FocusPicker | null = null;
  let closed = false;
  let close: () => void = () => {};
  const done = new Promise<void>((resolve) => {
    close = (): void => {
      if (closed) return;
      closed = true;
      release();
      part?.destroy();
      root.remove();
      resolve();
    };
  });
  const release = containDialog(root, () => close());
  root.addEventListener('mousedown', (e) => { if (e.target === root) close(); });
  $('.pro-sheet-close').addEventListener('click', () => close());

  // The counts: every colour in use, most cards first.
  const counts = new Map<number, number>();
  for (let i = 0; i < md.map.count; i++) {
    const c = md.store.cells[i];
    if (c) counts.set(c, (counts.get(c) ?? 0) + 1);
  }
  const colours = [...counts.entries()].sort((x, y) => y[1] - x[1]).map(([i, n]) => ({ hex: md.store.palette[i] ?? '#888888', cards: n }));
  const cards = colours.reduce((n, c) => n + c.cards, 0);
  const data = (): ProposalData => ({
    title: f.title.trim() || deps.title(),
    when: f.when.trim(),
    ground: tl(md.template.id),
    note: f.note,
    contact: f.contact,
    colours,
    cards,
    seats: md.map.count,
    rtl: lang === 'ar',
    mark: !deps.clean(),
    display: fontCssOf('condensed', TIFO_FONTS),
    body: getComputedStyle(document.body).fontFamily || 'system-ui, sans-serif',
    labels: {
      eyebrow: t('prop.eyebrow'), viewA: t('prop.viewA'), viewB: t('prop.viewB'), colours: t('prop.colours'), other: t('prop.other'),
      total: t('prop.total'), seats: t('prop.seats'), share: t('prop.share'), note: t('prop.note'), cards: t('prop.cards'),
    },
  });

  // The page is drawn once at its full size and shown scaled: what is saved is what was seen.
  const page = document.createElement('canvas');
  page.width = PAGE.w;
  page.height = PAGE.h;
  let picA: HTMLCanvasElement | null = null;
  let picB: HTMLCanvasElement | null = null;
  const redraw = (): void => {
    drawProposal(page.getContext('2d')!, data(), picA, picB);
    canvas.width = PAGE.w / 2;
    canvas.height = PAGE.h / 2;
    const g = canvas.getContext('2d')!;
    g.imageSmoothingQuality = 'high';
    g.drawImage(page, 0, 0, canvas.width, canvas.height);
    canvas.dataset.ready = '1';
  };

  let typing = 0;
  root.addEventListener('input', (e) => {
    const el = e.target as HTMLInputElement | HTMLTextAreaElement;
    const k = el.name?.replace(/^prop-/, '') as keyof Fields;
    if (!(k in f)) return;
    f[k] = el.value;
    keptFields = { ...f };
    window.clearTimeout(typing);
    typing = window.setTimeout(redraw, 120);
  });

  const save = (blob: Blob, name: string): void => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  };
  for (const b of buttons) {
    b.addEventListener('click', async () => {
      if (b.disabled) return;
      for (const x of buttons) x.disabled = true;
      status.textContent = '';
      try {
        const how = await exportGate([t('prop.item'), ...deps.designItems()]);
        // There is no free version of this page: the distribution PDF and the CSV are the free ones.
        if (how === 'free') status.textContent = t('prop.freeNote');
        if (how !== 'pro') return;
        window.clearTimeout(typing);
        redraw();
        const name = `${deps.title()}-proposal`;
        let size = 0;
        if (b.dataset.get === 'png') {
          const blob = await new Promise<Blob | null>((r) => page.toBlob(r, 'image/png'));
          if (!blob) throw new Error('no picture');
          size = blob.size;
          save(blob, `${name}.png`);
        } else {
          const jpeg = await new Promise<Blob | null>((r) => page.toBlob(r, 'image/jpeg', 0.92));
          if (!jpeg) throw new Error('no picture');
          const pdf = pdfFromJpeg(new Uint8Array(await jpeg.arrayBuffer()), PAGE.w, PAGE.h, PAGE.wPt, PAGE.hPt);
          size = pdf.length;
          save(new Blob([pdf.buffer as ArrayBuffer], { type: 'application/pdf' }), `${name}.pdf`);
        }
        const msg = tv('prop.saved', { mb: (size / (1024 * 1024)).toFixed(1) });
        status.textContent = msg;
        deps.say(msg);
      } catch (e) {
        console.warn('[tifo] the proposal sheet failed', e);
        status.textContent = t('pack.failed');
      } finally {
        for (const x of buttons) x.disabled = false;
      }
    });
  }

  // The two pictures, drawn one after the other, and again when the part to show changes (ui/tifoFocus.ts).
  let sim: MatchDaySimulator | null = null;
  let drawing: Promise<void> = Promise.resolve();
  let wanted = 0;
  const pictures = (): void => {
    const mine = ++wanted;
    wait.textContent = t('qv.p.drawingPreview');
    drawing = drawing.then(async () => {
      if (closed || !sim || mine !== wanted) return;
      try {
        sim.setTifoFocus(chosenSeats(md));
        const { filmStill, shotStill } = await import('../render/simulator/film');
        const a = await filmStill(sim.filmHost(), 1920, 1080);
        if (closed) return;
        picA = a;
        redraw();
        // From the pitch in front of the tifo; a tifo round the whole ground has no such camera, and gets the ultras' end.
        const b = await shotStill(sim.filmHost(), 1280, 720, ['Tifo Pitch Level', 'Ultra View', 'TV Broadcast']);
        if (closed) return;
        picB = b;
        redraw();
        if (mine === wanted) wait.textContent = '';
      } catch (e) {
        console.warn('[tifo] the proposal pictures failed', e);
        wait.textContent = t('pack.failed');
      }
    });
  };
  part = focusPicker(md, pictures);
  $('.qv-part').append(part.root);

  wait.textContent = t('qv.p.drawingPreview');
  await loadTifoFonts();
  if (closed) return;
  // The page with its words first; the pictures arrive into it.
  redraw();
  try {
    await offscreenMatchDay(async (s) => {
      sim = s;
      pictures();
      await done;
      await drawing;
      sim = null;
    });
  } catch (e) {
    console.warn('[tifo] the proposal pictures failed', e);
    wait.textContent = t('pack.failed');
    await done;
  }
}
