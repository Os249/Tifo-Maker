import { t } from './i18n';
import { track } from '../net/analytics';

/**
 * The guided first tifo (Direction B of the October 2026 review).
 *
 * The editor is a full workshop: nine tools, four views, five panel tabs, a
 * camera bar, layers, AI. Someone who has just picked their club and watched
 * its tifo go up card by card does not need the workshop; they need the next
 * step. Of 1,235 people who opened the editor in the 30 days to 25 Oct, 67%
 * painted and 75% looked in 3D, but only 2.3% opened Post it and 0.5% shared.
 *
 * So the first project gets four steps, one "Next" each: the club's colours,
 * make it yours on the seats, see it in the stadium, post it. Each step puts
 * the editor where that step happens (the view, the tab, the tool) and lights
 * up the control it is about. "Free mode" leaves at any point for the whole
 * editor, and the guide never comes back on its own (tifo_guide_v1).
 *
 * Desktop: a card at the top of the side panel, above the tabs, so it never
 * covers the stands. Phones and narrow windows: a card above the bottom bar,
 * under any sheet that opens, which is where it was going to be read anyway.
 */

const FLAG = 'tifo_guide_v1';

export function guideSeen(): boolean {
  try {
    return !!localStorage.getItem(FLAG);
  } catch {
    return true; // storage off: never nag
  }
}

function mark(how: 'done' | 'free'): void {
  try {
    localStorage.setItem(FLAG, how);
  } catch {
    /* storage off: it simply comes back next time */
  }
}

export interface GuideDeps {
  /** The editor's own view switch (main.ts), so the phone shell follows too. */
  setView: (view: '2d' | '3d' | 'split') => Promise<void>;
}

interface Step {
  name: string;
  head: string;
  body: string;
  view?: '2d' | '3d' | 'split';
  enter?: () => void;
  spot: () => Element | null;
}

let active = false;
export const guideActive = (): boolean => active;

export function startGuide(deps: GuideDeps): void {
  if (active || document.querySelector('.gd')) return;
  active = true;
  track('guide_started');
  const shell = document.body.classList.contains('m-shell');
  const docked = !shell && window.matchMedia('(min-width: 1100px)').matches;
  const $ = <T extends Element>(sel: string): T | null => document.querySelector<T>(sel);
  const click = (sel: string): void => $<HTMLElement>(sel)?.click();

  const steps: Step[] = [
    {
      name: t('gd.s1'),
      head: t('gd.h1'),
      body: t(shell ? 'gd.p1Phone' : 'gd.p1'),
      enter: () => {
        if (shell) return;
        click('#panel-tab-paint');
        $('#fg-well')?.closest('.panel-section')?.scrollIntoView({ block: 'nearest' });
      },
      spot: () => (shell ? $('.m-tab[data-tab="colors"]') : $('#fg-well')?.closest('.panel-section') ?? null),
    },
    {
      name: t('gd.s2'),
      head: t('gd.h2'),
      body: t(shell ? 'gd.p2Phone' : 'gd.p2'),
      // On a desktop the strip is drawn on in Split, under the stadium, with
      // the stand buttons in its dock; a phone has its own Design view.
      view: shell ? '2d' : 'split',
      enter: () => {
        if (!shell && !$('.tool[data-tool="brush"].active')) click('.tool[data-tool="brush"]');
      },
      spot: () => (shell ? $('.m-stands') : $('#stand-chips')),
    },
    {
      name: t('gd.s3'),
      head: t('gd.h3'),
      body: t('gd.p3'),
      view: '3d',
      spot: () => (shell ? $('.m-md [data-md-open]') : $('#match-day')),
    },
    {
      name: t('gd.s4'),
      head: t('gd.h4'),
      body: t('gd.p4'),
      view: '3d',
      spot: () => (shell ? $('.m-md .m-post') : $('#post-tifo')),
    },
  ];

  const card = document.createElement('section');
  card.className = `gd ${docked ? 'gd-docked' : 'gd-float'}`;
  card.setAttribute('aria-label', t('gd.label'));
  card.innerHTML = `
    <div class="gd-top">
      <span class="gd-label">${t('gd.label')}</span>
      <button class="gd-free" type="button" title="${t('gd.freeT')}">${t('gd.free')}</button>
    </div>
    <ol class="gd-steps">${steps.map((s, i) => `<li data-i="${i}"><b>${i + 1}</b><span>${s.name}</span></li>`).join('')}</ol>
    <h3 class="gd-h" aria-live="polite"></h3>
    <p class="gd-p"></p>
    <div class="gd-act">
      <button class="gd-back" type="button">${t('gd.back')}</button>
      <button class="gd-next" type="button"></button>
    </div>`;
  const head = card.querySelector('.gd-h') as HTMLElement;
  const body = card.querySelector('.gd-p') as HTMLElement;
  const back = card.querySelector('.gd-back') as HTMLButtonElement;
  const next = card.querySelector('.gd-next') as HTMLButtonElement;
  const items = [...card.querySelectorAll<HTMLElement>('.gd-steps li')];

  if (docked) {
    const panel = document.getElementById('panel');
    if (panel?.classList.contains('collapsed')) click('#panel-toggle');
    panel?.querySelector('.panel-head')?.prepend(card);
  } else {
    document.body.appendChild(card);
  }
  document.body.classList.add('guided');

  let at = -1;
  let lit: Element | null = null;
  const light = (el: Element | null): void => {
    lit?.classList.remove('gd-spot');
    lit = el;
    lit?.classList.add('gd-spot');
  };
  const go = async (i: number): Promise<void> => {
    if (i < 0 || i >= steps.length) return;
    at = i;
    const s = steps[i]!;
    items.forEach((li, k) => {
      li.classList.toggle('on', k === i);
      li.classList.toggle('done', k < i);
      if (k === i) li.setAttribute('aria-current', 'step');
      else li.removeAttribute('aria-current');
    });
    card.classList.toggle('gd-up', !docked && i === 1);
    head.textContent = s.head;
    body.textContent = s.body;
    back.hidden = i === 0;
    const last = i === steps.length - 1;
    next.innerHTML = last ? `<i class="ti ti-share" aria-hidden="true"></i> ${t('post.btn')}` : t('gd.next');
    next.classList.toggle('gd-post', last);
    if (s.view) await deps.setView(s.view);
    if (at !== i) return; // a quicker press moved on while the view changed
    s.enter?.();
    // The control a step is about may only exist once its view is up (the
    // phone's Match Day pill rides with the Stadium view).
    window.setTimeout(() => { if (at === i) light(s.spot()); }, 120);
  };
  const finish = (how: 'done' | 'free'): void => {
    light(null);
    card.remove();
    document.body.classList.remove('guided');
    active = false;
    mark(how);
    track(how === 'done' ? 'guide_done' : 'guide_free');
  };

  back.addEventListener('click', () => void go(at - 1));
  next.addEventListener('click', () => {
    if (at < steps.length - 1) { void go(at + 1); return; }
    // The last step's button is Post it itself: the one in the header (or
    // beside Match Day on a phone) opens the same sheet.
    finish('done');
    click('#post-tifo');
  });
  card.querySelector('.gd-free')!.addEventListener('click', () => finish('free'));
  void go(0);
}
