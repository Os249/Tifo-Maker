import { initLang, applyDom, toggleLang, t } from './ui/i18n';
import { mountHeroStadium } from './heroStadium';
import { mountShowcase } from './showcase';
import { installMobileNav } from './ui/mobileNav';
import { installConsent } from './ui/consent';

// Apply saved language on load, then translate the static page.
initLang();
applyDom(document);
installMobileNav();
installConsent();

// Mount the real rotating 3D stadium in the hero (lazy, after first paint).
void mountHeroStadium();
// Populate the community showcase with real designs (social proof).
void mountShowcase();

// Keep the document <title> and toggle button label in sync.
const toggle = document.getElementById('lang-toggle');
toggle?.addEventListener('click', () => {
  toggleLang();
  applyDom(document);
  if (toggle) toggle.textContent = t('common.language');
});
