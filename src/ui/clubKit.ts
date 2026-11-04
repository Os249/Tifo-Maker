/**
 * Club kit (Pro): a club's colours, logos and font, saved once and dropped
 * into any project in one tap. Mounted by proTools.ts, which loads this
 * module only for an account /api/pro says Pro is on for, so the editor's
 * start carries none of its code or words.
 *
 * Where it is: "Club kit", crowned, beside Import palette and Save palette in
 * the Colours panel. It opens a sheet (a dialog on a desktop, a bottom sheet
 * on a phone): "Save this design as a kit", the kits as cards (a colour strip,
 * the logos, the font), "Use in this project" as each card's one action, and
 * Rename and Delete as quiet ones.
 *
 * Use in this project, in one tap:
 *  - the kit's colours become the palette, as the preset menu's "Remap" does:
 *    index 0 (the empty seat) stays, and every painted seat (a colour past the
 *    new palette's end included) takes the nearest kit colour. It is ONE undo
 *    step, the palette with it (DesignStore.remapToPalette `undoPalette`);
 *  - the kit's font becomes the Text tool's font;
 *  - the logos are offered, not stamped: the first waits in Picture import,
 *    and each one placed brings the next, until all are down or Cancel is
 *    pressed. A row of the kit's logos in the import bar picks any of them.
 *    MAX_PICTURES holds. Real colours is off while a kit logo waits, so a logo
 *    is drawn in the kit's colours rather than growing the palette.
 *
 * Kept on the account (ui/clubKitStore.ts; server/src/kitRoutes.ts), so a kit
 * made on a laptop is there on the phone, with a copy in this browser for
 * when the network is not; the kits this browser made before move up the
 * first time. The sheet says where they are. Beyond the seats, the kit in use
 * dresses the AI designer's brief, banners and Post it (ui/kitEverywhere.ts).
 *
 * Free to try once: an account without Pro running can open it, save kits and
 * use one in a project FREE_KIT_USES times (remembered in this browser; a
 * courtesy, not a lock). After that "Use in this project" opens the gift (when
 * one waits) or "What Pro adds". With Pro running there is no limit and the
 * crown is quiet. Like the rest of Pro in the interface, it shows what
 * /api/pro says.
 */
import './clubKit.css';
import { escapeHtml } from '../core/escape';
import { MAX_PICTURES, decodePictureSrc, type ImageObject } from '../core/objects';
import { PRO_FONTS } from '../core/proVoices';
import { TIFO_FONTS } from '../core/text';
import { fetchPro, type ProState } from '../net/api';
import { containDialog } from './dialogFocus';
import { onLangChange, t, tv } from './i18n';
import { CROWN_SVG, proChipHtml } from './pro';
import type { ProToolsContext } from './proTools';
import {
  KIT_NAME_MAX, MAX_KITS, MAX_KIT_LOGOS, cleanName, forgetKit, lastSaved, loadKits, logoFromFile, logoFromImage, newKitId, storeKit,
  type ClubKit, type KitLoad, type KitLogo,
} from './clubKitStore';
import { mountKitEverywhere } from './kitEverywhere';
import { bannerScene } from './bannerHost';

/** How many times an account without Pro running may use a kit in a project. */
export const FREE_KIT_USES = 1;

/** Where this browser remembers the free uses (a courtesy, not a lock). */
const FREE_KEY = 'tifo_kit_free_v1';
const HEX = /^#[0-9a-f]{6}$/i;
const esc = escapeHtml;
/** A kit's name inside a sentence, isolated, so a Latin name keeps its quotes in place in an Arabic one. */
const iso = (s: string): string => `\u2068${s}\u2069`;
const CHECK_SVG = '<svg class="kit-tick" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
/** Where the kits are: a cloud with a tick (on the account), a cloud struck through (offline). */
const CLOUD_SVG = '<svg class="kit-cloud" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M7 18h10.5a4 4 0 0 0 .4-7.98A6 6 0 0 0 6.3 9.1 4.5 4.5 0 0 0 7 18z"/><path d="M9.5 13.2l2 2 3.6-3.8"/></svg>';
const CLOUD_OFF_SVG = '<svg class="kit-cloud" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M7 18h10.5a4 4 0 0 0 .4-7.98A6 6 0 0 0 6.3 9.1 4.5 4.5 0 0 0 7 18z"/><path d="M4 4l16 16"/></svg>';

// -------------------------------------------------------------- free try ---

let usedThisSession = 0;

function freeUsed(): number {
  try {
    const n = Number.parseInt(localStorage.getItem(FREE_KEY) ?? '0', 10);
    return Math.max(usedThisSession, Number.isFinite(n) && n > 0 ? n : 0);
  } catch {
    return usedThisSession;
  }
}

