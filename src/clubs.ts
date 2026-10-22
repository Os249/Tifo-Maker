import { cleanAddressBar } from './core/utm';
import { escapeHtml } from './core/escape';
import './clubs.css';
import { initLang, applyDom, toggleLang, t, tv } from './ui/i18n';
import { initScheme, setSchemeLabels } from './ui/colorScheme';
import { submitLead } from './net/api';
import { installMobileNav } from './ui/mobileNav';
import { installConsent } from './ui/consent';

initLang();
// The visit was counted when the page was sent; see core/utm.ts.
cleanAddressBar();
// Light / dark. The scheme is already on the <html> element (the inline head
// script settles it before first paint); this wires the header toggle and the
// translated labels.
initScheme();
setSchemeLabels({ dark: t('theme.dark'), light: t('theme.light') });

applyDom(document);
installMobileNav();
installConsent();

const langToggle = document.getElementById('lang-toggle');
if (langToggle) {
  langToggle.textContent = t('common.language');
  langToggle.addEventListener('click', () => {
    toggleLang();
    applyDom(document);
    langToggle.textContent = t('common.language');
  });
}

const form = document.getElementById('lead-form') as HTMLFormElement | null;
const submit = document.getElementById('lf-submit') as HTMLButtonElement | null;
const note = document.getElementById('lf-note');

form?.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!submit || !note) return;
  const data = {
    name: (document.getElementById('lf-name') as HTMLInputElement).value.trim(),
    email: (document.getElementById('lf-email') as HTMLInputElement).value.trim(),
    organization: (document.getElementById('lf-org') as HTMLInputElement).value.trim(),
    orgType: (document.getElementById('lf-type') as HTMLSelectElement).value,
    message: (document.getElementById('lf-msg') as HTMLTextAreaElement).value.trim(),
  };
  if (!data.name || !data.email) {
    note.textContent = t('clubs.invalid');
    note.className = 'b-form-note err';
    return;
  }
  submit.disabled = true;
  note.textContent = '';
  note.className = 'b-form-note';
  try {
    await submitLead(data);
    // Replace the form with a success state.
    form.classList.add('sent');
    form.innerHTML = `
      <div class="b-sent-icon">✓</div>
      <div class="b-sent-title">${escapeHtml(tv('clubs.thanks', { name: data.name.split(' ')[0] || data.name }))}</div>
      <div class="b-sent-body">${t('clubs.received')}</div>`;
  } catch (err) {
    submit.disabled = false;
    note.textContent = t('clubs.failed');
    note.className = 'b-form-note err';
  }
});


// The footer feedback entry. Lazy: the modal is only fetched once someone
// actually asks for it, so a visitor who never clicks pays nothing for it.
document.getElementById('foot-feedback')?.addEventListener('click', async () => {
  const { openFeedbackModal } = await import('./ui/feedbackModal');
  openFeedbackModal('other');
});
