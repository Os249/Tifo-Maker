/** Shared keyboard/focus behavior for stacked modal overlays. */
interface DialogEntry {
  root: HTMLElement;
  opener: HTMLElement | null;
  dismiss: () => void;
}
const stack: DialogEntry[] = [];
const previousInert = new Map<HTMLElement, boolean>();
let previousOverflow = '';
let serial = 0;
const selector = 'a[href],button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex]:not([tabindex="-1"])';
const controls = (root: HTMLElement): HTMLElement[] => Array.from(root.querySelectorAll<HTMLElement>(selector))
  .filter((el) => el.tabIndex >= 0 && !el.closest('[inert]') && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden');

function syncBackground(): void {
  const top = stack.at(-1);
  for (const [el, inert] of previousInert) el.inert = inert;
  // A dialog may live inside another overlay (the simulator help, for
  // example). Isolate siblings along the whole path, not just body children.
  let branch = top?.root;
  while (branch?.parentElement) {
    const parent = branch.parentElement;
    for (const child of Array.from(parent.children)) {
      if (!(child instanceof HTMLElement) || child === branch || ['SCRIPT', 'STYLE'].includes(child.tagName)) continue;
      if (!previousInert.has(child)) previousInert.set(child, child.inert);
      child.inert = true;
    }
    if (parent === document.body) break;
    branch = parent;
  }
}
const observer = new MutationObserver(syncBackground);
function focusInside(entry: DialogEntry): void {
  const target = controls(entry.root)[0] ?? entry.root.querySelector<HTMLElement>('[role="dialog"]') ?? entry.root;
  if (!target.hasAttribute('tabindex') && !target.matches(selector)) target.tabIndex = -1;
  target.focus({ preventScroll: true });
}
function onKey(e: KeyboardEvent): void {
  const top = stack.at(-1);
  if (!top) return;
  if (e.key === 'Escape') {
    e.preventDefault(); e.stopImmediatePropagation(); top.dismiss();
  } else if (e.key === 'Tab') {
    const items = controls(top.root);
    const at = items.indexOf(document.activeElement as HTMLElement);
    if (!items.length || at < 0 || (e.shiftKey ? at === 0 : at === items.length - 1)) {
      e.preventDefault(); e.stopImmediatePropagation();
      if (items.length) items[e.shiftKey ? items.length - 1 : 0].focus();
      else focusInside(top);
    }
  }
}
function onFocus(e: FocusEvent): void {
  const top = stack.at(-1);
  if (top && !top.root.contains(e.target as Node)) focusInside(top);
}

/** Call after insertion. Release before removing the overlay; safe to call twice. */
export function containDialog(root: HTMLElement, dismiss: () => void): () => void {
  const entry: DialogEntry = { root, dismiss, opener: document.activeElement as HTMLElement | null };
  const dialog = root.matches('[role="dialog"]') ? root : root.querySelector<HTMLElement>('[role="dialog"]') ?? root.querySelector<HTMLElement>('.modal') ?? root;
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  const heading = dialog.querySelector<HTMLElement>('h2,h3,.dlg-title');
  if (heading && !dialog.hasAttribute('aria-label') && !dialog.hasAttribute('aria-labelledby')) {
    heading.id ||= `dialog-title-${++serial}`;
    dialog.setAttribute('aria-labelledby', heading.id);
  }
  if (!stack.length) {
    previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', onKey, true);
    document.addEventListener('focusin', onFocus);
    observer.observe(document.body, { childList: true });
  }
  stack.push(entry);
  syncBackground();
  focusInside(entry);
  return () => {
    const at = stack.indexOf(entry);
    if (at < 0) return;
    const wasTop = at === stack.length - 1;
    stack.splice(at, 1);
    syncBackground();
    if (!stack.length) {
      observer.disconnect();
      window.removeEventListener('keydown', onKey, true);
      document.removeEventListener('focusin', onFocus);
      document.body.style.overflow = previousOverflow;
      for (const [el, inert] of previousInert) el.inert = inert;
      previousInert.clear();
    }
    if (wasTop && entry.opener?.isConnected && !entry.opener.closest('[inert]')) entry.opener.focus({ preventScroll: true });
    else if (wasTop && stack.length) focusInside(stack.at(-1)!);
  };
}