function spendFree(): void {
  usedThisSession = freeUsed() + 1;
  try {
    localStorage.setItem(FREE_KEY, String(usedThisSession));
  } catch {
    /* this session still counts it */
  }
}

// ----------------------------------------------------------------- fonts ---

interface Voice {
  id: string;
  name: string;
  pro: boolean;
}

/** The voices the Text tool offers that a kit can keep: the free ones and the Pro ones (not an uploaded file, which lasts a session). */
function voices(): Voice[] {
  return [
    ...TIFO_FONTS.filter((f) => !f.id.startsWith('tifo-custom-')).map((f) => ({ id: f.id, name: f.name, pro: false })),
    ...PRO_FONTS.map((f) => ({ id: f.id, name: f.name, pro: true })),
  ];
}

const knownFont = (id: string): boolean => voices().some((v) => v.id === id);
const fontName = (id: string): string => voices().find((v) => v.id === id)?.name ?? '';

/** Draw a picture into a canvas, whole and centred. */
function drawFit(cv: HTMLCanvasElement, img: ImageBitmap | null | undefined): void {
  const g = cv.getContext('2d');
  if (!g) return;
  g.clearRect(0, 0, cv.width, cv.height);
  if (!img || !img.width || !img.height) return;
  const s = Math.min(cv.width / img.width, cv.height / img.height);
  const w = img.width * s;
  const h = img.height * s;
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = 'high';
  g.drawImage(img, (cv.width - w) / 2, (cv.height - h) / 2, w, h);
}

/** Colour chips take their colour from data through a custom property, checked first. */
function paintColours(root: ParentNode): void {
  for (const el of root.querySelectorAll<HTMLElement>('[data-c]')) {
    const c = el.dataset.c ?? '';
    if (HEX.test(c)) el.style.setProperty('--kit-c', c);
  }
}

/** A picture in the "save a kit" form: one of the design's, or one added there. */
interface Pic {
  label: string;
  bitmap: ImageBitmap | null;
  src?: string;
  /** Ready for keeping (an added file); a design picture is made into one on Save. */
  logo: KitLogo | null;
  on: boolean;
}

