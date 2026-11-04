/**
 * The club kit beyond the seats (Pro): once a kit is in a project, the rest of
 * the project wears it too. Part of the club kit's chunk (ui/clubKit.ts).
 *
 *  - The AI designer gets the kit with every design (ui/kitActive.ts, read by
 *    ui/aiPanel.ts), and the AI panel says so: "Using kit: Blue Wave", with a
 *    way to stop.
 *  - A banner can be dressed in it, from the banner's panel, as one undo step:
 *    the kit's first colour for the cloth, the kit colour that stands out most
 *    on it for the letters, the kit's font for them, and its first logo at the
 *    banner's start end, the way a crest leads an ultras' banner. A sign keeps
 *    its words alone: it is held up by a row of fans, not read as a crest.
 *  - Post it lays its picture out in it (ui/postMoment.ts setPostKit): the
 *    kit's colours along the band, its crest at the band's end, its font for
 *    the title (a Pro voice only while Pro runs: a free export carries no Pro
 *    font).
 *  - The credit line's stripe takes the kit's first colour (ui/proCredit.ts).
 * The LED boards and the poster read the kits themselves (loadKits).
 *
 * Which kit is "in" a project: the one last used there, remembered in this
 * browser by the project's id (a courtesy, like the free try), and in memory
 * for a project that has no id yet.
 */
import { aspectOf, fitMessage, messageOf, type BannerItem, type ImageItem, type TextItem } from '../core/banner';
import { escapeHtml } from '../core/escape';
import { isProVoice } from '../core/proVoices';
import { fontCssOf, renderTextCanvas } from '../core/text';
import { loadProFonts, loadTifoFonts } from '../core/tifoFonts';
import { bannerScene } from './bannerHost';
import type { ClubKit } from './clubKitStore';
import { getLang, onLangChange, t, tv } from './i18n';
import { activeKit } from './kitActive';
import { CROWN_SVG, proChipHtml } from './pro';

const ACTIVE_KEY = 'tifo_kit_active_v1';
/** How many projects' kits this browser remembers. */
const ACTIVE_MAX = 60;
const esc = escapeHtml;
const iso = (s: string): string => `⁨${s}⁩`;

/** The project in the address bar (/d/:id, ?project=, ?local=, ?design=), or null for one not saved yet. */
function projectKey(): string | null {
  const m = location.pathname.match(/^(?:\/ar)?\/d\/([A-Za-z0-9-]+)\/?$/);
  if (m) return m[1];
  const q = new URLSearchParams(location.search);
  const id = q.get('project') ?? q.get('local') ?? q.get('design');
  return id && /^[A-Za-z0-9-]{1,64}$/.test(id) ? id : null;
}

function remembered(): Record<string, string> {
  try {
    const v = JSON.parse(localStorage.getItem(ACTIVE_KEY) ?? '{}') as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, string>) : {};
  } catch {
    return {};
  }
}

function remember(kitId: string | null): void {
  const key = projectKey();
  if (!key) return;
  try {
    const all = remembered();
    delete all[key];
    if (kitId) all[key] = kitId;
    const keys = Object.keys(all);
    for (const k of keys.slice(0, Math.max(0, keys.length - ACTIVE_MAX))) delete all[k];
    localStorage.setItem(ACTIVE_KEY, JSON.stringify(all));
  } catch {
    /* in memory for this visit */
  }
}

/** Relative luminance of #rrggbb (WCAG). */
function luminance(hex: string): number {
  const v = parseInt(hex.slice(1), 16);
  const ch = (c: number): number => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * ch((v >> 16) & 255) + 0.7152 * ch((v >> 8) & 255) + 0.0722 * ch(v & 255);
}
const contrast = (a: string, b: string): number => {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};
/** The kit colour that stands out most on `bg`; white or black when none reaches 3:1. */
export function inkOn(bg: string, colours: string[]): string {
  let best = '';
  let score = 0;
  for (const c of colours) {
    const k = contrast(c, bg);
    if (c !== bg && k > score) {
      best = c;
      score = k;
    }
  }
  if (score >= 3) return best;
  return contrast('#ffffff', bg) >= contrast('#141414', bg) ? '#ffffff' : '#141414';
}

