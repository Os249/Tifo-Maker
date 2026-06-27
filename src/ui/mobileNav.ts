/**
 * Shared mobile navigation + base mobile foundations for the marketing / content
 * pages (landing, community, clubs). On phones the inline nav links are hidden
 * and a hamburger opens a right-side drawer containing every link, the language
 * toggle, and the primary CTA — so the site feels like one product on a phone.
 *
 * Items are mirrored into the drawer: anchors navigate via their own href;
 * buttons proxy to the original element so existing handlers (language toggle,
 * sign-in) keep working. The drawer lives in <body> with cloned data-i18n
 * attributes, so the pages' applyDom() re-translation reaches it on language
 * switch. Call installMobileNav() once from each page entry, after the DOM is
 * parsed (module scripts are deferred, so top-level is fine).
 */

const MNAV_CSS = `
img, svg, video, canvas { max-width: 100%; }
.mnav-burger {
  display: none; align-items: center; justify-content: center;
  width: 44px; height: 44px; margin-inline-start: auto;
  border: none; background: transparent; color: inherit; cursor: pointer; border-radius: 10px;
}
.mnav-burger:hover { background: rgba(127,127,127,.14); }
.mnav-burger svg { width: 26px; height: 26px; }
.mnav-scrim {
  position: fixed; inset: 0; background: rgba(4,6,12,.5);
  opacity: 0; pointer-events: none; transition: opacity .2s; z-index: 998;
}
.mnav-scrim.open { opacity: 1; pointer-events: auto; }
.mnav-drawer {
  position: fixed; top: 0; right: 0; bottom: 0; width: min(82vw, 320px);
  background: #0F172A; color: #F1F4FB;
  transform: translateX(100%); transition: transform .24s ease; z-index: 999;
  display: flex; flex-direction: column; gap: 4px;
  padding: calc(18px + env(safe-area-inset-top)) 16px calc(18px + env(safe-area-inset-bottom));
  box-shadow: -14px 0 44px rgba(0,0,0,.45); overflow-y: auto;
  font-family: 'Inter', system-ui, -apple-system, sans-serif;
}
.mnav-drawer.open { transform: none; }
.mnav-title { font-weight: 800; font-size: 18px; letter-spacing: .04em; padding: 4px 14px 14px; color: #fff; }
.mnav-drawer a, .mnav-drawer button {
  display: block; width: 100%; text-align: start; box-sizing: border-box;
  padding: 13px 14px; border-radius: 12px; font: inherit; font-size: 16px; font-weight: 600;
  color: #F1F4FB; background: transparent; border: none; text-decoration: none; cursor: pointer; min-height: 48px;
}
.mnav-drawer a:hover, .mnav-drawer button:hover { background: rgba(255,255,255,.08); }
.mnav-drawer a.nav-cta, .mnav-drawer button.nav-cta {
  background: #1C6FE0; color: #fff; text-align: center; margin-top: 10px; border-radius: 999px;
}
@media (max-width: 860px) {
  .mnav-burger { display: inline-flex; }
  header.nav .nav-links { display: none !important; }
  header.nav { padding-top: calc(14px + env(safe-area-inset-top)); }
}
[dir="rtl"] .mnav-drawer { right: auto; left: 0; transform: translateX(-100%); }
[dir="rtl"] .mnav-drawer.open { transform: none; }
[dir="rtl"] .mnav-drawer a, [dir="rtl"] .mnav-drawer button { text-align: start; }
@media (prefers-reduced-motion: reduce) {
  .mnav-drawer, .mnav-scrim { transition: none; }
}
`;

const BURGER_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 6h18M3 12h18M3 18h18"/></svg>';

export function installMobileNav(): void {
  if (document.getElementById('mnav-style')) return; // idempotent
  const style = document.createElement('style');
  style.id = 'mnav-style';
  style.textContent = MNAV_CSS;
  document.head.appendChild(style);

  const header = document.querySelector('header.nav');
  const links = document.querySelector('.nav-links');
  if (!header || !links) return;

  const burger = document.createElement('button');
  burger.className = 'mnav-burger';
  burger.type = 'button';
  burger.setAttribute('aria-label', 'Menu');
  burger.setAttribute('aria-expanded', 'false');
  burger.innerHTML = BURGER_SVG;

  const scrim = document.createElement('div');
  scrim.className = 'mnav-scrim';
  const drawer = document.createElement('div');
  drawer.className = 'mnav-drawer';
  drawer.setAttribute('role', 'dialog');
  drawer.setAttribute('aria-label', 'Menu');

  const title = document.createElement('div');
  title.className = 'mnav-title';
  title.textContent = document.querySelector('.brand')?.textContent ?? 'TIFOMAKER';
  drawer.appendChild(title);

  const close = (): void => {
    drawer.classList.remove('open');
    scrim.classList.remove('open');
    burger.setAttribute('aria-expanded', 'false');
  };
  const open = (): void => {
    drawer.classList.add('open');
    scrim.classList.add('open');
    burger.setAttribute('aria-expanded', 'true');
  };

  Array.from(links.children).forEach((orig) => {
    const el = orig as HTMLElement;
    const clone = el.cloneNode(true) as HTMLElement;
    clone.removeAttribute('id');
    if (el.tagName === 'BUTTON') {
      clone.addEventListener('click', (e) => {
        e.preventDefault();
        el.click();
        close();
      });
    } else {
      clone.addEventListener('click', () => close());
    }
    drawer.appendChild(clone);
  });

  burger.addEventListener('click', () => (drawer.classList.contains('open') ? close() : open()));
  scrim.addEventListener('click', close);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') close();
  });

  header.appendChild(burger);
  document.body.append(scrim, drawer);
}
