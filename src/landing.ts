import { initLang, applyDom, toggleLang, t } from './ui/i18n';
import { initScheme, setSchemeLabels } from './ui/colorScheme';
import { mountHeroStadium } from './heroStadium';
import { mountShowcase } from './showcase';
import { localizeDailyTifo, mountDailyTifo } from './dailyTifo';
import { installMobileNav } from './ui/mobileNav';
import { installConsent } from './ui/consent';

// Apply saved language on load, then translate the static page.
initLang();
// Light / dark. The scheme is already on the <html> element (the inline head
// script settles it before first paint); this wires the header toggle and the
// translated labels.
initScheme();
setSchemeLabels({ dark: t('theme.dark'), light: t('theme.light') });

applyDom(document);
installMobileNav();
installConsent();

// Mount the real rotating 3D stadium in the hero (lazy, after first paint).
void mountHeroStadium();
// Populate the community showcase with real designs (social proof).
void mountShowcase();
// Tifo of the day. Usually already in the HTML (the server renders it), in
// which case this only settles which language the design's title shows in.
void mountDailyTifo();

// Keep the document <title> and toggle button label in sync.
const toggle = document.getElementById('lang-toggle');
toggle?.addEventListener('click', () => {
  toggleLang();
  applyDom(document);
  // A design's own title is data, not a string table entry, so applyDom cannot
  // reach it — it ships in both languages on the element and swaps here.
  localizeDailyTifo();
  if (toggle) toggle.textContent = t('common.language');
});

// The footer feedback entry. Lazy: the modal is only fetched once someone
// actually asks for it, so a visitor who never clicks pays nothing for it.
document.getElementById('foot-feedback')?.addEventListener('click', async () => {
  const { openFeedbackModal } = await import('./ui/feedbackModal');
  openFeedbackModal('other');
});
