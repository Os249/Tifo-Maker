/**
 * The AI drawer: one home for both AI tools.
 *
 * The AI tab opens on two doors. "Create a new tifo" is the AI Designer
 * (ui/aiPanel.ts, unchanged, in its own view): it replaces what is on the
 * stands. "Review my tifo" is AI Critique, which is this file: it keeps the
 * design and suggests fixes, one card each, and nothing changes until Apply
 * is pressed. Each door says what it does to the tifo and carries its own
 * counter, shown before anything is spent.
 *
 * Critique's answer is a list of typed operations (core/fixParse.ts). Every
 * one is checked against the live design again before it is applied, and
 * applied as one undo step (core/fixOps.ts). Nothing the model wrote is ever
 * put on the page as HTML.
 */
import type { DesignStore } from '../core/design';
import { describeDesign } from '../core/designText';
import { applyFix, fixContextOf, parseFixOp, type AppliedFix, type ColorRef, type FixOp, type FixOpType } from '../core/fixOps';
import { textObjectSize, type ObjectLayer } from '../core/objects';
import type { SeatMap } from '../core/types';
import {
  chatAiTifo, fetchAiQuota, fetchPro, isSignedIn, resendVerification, reviewAiTifo,
  type AiError, type AiLimits, type AiQuota, type Allowance, type ProState, type ReviewQuota, type ReviewRefusal, type ReviewResult,
} from '../net/api';
import { track } from '../net/analytics';
import type { Editor } from '../render/editor';
import { canvasOf, stripPixels } from '../render/seatPixels';
import { openAuthModal } from './authModal';
import { getLang, onLangChange, t, tv } from './i18n';
import { backWhen, limitBack, limitTitle, proChipHtml } from './pro';
import './aiDrawer.css';

export type AiView = 'home' | 'create' | 'review';

export interface AiDrawerDeps {
  root: HTMLElement;
  store: DesignStore;
  objects: ObjectLayer;
  map: SeatMap;
  editor: Editor;
  /** The project's name, as typed. */
  title: () => string;
  /** The ground's name. */
  stadium: () => string;
  /** Bring the palette panel and the 3D view in line after a fix changed the design. */
  refresh: () => void;
}

export interface AiDrawerHandle {
  /** Show a view; with a brief, Create's prompt is filled with it. */
  show(view: AiView, brief?: string): void;
}

const VIEW_KEY = 'tifo_ai_view_v1';
const INTENT_KEY = 'tifo_ai_intent_v1';
/** The picture a review is sent: the stands unrolled, this many pixels wide at most. */
const PICTURE_WIDTH = 1272;
const PICTURE_BYTES = 560 * 1024;

/** A fix card's title, by what the fix does. Named in full: the build collects strings by their literal keys. */
const FIX_TITLE: Record<FixOpType, string> = {
  'text.setCase': 'ai.fix.case',
  'text.setText': 'ai.fix.words',
  'text.resize': 'ai.fix.size',
  'text.outline': 'ai.fix.outline',
  'object.recolor': 'ai.fix.recolor',
  'object.fitToStand': 'ai.fix.fit',
  'object.center': 'ai.fix.center',
  'paint.replaceColor': 'ai.fix.repaint',
  'palette.merge': 'ai.fix.merge',
};
const FIX_KIND: Record<FixOpType, string> = {
  'text.setCase': 'ai.kind.text', 'text.setText': 'ai.kind.text', 'text.resize': 'ai.kind.text', 'text.outline': 'ai.kind.text',
  'object.recolor': 'ai.kind.colour', 'object.fitToStand': 'ai.kind.place', 'object.center': 'ai.kind.place',
  'paint.replaceColor': 'ai.kind.colour', 'palette.merge': 'ai.kind.colour',
};
const STAND_KEY: Record<string, string> = { north: 'area.north', south: 'area.south', east: 'area.east', west: 'area.west', all: 'area.all' };
const PER_KEY: Record<Allowance['period'], string> = { day: 'pro.per.day', week: 'pro.per.week', month: 'pro.per.month' };
const AXIS_KEY: Record<string, string> = { x: 'ai.axis.x', y: 'ai.axis.y', both: 'ai.axis.both' };

type Tone = 'good' | 'warn' | 'bad' | 'info';
const TONE_ICON: Record<Tone, string> = { good: 'ti-circle-check', warn: 'ti-alert-triangle', bad: 'ti-alert-circle', info: 'ti-info-circle' };
interface Action { label: string; primary?: boolean; run: () => void }

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}
function icon(name: string): HTMLElement {
  const i = el('i', `ti ${name}`);
  i.setAttribute('aria-hidden', 'true');
  return i;
}
function button(label: string, cls: string, run: () => void, iconName?: string): HTMLButtonElement {
  const b = el('button', cls);
  b.type = 'button';
  if (iconName) b.append(icon(iconName), ' ');
  b.append(label);
  b.addEventListener('click', run);
  return b;
}
/** One state card: a title, a sentence, one way on and at most one quiet alternative (docs/DESIGN.md). */
function card(tone: Tone, title: string, body?: string, actions: Action[] = []): HTMLElement {
  const box = el('div', 'ai-state');
  box.dataset.tone = tone;
  box.setAttribute('role', 'status');
  const head = el('p', 'ai-state-title');
  head.append(icon(`ai-state-icon ${TONE_ICON[tone]}`), el('span', undefined, title));
  box.append(head);
  if (body) box.append(el('p', 'ai-state-body', body));
  if (actions.length) {
    const row = el('div', 'ai-state-actions');
    for (const a of actions) row.append(button(a.label, a.primary ? 'primary' : '', a.run));
    box.append(row);
  }
  return box;
}

