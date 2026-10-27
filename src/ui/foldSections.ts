import { onLangChange, t } from './i18n';

/**
 * Side-panel sections that fold (Direction A, October 2026).
 *
 * The Paint tab stacks Brush, Colours and Layers, and on a laptop Layers was
 * a long scroll down. Each section's title is now a button that folds it to
 * its title and opens it again; the browser remembers which are folded
 * (tifo_folds_v1). Picking a tool opens the section that is about that tool,
 * so folding never hides what you reach for.
 *
 * The motion is the accordion of transitions.dev (free for use in products):
 * the body's grid row goes from 1fr to 0fr, so nothing measures heights, and
 * the chevron flips. It reads the motion tokens in ui/tokens.css, which drop
 * to zero for anyone who asks for less motion.
 *
 * The DOM keeps its shape where other code looks: a section stays a
 * .panel-section with its id, its title stays its first h4, and everything
 * after the title moves into .fold-body > .fold-inner.
 */

const KEY = 'tifo_folds_v1';

function readFolded(): Set<string> {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    return new Set(Array.isArray(v) ? v.filter((x) => typeof x === 'string').slice(0, 40) : []);
  } catch {
    return new Set();
  }
}

function saveFolded(ids: Set<string>): void {
  try {
    localStorage.setItem(KEY, JSON.stringify([...ids]));
  } catch {
    /* storage off: folds last until the page closes */
  }
}

const CHEVRON = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M4 6.5L8 10.5L12 6.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';

export function mountFoldSections(root: ParentNode = document): void {
  const folded = readFolded();
  const sections = [...root.querySelectorAll<HTMLElement>('.panel-section[id]')].filter(
    (s) => s.firstElementChild?.tagName === 'H4' && !s.querySelector(':scope > .fold-body'),
  );
  const parts = new Map<HTMLElement, HTMLButtonElement>();

  const setFolded = (sec: HTMLElement, fold: boolean, remember = true): void => {
    const btn = parts.get(sec);
    if (!btn || sec.classList.contains('folded') === fold) return;
    // Clip only while it moves or stays folded: an open section may hold a
    // menu or a picker that has to reach outside it.
    sec.classList.add('fold-anim');
    window.setTimeout(() => sec.classList.remove('fold-anim'), 320);
    sec.classList.toggle('folded', fold);
    btn.setAttribute('aria-expanded', String(!fold));
    btn.title = t(fold ? 'ed.fold.open' : 'ed.fold.close');
    const body = sec.querySelector<HTMLElement>(':scope > .fold-body');
    if (body) body.inert = fold;
    if (!remember) return;
    if (fold) folded.add(sec.id);
    else folded.delete(sec.id);
    saveFolded(folded);
  };

  for (const sec of sections) {
    const h4 = sec.firstElementChild as HTMLElement;
    const body = document.createElement('div');
    body.className = 'fold-body';
    body.id = `fold-${sec.id}`;
    const inner = document.createElement('div');
    inner.className = 'fold-inner';
    while (h4.nextSibling) inner.appendChild(h4.nextSibling);
    body.appendChild(inner);
    sec.appendChild(body);

    // A title translated as a whole (data-i18n on the h4 itself) keeps its key
    // on a span inside the button: applying the language replaces the text of
    // the element that carries the key, and that must not be the button's parent.
    const key = h4.getAttribute('data-i18n');
    if (key) {
      const span = document.createElement('span');
      span.setAttribute('data-i18n', key);
      span.textContent = h4.textContent;
      h4.textContent = '';
      h4.appendChild(span);
      h4.removeAttribute('data-i18n');
    }
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'fold-btn';
    btn.setAttribute('aria-controls', body.id);
    btn.setAttribute('aria-expanded', 'true');
    btn.title = t('ed.fold.close');
    while (h4.firstChild) btn.appendChild(h4.firstChild);
    btn.insertAdjacentHTML('beforeend', `<span class="fold-chev">${CHEVRON}</span>`);
    h4.appendChild(btn);
    h4.classList.add('fold-head');
    parts.set(sec, btn);
    // Panels that add to their section later (the AI panel's admin lock, a
    // list filled on first open) append to the section: their additions go
    // inside the fold too.
    new MutationObserver(() => {
      for (const el of [...sec.children]) if (el !== h4 && el !== body) inner.appendChild(el);
    }).observe(sec, { childList: true });
    btn.addEventListener('click', () => setFolded(sec, !sec.classList.contains('folded')));
    if (folded.has(sec.id)) {
      sec.classList.add('folded');
      btn.setAttribute('aria-expanded', 'false');
      btn.title = t('ed.fold.open');
      body.inert = true;
    }
  }

  onLangChange(() => {
    for (const [sec, btn] of parts) btn.title = t(sec.classList.contains('folded') ? 'ed.fold.open' : 'ed.fold.close');
  });

  // A tool opens its own section: the shown section that lists the fewest
  // tools besides it (Brush for the brush, the object's card for Select).
  document.addEventListener('tifo:tool', (e) => {
    const tool = (e as CustomEvent<string>).detail;
    let best: HTMLElement | null = null;
    let fewest = Infinity;
    for (const sec of parts.keys()) {
      if (sec.style.display === 'none' || sec.classList.contains('ctx-hidden')) continue;
      const tools = (sec.dataset.panel ?? '').split(/\s+/);
      if (!tools.includes(tool)) continue;
      if (tools.length < fewest) {
        fewest = tools.length;
        best = sec;
      }
    }
    if (best?.classList.contains('folded')) setFolded(best, false);
  });
}
