/**
 * Legal page entry.
 *
 * The legal texts are NOT run through t(): they are long prose with inline
 * links and emphasis, and t() sets textContent, which would strip that markup.
 * So the page carries both languages as complete blocks and this swaps which
 * one is shown, along with <html lang/dir> and the in-page anchors.
 */
import { initLang, applyDom, getLang, toggleLang, t } from './ui/i18n';
import { initScheme, setSchemeLabels } from './ui/colorScheme';

const yr = document.getElementById('yr');
if (yr) yr.textContent = String(new Date().getFullYear());

function show(): void {
  const ar = getLang() === 'ar';
  document.getElementById('legal-en')!.hidden = ar;
  document.getElementById('legal-ar')!.hidden = !ar;
  document.getElementById('toc-en')!.hidden = ar;
  document.getElementById('toc-ar')!.hidden = !ar;
  // Footer links point at whichever set of sections is on the page.
  const suffix = ar ? '-ar' : '';
  for (const [id, base] of [
    ['foot-terms', '#terms'],
    ['foot-privacy', '#privacy'],
    ['foot-au', '#acceptable-use'],
    ['foot-cookies', '#cookies'],
  ] as const) {
    document.getElementById(id)?.setAttribute('href', base + suffix);
  }
  const toggle = document.getElementById('lang-toggle');
  if (toggle) toggle.textContent = t('common.language');
  document.title = t('lg.title');
}

initLang();
// Light / dark. The scheme is already on the <html> element (the inline head
// script settles it before first paint); this wires the header toggle and the
// translated labels.
initScheme();
setSchemeLabels({ dark: t('theme.dark'), light: t('theme.light') });

applyDom(document);
show();

document.getElementById('lang-toggle')?.addEventListener('click', () => {
  toggleLang();
  applyDom(document);
  show();
});