/** "7 of 10 left today", "Last one this week", "None left · back on Sunday". */
function countText(a: Allowance): string {
  if (a.remaining <= 0) return tv('ai.count.none', { when: backWhen(a) });
  const per = t(PER_KEY[a.period]);
  return a.remaining === 1 && a.limit > 1 ? tv('ai.count.last', { per }) : tv('ai.count.left', { n: a.remaining, limit: a.limit, per });
}
function countLevel(a: Allowance): 'none' | 'low' | '' {
  if (a.remaining <= 0) return 'none';
  return a.remaining === 1 || (a.limit >= 10 && a.remaining <= 2) ? 'low' : '';
}

/**
 * The home screen: the two doors. Each says in one sentence what it does to
 * the tifo and carries its own counter. Built here for the same reason as the
 * review's controls below. Returns the function that words it again.
 */
function buildHome(host: HTMLElement | null): (() => void) | null {
  if (!host || host.childElementCount) return null;
  const title = el('h4');
  const titleText = el('span');
  const tag = el('span', 'h4-tag');
  title.append(titleText, ' ', tag);
  const gate = el('div');
  gate.id = 'ai-gate';
  gate.setAttribute('aria-live', 'polite');
  const door = (id: string, iconName: string, whatIcon: string): { box: HTMLElement; name: HTMLElement; body: HTMLElement; what: HTMLElement; go: HTMLButtonElement } => {
    const box = el('section', 'ai-door');
    box.id = `ai-door-${id}`;
    const h = el('h5');
    const name = el('span');
    h.append(icon(iconName), ' ', name);
    const body = el('p');
    const whatLine = el('p', 'ai-door-what');
    const what = el('span');
    whatLine.append(icon(whatIcon), ' ', what);
    const foot = el('div', 'ai-door-foot');
    const count = el('span', 'ai-count');
    count.id = `ai-count-${id}`;
    count.hidden = true;
    const go = el('button', 'ai-go');
    go.id = `ai-open-${id}`;
    go.type = 'button';
    foot.append(count, go);
    box.append(h, body, whatLine, foot);
    return { box, name, body, what, go };
  };
  const create = door('create', 'ti-sparkles', 'ti-refresh');
  const review = door('review', 'ti-eye', 'ti-shield-check');
  const doors = el('div', 'ai-doors');
  doors.append(create.box, review.box);
  const foot = el('p', 'ai-home-foot');
  foot.id = 'ai-home-foot';
  foot.hidden = true;
  host.append(title, gate, doors, foot);
  const word = (): void => {
    titleText.textContent = t('ai.home.title');
    tag.textContent = t('ai.home.tag');
    create.name.textContent = t('ai.door.create');
    create.body.textContent = t('ai.door.createBody');
    create.what.textContent = t('ai.door.createWhat');
    create.go.textContent = t('ai.door.createGo');
    review.name.textContent = t('ai.door.review');
    review.body.textContent = t('ai.door.reviewBody');
    review.what.textContent = t('ai.door.reviewWhat');
    review.go.textContent = t('ai.door.reviewGo');
  };
  word();
  return word;
}

/**
 * The review's own controls: its header, the list and the message box. Built
 * here, not written in index.html, so their words arrive with this module
 * (it loads on demand) and not with the editor's first download. Returns the
 * function that words them again when the language changes.
 */
function buildReview(host: HTMLElement | null): (() => void) | null {
  if (!host || host.childElementCount) return null;
  const head = el('div', 'ai-head');
  const back = el('button', 'ai-back');
  back.id = 'ai-back-review';
  back.type = 'button';
  back.append(icon('ti-arrow-right'));
  const title = el('h4');
  const titleText = el('span');
  title.append(titleText);
  const pill = el('span', 'ai-count');
  pill.id = 'ai-pill-review';
  pill.hidden = true;
  const full = el('button', 'ai-icon');
  full.id = 'ai-full';
  full.type = 'button';
  full.setAttribute('aria-pressed', 'false');
  full.append(icon('ti-maximize'));
  head.append(back, title, pill, full);
  const list = el('div', 'rv-body');
  list.id = 'rv-body';
  const form = el('form', 'rv-composer');
  form.id = 'rv-composer';
  form.autocomplete = 'off';
  const sugg = el('div', 'rv-sugg');
  sugg.id = 'rv-sugg';
  const asks = ['ai.chat.s1', 'ai.chat.s2'].map(() => {
    const b = el('button', 'chip');
    b.type = 'button';
    b.dataset.ask = '';
    return b;
  });
  sugg.append(...asks);
  const row = el('div', 'rv-in');
  const input = el('input');
  input.id = 'rv-input';
  input.type = 'text';
  input.name = 'message';
  input.maxLength = 400;
  input.enterKeyHint = 'send';
  input.spellcheck = true;
  const send = el('button', 'rv-send');
  send.id = 'rv-send';
  send.type = 'submit';
  send.append(icon('ti-arrow-big-up'));
  row.append(input, send);
  const count = el('p', 'ai-quota');
  count.id = 'rv-chat-count';
  form.append(sugg, row, count);
  host.append(head, list, form);
  const word = (): void => {
    back.setAttribute('aria-label', t('ai.back'));
    titleText.textContent = t('ai.door.review');
    asks[0].textContent = t('ai.chat.s1');
    asks[1].textContent = t('ai.chat.s2');
    input.setAttribute('aria-label', t('ai.chat.label'));
    input.placeholder = t('ai.chat.ph');
    send.setAttribute('aria-label', t('ai.chat.send'));
  };
  word();
  return word;
}

