/**
 * The Create panel: the one door into the editor.
 *
 * It asks for exactly what a project cannot exist without, and nothing else:
 *
 *   - a NAME, already filled in, so pressing Create straight away works;
 *   - a STADIUM, because the stadium decides the seats: how many, in how many
 *     tiers, in what shape. That is "the logistics of the tifo", and it is
 *     fixed for the life of the project, so the panel says so here rather than
 *     letting someone find out later.
 *
 * Everything else a tifo has (colours, tags, publishing) belongs to the editor
 * or to Publish, where it can be changed at any time. It is left out on
 * purpose: every extra field here is one more thing between "I want to make a
 * tifo" and making one.
 *
 * The second button, Generate with AI, swaps the name for a prompt. The AI
 * names the project itself. It needs an account with a verified email, and
 * when that is missing the button still works: it opens the panel's AI side
 * and says, in one line, what is needed and offers the one click that fixes it.
 */

import { STADIUM_CATALOG, sectionCount, tierCount, type StadiumEntry } from '../core/stadiumCatalog';
import { DEFAULT_TEMPLATE } from '../core/template';
import { newProjectUrl, stashNewProject } from '../core/projects';
import { loadFavorites } from './stadiumFavorites';
import { escapeHtml } from '../core/escape';
import { fetchAiQuota, fetchMe, isSignedIn, type AiError } from '../net/api';
import { t, tl, tv } from './i18n';

const LAST_STADIUM_KEY = 'tifo_last_stadium_v1';

export interface CreateProjectOptions {
  /** Start on the AI side (the "Generate a tifo" entry point). */
  ai?: boolean;
  /** The name to offer: the next free "My tifo n". */
  defaultName: string;
  /** Called when the panel needs someone to sign in. Resolves true when they did. */
  signIn: () => Promise<boolean>;
  /** Where the browser goes. Swappable so tests and the page can observe it. */
  navigate?: (url: string) => void;
}

/** The stadiums a new project can use: the shipped catalogue, favourites first. */
function stadiumChoices(): StadiumEntry[] {
  const favs = loadFavorites();
  const list = STADIUM_CATALOG.filter((e) => e.meta.source === 'builtin');
  return [...list.filter((e) => favs.has(e.id)), ...list.filter((e) => !favs.has(e.id))];
}

function lastStadium(): string | null {
  try {
    return localStorage.getItem(LAST_STADIUM_KEY);
  } catch {
    return null;
  }
}

function rememberStadium(id: string): void {
  try {
    localStorage.setItem(LAST_STADIUM_KEY, id);
  } catch {
    /* next time simply starts on the default */
  }
}

const fmt = (n: number): string => n.toLocaleString('en-US');

type AiGate =
  | { kind: 'ok'; left: number | null; unlimited: boolean }
  | { kind: 'signin' }
  | { kind: 'verify' }
  | { kind: 'empty'; resetInSec: number };

/** Can this person generate right now, and if not, what is the one fix? */
async function readAiGate(): Promise<AiGate> {
  if (!isSignedIn()) return { kind: 'signin' };
  const me = await fetchMe().catch(() => null);
  if (!me) return { kind: 'signin' };
  if (!me.emailVerified) return { kind: 'verify' };
  try {
    const q = await fetchAiQuota();
    if (q.unlimited) return { kind: 'ok', left: null, unlimited: true };
    if (q.remaining <= 0) return { kind: 'empty', resetInSec: q.resetInSec ?? 3600 };
    return { kind: 'ok', left: q.remaining, unlimited: false };
  } catch (e) {
    const err = e as AiError;
    if (err.reason === 'verify') return { kind: 'verify' };
    if (err.reason === 'signin' || err.status === 401) return { kind: 'signin' };
    // Anything else (the quota endpoint being down) is not a reason to refuse:
    // the editor reports the real outcome of the generation itself.
    return { kind: 'ok', left: null, unlimited: false };
  }
}

function waitLabel(sec: number): string {
  const m = Math.max(1, Math.round(sec / 60));
  return m >= 60 ? tv('np.inH', { n: fmt(Math.round(m / 60)) }) : tv('np.inMin', { n: fmt(m) });
}

