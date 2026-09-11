/**
 * Tell the developer something.
 *
 * WHY THIS EXISTS
 * There was no way to report a bug from inside the product. The only routes out
 * were a Twitter handle in the footer and an email address in the legal page,
 * and effectively nobody takes either: a person who hits a broken state leaves,
 * and the bug is never heard about. The research is consistent that an in-app
 * widget collects far more than a separate portal, because it removes the
 * friction at the moment the thought occurs.
 *
 * WHAT IT ASKS FOR
 * As little as possible. One choice of kind, one box to type in, and an email
 * only if they want a reply. Every required field measurably reduces the number
 * of people who finish, and a report that says only "the save button does
 * nothing on my phone" is worth far more than a perfect form nobody submits.
 * For a bug there is a second, optional box for what they were doing, because
 * a bug that cannot be reproduced usually cannot be fixed.
 *
 * WHAT IT ATTACHES, AND WHY IT SHOWS IT
 * Browser, OS, device, viewport and the current path: the coarse facts that
 * make a bug reproducible, taken automatically because asking a person to find
 * their browser version is friction that produces wrong answers. It is printed
 * in the form before sending and can be switched off. Nothing identifying is
 * collected, and nothing is sent until the person presses the button.
 */

import { t } from './i18n';
import { isSignedIn } from '../net/api';

type Kind = 'bug' | 'idea' | 'other';

/**
 * The component carries its own styles.
 *
 * This modal opens from the editor AND from the footer of the landing,
 * community and clubs pages, and those pages do not load the editor's
 * stylesheet. Relying on it meant the form rendered completely unstyled for
 * every visitor who was not already in the editor - which is most of them, and
 * exactly the people most likely to be reporting that something looks wrong.
 * So the palette is literal here rather than inherited from whatever host page
 * happens to be underneath.
 */
const FEEDBACK_CSS = `
.fb-backdrop{ position:fixed; inset:0; z-index:2000; display:flex; align-items:center; justify-content:center;
  background:rgba(3,6,12,.72); backdrop-filter:blur(3px); padding:20px;
  font:14px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif; }
.fb-modal{ position:relative; width:min(460px,100%); max-height:88vh; overflow-y:auto; color:#e6edf3;
  background:#11151c; border:1px solid #2b3440; border-radius:14px; padding:22px 22px 18px;
  box-shadow:0 24px 60px rgba(0,0,0,.5); text-align:start; }
.fb-close{ position:absolute; top:10px; inset-inline-end:12px; background:none; border:none; color:#7d8794;
  font-size:22px; line-height:1; cursor:pointer; padding:4px 8px; }
.fb-close:hover{ color:#e6edf3; }
.fb-modal .fb-h3{ margin:0 0 6px; font-size:17px; color:#e6edf3; }
.fb-modal .fb-lead{ margin:0 0 16px; font-size:12.5px; line-height:1.6; color:#aeb8c4; }
.fb-kinds{ display:flex; gap:8px; margin-bottom:16px; flex-wrap:wrap; }
.fb-kind{ flex:1 1 auto; min-width:112px; display:inline-flex; align-items:center; justify-content:center; gap:6px;
  padding:9px 10px; border-radius:9px; cursor:pointer; font:inherit; font-size:12.5px; font-weight:600;
  background:#1a202a; border:1px solid #2b3440; color:#aeb8c4; }
.fb-kind:hover{ color:#e6edf3; }
.fb-kind.on{ background:#1c5fd9; border-color:transparent; color:#fff; }
.fb-label{ display:block; font-size:12px; font-weight:600; margin:0 0 6px; color:#e6edf3; }
.fb-optional{ font-weight:400; color:#7d8794; margin-inline-start:6px; }
.fb-input{ width:100%; padding:9px 11px; margin-bottom:12px; border-radius:8px; font:inherit; font-size:13px;
  background:#1a202a; border:1px solid #2b3440; color:#e6edf3; resize:vertical; box-sizing:border-box; }
.fb-input:focus{ outline:none; border-color:#1c5fd9; box-shadow:0 0 0 3px rgba(28,95,217,.3); }
.fb-hint{ margin:-6px 0 14px; font-size:11px; line-height:1.6; color:#7d8794; }
.fb-ctx{ display:flex; gap:9px; align-items:flex-start; font-size:11.5px; color:#aeb8c4; line-height:1.6;
  margin-bottom:14px; cursor:pointer; }
.fb-ctx input{ margin-top:2px; flex:0 0 auto; }
.fb-ctx-line{ display:block; margin-top:3px; font-size:10.5px; color:#7d8794; word-break:break-word; }
.fb-hp{ position:absolute; left:-9999px; top:0; width:1px; height:1px; overflow:hidden; }
.fb-error{ margin:0 0 12px; font-size:12px; color:#f85149; }
.fb-actions{ display:flex; gap:9px; justify-content:flex-end; }
.fb-cancel{ background:none; border:none; color:#7d8794; font:inherit; font-size:12.5px; cursor:pointer; padding:9px 12px; }
.fb-cancel:hover{ color:#aeb8c4; }
.fb-send{ padding:9px 20px; border:none; border-radius:8px; background:#1c5fd9; color:#fff;
  font:inherit; font-size:13px; font-weight:600; cursor:pointer; }
.fb-send:hover{ filter:brightness(1.08); }
.fb-send:disabled{ opacity:.6; cursor:default; }
.fb-done{ text-align:center; padding:14px 0 6px; }
.fb-done .ti{ font-size:38px; color:#0fbf6b; display:block; margin-bottom:10px; }
.fb-entry{ display:inline-flex; align-items:center; gap:6px; background:none; border:none;
  color:inherit; font:inherit; font-size:inherit; cursor:pointer; padding:0; opacity:.85; }
.fb-entry:hover{ opacity:1; text-decoration:underline; }
@media (max-width:480px){ .fb-modal{ padding:18px 16px 14px; } .fb-kind{ min-width:0; } }
`;

