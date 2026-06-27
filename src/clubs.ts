import './clubs.css';
import { initLang, applyDom, toggleLang, t } from './ui/i18n';
import { submitLead } from './net/api';
import { installMobileNav } from './ui/mobileNav';

initLang();
applyDom(document);
installMobileNav();

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
    note.textContent = 'Please add your name and a valid email.';
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
      <div class="b-sent-title">Thanks, ${escapeHtml(data.name.split(' ')[0] || 'there')}!</div>
      <div class="b-sent-body">We’ve got your details and will be in touch shortly to set up your walkthrough and venue model.</div>`;
  } catch (err) {
    submit.disabled = false;
    note.textContent = (err as Error).message;
    note.className = 'b-form-note err';
  }
});

function escapeHtml(s: string): string {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}
