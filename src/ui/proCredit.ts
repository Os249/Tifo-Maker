/**
 * The credit line (Pro): the fan's own handle or group name, small, in a
 * corner of every export that leaves the site, so a tifo posted without the
 * tifomaker.org mark still says whose it is. Mounted by proTools.ts, so only
 * for an account /api/pro says Pro is on for; its words load with it.
 *
 * Kept on the account (server/src/kitRoutes.ts, /api/pro/credit), not with a
 * club kit: a credit names who made the tifo, which is the same whichever
 * club it is for, and it has to be there in a project that never used a kit.
 * One value, on every device the fan signs in on, with a copy in this browser
 * for when the server does not answer (kept for this session only, so a
 * shared computer never signs one person's export with another's name).
 *
 * Where it is typed: the same field wherever an export is made — the
 * stadium's video and poster panel, the Post it sheet, Match Day's Record
 * section — and all of them are the one value, so what the fan sees is what
 * goes out. Free to try: every preview shows it as typed. What leaves the
 * site asks first (proGate.ts lists "Your credit line" among the Pro items),
 * and the free version goes without it.
 *
 * Drawn by ui/creditLine.ts (drawCreditLine); this module only says what the
 * credit is (creditSource) and lets the fan change it.
 */
import './proCredit.css';
import { cleanCredit, CREDIT_MAX } from '../core/kitRules';
import { fetchPro, type ProState } from '../net/api';
import { getAccountCredit, putAccountCredit, sessionTag } from '../net/kitApi';
import { creditSource } from './creditLine';
import { onLangChange, t } from './i18n';
import { activeKit } from './kitActive';
import { proChipHtml } from './pro';

/** This browser's copy, for when the server does not answer: { tag, text, pending }. */
const CACHE_KEY = 'tifo_credit_v1';
const SAVE_AFTER_MS = 700;

let text = '';
let live = false;
let running = false;
let tag: string | null = null;
const listeners = new Set<() => void>();
const tell = (): void => listeners.forEach((f) => f());

function readCache(): { tag: string; text: string; pending: boolean } | null {
  try {
    const c = JSON.parse(localStorage.getItem(CACHE_KEY) ?? 'null') as { tag?: unknown; text?: unknown; pending?: unknown } | null;
    return c && typeof c.tag === 'string' && typeof c.text === 'string' ? { tag: c.tag, text: cleanCredit(c.text), pending: c.pending === true } : null;
  } catch {
    return null;
  }
}
function writeCache(pending: boolean): void {
  if (!tag) return;
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ tag, text, pending }));
  } catch {
    /* the account keeps it; this copy is only for offline */
  }
}

type Saved = 'account' | 'later' | 'cleared';
let saveTimer = 0;
let saving: Promise<Saved> | null = null;

/** Send the credit up now. 'later': no answer, kept here and sent at the next load. */
async function flush(): Promise<Saved> {
  clearTimeout(saveTimer);
  saveTimer = 0;
  const want = text;
  const r = await putAccountCredit(want);
  if (r.ok) {
    writeCache(false);
    return want ? 'account' : 'cleared';
  }
  writeCache(true);
  return 'later';
}

/** Keep a new credit: shown at once everywhere, saved on the account a moment after the typing stops. */
function setCredit(v: string, now = false): void {
  const next = cleanCredit(v);
  if (next !== text) {
    text = next;
    writeCache(true);
    tell();
  }
  clearTimeout(saveTimer);
  const go = (): void => {
    saving = flush();
    void saving.then((how) => paintNotes(how));
  };
  if (now) go();
  else saveTimer = window.setTimeout(go, SAVE_AFTER_MS);
}

/** The account's credit, or this browser's copy of it when the server does not answer. */
async function load(): Promise<void> {
  tag = await sessionTag();
  const cached = readCache();
  const mine = cached && tag && cached.tag === tag ? cached : null;
  const r = await getAccountCredit();
  if (r.ok) {
    // A change made here with no answer is newer than what the account has: it goes up now.
    if (mine?.pending && mine.text !== r.value) {
      text = mine.text;
      tell();
      void flush();
      return;
    }
    text = cleanCredit(r.value);
    writeCache(false);
  } else if (mine) {
    text = mine.text;
  }
  tell();
}

// ---------------------------------------------------------------- field ---

let fieldN = 0;
const notes = new Set<HTMLElement>();

