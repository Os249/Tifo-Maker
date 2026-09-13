import { t } from './i18n';

/**
 * Desktop-only gate for the editor.
 *
 * Two live bug reports from phones (Chrome/Android, 360x680) were both the same
 * story: the editor technically opened, so people tried to use it, and then hit
 * walls it was never built for on a phone — no way to pan the bowl to a
 * different stand, and adding an image appearing to hang. Letting a phone into
 * a tool that cannot serve it is worse than saying so up front, so /app now
 * stops below EDITOR_MIN_WIDTH and sends people to what does work on a phone:
 * the community, the home page, and shared tifo links (which still open in the
 * read-only viewer).
 *
 * Deliberate decisions:
 *  - Width only, no touch sniffing. A touchscreen laptop designs fine; a narrow
 *    window does not. Width is also the thing that actually breaks the layout.
 *  - Entry-only. An editor that is already open is never torn down when the
 *    window is dragged narrow — that would destroy someone's unsaved work.
 *  - main.ts mounts this BEFORE loading Pixi, Three and the toolbar, so a phone
 *    downloads a small page instead of ~1.3 MB to be told to come back later.
 */

/**
 * Below this width the editor is not offered. ?editor=1 overrides it.
 *
 * Was 900 while the editor was desktop-only. Phones now get their own front end
 * (ui/mobileShell.ts), so the gate only has to catch what neither layout serves:
 * a window too narrow for the phone ribbon's five tabs to hold their labels.
 */
export const EDITOR_MIN_WIDTH = 320;

const NARROW_QUERY = `(max-width: ${EDITOR_MIN_WIDTH - 1}px)`;

/** True when this viewport is too narrow for the editor and not force-opted in. */
export function isNarrowForEditor(): boolean {
  const forced = new URLSearchParams(location.search).get('editor') === '1';
  return !forced && window.matchMedia(NARROW_QUERY).matches;
}

function linkButton(href: string, label: string, primary: boolean, icon: string): HTMLAnchorElement {
  const a = document.createElement('a');
  a.className = primary ? 'gate-btn gate-btn-primary' : 'gate-btn';
  a.href = href;
  const i = document.createElement('i');
  i.className = `ti ti-${icon}`;
  i.setAttribute('aria-hidden', 'true');
  const span = document.createElement('span');
  span.textContent = label;
  a.append(i, span);
  return a;
}

/** Replace the page with the "come back on a desktop" screen. Owns the body. */
export function mountDesktopOnly(): void {
  document.title = `${t('dt.title')} — Tifo Maker`;
  document.body.innerHTML = '';
  document.body.className = 'gate';

  const root = document.createElement('main');
  root.className = 'gate-root';
  root.id = 'main';

  const brand = document.createElement('div');
  brand.className = 'gate-brand';
  brand.innerHTML = 'TIFO<b>MAKER</b>';

  const mark = document.createElement('div');
  mark.className = 'gate-mark';
  mark.innerHTML = '<i class="ti ti-device-desktop" aria-hidden="true"></i>';

  const h1 = document.createElement('h1');
  h1.className = 'gate-title';
  h1.textContent = t('dt.title');

  const body = document.createElement('p');
  body.className = 'gate-body';
  body.textContent = t('dt.body');

  const actions = document.createElement('div');
  actions.className = 'gate-actions';
  actions.append(
    linkButton('/community', t('dt.browse'), true, 'users'),
    linkButton('/', t('dt.home'), false, 'home'),
  );

  // The bridge to a desktop: copy the address so it can be pasted into a
  // message to yourself. Hidden entirely where the clipboard API is missing,
  // rather than shipping a button that silently does nothing.
  const copyWrap = document.createElement('div');
  copyWrap.className = 'gate-copy';
  if (navigator.clipboard?.writeText) {
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'gate-link';
    copy.innerHTML = '<i class="ti ti-link" aria-hidden="true"></i>';
    const copyLabel = document.createElement('span');
    copyLabel.textContent = t('dt.copy');
    copy.appendChild(copyLabel);
    const status = document.createElement('span');
    status.className = 'gate-copied';
    status.setAttribute('role', 'status');
    copy.addEventListener('click', () => {
      void navigator.clipboard
        .writeText(`${location.origin}/app`)
        .then(() => {
          status.textContent = t('dt.copied');
          window.setTimeout(() => (status.textContent = ''), 2600);
        })
        .catch(() => {
          // Clipboard denied (permissions, insecure context): show the address
          // so it can still be typed rather than failing silently.
          status.textContent = `${location.host}/app`;
        });
    });
    copyWrap.append(copy, status);
  }

  const note = document.createElement('p');
  note.className = 'gate-note';
  note.textContent = t('dt.note');

  root.append(brand, mark, h1, body, actions, copyWrap, note);
  document.body.appendChild(root);

  // Widening past the threshold (a laptop window dragged out, a rotation on a
  // large tablet) should hand over the editor rather than stranding people on a
  // screen that no longer applies. Reloading is safe here: nothing is unsaved,
  // and the reload re-runs the same check, so it cannot bounce.
  const mq = window.matchMedia(NARROW_QUERY);
  const onChange = (e: MediaQueryListEvent): void => {
    if (!e.matches) location.reload();
  };
  mq.addEventListener('change', onChange);

  // Back-forward cache can restore this page on a device that has since been
  // rotated or resized; re-check on restore instead of showing a stale gate.
  window.addEventListener('pageshow', (e) => {
    if ((e as PageTransitionEvent).persisted && !isNarrowForEditor()) location.reload();
  });
}
