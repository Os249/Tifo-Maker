import { t, onLangChange } from './i18n';
import { track } from '../net/analytics';

/**
 * The AI prompt bar on the canvas (Direction A, October 2026).
 *
 * The AI Designer lived behind its own panel tab: two steps away from the
 * stands, for the thing the paid plan will sell. The bar puts one line on the
 * canvas: what you want, where (the whole bowl or one stand), Go.
 *
 * It is the AI tab, not a second AI. Go writes the brief into the tab's own
 * prompt and presses the tab's own Generate, so the sign-in, the limits, the
 * progress, the result and every card are exactly the tab's. The bar shows
 * the progress as one shimmering line; anything that needs reading (a limit,
 * a failure, a result to keep or undo) opens the AI tab, where it is.
 *
 * Desktop and tablet only (phones have the AI tab in their bottom bar); never
 * in the Banner view or while the first-tifo guide is up.
 */

const STANDS = ['north', 'east', 'south', 'west'] as const;
type Stand = (typeof STANDS)[number];
/** A brief that already says where: the bar adds nothing to it. */
const NAMES_A_STAND = /\b(north|south|east|west|kop|whole|stadium|bowl|everywhere)\b|الشمال|الجنوب|الشرق|الغرب|كامل|الملعب كله/i;

export function mountAiBar(): void {
  const form = document.getElementById('ai-bar') as HTMLFormElement | null;
  const input = document.getElementById('ai-bar-input') as HTMLInputElement | null;
  const target = document.getElementById('ai-bar-target') as HTMLSelectElement | null;
  const go = document.getElementById('ai-bar-go') as HTMLButtonElement | null;
  const state = document.getElementById('ai-bar-state') as HTMLElement | null;
  const prompt = document.getElementById('ai-prompt') as HTMLTextAreaElement | null;
  const generate = document.getElementById('ai-generate') as HTMLButtonElement | null;
  const section = document.getElementById('ctx-ai');
  if (!form || !input || !target || !go || !state || !prompt || !generate || !section) return;

  // Where: the stand that is picked on the strip, else the whole bowl.
  const fillTargets = (): void => {
    const keep = target.value;
    target.replaceChildren();
    const add = (value: string, label: string): void => {
      const o = document.createElement('option');
      o.value = value;
      o.textContent = label;
      target.appendChild(o);
    };
    add('whole', t('ai.bar.whole'));
    for (const s of STANDS) add(s, t(`ai.bar.on.${s}`));
    target.value = keep || 'whole';
  };
  fillTargets();
  onLangChange(() => { fillTargets(); setState(phase); });
  document.addEventListener('click', (e) => {
    const chip = (e.target as Element | null)?.closest?.('#stand-chips .stand-chip[data-stand]') as HTMLElement | null;
    if (!chip) return;
    const s = chip.dataset.stand ?? 'all';
    target.value = (STANDS as readonly string[]).includes(s) ? s : 'whole';
  });

  type Phase = 'idle' | 'busy' | 'done' | 'card';
  let phase: Phase = 'idle';
  const setState = (p: Phase, text = ''): void => {
    phase = p;
    form.dataset.phase = p;
    const words = text || (p === 'busy' ? t('ai.bar.busy') : p === 'done' ? t('ai.bar.done') : p === 'card' ? t('ai.bar.card') : '');
    state.textContent = words;
    state.dataset.text = words; // the shimmer layer paints the same words
    go.disabled = p === 'busy';
    if (openBtn) openBtn.hidden = p !== 'done' && p !== 'card';
  };
  const openBtn = document.getElementById('ai-bar-open') as HTMLButtonElement | null;
  const openTab = (): void => document.getElementById('rail-ai')?.click();
  openBtn?.addEventListener('click', openTab);

  // Follow the tab's own run: its progress line while it works, then its card
  // (a limit, a failure: open the tab, where it can be read) or its result.
  const progress = document.getElementById('ai-progress');
  const stage = document.getElementById('ai-progress-stage');
  const card = document.getElementById('ai-state');
  const result = document.getElementById('ai-result');
  const visible = (el: HTMLElement | null): boolean => !!el && !el.hidden && el.style.display !== 'none';
  let watching: MutationObserver | null = null;
  let sawProgress = false;
  const stop = (): void => { watching?.disconnect(); watching = null; };
  // A result is done even with its card up when the card only says so (the
  // tab's "good" tone); any other card (a limit, a failure, a missing
  // picture) is something to read, so the tab opens on it.
  const settle = (): void => {
    stop();
    const note = visible(card) && card?.dataset.tone !== 'good';
    if (sawProgress && visible(result) && !note) { setState('done'); input.value = ''; }
    else if (visible(card)) { setState('card'); openTab(); }
    else setState('idle');
    if (phase !== 'idle') backLater();
  };
  // The bar goes back to its input by itself after a while, and at once when
  // it is clicked: the line says what happened, then gets out of the way.
  let back = 0;
  const backToInput = (focus: boolean): void => {
    window.clearTimeout(back);
    setState('idle');
    if (focus) input.focus();
  };
  const backLater = (): void => {
    window.clearTimeout(back);
    back = window.setTimeout(() => { if (phase === 'done' || phase === 'card') backToInput(false); }, 8000);
  };
  state.addEventListener('click', () => { if (phase === 'done' || phase === 'card') backToInput(true); });
  const watch = (): void => {
    stop();
    sawProgress = false;
    watching = new MutationObserver(() => {
      if (visible(progress)) {
        sawProgress = true;
        setState('busy', (stage?.textContent ?? '').trim() || t('ai.bar.busy'));
      } else if (sawProgress || visible(card)) {
        settle();
      }
    });
    watching.observe(section, { subtree: true, attributes: true, childList: true, characterData: true });
  };

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    // After a run the line shows what happened; Go brings the input back.
    if (phase === 'done' || phase === 'card') { backToInput(true); return; }
    const brief = input.value.trim();
    if (!brief) {
      input.focus();
      form.classList.remove('ai-bar-shake');
      void form.offsetWidth;
      form.classList.add('ai-bar-shake');
      return;
    }
    const where = target.value as Stand | 'whole';
    // The tab's prompt, with the stand said in the brief's own language when
    // the brief does not already say where.
    prompt.value = where !== 'whole' && !NAMES_A_STAND.test(brief) ? `${brief} ${t(`ai.bar.in.${where}`)}` : brief;
    track('ai_bar');
    setState('busy');
    watch();
    generate.click();
    // Signed out, Generate opens the sign-up instead of running: the bar goes
    // quiet, and still follows a run that starts once they are in.
    window.setTimeout(() => { if (phase === 'busy' && !sawProgress && !visible(card)) setState('idle'); }, 2500);
    window.setTimeout(() => { if (!sawProgress) stop(); }, 5 * 60 * 1000);
  });
  setState('idle');
}