function ensureStyles(): void {
  if (document.getElementById('fb-styles')) return;
  const el = document.createElement('style');
  el.id = 'fb-styles';
  el.textContent = FEEDBACK_CSS;
  document.head.appendChild(el);
}


function clientFacts(): { browser: string; os: string; device: string } {
  const u = navigator.userAgent || '';
  const tablet = /iPad|Tablet|PlayBook|Silk|(Android(?!.*Mobile))/i.test(u);
  const mobile = /Mobi|iPhone|iPod|Android|Windows Phone|IEMobile/i.test(u);
  const device = tablet ? 'Tablet' : mobile ? 'Mobile' : 'Desktop';

  let os = 'unknown';
  if (/iPhone|iPad|iPod|iOS/i.test(u)) os = 'iOS';
  else if (/Android/i.test(u)) os = 'Android';
  else if (/Windows NT/i.test(u)) os = 'Windows';
  else if (/Mac OS X|Macintosh/i.test(u)) os = 'macOS';
  else if (/CrOS/i.test(u)) os = 'ChromeOS';
  else if (/Linux/i.test(u)) os = 'Linux';

  // Order matters: in-app webviews masquerade as Safari or Chrome later in the
  // string, and "it only breaks in the Instagram browser" is a real bug class.
  let browser = 'unknown';
  if (/FBAN|FBAV/i.test(u)) browser = 'Facebook in-app';
  else if (/Instagram/i.test(u)) browser = 'Instagram in-app';
  else if (/TikTok|BytedanceWebview/i.test(u)) browser = 'TikTok in-app';
  else if (/Edg\//i.test(u)) browser = 'Edge';
  else if (/OPR\/|Opera/i.test(u)) browser = 'Opera';
  else if (/SamsungBrowser/i.test(u)) browser = 'Samsung Internet';
  else if (/Firefox\//i.test(u)) browser = 'Firefox';
  else if (/Chrome\//i.test(u)) browser = 'Chrome';
  else if (/Safari\//i.test(u)) browser = 'Safari';
  return { browser, os, device };
}

function buildContext(): Record<string, unknown> {
  const f = clientFacts();
  return {
    // Path only. A query string can carry a share token or a design id, and
    // none of that belongs in a bug report.
    path: location.pathname.slice(0, 120),
    browser: f.browser,
    os: f.os,
    device: f.device,
    viewport: `${window.innerWidth}x${window.innerHeight}`,
    language: (navigator.language || '').slice(0, 12),
    signedIn: isSignedIn(),
  };
}

function contextSummary(c: Record<string, unknown>): string {
  return `${c.path} · ${c.browser} on ${c.os} · ${c.device} · ${c.viewport}`;
}

export function openFeedbackModal(initialKind: Kind = 'bug'): void {
  if (document.querySelector('.fb-backdrop')) return;
  ensureStyles();

  // The time-trap the server checks. Nothing a person typed arrives in under
  // two seconds, and a bot that posts instantly is silently dropped.
  const openedAt = Date.now();
  const ctx = buildContext();

  const backdrop = document.createElement('div');
  backdrop.className = 'fb-backdrop';
  backdrop.innerHTML = `
    <div class="fb-modal" role="dialog" aria-modal="true" aria-label="${t('fb.aria')}">
      <button class="fb-close" aria-label="${t('common.close')}">&times;</button>
      <h3 class="fb-h3">${t('fb.h')}</h3>
      <p class="fb-lead">${t('fb.lead')}</p>

      <div class="fb-kinds" role="radiogroup" aria-label="${t('fb.kindAria')}">
        <button type="button" class="fb-kind" data-kind="bug"><i class="ti ti-bug"></i> ${t('fb.bug')}</button>
        <button type="button" class="fb-kind" data-kind="idea"><i class="ti ti-bulb"></i> ${t('fb.idea')}</button>
        <button type="button" class="fb-kind" data-kind="other"><i class="ti ti-message"></i> ${t('fb.other')}</button>
      </div>

      <label class="fb-label" for="fb-message">${t('fb.what')}</label>
      <textarea id="fb-message" class="fb-input" rows="4" placeholder="${t('fb.whatPh')}"></textarea>

      <div class="fb-steps-wrap">
        <label class="fb-label" for="fb-steps">${t('fb.steps')}
          <span class="fb-optional">${t('common.optional')}</span></label>
        <textarea id="fb-steps" class="fb-input" rows="2" placeholder="${t('fb.stepsPh')}"></textarea>
      </div>

      <label class="fb-label" for="fb-email">${t('fb.email')}
        <span class="fb-optional">${t('common.optional')}</span></label>
      <input id="fb-email" class="fb-input" type="email" autocomplete="email" placeholder="${t('fb.emailPh')}" />
      <p class="fb-hint">${t('fb.emailHint')}</p>

      <label class="fb-ctx">
        <input type="checkbox" id="fb-attach" checked />
        <span>${t('fb.attach')}<code class="fb-ctx-line">${contextSummary(ctx)}</code></span>
      </label>

      <!-- Honeypot. Hidden from people and from assistive tech; bots fill it. -->
      <div class="fb-hp" aria-hidden="true">
        <label for="fb-website">Website</label>
        <input id="fb-website" name="website" type="text" tabindex="-1" autocomplete="off" />
      </div>

      <p class="fb-error" hidden></p>
      <div class="fb-actions">
        <button type="button" class="fb-cancel">${t('common.cancel')}</button>
        <button type="button" class="primary fb-send">${t('fb.send')}</button>
      </div>
    </div>`;
  const opener = document.activeElement as HTMLElement | null;
  document.body.appendChild(backdrop);

  const $ = <T extends HTMLElement>(sel: string): T => backdrop.querySelector(sel) as T;
  const message = $<HTMLTextAreaElement>('#fb-message');
  const steps = $<HTMLTextAreaElement>('#fb-steps');
  const email = $<HTMLInputElement>('#fb-email');
  const attach = $<HTMLInputElement>('#fb-attach');
  const honeypot = $<HTMLInputElement>('#fb-website');
  const errorEl = $<HTMLParagraphElement>('.fb-error');
  const sendBtn = $<HTMLButtonElement>('.fb-send');
  const stepsWrap = $<HTMLDivElement>('.fb-steps-wrap');

  let kind: Kind = initialKind;
  const paintKind = (): void => {
    backdrop.querySelectorAll<HTMLButtonElement>('.fb-kind').forEach((b) => {
      const on = b.dataset.kind === kind;
      b.classList.toggle('on', on);
      b.setAttribute('aria-checked', String(on));
    });
    // "What were you doing" only earns its place for a bug.
    stepsWrap.hidden = kind !== 'bug';
    message.placeholder = kind === 'bug' ? t('fb.whatPh') : kind === 'idea' ? t('fb.ideaPh') : t('fb.otherPh');
  };
  backdrop.querySelectorAll<HTMLButtonElement>('.fb-kind').forEach((b) => {
    b.setAttribute('role', 'radio');
    b.addEventListener('click', () => { kind = (b.dataset.kind as Kind) ?? 'bug'; paintKind(); });
  });
  paintKind();

  const close = (): void => {
    backdrop.remove();
    // Focus goes back to whatever opened this, so a keyboard user who
    // closes it is not dropped at the top of the document.
    if (opener && document.contains(opener)) opener.focus();
    document.removeEventListener('keydown', onKey);
  };
  const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  backdrop.addEventListener('mousedown', (e) => { if (e.target === backdrop) close(); });
  $('.fb-close').addEventListener('click', close);
  $('.fb-cancel').addEventListener('click', close);

  sendBtn.addEventListener('click', async () => {
    const text = message.value.trim();
    if (text.length < 4) {
      errorEl.textContent = t('fb.errEmpty');
      errorEl.hidden = false;
      message.focus();
      return;
    }
    errorEl.hidden = true;
    sendBtn.disabled = true;
    sendBtn.textContent = t('fb.sending');
    try {
      const res = await fetch('/api/feedback', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          kind,
          message: text,
          steps: kind === 'bug' ? steps.value.trim() || null : null,
          email: email.value.trim() || null,
          context: attach.checked ? ctx : null,
          elapsedMs: Date.now() - openedAt,
          website: honeypot.value,
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? 'could not send');
      }
      // Thank them properly. A form that just closes leaves people unsure it
      // worked, and a person who is unsure does not send a second report.
      backdrop.querySelector('.fb-modal')!.innerHTML =
        `<div class="fb-done"><i class="ti ti-circle-check"></i>` +
        `<h3 class="fb-h3">${t('fb.thanksH')}</h3>` +
        `<p class="fb-lead">${email.value.trim() ? t('fb.thanksReply') : t('fb.thanks')}</p>` +
        `<button type="button" class="primary fb-ok">${t('fb.done')}</button></div>`;
      backdrop.querySelector('.fb-ok')!.addEventListener('click', close);
      setTimeout(close, 4000);
    } catch (err) {
      errorEl.textContent = `${t('fb.errSend')} ${(err as Error).message}`;
      errorEl.hidden = false;
      sendBtn.disabled = false;
      sendBtn.textContent = t('fb.send');
    }
  });

  setTimeout(() => message.focus(), 0);
}