export function openCreateProject(opts: CreateProjectOptions): void {
  const go = opts.navigate ?? ((url: string) => location.assign(url));
  const stadiums = stadiumChoices();
  const favs = loadFavorites();
  const remembered = lastStadium();
  let selected =
    stadiums.find((e) => e.id === remembered) ??
    stadiums.find((e) => e.id === DEFAULT_TEMPLATE.id) ??
    stadiums[0];
  let mode: 'plain' | 'ai' = opts.ai ? 'ai' : 'plain';
  let nameEdited = false;
  let gate: AiGate | null = null;

  const backdrop = document.createElement('div');
  backdrop.className = 'np-backdrop';
  backdrop.innerHTML = `
    <div class="np-modal" role="dialog" aria-modal="true" aria-labelledby="np-h">
      <button type="button" class="np-close" aria-label="${escapeHtml(t('common.close'))}">&times;</button>
      <h2 class="np-h" id="np-h"></h2>
      <div class="np-body">
        <section class="np-sec" id="np-name-sec">
          <label class="np-label" for="np-name">${escapeHtml(t('np.name'))}</label>
          <input id="np-name" class="np-input" type="text" maxlength="80" autocomplete="off" spellcheck="false" />
          <p class="np-err" id="np-name-err" role="alert" hidden></p>
        </section>
        <section class="np-sec" id="np-ai-sec" hidden>
          <label class="np-label" for="np-prompt">${escapeHtml(t('np.aiAsk'))}</label>
          <textarea id="np-prompt" class="np-input np-prompt" rows="3" maxlength="400" placeholder="${escapeHtml(t('np.aiPh'))}"></textarea>
          <div class="np-examples">
            ${['np.aiEx1', 'np.aiEx2', 'np.aiEx3']
              .map((k) => `<button type="button" class="np-example">${escapeHtml(t(k))}</button>`)
              .join('')}
          </div>
          <p class="np-err" id="np-prompt-err" role="alert" hidden></p>
          <p class="np-hint">${escapeHtml(t('np.aiNamed'))}</p>
        </section>
        <section class="np-sec">
          <div class="np-sec-head">
            <span class="np-label" id="np-stad-label">${escapeHtml(t('np.stadium'))}</span>
            <input type="search" class="np-search" id="np-search" placeholder="${escapeHtml(t('np.stadiumSearch'))}" aria-label="${escapeHtml(t('np.stadiumSearch'))}" />
          </div>
          <div class="np-stadiums" id="np-stadiums" role="radiogroup" aria-labelledby="np-stad-label"></div>
          <p class="np-facts" id="np-facts" aria-live="polite"></p>
          <p class="np-hint">${escapeHtml(t('np.fixed'))}</p>
        </section>
      </div>
      <div class="np-foot">
        <p class="np-gate" id="np-gate" hidden></p>
        <div class="np-actions" id="np-actions"></div>
      </div>
    </div>`;
  document.body.appendChild(backdrop);

  const $ = <T extends HTMLElement>(sel: string): T => backdrop.querySelector(sel) as T;
  const heading = $<HTMLElement>('#np-h');
  const nameSec = $<HTMLElement>('#np-name-sec');
  const aiSec = $<HTMLElement>('#np-ai-sec');
  const nameInput = $<HTMLInputElement>('#np-name');
  const nameErr = $<HTMLElement>('#np-name-err');
  const prompt = $<HTMLTextAreaElement>('#np-prompt');
  const promptErr = $<HTMLElement>('#np-prompt-err');
  const search = $<HTMLInputElement>('#np-search');
  const list = $<HTMLElement>('#np-stadiums');
  const facts = $<HTMLElement>('#np-facts');
  const gateEl = $<HTMLElement>('#np-gate');
  const actions = $<HTMLElement>('#np-actions');
  nameInput.value = opts.defaultName;

  // Everything behind the dialog is inert while it is up, the same bargain the
  // first-run dialog makes, cookie banner excepted: it must stay answerable.
  const inertTargets = Array.from(document.body.children).filter(
    (el) => el !== backdrop && el instanceof HTMLElement && !el.hasAttribute('data-stays-live'),
  ) as HTMLElement[];
  for (const el of inertTargets) el.inert = true;
  const opener = document.activeElement as HTMLElement | null;

  const close = (): void => {
    for (const el of inertTargets) el.inert = false;
    backdrop.remove();
    document.removeEventListener('keydown', onKey, true);
    if (opener && document.contains(opener)) opener.focus();
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
      return;
    }
    if (e.key !== 'Tab') return;
    const focusable = Array.from(
      backdrop.querySelectorAll<HTMLElement>('button:not([disabled]),input,textarea,a[href],[tabindex="0"]'),
    ).filter((el) => el.offsetParent !== null);
    if (!focusable.length) return;
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };
  document.addEventListener('keydown', onKey, true);
  backdrop.addEventListener('mousedown', (e) => {
    if (e.target === backdrop) close();
  });
  $<HTMLButtonElement>('.np-close').addEventListener('click', close);

  // ---- stadiums ----
  const renderFacts = (): void => {
    const tpl = selected.template;
    const tiers = tierCount(tpl);
    const seats = fmt(selected.meta.capacity ?? 0);
    const sections = fmt(sectionCount(tpl));
    const line = tiers === 1
      ? tv('np.facts1', { seats, sections })
      : tv('np.facts', { seats, tiers: fmt(tiers), sections });
    facts.innerHTML = `<b>${escapeHtml(tl(selected.id))}</b> · ${escapeHtml(line)}`;
  };

  const renderStadiums = (): void => {
    const q = search.value.trim().toLowerCase();
    const shown = stadiums.filter((e) => {
      if (!q) return true;
      const hay = `${tl(e.id)} ${e.meta.name} ${(e.meta.tags ?? []).join(' ')} ${e.meta.country ?? ''}`.toLowerCase();
      return hay.includes(q);
    });
    list.innerHTML = shown.length
      ? shown
          .map((e) => {
            const on = e.id === selected.id;
            return `<button type="button" class="np-stadium${on ? ' on' : ''}" role="radio" aria-checked="${on}" data-id="${escapeHtml(e.id)}" tabindex="${on ? 0 : -1}">
              <span class="np-stadium-name">${favs.has(e.id) ? `<span class="np-fav" title="${escapeHtml(t('np.fav'))}" aria-label="${escapeHtml(t('np.fav'))}">★</span>` : ''}${escapeHtml(tl(e.id))}</span>
              <span class="np-stadium-seats">${escapeHtml(tv('np.seats', { seats: fmt(e.meta.capacity ?? 0) }))}</span>
            </button>`;
          })
          .join('')
      : `<p class="np-none">${escapeHtml(t('np.noStadium'))}</p>`;
    // A filtered-out selection still needs one tabbable stop in the group.
    if (shown.length && !shown.some((e) => e.id === selected.id)) {
      (list.querySelector('.np-stadium') as HTMLElement | null)?.setAttribute('tabindex', '0');
    }
  };

  const select = (id: string, focus = false): void => {
    const next = stadiums.find((e) => e.id === id);
    if (!next) return;
    selected = next;
    renderStadiums();
    renderFacts();
    if (focus) (list.querySelector(`.np-stadium[data-id="${CSS.escape(id)}"]`) as HTMLElement | null)?.focus();
  };

  list.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('.np-stadium');
    if (b?.dataset.id) select(b.dataset.id);
  });
  // Arrow keys move the choice, as in any radio group.
  list.addEventListener('keydown', (e) => {
    const keys = ['ArrowDown', 'ArrowRight', 'ArrowUp', 'ArrowLeft'];
    if (!keys.includes(e.key)) return;
    const buttons = Array.from(list.querySelectorAll<HTMLElement>('.np-stadium'));
    const i = buttons.indexOf(document.activeElement as HTMLElement);
    if (i < 0) return;
    e.preventDefault();
    const rtl = document.documentElement.dir === 'rtl';
    const fwd = e.key === 'ArrowDown' || e.key === (rtl ? 'ArrowLeft' : 'ArrowRight');
    const next = buttons[(i + (fwd ? 1 : -1) + buttons.length) % buttons.length];
    if (next?.dataset.id) select(next.dataset.id, true);
  });
  search.addEventListener('input', renderStadiums);

  // ---- the two sides ----
  const renderGate = (): void => {
    if (mode !== 'ai' || !gate) {
      gateEl.hidden = true;
      return;
    }
    gateEl.hidden = false;
    gateEl.className = 'np-gate';
    if (gate.kind === 'ok') {
      gateEl.textContent = gate.unlimited ? t('np.aiUnlimited') : gate.left !== null ? tv('np.aiCost', { left: fmt(gate.left) }) : '';
      gateEl.hidden = !gateEl.textContent;
      return;
    }
    gateEl.classList.add('locked');
    if (gate.kind === 'empty') {
      gateEl.textContent = tv('np.aiNone', { when: waitLabel(gate.resetInSec) });
      return;
    }
    const isSignin = gate.kind === 'signin';
    gateEl.innerHTML = `<span>${escapeHtml(t(isSignin ? 'np.aiLockedSignin' : 'np.aiLockedVerify'))}</span>`;
    const fix = document.createElement(isSignin ? 'button' : 'a');
    fix.className = 'np-gate-fix';
    fix.textContent = t(isSignin ? 'np.signIn' : 'np.verify');
    if (fix instanceof HTMLAnchorElement) fix.href = '/account';
    else {
      fix.setAttribute('type', 'button');
      fix.addEventListener('click', async () => {
        if (await opts.signIn()) {
          gate = await readAiGate();
          render();
        }
      });
    }
    gateEl.appendChild(fix);
  };

  const render = (): void => {
    heading.textContent = t(mode === 'ai' ? 'np.aiTitle' : 'np.title');
    nameSec.hidden = mode === 'ai';
    aiSec.hidden = mode !== 'ai';
    const aiReady = gate?.kind === 'ok';
    actions.innerHTML =
      mode === 'plain'
        ? `<button type="button" class="np-btn np-ai-btn" id="np-to-ai"><span class="np-spark" aria-hidden="true">✦</span>${escapeHtml(t('np.ai'))}</button>
           <button type="button" class="np-btn primary" id="np-create">${escapeHtml(t('np.create'))}</button>`
        : `<button type="button" class="np-btn" id="np-back">${escapeHtml(t('np.back'))}</button>
           <button type="button" class="np-btn primary" id="np-generate"${aiReady ? '' : ' disabled'}><span class="np-spark" aria-hidden="true">✦</span>${escapeHtml(t('np.aiGo'))}</button>`;
    renderGate();
    actions.querySelector('#np-create')?.addEventListener('click', create);
    actions.querySelector('#np-to-ai')?.addEventListener('click', () => void toAi());
    actions.querySelector('#np-back')?.addEventListener('click', () => {
      mode = 'plain';
      render();
      nameInput.focus();
    });
    actions.querySelector('#np-generate')?.addEventListener('click', generate);
  };

  const toAi = async (): Promise<void> => {
    mode = 'ai';
    render();
    prompt.focus();
    gate = await readAiGate();
    if (backdrop.isConnected && mode === 'ai') render();
  };

  const create = (): void => {
    const title = nameInput.value.trim().slice(0, 80);
    if (!title) {
      nameErr.textContent = t('np.nameNeeded');
      nameErr.hidden = false;
      nameInput.focus();
      return;
    }
    rememberStadium(selected.id);
    stashNewProject({ title, templateId: selected.id });
    go(newProjectUrl(selected.id));
  };

  const generate = (): void => {
    const brief = prompt.value.trim();
    if (!brief) {
      promptErr.textContent = t('np.aiNeedPrompt');
      promptErr.hidden = false;
      prompt.focus();
      return;
    }
    if (gate?.kind !== 'ok') return;
    rememberStadium(selected.id);
    const typed = nameInput.value.trim();
    stashNewProject({
      title: nameEdited && typed ? typed.slice(0, 80) : opts.defaultName,
      templateId: selected.id,
      prompt: brief.slice(0, 400),
      autoName: !(nameEdited && typed),
    });
    go(newProjectUrl(selected.id, { ai: '1' }));
  };

  nameInput.addEventListener('input', () => {
    nameEdited = true;
    nameErr.hidden = true;
  });
  nameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') create();
  });
  prompt.addEventListener('input', () => {
    promptErr.hidden = true;
  });
  prompt.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) generate();
  });
  backdrop.querySelectorAll<HTMLButtonElement>('.np-example').forEach((b) =>
    b.addEventListener('click', () => {
      prompt.value = b.textContent ?? '';
      promptErr.hidden = true;
      prompt.focus();
    }),
  );

  renderStadiums();
  renderFacts();
  render();
  if (mode === 'ai') void toAi();
  else {
    nameInput.focus();
    nameInput.select();
  }
}
