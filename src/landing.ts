import { initLang, applyDom, toggleLang, t } from './ui/i18n';

// Apply saved language on load, then translate the static page.
initLang();
applyDom(document);

// Keep the document <title> and toggle button label in sync.
const toggle = document.getElementById('lang-toggle');
toggle?.addEventListener('click', () => {
  toggleLang();
  applyDom(document);
  if (toggle) toggle.textContent = t('common.language');
});