export function mountAiDrawer(deps: AiDrawerDeps): AiDrawerHandle {
  const { root, store, objects, map, editor } = deps;
  const $ = <T extends HTMLElement>(sel: string): T | null => root.querySelector<T>(sel);
  const wordHome = buildHome($('#ai-home'));
  const wordReview = buildReview($('#ai-review'));
  const views: Record<AiView, HTMLElement | null> = { home: $('#ai-home'), create: $('#ai-create'), review: $('#ai-review') };
  const body = $('#rv-body');
  const input = $<HTMLInputElement>('#rv-input');
  const form = $<HTMLFormElement>('#rv-composer');
  const noop: AiDrawerHandle = { show: () => {} };
  if (!views.home || !views.create || !views.review || !body || !input || !form) return noop;
  const field: HTMLInputElement = input;

  // ---------------------------------------------------------------- views ---
  let view: AiView = 'home';
  const remembered = (): AiView => {
    try {
      const v = localStorage.getItem(VIEW_KEY);
      return v === 'create' || v === 'review' ? v : 'home';
    } catch { return 'home'; }
  };
  const setFull = (on: boolean): void => {
    document.body.classList.toggle('ai-full', on);
    const b = $('#ai-full');
    if (!b) return;
    b.setAttribute('aria-pressed', String(on));
    b.setAttribute('aria-label', t(on ? 'ai.full.off' : 'ai.full.on'));
    b.title = t(on ? 'ai.full.off' : 'ai.full.on');
    const i = b.querySelector('i');
    if (i) i.className = `ti ${on ? 'ti-layout-sidebar-right-collapse' : 'ti-maximize'}`;
  };
  const show = (next: AiView, brief?: string): void => {
    view = next;
    for (const k of Object.keys(views) as AiView[]) views[k]!.hidden = k !== next;
    if (next !== 'review') setFull(false);
    if (next !== 'home') { try { localStorage.setItem(VIEW_KEY, next); } catch { /* private window */ } }
    if (next === 'create' && brief !== undefined) {
      const prompt = $<HTMLTextAreaElement>('#ai-prompt');
      if (prompt) {
        prompt.value = brief.slice(0, prompt.maxLength > 0 ? prompt.maxLength : 400);
        prompt.focus();
      }
    }
    if (next === 'review') enterReview();
    paintCounts();
  };

  // ------------------------------------------------------------- counters ---
  let quota: AiQuota | null = null;
  let limits: AiLimits | null = null;
  let gate: 'signin' | 'verify' | null = null;
  let pro: ProState | null = null;
  let review: ReviewQuota | null = null;

  /** The AI designs' counter, in the same words as the reviews'. */
  const createCount = (): { text: string; level: string } => {
    const q = quota;
    if (!q) return { text: '', level: '' };
    if (q.unlimited || q.admin) return { text: t('ai.count.unlimited'), level: '' };
    const al = q.allowances?.std;
    if (al) return { text: countText(al), level: countLevel(al) };
    // The hourly meter, for an account Pro is off for.
    if (q.remaining <= 0) return { text: tv('ai.count.noneMin', { mins: Math.max(1, Math.ceil((q.resetInSec ?? 0) / 60)) }), level: 'none' };
    return { text: tv('ai.count.left', { n: q.remaining, limit: q.limit, per: t('ai.count.hour') }), level: q.remaining <= 2 ? 'low' : '' };
  };
  const setCount = (sel: string, c: { text: string; level: string }): void => {
    const n = $(sel);
    if (!n) return;
    n.textContent = c.text;
    n.hidden = !c.text;
    if (c.level) n.dataset.level = c.level;
    else delete n.dataset.level;
  };
  const reviewCount = (kind: 'critique' | 'chat'): { text: string; level: string } => {
    if (quota && (quota.unlimited || quota.admin)) return { text: t('ai.count.unlimited'), level: '' };
    const al = review?.[kind];
    return al ? { text: countText(al), level: countLevel(al) } : { text: '', level: '' };
  };
  const onFree = (): boolean => !review || review.plan === 'free';
  /** Pro is on for this visitor and gives more reviews than the free plan. */
  const proAdds = (): boolean => !!pro?.live && !!limits && JSON.stringify(limits.pro.critique) !== JSON.stringify(limits.free.critique);

  function paintCounts(): void {
    const c = createCount();
    setCount('#ai-count-create', c);
    setCount('#ai-pill-create', c);
    const r = reviewCount('critique');
    setCount('#ai-count-review', r);
    setCount('#ai-pill-review', r);
    const chat = $('#rv-chat-count');
    if (chat) {
      const m = reviewCount('chat');
      chat.textContent = m.text ? tv('ai.count.messages', { count: m.text }) : '';
      if (m.level) chat.dataset.level = m.level;
      else delete chat.dataset.level;
    }
    // What Pro adds, only where Pro is on and the account is not on it.
    const foot = $('#ai-home-foot');
    if (foot) {
      foot.textContent = '';
      const day = (w: { period: string; limit: number }[]): number => w.find((x) => x.period === 'day')?.limit ?? w[0]?.limit ?? 0;
      if (limits && proAdds() && onFree() && !gate) {
        const chip = el('span');
        chip.innerHTML = proChipHtml();
        foot.append(chip, ' ', tv('ai.home.proAdds', { designs: day(limits.pro.std), reviews: day(limits.pro.critique) }));
      }
      foot.hidden = !foot.textContent;
    }
    paintGate();
    paintStart();
  }

  /** Signed out or not verified: the panel is all there, and says the one step that opens it. */
  function paintGate(): void {
    const host = $('#ai-gate');
    if (!host) return;
    host.textContent = '';
    for (const id of ['#ai-open-create', '#ai-open-review']) {
      const b = $<HTMLButtonElement>(id);
      // Create signs a visitor up from its own button, as it always has; only the review is held back.
      if (b && id === '#ai-open-review') b.disabled = !!gate;
    }
    root.classList.toggle('ai-locked', !!gate);
    if (!gate) return;
    const reviews = limits?.free.critique[0]?.limit ?? 3;
    host.append(gate === 'signin'
      ? card('info', t('ai.gate.signin.title'), tv('ai.gate.signin.body', { reviews }), [
          { label: t('ai.gate.signin.go'), primary: true, run: () => { void openAuthModal().then(() => void load()); } },
          { label: t('ai.gate.signin.new'), run: () => { void openAuthModal(false, 'signup').then(() => void load()); } },
        ])
      : card('info', t('ai.gate.verify.title'), t('ai.gate.verify.body'), [
          { label: t('ai.gate.verify.go'), primary: true, run: () => { window.open('/account', '_blank', 'noopener'); } },
          { label: t('ai.gate.verify.again'), run: () => { void resendVerification().then((r) => { if (r?.ok && r.alreadyVerified) void load(); }).catch(() => {}); } },
        ]));
  }

  async function load(): Promise<void> {
    try {
      quota = await fetchAiQuota();
      gate = null;
      limits = quota.limits ?? limits;
      review = quota.review ?? null;
    } catch (e) {
      const err = e as AiError;
      quota = null;
      review = null;
      limits = err.limits ?? limits;
      gate = err.reason === 'verify' ? 'verify' : err.reason === 'signin' || !isSignedIn() ? 'signin' : null;
    }
    pro = await fetchPro().catch(() => null);
    paintCounts();
  }
  // A design is being made (the AI bar, "Generate with AI", an idea handed over): show the designer.
  window.addEventListener('tifo:ai-create', () => { if (view !== 'create') show('create'); });
  window.addEventListener('tifo:auth', () => void load());
  window.addEventListener('tifo:pro', () => void load());
  // The designer tells its own count as it changes (ui/aiPanel.ts setQuota).
  window.addEventListener('tifo:ai-quota', (e) => {
    const q = (e as CustomEvent<AiQuota | null>).detail;
    if (!q) return;
    quota = { ...q, review: quota?.review ?? q.review, limits: quota?.limits ?? q.limits };
    if (q.review !== undefined) review = q.review ?? null;
    paintCounts();
  });

  // --------------------------------------------------------------- review ---
  type Block =
    | { t: 'bubble'; role: 'user' | 'ai'; text: string }
    | { t: 'fix'; n: number; raw: unknown; why: string; status: 'open' | 'done' | 'gone' | 'stale'; applied?: AppliedFix; type: FixOpType | null }
    | { t: 'idea'; text: string; brief: string; gone?: boolean }
    | { t: 'card'; node: HTMLElement }
    | { t: 'ask'; question: string };
  let blocks: Block[] = [];
  let intent: { text: string; confirmed: boolean } | null = null;
  let reviewed = false;
  let busy = false;
  let inflight: AbortController | null = null;
  let fixNo = 0;
  /** What the next message is: a question to the critic, or the user's own account of the tifo. */
  let answering: 'chat' | 'intent' = 'chat';

  const intentKey = (): string =>
    `${deps.stadium()}|${deps.title()}|${objects.list().filter((o) => o.kind === 'text').map((o) => (o.kind === 'text' ? o.text : '')).join('|')}`;
  const loadIntent = (): void => {
    try {
      const saved = JSON.parse(localStorage.getItem(INTENT_KEY) ?? 'null') as { key?: string; text?: string } | null;
      intent = saved && saved.key === intentKey() && typeof saved.text === 'string' && saved.text ? { text: saved.text.slice(0, 300), confirmed: true } : null;
    } catch { intent = null; }
  };
  const saveIntent = (): void => {
    try {
      if (intent?.confirmed) localStorage.setItem(INTENT_KEY, JSON.stringify({ key: intentKey(), text: intent.text }));
      else localStorage.removeItem(INTENT_KEY);
    } catch { /* private window */ }
  };

  const designNow = (): ReturnType<typeof describeDesign> =>
    describeDesign({ store, objects, map, title: deps.title(), stadium: deps.stadium() });

  /** The stands unrolled, as a JPEG small enough to send; undefined when it cannot be made. */
  const picture = (): string | undefined => {
    try {
      const c = canvasOf(stripPixels(map, store.cells, store.palette, PICTURE_WIDTH));
      for (const q of [0.82, 0.6, 0.4]) {
        const url = c.toDataURL('image/jpeg', q);
        if (url.startsWith('data:image/jpeg') && url.length * 0.75 <= PICTURE_BYTES) return url;
      }
    } catch { /* no picture: the text carries the review */ }
    return undefined;
  };

  const request = (): { design: string; lang: 'en' | 'ar'; ctx: unknown; intent?: string } => ({
    design: designNow().text,
    lang: getLang() === 'ar' ? 'ar' : 'en',
    ctx: fixContextOf(objects, store, map),
    ...(intent?.confirmed ? { intent: intent.text } : {}),
  });

  const swatch = (c: ColorRef): HTMLElement => {
    const s = el('span', 'rv-sw');
    const hex = typeof c === 'number' ? store.palette[c] : c;
    if (hex && /^#[0-9a-f]{6}$/i.test(hex)) s.style.setProperty('--sw', hex);
    return s;
  };
  const arrow = (): HTMLElement => icon('ti-arrow-right rv-arrow');
  const chip = (text: string): HTMLElement => {
    const c = el('span', 'rv-chip', text);
    c.dir = 'auto';
    return c;
  };

  /** What a fix would change, drawn from the design as it is now: the before and the after. */
  function preview(op: FixOp): HTMLElement | null {
    const row = el('div', 'rv-preview');
    const o = 'layer' in op ? objects.get(op.layer) : null;
    switch (op.type) {
      case 'text.setCase':
      case 'text.setText':
        if (o?.kind !== 'text') return null;
        row.append(chip(o.text), arrow(), chip(op.text));
        return row;
      case 'text.resize':
        if (o?.kind !== 'text') return null;
        row.append(chip(tv('ai.prev.rows', { n: Math.round(o.heightSeats) })), arrow(), chip(tv('ai.prev.rows', { n: op.rows })));
        return row;
      case 'text.outline':
        if (op.seats <= 0) row.append(chip(t('ai.prev.noOutline')));
        else row.append(swatch(op.color), chip(tv('ai.prev.outline', { n: op.seats })));
        return row;
      case 'object.recolor':
        if (!o) return null;
        row.append(swatch(o.colorIndex), arrow(), swatch(op.color));
        return row;
      case 'object.fitToStand':
        row.append(chip(t(STAND_KEY[op.stand])));
        return row;
      case 'object.center':
        row.append(chip(t(AXIS_KEY[op.axis])));
        return row;
      case 'paint.replaceColor':
        row.append(swatch(op.from), arrow(), swatch(op.to), chip(t(STAND_KEY[op.stand])));
        return row;
      case 'palette.merge':
        for (const m of op.merge) row.append(swatch(m.from));
        row.append(arrow());
        for (const to of new Set(op.merge.map((m) => m.to))) row.append(swatch(to));
        return row;
    }
  }

  function fixCard(b: Extract<Block, { t: 'fix' }>): HTMLElement {
    const op = b.status === 'open' ? parseFixOp(b.raw, fixContextOf(objects, store, map)) : null;
    if (b.status === 'open' && !op) b.status = 'stale';
    const box = el('article', `rv-fix is-${b.status}`);
    const head = el('div', 'rv-fix-head');
    head.append(el('b', 'rv-pin', String(b.n)), el('h5', undefined, t(b.type ? FIX_TITLE[b.type] : 'ai.fix.generic')));
    if (b.type) head.append(el('span', 'rv-kind', t(FIX_KIND[b.type])));
    box.append(head);
    if (b.status === 'gone') return box;
    if (b.why) {
      const why = el('p', 'rv-why', b.why);
      why.dir = 'auto';
      box.append(why);
    }
    const foot = el('div', 'rv-fix-foot');
    if (b.status === 'stale') {
      foot.append(el('span', 'rv-note', t('ai.fix.stale')));
    } else if (b.status === 'done') {
      const done = el('span', 'rv-done');
      done.append(icon('ti-circle-check'), ' ', t('ai.fix.applied'));
      foot.append(done, button(t('ai.fix.undo'), 'link-btn', () => {
        const back = b.applied?.revert() ?? false;
        b.applied = undefined;
        b.status = back ? 'open' : 'stale';
        afterChange();
      }, 'ti-arrow-back-up'));
    } else if (op) {
      const pv = preview(op);
      if (pv) box.append(pv);
      // Selecting the layer puts the editor's own selection box on it: that is the highlight.
      // On a phone a selection changes the sheet, so the highlight is for a pointer.
      if ('layer' in op && window.matchMedia('(min-width: 900px)').matches) {
        const point = (): void => { if (objects.get(op.layer)) objects.select(op.layer); };
        box.addEventListener('mouseenter', point);
        box.addEventListener('focusin', point);
      }
      foot.append(
        button(t('ai.fix.apply'), 'rv-apply', () => {
          const fresh = parseFixOp(b.raw, fixContextOf(objects, store, map));
          const applied = fresh ? applyFix(fresh, { store, objects, map, textSize: textObjectSize }) : null;
          if (applied) { b.applied = applied; b.status = 'done'; } else b.status = 'stale';
          afterChange();
        }),
        button(t('ai.fix.dismiss'), 'link-btn', () => { b.status = 'gone'; render(); }),
      );
    }
    box.append(foot);
    return box;
  }

  /** The design changed under a fix: every view of it follows, and the cards are drawn against it again. */
  function afterChange(): void {
    deps.refresh();
    editor.objectOverlay?.sync();
    render();
  }

  function intentCard(): HTMLElement | null {
    if (!intent) return null;
    const box = el('div', 'rv-intent');
    const lbl = el('span', 'rv-label');
    lbl.append(icon('ti-eye'), ' ', t(intent.confirmed ? 'ai.intent.yours' : 'ai.intent.mine'));
    const p = el('p', undefined, intent.text);
    p.dir = 'auto';
    box.append(lbl, p);
    const row = el('div', 'rv-acts');
    if (!intent.confirmed) {
      row.append(button(t('ai.intent.yes'), 'rv-apply', () => { intent!.confirmed = true; saveIntent(); render(); }));
    }
    row.append(button(t(intent.confirmed ? 'ai.intent.change' : 'ai.intent.no'), 'link-btn', () => {
      answering = 'intent';
      field.placeholder = t('ai.intent.ph');
      field.focus();
    }));
    box.append(row);
    return box;
  }

  function ideaCard(b: Extract<Block, { t: 'idea' }>): HTMLElement {
    const box = el('div', 'rv-idea');
    const p = el('p', undefined, b.text);
    p.dir = 'auto';
    box.append(p);
    const row = el('div', 'rv-acts');
    row.append(
      button(t('ai.idea.create'), 'rv-apply', () => { show('create', b.brief); }, 'ti-sparkles'),
      button(t('ai.idea.hand'), 'link-btn', () => { b.gone = true; render(); }),
    );
    box.append(row, el('small', 'rv-note', t('ai.idea.cost')));
    return box;
  }

  const progress = el('div', 'ai-progress');
  progress.setAttribute('aria-live', 'polite');
  {
    const bar = el('div', 'ai-progress-bar');
    bar.append(el('span'));
    const label = el('p', 'ai-progress-label');
    label.append(el('span', 'rv-stage'), el('span', 'rv-elapsed'));
    progress.append(bar, label, button(t('ed.ai.cancel'), 'ai-cancel', () => inflight?.abort()), el('p', 'rv-note', t('ai.rv.notCounted')));
  }
  let ticker: number | null = null;
  const startProgress = (stages: string[]): void => {
    const started = Date.now();
    const tick = (): void => {
      const secs = Math.floor((Date.now() - started) / 1000);
      progress.querySelector('.rv-stage')!.textContent = t(stages[Math.min(stages.length - 1, Math.floor(secs / 4))]);
      progress.querySelector('.rv-elapsed')!.textContent = ` ${secs}s`;
    };
    tick();
    ticker = window.setInterval(tick, 1000);
  };
  const stopProgress = (): void => {
    if (ticker !== null) { clearInterval(ticker); ticker = null; }
  };

  /** The card a fresh review starts from: what it costs, said on the button before it is pressed. */
  function startCard(): HTMLElement {
    const d = designNow();
    if (!d.painted && !d.layers) {
      return card('info', t('ai.rv.empty.title'), t('ai.rv.empty.body'), [{ label: t('ai.rv.empty.go'), run: () => show('create') }]);
    }
    const box = el('div', 'rv-start');
    box.append(el('p', 'rv-lead', t('ai.rv.lead')));
    const al = review?.critique;
    const label = al && al.remaining > 0 ? tv('ai.rv.goCost', { n: al.remaining }) : t('ai.rv.go');
    const go = button(label, 'rv-apply rv-go', () => void runReview(), 'ti-eye');
    go.id = 'rv-run';
    go.disabled = !!gate || (!!al && al.remaining <= 0);
    box.append(go);
    if (al && al.remaining <= 0) box.append(limitCard(al, 'critique'));
    return box;
  }
  function paintStart(): void {
    if (view === 'review' && !reviewed && !busy && !blocks.length) render();
  }

  /** Used up: what ran out, when it comes back, one way on and one quiet alternative. A member is never sold to. */
  function limitCard(al: Allowance, kind: 'critique' | 'chat'): HTMLElement {
    track('pro_limit');
    const sell = onFree() && proAdds();
    const keep: Action = { label: t(kind === 'chat' ? 'ai.limit.keepChat' : 'ai.limit.keep'), run: () => { blocks = blocks.filter((b) => b.t !== 'card'); render(); } };
    const way: Action = { label: t('pro.limit.seePro'), primary: true, run: () => { if (pro) void import('./proSheets').then((m) => m.openProSheet(pro!)); } };
    return card('warn', limitTitle(al), `${limitBack(al)} ${sell ? t('pro.limit.withPro') : t('ai.limit.same')}`, sell ? [way, keep] : [keep]);
  }

  function refusalCard(r: ReviewRefusal, retry: () => void, kind: 'critique' | 'chat'): HTMLElement | null {
    if (r.review !== undefined) review = r.review ?? review;
    if (r.reason === 'signin' || r.reason === 'verify') {
      gate = r.reason;
      show('home');
      return null;
    }
    if (r.reason === 'quota') {
      const al = review?.[kind];
      return al ? limitCard(al, kind) : card('warn', t('ai.rv.failed.title'), t('ai.rv.failed.body'));
    }
    if (r.reason === 'blocked') return card('warn', r.message || t('ai.rv.blocked'));
    const again: Action = { label: t('ai.card.tryAgain'), run: retry };
    if (r.reason === 'offline' || !navigator.onLine) return card('bad', t('ai.card.offline'), t('ai.rv.untouched'), [again]);
    return card('bad', t(kind === 'chat' ? 'ai.rv.chatFailed.title' : 'ai.rv.failed.title'), t('ai.rv.failed.body'), [again]);
  }

  function take(res: Extract<ReviewResult, { ok: true }>, chat: boolean): void {
    if (res.review !== undefined) review = res.review ?? review;
    if (chat && res.reply) blocks.push({ t: 'bubble', role: 'ai', text: res.reply });
    if (!chat) {
      if (res.intent.summary && !intent?.confirmed) intent = { text: res.intent.summary, confirmed: false };
      if (!res.intent.sure && res.intent.question) blocks.push({ t: 'ask', question: res.intent.question });
    }
    const ctx = fixContextOf(objects, store, map);
    for (const f of res.fixes) {
      const op = parseFixOp(f.op, ctx);
      // A fix this design cannot take is never shown: nothing to apply, nothing to explain.
      if (op) blocks.push({ t: 'fix', n: ++fixNo, raw: f.op, why: f.why, status: 'open', type: op.type });
    }
    for (const i of res.ideas) blocks.push({ t: 'idea', text: i.text, brief: i.brief });
    if (!chat && !res.fixes.length && res.intent.sure) {
      blocks.push({ t: 'card', node: card('good', t('ai.rv.clean.title'), t(res.ideas.length ? 'ai.rv.clean.ideas' : 'ai.rv.clean.body')) });
    }
  }

  async function runReview(): Promise<void> {
    if (busy) return;
    busy = true;
    blocks = blocks.filter((b) => b.t !== 'card' && b.t !== 'ask');
    inflight = new AbortController();
    render();
    startProgress(['ai.rv.stage1', 'ai.rv.stage2', 'ai.rv.stage3']);
    try {
      const res = await reviewAiTifo({ ...request(), image: picture() }, inflight.signal);
      if (res.ok) {
        reviewed = true;
        // A new review replaces the open suggestions of the last one; what was applied stays on the record.
        blocks = blocks.filter((b) => !(b.t === 'fix' && b.status === 'open') && b.t !== 'idea');
        take(res, false);
      } else {
        const c = refusalCard(res, () => void runReview(), 'critique');
        if (c) blocks.push({ t: 'card', node: c });
      }
    } catch (e) {
      if ((e as Error)?.name !== 'AbortError') blocks.push({ t: 'card', node: card('bad', t('ai.rv.failed.title'), t('ai.rv.failed.body'), [{ label: t('ai.card.tryAgain'), run: () => void runReview() }]) });
      else blocks.push({ t: 'card', node: card('info', t('ai.card.stopped'), t('ai.rv.stoppedBody')) });
    } finally {
      busy = false;
      inflight = null;
      stopProgress();
      paintCounts();
      render();
    }
  }

  async function sendChat(message: string): Promise<void> {
    if (busy) return;
    busy = true;
    const history = blocks.filter((b): b is Extract<Block, { t: 'bubble' }> => b.t === 'bubble').slice(-6).map((b) => ({ role: b.role, text: b.text.slice(0, 500) }));
    const fixes = blocks.filter((b): b is Extract<Block, { t: 'fix' }> => b.t === 'fix' && b.status !== 'stale')
      .map((b) => `${b.n} ${b.type ?? 'fix'} ${b.status === 'done' ? 'applied' : b.status === 'gone' ? 'dismissed' : 'open'}`).join(' | ').slice(0, 1500);
    blocks = blocks.filter((b) => b.t !== 'card');
    blocks.push({ t: 'bubble', role: 'user', text: message });
    inflight = new AbortController();
    render();
    startProgress(['ai.rv.chatStage']);
    try {
      const res = await chatAiTifo({ ...request(), message, history, ...(fixes ? { fixes } : {}) }, inflight.signal);
      if (res.ok) {
        take(res, true);
      } else {
        const c = refusalCard(res, () => void sendChat(message), 'chat');
        // The message was not answered: it goes back in the box, not into the conversation.
        blocks = blocks.filter((b) => !(b.t === 'bubble' && b.role === 'user' && b.text === message));
        field.value = message;
        if (c) blocks.push({ t: 'card', node: c });
      }
    } catch {
      blocks = blocks.filter((b) => !(b.t === 'bubble' && b.role === 'user' && b.text === message));
      field.value = message;
    } finally {
      busy = false;
      inflight = null;
      stopProgress();
      paintCounts();
      render();
    }
  }

  function render(): void {
    body!.textContent = '';
    const ic = intentCard();
    if (ic) body!.append(ic);
    if (!reviewed && !busy && !blocks.some((b) => b.t === 'fix' || b.t === 'ask')) body!.append(startCard());
    const open = blocks.filter((b) => b.t === 'fix' && b.status === 'open').length;
    if (blocks.some((b) => b.t === 'fix')) body!.append(el('p', 'rv-count', tv('ai.rv.count', { n: open })));
    let ideasShown = false;
    for (const b of blocks) {
      if (b.t === 'fix') body!.append(fixCard(b));
      else if (b.t === 'idea') {
        if (b.gone) continue;
        if (!ideasShown) {
          const h = el('p', 'rv-sec');
          h.append(el('b', undefined, t('ai.ideas.title')), ' ', t('ai.ideas.sub'));
          body!.append(h);
          ideasShown = true;
        }
        body!.append(ideaCard(b));
      } else if (b.t === 'bubble') {
        const bub = el('div', `rv-bub is-${b.role}`, b.text);
        bub.dir = 'auto';
        body!.append(bub);
      } else if (b.t === 'ask') {
        const bub = el('div', 'rv-bub is-ai', b.question);
        bub.dir = 'auto';
        const chips = el('div', 'rv-sugg');
        for (const k of ['ai.ask.support', 'ai.ask.derby', 'ai.ask.farewell', 'ai.ask.title']) {
          chips.append(button(t(k), 'chip', () => { answerIntent(t(k)); }));
        }
        body!.append(bub, chips, el('p', 'rv-note', t('ai.ask.free')));
      } else body!.append(b.node);
    }
    if (busy) body!.append(progress);
    if (reviewed && !busy) {
      body!.append(button(t('ai.rv.again'), 'link-btn rv-again', () => void runReview(), 'ti-refresh'));
    }
    form!.classList.toggle('is-busy', busy);
    if (answering === 'chat') field.placeholder = t('ai.chat.ph');
    if (busy) body!.scrollTop = body!.scrollHeight;
  }

  /** The person says what the tifo is: kept as the confirmed intent, and the review runs on it. */
  function answerIntent(text: string): void {
    const clean = text.replace(/\s+/g, ' ').trim().slice(0, 300);
    if (!clean) return;
    intent = { text: clean, confirmed: true };
    saveIntent();
    answering = 'chat';
    const asked = blocks.some((b) => b.t === 'ask');
    blocks = blocks.filter((b) => b.t !== 'ask');
    if (asked || !reviewed) void runReview();
    else {
      blocks.push({ t: 'bubble', role: 'ai', text: t('ai.intent.got') });
      render();
    }
  }

  function enterReview(): void {
    if (!intent) loadIntent();
    render();
  }

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = field.value.replace(/\s+/g, ' ').trim();
    if (!text || busy) return;
    if (gate) { show('home'); return; }
    field.value = '';
    if (answering === 'intent' || blocks.some((b) => b.t === 'ask')) answerIntent(text);
    else void sendChat(text);
  });
  for (const c of Array.from(root.querySelectorAll<HTMLButtonElement>('#rv-sugg [data-ask]'))) {
    c.addEventListener('click', () => {
      field.value = c.textContent ?? '';
      field.focus();
    });
  }

  // The card a review starts from describes the design (empty, or ready to
  // review): it follows the design while nothing has been reviewed yet.
  let startDue = false;
  const startSoon = (): void => {
    if (startDue) return;
    startDue = true;
    requestAnimationFrame(() => { startDue = false; paintStart(); });
  };
  store.onHistoryChange(startSoon);
  objects.onChange((why) => { if (why === 'content') startSoon(); });

  // ---------------------------------------------------------------- wiring ---
  $('#ai-open-create')?.addEventListener('click', () => show('create'));
  $('#ai-open-review')?.addEventListener('click', () => show('review'));
  $('#ai-back-create')?.addEventListener('click', () => show('home'));
  $('#ai-back-review')?.addEventListener('click', () => show('home'));
  $('#ai-full')?.addEventListener('click', () => setFull(!document.body.classList.contains('ai-full')));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && document.body.classList.contains('ai-full')) setFull(false);
  });
  onLangChange(() => { wordHome?.(); wordReview?.(); paintCounts(); if (view === 'review') render(); setFull(document.body.classList.contains('ai-full')); });

  setFull(false);
  show(remembered());
  void load();
  return { show };
}