function paintNotes(how: Saved): void {
  const msg = how === 'account' ? t('qk.creditSaved') : how === 'later' ? t('qk.creditLater') : t('qk.creditCleared');
  for (const n of notes) if (n.isConnected) n.textContent = msg;
}

/**
 * A credit field, the same wherever it is: its label with the crown, the
 * input, a line saying what it does, and a status line. `changed` runs when
 * the credit changes (a preview to draw again).
 */
export function creditField(changed?: () => void): HTMLElement {
  const id = `qk-credit-${++fieldN}`;
  const box = document.createElement('div');
  box.className = 'qk-credit';
  box.innerHTML =
    `<label class="qk-credit-label" for="${id}"><span></span></label>` +
    `<input id="${id}" class="qk-credit-input" type="text" dir="auto" maxlength="${CREDIT_MAX}" autocomplete="off" spellcheck="false" aria-describedby="${id}-hint">` +
    `<p class="qk-credit-hint" id="${id}-hint"></p>` +
    `<p class="qk-credit-note" role="status" aria-live="polite"></p>`;
  const label = box.querySelector('label') as HTMLElement;
  const input = box.querySelector('input') as HTMLInputElement;
  const hint = box.querySelector('.qk-credit-hint') as HTMLElement;
  const note = box.querySelector('.qk-credit-note') as HTMLElement;
  notes.add(note);
  const paint = (): void => {
    (label.firstElementChild as HTMLElement).textContent = t('qk.credit');
    label.querySelector('.pro-chip')?.remove();
    label.insertAdjacentHTML('beforeend', proChipHtml({ quiet: running }));
    input.placeholder = t('qk.creditPh');
    hint.textContent = t('qk.creditHint');
    box.hidden = !live;
  };
  let shown = false;
  const follow = (): void => {
    // A field whose sheet has closed stops listening.
    if (!box.isConnected) {
      if (shown) {
        listeners.delete(follow);
        notes.delete(note);
      }
      return;
    }
    shown = true;
    if (document.activeElement !== input) input.value = text;
    paint();
    changed?.();
  };
  input.value = text;
  paint();
  input.addEventListener('input', () => {
    note.textContent = '';
    setCredit(input.value);
  });
  // Leaving the field keeps it there and then, cleaned as it will be drawn.
  input.addEventListener('change', () => {
    setCredit(input.value, true);
    input.value = text;
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      input.blur();
    }
  });
  listeners.add(follow);
  onLangChange(paint);
  return box;
}

// ---------------------------------------------------------------- mount ---

export function mountProCredit(): void {
  // What every export reads (ui/creditLine.ts): the credit, the kit's colour for its stripe, and its name for the export sheet.
  creditSource.current = () => (live && text ? { text, accent: activeKit.current?.colours[0], label: t('qk.credit') } : { text: '', label: t('qk.credit') });

  // The stadium export's panel: under "Without the tifomaker.org mark".
  const anchor = document.getElementById('sx-nomark')?.closest('label') ?? document.getElementById('sx-export')?.closest('.group');
  if (anchor && !document.getElementById('sx-credit')) {
    const field = creditField();
    field.id = 'sx-credit';
    field.classList.add('qk-credit-panel');
    anchor.after(field);
  }

  // The Post it sheet's field, and its say in the picture (ui/postMoment.ts).
  void import('./postMoment').then(({ setPostCredit }) =>
    setPostCredit({ field: (changed) => (live ? creditField(changed) : null) }),
  ).catch(() => {});

  const show = (st: ProState | null): void => {
    live = !!st?.live;
    running = live && !!st?.plan && st.plan !== 'free';
    tell();
  };
  void fetchPro().then(show, () => show(null));
  void load();
  const refresh = (): void => {
    void fetchPro(true).then(show, () => show(null));
    void load();
  };
  window.addEventListener('tifo:auth', refresh);
  window.addEventListener('tifo:pro', refresh);
  // Back online: a credit kept here goes up.
  window.addEventListener('online', () => {
    if (readCache()?.pending) void flush().then(paintNotes);
  });
  // The kit's colour is the stripe's: a kit used in the project redraws what shows the credit.
  window.addEventListener('tifo:kit-active', tell);

  // The browser suite's way in (e2e-pro-kit-sync.mjs), only on a page opened with ?e2e.
  if ((window as unknown as { __tifo?: unknown }).__tifo) {
    (window as unknown as { __tifoCredit?: unknown }).__tifoCredit = {
      text: () => text,
      live: () => live,
      set: (v: string) => setCredit(v, true),
      saved: () => saving,
    };
  }
}