function blobToDataUrl(b: Blob): Promise<string | null> {
  return new Promise((resolve) => {
    const r = new FileReader();
    r.onload = () => resolve(typeof r.result === 'string' ? r.result : null);
    r.onerror = () => resolve(null);
    r.readAsDataURL(b);
  });
}

export interface KitEverywhere {
  /** The kits as loaded (the sheet's list), so the banner panel can offer them. */
  setKits(kits: ClubKit[]): void;
  /** This kit is in the project now ("Use in this project"). */
  setActive(kit: ClubKit | null): void;
  readonly active: ClubKit | null;
  /** Pro on, Pro running: whether any of this shows, and quietly. */
  setPro(live: boolean, running: boolean): void;
}

export function mountKitEverywhere(opts: {
  /** May this kit be used in this project (the free try, or Pro running)? Spends the free try when it says yes. */
  mayUse(kit: ClubKit): Promise<boolean>;
  kitName(kit: ClubKit): string;
  say(msg: string): void;
}): KitEverywhere {
  let kits: ClubKit[] = [];
  let active: ClubKit | null = null;
  let live = false;
  let running = false;

  const fontFor = (kit: ClubKit): void => {
    if (!kit.font) return;
    void (isProVoice(kit.font) ? loadProFonts([kit.font]) : loadTifoFonts()).catch(() => {});
  };

  // ---- the AI panel: "Using kit: Blue Wave" ----
  const chip = document.createElement('div');
  chip.className = 'qk-ai-kit';
  chip.hidden = true;
  chip.setAttribute('role', 'status');
  const prompt = document.getElementById('ai-prompt');
  prompt?.after(chip);
  const paintChip = (): void => {
    const k = active;
    chip.hidden = !live || !k;
    if (!k || chip.hidden) {
      chip.textContent = '';
      return;
    }
    const name = opts.kitName(k);
    chip.title = t('qk.aiUsingT');
    chip.innerHTML =
      `<span class="qk-ai-strip" aria-hidden="true">${k.colors.slice(0, 5).map((c) => `<i data-c="${esc(c)}"></i>`).join('')}</span>` +
      `<span class="qk-ai-name">${esc(tv('qk.aiUsing', { name: iso(name) }))}</span>` +
      `<button type="button" class="qk-ai-stop" aria-label="${esc(tv('qk.aiStop', { name }))}">&times;</button>`;
    for (const i of chip.querySelectorAll<HTMLElement>('[data-c]')) {
      if (/^#[0-9a-f]{6}$/i.test(i.dataset.c ?? '')) i.style.setProperty('--kit-c', i.dataset.c!);
    }
  };
  chip.addEventListener('click', (e) => {
    if ((e.target as Element | null)?.closest('.qk-ai-stop')) api.setActive(null);
  });

  // ---- the banner's panel: dress this banner in the kit ----
  const block = document.createElement('div');
  block.className = 'bn-block qk-bn-kit';
  block.id = 'qk-bn-kit';
  block.hidden = true;
  const detail = document.getElementById('bn-detail');
  detail?.prepend(block);
  let picked: string | null = null;
  const bannerKit = (): ClubKit | null => kits.find((k) => k.id === picked) ?? active ?? kits[0] ?? null;
  /** What the block shows, so a banner edit (every brush point is one) redraws it only when that changes. */
  let shownKey = '';
  const paintBlock = (): void => {
    const doc = bannerScene.store?.active ?? null;
    const k = bannerKit();
    const key = [live, running, doc?.id, k?.id, getLang(), ...kits.map((x) => `${x.id}:${opts.kitName(x)}`)].join('|');
    if (key === shownKey) return;
    shownKey = key;
    block.hidden = !live || !k || !doc;
    if (block.hidden || !k) {
      block.textContent = '';
      return;
    }
    const name = opts.kitName(k);
    block.innerHTML =
      `<h4><span>${esc(t('kit.entry'))}</span> ${proChipHtml({ quiet: running })}</h4>` +
      (kits.length > 1
        ? `<div class="group bn-row"><label for="qk-bn-pick">${esc(t('qk.bnPick'))}</label><select id="qk-bn-pick">` +
          kits.map((x) => `<option value="${esc(x.id)}"${x.id === k.id ? ' selected' : ''}>${esc(opts.kitName(x))}</option>`).join('') +
          `</select></div>`
        : '') +
      `<button type="button" class="pro-btn qk-bn-dress" title="${esc(t('qk.bnDressT'))}">${CROWN_SVG}<span>${esc(tv('qk.bnDress', { name: iso(name) }))}</span></button>`;
    block.querySelector<HTMLSelectElement>('#qk-bn-pick')?.addEventListener('change', (e) => {
      picked = (e.target as HTMLSelectElement).value;
      paintBlock();
    });
  };
  block.addEventListener('click', (e) => {
    const b = (e.target as Element | null)?.closest<HTMLButtonElement>('.qk-bn-dress');
    const k = bannerKit();
    if (!b || b.disabled || !k) return;
    b.disabled = true;
    void dress(k).finally(() => {
      b.disabled = false;
    });
  });

  /** Dress the banner being edited in `kit`: one undo step. */
  const dress = async (kit: ClubKit): Promise<void> => {
    const store = bannerScene.store;
    const doc = store?.active;
    if (!store || !doc) return;
    if (!(await opts.mayUse(kit))) return;
    // Everything that waits happens before the step opens, so nothing else lands inside it.
    if (kit.font && isProVoice(kit.font)) await loadProFonts([kit.font]).catch(() => {});
    else if (kit.font) await loadTifoFonts().catch(() => {});
    const logo = doc.kind !== 'sign' ? kit.logos[0] : undefined;
    const src = logo ? await blobToDataUrl(logo.blob) : null;
    if (store.active !== doc) return;
    const bg = kit.colors[0];
    const ink = inkOn(bg, kit.colors);
    const aspect = aspectOf(doc);
    const rtl = document.documentElement.dir === 'rtl';
    // Named for its kit, so dressing the banner again does not add a second crest.
    const logoName = opts.kitName(kit);
    // The crest at the banner's start end, as tall as the sheet allows.
    let crest: Omit<ImageItem, 'id' | 'kind'> | null = null;
    if (src && logo && !doc.items.some((i) => i.kind === 'image' && i.name === logoName)) {
      const ratio = logo.bitmap.width / Math.max(1, logo.bitmap.height);
      const h = Math.min(0.78 * aspect, 0.3 / Math.max(ratio, 1e-3));
      const w = h * ratio;
      const edge = 0.03 + w / 2;
      crest = { src, name: logoName, cx: rtl ? 1 - edge : edge, cy: aspect / 2, w, h, rot: 0, opacity: 1 };
    }
    store.begin();
    store.patch({ bg });
    for (const it of doc.items) {
      if (it.kind !== 'text') continue;
      const fontId = kit.font || it.fontId;
      const patch: Partial<BannerItem> = { color: ink, fontId } as Partial<BannerItem>;
      const r = renderTextCanvas(it.text, fontCssOf(fontId), it.arcDeg);
      if (r) {
        const glyph = r.canvas.width / Math.max(1, r.canvas.height);
        if (doc.kind === 'sign' && messageOf(doc)?.id === it.id) Object.assign(patch, fitMessage(aspect, glyph));
        else {
          // Its height kept; its width the new face's, and clear of the crest.
          let w = it.h * glyph;
          let cx = it.cx;
          if (crest) {
            const room = 1 - (crest.w + 0.06) - 0.03;
            if (w > room) w = room;
            const start = rtl ? 1 - (crest.w + 0.06) : crest.w + 0.06;
            const left = cx - w / 2;
            const right = cx + w / 2;
            if (!rtl && left < start) cx = start + w / 2;
            if (rtl && right > start) cx = start - w / 2;
          }
          Object.assign(patch, { w, h: w / glyph, cx });
        }
      }
      store.patchItem(it.id, patch);
    }
    if (crest) store.addItem({ ...crest, id: `m${Date.now().toString(36)}`, kind: 'image' });
    // A banner with no words yet gets the club's name beside its crest, as an ultras' banner reads.
    const headline = doc.kind !== 'sign' && !doc.items.some((i) => i.kind === 'text') ? nameLine(kit, ink, aspect, crest, rtl) : null;
    if (headline) store.addItem(headline);
    store.commit();
    const name = iso(opts.kitName(kit));
    opts.say(tv(crest ? 'qk.bnDone' : 'qk.bnDoneNoLogo', { name }));
  };

  /** The kit's name as a headline in its font, in the room the crest leaves, as tall as reads. */
  const nameLine = (kit: ClubKit, ink: string, aspect: number, crest: { w: number } | null, rtl: boolean): TextItem | null => {
    const text = opts.kitName(kit);
    const fontId = kit.font || 'condensed';
    const r = renderTextCanvas(text, fontCssOf(fontId), 0);
    if (!r) return null;
    const glyph = r.canvas.width / Math.max(1, r.canvas.height);
    const start = crest ? crest.w + 0.08 : 0.06;
    const room = 1 - start - 0.06;
    const h = Math.min(0.42 * aspect, room / glyph);
    const w = h * glyph;
    const mid = start + room / 2;
    return { kind: 'text', id: `t${Date.now().toString(36)}`, text, fontId, arcDeg: 0, color: ink, cx: rtl ? 1 - mid : mid, cy: aspect / 2, w, h, rot: 0 };
  };

  // ---- Post it: the picture in the kit ----
  void import('./postMoment').then(({ setPostKit }) =>
    setPostKit(() => {
      const k = active;
      if (!live || !k) return null;
      // A free export carries no Pro font: the kit's voice on the band only while Pro runs, or when it is a free one.
      const font = k.font && (running || !isProVoice(k.font)) ? fontCssOf(k.font) : '';
      return { name: opts.kitName(k), colours: k.colors, fontCss: font, logo: k.logos[0]?.bitmap ?? null };
    }),
  ).catch(() => {});

  // The banner store is made by main.ts and may come after this mounts: followed once it is there.
  let following = false;
  const paint = (): void => {
    if (!following && bannerScene.store) {
      following = true;
      bannerScene.store.onChange(paintBlock);
    }
    paintChip();
    paintBlock();
  };
  onLangChange(paint);

  const api: KitEverywhere = {
    setKits(next) {
      kits = next;
      // The kit in use, as the store has it now (renamed, or deleted on another device).
      if (active) {
        const now = kits.find((k) => k.id === active!.id) ?? null;
        if (now !== active) api.setActive(now);
      } else {
        const want = projectKey() ? remembered()[projectKey()!] : undefined;
        const k = want ? kits.find((x) => x.id === want) : undefined;
        if (k) api.setActive(k);
      }
      paint();
    },
    setActive(kit) {
      active = kit;
      activeKit.current = kit ? { name: opts.kitName(kit), colours: kit.colors.slice(), ...(kit.font ? { font: kit.font } : {}) } : null;
      remember(kit?.id ?? null);
      if (kit) fontFor(kit);
      window.dispatchEvent(new CustomEvent('tifo:kit-active'));
      paint();
    },
    get active() {
      return active;
    },
    setPro(l, r) {
      live = l;
      running = r;
      if (!live) activeKit.current = null;
      else if (active) activeKit.current = { name: opts.kitName(active), colours: active.colors.slice(), ...(active.font ? { font: active.font } : {}) };
      paint();
    },
  };
  return api;
}