export function mountClubKit(ctx: ProToolsContext): void {
  const { store, editor, objects } = ctx;
  const links = document.getElementById('palette-save')?.parentElement;
  if (!links) return;

  let live = false;
  let running = false;
  let pro: ProState | null = null;

  // ---- the kits ----
  let kits: ClubKit[] = [];
  let kept = true;
  let dropped = 0;
  let loaded = false;
  /** Where the kits are, as the last load found them (the sheet says so). */
  let where: Pick<KitLoad, 'where' | 'offline' | 'moved' | 'left'> = {};
  let loading: Promise<void> | null = null;
  /** Read again each time the sheet opens: a kit saved on another device is there. */
  const load = (): Promise<void> =>
    (loading ??= loadKits(knownFont).then(
      (r) => {
        kits = r.kits;
        kept = r.kept;
        dropped += r.dropped;
        // "Moved up" is news until the sheet has said it, whichever load did the moving.
        where = { where: r.where, offline: r.offline, moved: (where.moved ?? 0) + (r.moved ?? 0), left: r.left };
        loaded = true;
        everywhere.setKits(kits);
      },
      () => {
        kept = false;
        loaded = true;
      },
    ).finally(() => {
      loading = null;
    }));
  const onAccount = (): boolean => where.where === 'account';
  const kitName = (k: ClubKit): string => k.name || t('kit.defaultName');
  const everywhere = mountKitEverywhere({
    kitName,
    say: (msg) => ctx.say(msg),
    mayUse: async (kit) => {
      if (running || everywhere.active?.id === kit.id) return true;
      if (freeUsed() < FREE_KIT_USES) {
        spendFree();
        everywhere.setActive(kit);
        return true;
      }
      await offerPro();
      return false;
    },
  });

  // ---- the entry: beside Import palette and Save palette ----
  const entry = document.createElement('button');
  entry.type = 'button';
  entry.className = 'link-btn kit-entry';
  entry.hidden = true;
  links.appendChild(entry);
  const paintEntry = (): void => {
    entry.innerHTML = `<span>${esc(t('kit.entry'))}</span>${proChipHtml({ quiet: running })}`;
    entry.title = t('kit.entryT');
  };
  entry.addEventListener('click', () => void openKitSheet());

  // ---- the sheet ----
  let sheet: { root: HTMLElement; body: HTMLElement; close: () => void } | null = null;
  let view: 'list' | 'new' = 'list';
  let form: { colors: { hex: string; on: boolean }[]; pics: Pic[]; name: string; font: string } | null = null;

  const note = (msg: string): void => {
    const n = sheet?.body.querySelector('.kit-note');
    if (n) n.textContent = msg;
  };
  const focusIn = (sel: string): void => {
    const el = sheet?.body.querySelector<HTMLElement>(sel);
    el?.focus({ preventScroll: false });
  };

  const openKitSheet = async (): Promise<void> => {
    if (sheet || !live) return;
    const root = document.createElement('div');
    root.className = 'pro-sheet-backdrop kit-backdrop';
    root.innerHTML =
      `<div class="pro-sheet kit-sheet" role="dialog" aria-modal="true">` +
      `<button type="button" class="pro-sheet-close" aria-label="${esc(t('common.close'))}">&times;</button>` +
      `<div class="pro-sheet-body kit-body"><h2 tabindex="-1">${esc(t('kit.entry'))}</h2><p class="kit-hint">${esc(t('kit.loading'))}</p></div></div>`;
    document.body.appendChild(root);
    let finished = false;
    const close = (): void => {
      if (finished) return;
      finished = true;
      release();
      if (sheet?.root === root) sheet = null;
      form = null;
      // Closes quicker than it opened, and never waits on reduced motion.
      root.classList.add('closing');
      const gone = (): void => root.remove();
      const ms = parseFloat(getComputedStyle(root).animationDuration || '0') * 1000;
      if (ms > 0) setTimeout(gone, ms);
      else gone();
    };
    const release = containDialog(root, close);
    root.addEventListener('mousedown', (e) => {
      if (e.target === root) close();
    });
    root.querySelector('.pro-sheet-close')!.addEventListener('click', close);
    const body = root.querySelector('.kit-body') as HTMLElement;
    body.addEventListener('click', (e) => onSheetClick(e));
    sheet = { root, body, close };
    await load();
    if (sheet?.root !== root) return;
    renderList();
    focusIn('h2');
  };

  const cardHtml = (k: ClubKit): string => {
    const name = kitName(k);
    const font = k.font ? fontName(k.font) : '';
    return (
      `<li class="kit-card" data-id="${esc(k.id)}">` +
      `<div class="kit-card-head"><h3 class="kit-name"><bdi>${esc(name)}</bdi></h3>` +
      `<span class="kit-quiet">` +
      `<button type="button" class="kit-link" data-act="rename" aria-label="${esc(tv('kit.renameA', { name }))}">${esc(t('kit.rename'))}</button>` +
      `<button type="button" class="kit-link" data-act="delete" aria-label="${esc(tv('kit.deleteA', { name }))}">${esc(t('kit.delete'))}</button>` +
      `</span></div>` +
      `<div class="kit-strip" role="img" aria-label="${esc(tv('kit.coloursA', { n: k.colors.length }))}">` +
      k.colors.map((c) => `<span data-c="${esc(c)}"></span>`).join('') +
      `</div>` +
      `<div class="kit-row">` +
      (k.logos.length
        ? `<span class="kit-logos">${k.logos.map((_, i) => `<canvas class="kit-logo" width="96" height="96" data-logo="${i}" role="img" aria-label="${esc(tv('kit.logoA', { n: i + 1, name }))}"></canvas>`).join('')}</span>`
        : `<span class="kit-none">${esc(t('kit.noLogos'))}</span>`) +
      `<span class="kit-font">${esc(font ? tv('kit.fontIs', { name: font }) : t('kit.noFont'))}</span>` +
      `</div>` +
      `<button type="button" class="kit-use" data-act="use">${esc(t('kit.use'))}</button>` +
      `</li>`
    );
  };

  const renderList = (msg = ''): void => {
    if (!sheet) return;
    view = 'list';
    form = null;
    const full = kits.length >= MAX_KITS;
    const left = FREE_KIT_USES - freeUsed();
    // One blue step at most: saving the first kit. With kits, Use is each card's (tinted) step.
    sheet.body.innerHTML =
      `<h2 class="kit-h" tabindex="-1"><span>${esc(t('kit.entry'))}</span>${proChipHtml({ quiet: running })}</h2>` +
      `<p>${esc(t('kit.lead'))}</p>` +
      (onAccount()
        ? `<p class="kit-where${where.offline ? ' off' : ''}">${where.offline ? CLOUD_OFF_SVG : CLOUD_SVG}<span>${esc(t(where.offline ? 'qk.offline' : 'qk.onAccount'))}</span></p>`
        : '') +
      (!running ? `<div class="pro-strip kit-free">${CROWN_SVG}<span>${esc(t(left > 0 ? 'kit.freeOnce' : 'kit.freeUsed'))}</span></div>` : '') +
      (kits.length ? `<ul class="kit-cards">${kits.map(cardHtml).join('')}</ul>` : `<p class="kit-empty">${esc(t('kit.empty'))}</p>`) +
      `<div class="pro-actions">` +
      `<button type="button" class="${kits.length ? 'pro-alt' : 'pro-primary'}" data-act="new"${full ? ' disabled' : ''}>${esc(t('kit.save'))}</button>` +
      `</div>` +
      (full ? `<p class="kit-hint kit-center">${esc(tv('kit.full', { n: MAX_KITS }))}</p>` : '') +
      (!onAccount() && !kept ? `<p class="kit-hint kit-center">${esc(t('kit.notKept'))}</p>` : '') +
      (where.left ? `<p class="kit-hint kit-center">${esc(t('qk.left'))}</p>` : '') +
      `<p class="pro-note kit-note" role="status" aria-live="polite"></p>`;
    paintColours(sheet.body);
    for (const cv of sheet.body.querySelectorAll<HTMLCanvasElement>('canvas[data-logo]')) {
      const kit = kits.find((k) => k.id === cv.closest<HTMLElement>('[data-id]')?.dataset.id);
      drawFit(cv, kit?.logos[Number(cv.dataset.logo)]?.bitmap);
    }
    // The status line is filled after it is in the page, so it is spoken.
    const say = msg || (dropped ? t('kit.dropped') : where.moved ? t('qk.moved') : '');
    dropped = 0;
    where.moved = 0;
    if (say) requestAnimationFrame(() => note(say));
  };

  // ---- save this design as a kit ----
  const logoInput = document.createElement('input');
  logoInput.type = 'file';
  logoInput.className = 'kit-logo-file';
  logoInput.accept = 'image/png,image/jpeg,image/webp,image/gif';
  logoInput.hidden = true;
  logoInput.setAttribute('aria-hidden', 'true');
  logoInput.tabIndex = -1;
  document.body.appendChild(logoInput);

  const fontOptions = (chosen: string): string => {
    const all = voices();
    const opt = (v: Voice): string => `<option value="${esc(v.id)}"${v.id === chosen ? ' selected' : ''}>${esc(v.name)}</option>`;
    return (
      all.filter((v) => !v.pro).map(opt).join('') +
      `<optgroup label="${esc(t('kit.fontPro'))}">${all.filter((v) => v.pro).map(opt).join('')}</optgroup>`
    );
  };

  const paintPics = (): void => {
    const box = sheet?.body.querySelector<HTMLElement>('.kit-pics');
    if (!box || !form) return;
    box.innerHTML =
      form.pics.map((p, i) =>
        `<button type="button" class="kit-pic" data-act="pic" data-i="${i}" aria-pressed="${p.on}" aria-label="${esc(tv('kit.picA', { name: p.label }))}">` +
        `<canvas width="112" height="112" aria-hidden="true"></canvas>${CHECK_SVG}</button>`).join('') +
      `<button type="button" class="kit-add" data-act="add-logo"><i class="ti ti-plus" aria-hidden="true"></i><span>${esc(t('kit.addLogo'))}</span></button>`;
    box.querySelectorAll<HTMLCanvasElement>('.kit-pic canvas').forEach((cv, i) => drawFit(cv, form?.pics[i]?.bitmap));
  };

  const renderForm = (): void => {
    if (!sheet) return;
    if (kits.length >= MAX_KITS) return renderList(tv('kit.full', { n: MAX_KITS }));
    if (!form) {
      const colors: string[] = [];
      for (const c of store.palette.slice(1)) {
        const hex = typeof c === 'string' && HEX.test(c) ? c.toLowerCase() : '';
        if (hex && !colors.includes(hex)) colors.push(hex);
      }
      if (!colors.length) return renderList(t('kit.noColours'));
      const pics: Pic[] = objects.list()
        .filter((o): o is ImageObject => o.kind === 'image')
        .map((o, i) => ({ label: o.label || o.name, bitmap: o.bitmap, src: o.src, logo: null, on: i < MAX_KIT_LOGOS }));
      const tf = (document.getElementById('text-font') as HTMLSelectElement | null)?.value ?? '';
      form = {
        colors: colors.map((hex) => ({ hex, on: true })),
        pics,
        name: cleanName(ctx.title()),
        font: knownFont(tf) ? tf : voices()[0].id,
      };
      // A design picture that has not been decoded yet gets its thumbnail when it is.
      for (const p of pics) {
        if (p.bitmap || !p.src) continue;
        void decodePictureSrc(p.src).then((b) => {
          p.bitmap = b;
          if (view === 'new') paintPics();
        });
      }
    }
    view = 'new';
    const f = form;
    sheet.body.innerHTML =
      `<h2 tabindex="-1">${esc(t('kit.save'))}</h2>` +
      `<div class="kit-field"><label for="kit-name">${esc(t('kit.name'))}</label>` +
      `<input id="kit-name" type="text" dir="auto" maxlength="${KIT_NAME_MAX}" autocomplete="off" spellcheck="false" placeholder="${esc(t('kit.namePh'))}" value="${esc(f.name)}"></div>` +
      `<fieldset class="kit-set"><legend>${esc(t('kit.colours'))}</legend>` +
      `<p class="kit-hint" id="kit-colours-hint">${esc(t('kit.coloursHint'))}</p>` +
      `<div class="kit-colours">` +
      f.colors.map((c, i) => `<button type="button" class="kit-colour" data-act="colour" data-i="${i}" data-c="${esc(c.hex)}" aria-pressed="${c.on}" aria-label="${esc(tv('kit.colourA', { hex: c.hex }))}" aria-describedby="kit-colours-hint"></button>`).join('') +
      `</div></fieldset>` +
      `<fieldset class="kit-set"><legend>${esc(t('kit.logos'))}</legend>` +
      `<p class="kit-hint">${esc(tv(f.pics.length ? 'kit.logosHint' : 'kit.logosHintNone', { n: MAX_KIT_LOGOS }))}</p>` +
      `<div class="kit-pics"></div></fieldset>` +
      `<div class="kit-field"><label for="kit-font">${esc(t('kit.font'))}</label><select id="kit-font">${fontOptions(f.font)}</select></div>` +
      `<div class="pro-actions">` +
      `<button type="button" class="pro-primary" data-act="save">${esc(t('kit.saveGo'))}</button>` +
      `<button type="button" class="pro-text-btn" data-act="back">${esc(t('kit.back'))}</button>` +
      `</div><p class="pro-note kit-note" role="status" aria-live="polite"></p>`;
    paintColours(sheet.body);
    paintPics();
    const nameInput = sheet.body.querySelector<HTMLInputElement>('#kit-name')!;
    nameInput.addEventListener('input', () => {
      if (form) form.name = nameInput.value;
    });
    const fontSel = sheet.body.querySelector<HTMLSelectElement>('#kit-font')!;
    fontSel.addEventListener('change', () => {
      if (form) form.font = fontSel.value;
    });
  };

  const onCount = (): number => form?.pics.filter((p) => p.on).length ?? 0;

  logoInput.addEventListener('change', async () => {
    const file = logoInput.files?.[0];
    logoInput.value = '';
    if (!file || !form || view !== 'new') return;
    note(t('kit.reading'));
    const logo = await logoFromFile(file);
    if (!form || view !== 'new') return;
    if (!logo) return note(t('kit.logoFailed'));
    const on = onCount() < MAX_KIT_LOGOS;
    form.pics.push({ label: file.name, bitmap: logo.bitmap, logo, on });
    paintPics();
    note(on ? '' : tv('kit.logosMax', { n: MAX_KIT_LOGOS }));
    focusIn(`.kit-pic[data-i="${form.pics.length - 1}"]`);
  });

  const saveForm = async (): Promise<void> => {
    if (!sheet || !form) return;
    const f = form;
    const colors = f.colors.filter((c) => c.on).map((c) => c.hex);
    if (!colors.length) return note(t('kit.needColour'));
    if (kits.length >= MAX_KITS) return renderList(tv('kit.full', { n: MAX_KITS }));
    const go = sheet.body.querySelector<HTMLButtonElement>('[data-act="save"]');
    if (go) go.disabled = true;
    note(t('kit.saving'));
    const logos: KitLogo[] = [];
    for (const p of f.pics.filter((x) => x.on).slice(0, MAX_KIT_LOGOS)) {
      let logo = p.logo;
      if (!logo) {
        const src = p.bitmap ?? (p.src ? await decodePictureSrc(p.src) : null);
        logo = src ? await logoFromImage(src) : null;
      }
      if (logo) logos.push(logo);
    }
    if (form !== f || !sheet) return;
    const name = cleanName(f.name) || t('kit.defaultName');
    const kit: ClubKit = { id: newKitId(), name, colors, logos, font: knownFont(f.font) ? f.font : '', at: Date.now() };
    kits.push(kit);
    everywhere.setKits(kits);
    const ok = (kept || onAccount()) && (await storeKit(kit));
    if (!sheet) return;
    const went = lastSaved();
    renderList(!ok ? t('kit.notKept') : tv(went === 'account' ? 'qk.saved' : went === 'later' ? 'qk.savedLater' : 'kit.saved', { name: iso(name) }));
    focusIn(`.kit-card[data-id="${kit.id}"] .kit-use`);
  };

  const renameKit = async (kit: ClubKit): Promise<void> => {
    const { promptModal } = await import('./modal');
    const v = await promptModal({
      title: t('kit.renameTitle'),
      defaultValue: kitName(kit),
      placeholder: t('kit.namePh'),
      confirmLabel: t('kit.rename'),
      maxLength: KIT_NAME_MAX,
    });
    const name = cleanName(v);
    if (!name || !sheet) return;
    kit.name = name;
    everywhere.setKits(kits);
    const ok = (kept || onAccount()) && (await storeKit(kit));
    if (!sheet) return;
    renderList(ok ? tv('kit.renamed', { name: iso(name) }) : t('kit.notKept'));
    focusIn(`.kit-card[data-id="${kit.id}"] [data-act="rename"]`);
  };

  const deleteKit = async (kit: ClubKit): Promise<void> => {
    const { confirmModal } = await import('./modal');
    const name = kitName(kit);
    const yes = await confirmModal({
      title: tv('kit.deleteQ', { name: iso(name) }),
      message: t(onAccount() ? 'qk.deleteMsg' : 'kit.deleteMsg'),
      confirmLabel: t('kit.delete'),
      cancelLabel: t('kit.keep'),
      danger: true,
    });
    if (!yes) return;
    kits = kits.filter((k) => k !== kit);
    everywhere.setKits(kits);
    const ok = (kept || onAccount()) && (await forgetKit(kit.id));
    if (!sheet) return;
    renderList(ok || !kept ? tv('kit.deleted', { name: iso(name) }) : t('kit.notKept'));
    focusIn('h2');
  };

  const onSheetClick = (e: Event): void => {
    const b = (e.target as Element | null)?.closest<HTMLElement>('[data-act]');
    if (!b || !sheet?.body.contains(b) || (b as HTMLButtonElement).disabled) return;
    const kit = kits.find((k) => k.id === b.closest<HTMLElement>('[data-id]')?.dataset.id);
    const i = Number(b.dataset.i);
    switch (b.dataset.act) {
      case 'new':
        renderForm();
        focusIn('#kit-name');
        break;
      case 'back':
        renderList();
        focusIn('[data-act="new"]');
        break;
      case 'save':
        void saveForm();
        break;
      case 'use':
        if (kit) void useKit(kit);
        break;
      case 'rename':
        if (kit) void renameKit(kit);
        break;
      case 'delete':
        if (kit) void deleteKit(kit);
        break;
      case 'add-logo':
        logoInput.click();
        break;
      case 'colour': {
        const c = form?.colors[i];
        if (!c || !form) break;
        if (c.on && form.colors.filter((x) => x.on).length <= 1) {
          note(t('kit.needColour'));
          break;
        }
        c.on = !c.on;
        b.setAttribute('aria-pressed', String(c.on));
        note('');
        break;
      }
      case 'pic': {
        const p = form?.pics[i];
        if (!p) break;
        if (!p.on && onCount() >= MAX_KIT_LOGOS) {
          note(tv('kit.logosMax', { n: MAX_KIT_LOGOS }));
          break;
        }
        p.on = !p.on;
        b.setAttribute('aria-pressed', String(p.on));
        note('');
        break;
      }
    }
  };

  // ---- use in this project ----
  /** The palettes a kit put in: an undo or redo that lands on one redraws the editor's colours. */
  const ours = new WeakSet<string[]>();
  const pickSwatch = (idx: number): void => {
    const b = document.querySelector<HTMLButtonElement>(`#palette button.swatch[data-idx="${idx}"]`);
    if (b) b.click();
    else editor.colorIndex = idx;
  };
  const followPalette = (): void => {
    ctx.paletteChanged();
    editor.repaintAll();
    editor.objectOverlay?.sync();
    editor.refreshStampPreviewTint();
    if (editor.colorIndex >= store.palette.length) pickSwatch(store.palette.length - 1);
  };
  store.onPaletteChange(() => {
    if (ours.has(store.palette)) followPalette();
  });

  const applyKit = (kit: ClubKit): void => {
    const empty = store.palette[0];
    const next = (typeof empty === 'string' ? [empty, ...kit.colors] : kit.colors.slice()).slice(0, 256);
    ours.add(store.palette);
    // The preset menu's Remap: seats take the nearest kit colour; one undo step, palette and all.
    store.remapToPalette(next, { undoPalette: true });
    ours.add(store.palette);
    followPalette();
    const preset = document.getElementById('preset') as HTMLSelectElement | null;
    if (preset) preset.value = '';
    // The Text tool's font, through its own picker, so its preview follows.
    const tf = document.getElementById('text-font') as HTMLSelectElement | null;
    const font = !!kit.font && !!tf && Array.from(tf.options).some((o) => o.value === kit.font);
    if (font && tf) {
      tf.value = kit.font;
      tf.dispatchEvent(new Event('change'));
    }
    ctx.say(tv(font ? 'kit.used' : 'kit.usedColours', { name: iso(kitName(kit)) }));
    // In the project now: the AI designer, banners and Post it wear it too.
    everywhere.setActive(kit);
    if (kit.logos.length) offer(kit);
  };

  /** The free try is spent: the gift when one waits, else what Pro adds. */
  const offerPro = async (): Promise<void> => {
    sheet?.close();
    const st = pro;
    const m = await import('./proSheets');
    if (!st) return;
    if (st.gift?.state === 'offered') await m.openGiftSheet(st);
    else await m.openProSheet(st, { lead: t('kit.sheetLead') });
  };

  const useKit = async (kit: ClubKit): Promise<void> => {
    const st = await fetchPro().catch(() => pro);
    show(st);
    if (!live) return;
    if (!running && freeUsed() >= FREE_KIT_USES) {
      await offerPro();
      return;
    }
    sheet?.close();
    applyKit(kit);
    if (!running) spendFree();
  };

  // ---- the kit's logos in Picture import ----
  let offered: { kit: ClubKit; placed: boolean[] } | null = null;
  /** Placing one brings the next, until all are down or Cancel is pressed. */
  let queue = false;
  let pendingArm: number | null = null;
  let armedLogo: number | null = null;
  let countAtArm = 0;
  let firstOfKit = false;

  const strip = document.createElement('span');
  strip.className = 'tb-field kit-logos-field';
  strip.hidden = true;
  strip.innerHTML = '<span class="kit-logos-label" id="kit-logos-label"></span><span class="kit-logos-row" role="group" aria-labelledby="kit-logos-label"></span>';
  const stripLabel = strip.firstElementChild as HTMLElement;
  const stripRow = strip.lastElementChild as HTMLElement;
  const bar = document.getElementById('import-bar');
  const importName = document.getElementById('import-name');
  if (bar) {
    if (importName?.parentElement === bar) importName.after(strip);
    else bar.prepend(strip);
  }
  const paintStrip = (): void => {
    stripLabel.textContent = t('kit.logosField');
    strip.hidden = !live || !offered || !offered.kit.logos.length;
    if (!offered || strip.hidden) {
      stripRow.textContent = '';
      return;
    }
    const { kit, placed } = offered;
    const name = kitName(kit);
    const full = objects.pictureCount() >= MAX_PICTURES;
    stripRow.innerHTML = kit.logos.map((_, i) =>
      `<button type="button" class="kit-logo-btn${placed[i] ? ' placed' : ''}" data-i="${i}" aria-pressed="${armedLogo === i}"` +
      ` aria-label="${esc(tv(placed[i] ? 'kit.logoPlacedA' : 'kit.logoA', { n: i + 1, name }))}"${full && armedLogo !== i ? ' disabled' : ''}>` +
      `<canvas width="72" height="72" aria-hidden="true"></canvas>${placed[i] ? CHECK_SVG : ''}</button>`).join('');
    stripRow.querySelectorAll('canvas').forEach((cv, i) => drawFit(cv, kit.logos[i]?.bitmap));
  };
  stripRow.addEventListener('click', (e) => {
    const b = (e.target as Element | null)?.closest<HTMLButtonElement>('.kit-logo-btn');
    if (!b || b.disabled) return;
    queue = true;
    arm(Number(b.dataset.i));
  });

  /** Real colours would grow the palette past the kit's colours: off while a kit logo waits, as it was after. */
  let realWas: boolean | null = null;
  const realBox = (): HTMLInputElement | null => document.getElementById('real-colors') as HTMLInputElement | null;
  const realOff = (): void => {
    const box = realBox();
    if (!box || box.disabled || realWas !== null) return;
    realWas = box.checked;
    box.checked = false;
  };
  const realBack = (): void => {
    const box = realBox();
    if (box && realWas !== null && !box.disabled) box.checked = realWas;
    realWas = null;
  };

  const fileName = (kit: ClubKit, i: number): string => `${kitName(kit).replace(/[\\/:*?"<>|]+/g, '-')} ${i + 1}.png`;

  /** Put kit logo i in Picture import, through its own file input: the toolbar arms it as any picked picture. */
  const arm = (i: number): void => {
    if (!offered || !live) return;
    const logo = offered.kit.logos[i];
    const input = document.getElementById('import-file') as HTMLInputElement | null;
    if (!logo || !input) return;
    if (objects.pictureCount() >= MAX_PICTURES) {
      queue = false;
      realBack();
      paintStrip();
      ctx.say(tv('kit.picFull', { n: MAX_PICTURES }));
      return;
    }
    try {
      const dt = new DataTransfer();
      dt.items.add(new File([logo.blob], fileName(offered.kit, i), { type: logo.blob.type || 'image/png' }));
      input.files = dt.files;
    } catch {
      queue = false;
      ctx.say(t('kit.armFailed'));
      return;
    }
    pendingArm = i;
    realOff();
    input.dispatchEvent(new Event('change'));
  };

  const offer = (kit: ClubKit): void => {
    offered = { kit, placed: kit.logos.map(() => false) };
    queue = true;
    firstOfKit = true;
    arm(0);
    paintStrip();
  };

  document.addEventListener('tifo:import-armed', () => {
    armedLogo = pendingArm;
    pendingArm = null;
    if (armedLogo === null) realBack(); // a picture of their own
    else if (offered) {
      countAtArm = objects.pictureCount();
      const n = offered.kit.logos.length;
      const name = iso(kitName(offered.kit));
      const msg = firstOfKit ? tv('kit.logoFirst', { name, n }) : tv('kit.logoReady', { i: armedLogo + 1, n, name });
      firstOfKit = false;
      // After the toolbar's own "ready" line, which it writes once this event has run.
      setTimeout(() => ctx.say(msg), 0);
    }
    paintStrip();
  });
  document.addEventListener('tifo:import-done', () => {
    const i = armedLogo;
    armedLogo = null;
    if (i !== null && offered) {
      if (objects.pictureCount() > countAtArm) {
        offered.placed[i] = true;
        const next = offered.placed.findIndex((p) => !p);
        if (queue && next >= 0) setTimeout(() => arm(next), 0);
        else {
          queue = false;
          realBack();
        }
      } else {
        // Cancelled: the rest wait in the row for when Picture import is open again.
        queue = false;
        realBack();
      }
    }
    paintStrip();
  });

  // ---- Pro on, Pro running ----
  /** Only while /api/pro says Pro is on for this account: a sign-out takes it all away. */
  function show(st: ProState | null): void {
    pro = st;
    live = !!st?.live;
    running = live && !!st?.plan && st.plan !== 'free';
    entry.hidden = !live;
    if (!live) {
      sheet?.close();
      offered = null;
      queue = false;
      realBack();
    }
    everywhere.setPro(live, running);
    // The kits once at the start, so the kit this project used is back in use (the AI, banners, Post it).
    if (live && !loaded) void load();
    paintEntry();
    paintStrip();
    if (sheet && view === 'list' && loaded) renderList();
  }
  paintEntry();
  const refresh = (): void => void fetchPro(true).then(show, () => show(null));
  void fetchPro().then(show, () => show(null));
  window.addEventListener('tifo:auth', refresh);
  window.addEventListener('tifo:pro', refresh);
  onLangChange(() => {
    paintEntry();
    paintStrip();
    if (!sheet || !loaded) return;
    if (view === 'new') renderForm();
    else renderList();
  });

  // The browser suite's way in (e2e-pro-kit.mjs). Opt-in by URL only: main.ts
  // sets window.__tifo for ?e2e=1 at boot, before the address bar is tidied.
  if ((window as unknown as { __tifo?: unknown }).__tifo) {
    (window as unknown as { __tifoClubKit?: unknown }).__tifoClubKit = {
      kits: () => kits.map((k) => ({ id: k.id, name: k.name, colors: k.colors.slice(), logos: k.logos.length, font: k.font })),
      kept: () => kept,
      freeUsed,
      offered: () => (offered ? { name: offered.kit.name, placed: offered.placed.slice(), armed: armedLogo } : null),
      where: () => ({ ...where }),
      active: () => everywhere.active?.id ?? null,
      reload: () => load(),
      banner: () => {
        const d = bannerScene.store?.active;
        return d ? { kind: d.kind, bg: d.bg, items: d.items.map((i) => ({ kind: i.kind, ...('fontId' in i ? { fontId: i.fontId } : {}), ...('color' in i ? { color: i.color } : {}), ...('name' in i ? { name: i.name } : {}), ...('cx' in i ? { cx: i.cx, w: i.w } : {}) })) } : null;
      },
    };
  }
}
