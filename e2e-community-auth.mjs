/**
 * The sign-in / create-account dialog on the community page.
 *
 * Reported (Sept 2026): it looked broken there. The dialog is shared with the
 * editor, but the community page styles it from its own stylesheet, and that
 * copy had fallen behind: the Google button, the "or" divider, "Forgot
 * password?", "Back to sign in" and the note were bare browser buttons, and
 * `.auth-field { display: flex }` beat the `hidden` attribute, so "Confirm
 * password" showed on the Sign in tab.
 *
 * Every state is checked in dark, light, Arabic and on a phone. The Google
 * button only appears when the server has Google credentials, so the provider
 * list is answered here rather than depending on the server's environment.
 *
 * Needs the server on :8911 with a built dist (npm run build; PORT=8911 npm run server).
 */
import { chromium } from 'playwright';

const B = 'http://127.0.0.1:8911';
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' }).catch(() => chromium.launch());
let pass = 0, fail = 0;
const check = (n, ok, x = '') => { (ok ? pass++ : fail++); console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${x ? '  — ' + x : ''}`); };

async function open(theme, lang, w, h, phone = false) {
  const ctx = await browser.newContext({
    viewport: { width: w, height: h },
    colorScheme: theme,
    ...(phone ? { deviceScaleFactor: 2, isMobile: true, hasTouch: true } : {}),
    storageState: { cookies: [], origins: [{ origin: B, localStorage: [
      { name: 'tifo_lang_v1', value: lang }, { name: 'tifo_consent_v1', value: 'essential' }, { name: 'tifo_theme_v1', value: theme }] }] },
  });
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', (e) => errs.push(e.message.slice(0, 160)));
  await p.route('**/api/auth/providers', (r) => r.fulfill({ contentType: 'application/json', body: '{"providers":["google"]}' }));
  await p.goto(B + '/community', { waitUntil: 'networkidle', timeout: 120000 });
  await p.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme);
  await p.waitForFunction(() => document.getElementById('auth-btn'), null, { timeout: 60000 });
  await p.evaluate(() => document.getElementById('auth-btn').click());
  await p.waitForSelector('.auth-modal');
  await p.waitForSelector('.auth-providers:not([hidden])', { timeout: 10000 }).catch(() => {});
  await p.waitForTimeout(300);
  return { ctx, p, errs };
}

/** Everything a check needs about the dialog, read in one go. */
const read = (p) => p.evaluate(() => {
  const q = (s) => document.querySelector(s);
  const cs = (el) => getComputedStyle(el);
  const shown = (el) => !!el && cs(el).display !== 'none' && el.getClientRects().length > 0;
  const rgb = (c) => (c.match(/[\d.]+/g) || []).map(Number);
  const lum = ([r, g, b]) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
  const contrast = (a, b) => { const [x, y] = [lum(rgb(a)), lum(rgb(b))].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); };
  const opaque = (c) => { const v = rgb(c); return v.length < 4 || v[3] > 0; };
  // The colour actually behind an element: walk up to the first painted background.
  // Translucent layers (the error box's tint) are blended onto what is beneath them.
  const bgOf = (el) => {
    const layers = [];
    for (let e = el; e; e = e.parentElement) {
      const v = rgb(cs(e).backgroundColor); const a = v.length < 4 ? 1 : v[3];
      if (a > 0) { layers.push([...v.slice(0, 3), a]); if (a >= 1) break; }
    }
    let [r, g, b] = layers.length && layers[layers.length - 1][3] >= 1 ? layers.pop() : [255, 255, 255];
    for (const [lr, lg, lb, a] of layers.reverse()) { r = lr * a + r * (1 - a); g = lg * a + g * (1 - a); b = lb * a + b * (1 - a); }
    return `rgb(${r}, ${g}, ${b})`;
  };
  const isUaButton = (el) => { const s = cs(el); return /rgb\(2(39|40), 2(39|40), 2(39|40)\)/.test(s.backgroundColor) || s.borderStyle === 'outset'; };
  const modal = q('.auth-modal'), m = modal.getBoundingClientRect();
  const google = q('.auth-provider'), idIn = q('.auth-form input[name="identity"]');
  const submit = q('.auth-form .auth-submit'), form = q('.auth-form');
  const close = q('.auth-close').getBoundingClientRect();
  const tabs = [...document.querySelectorAll('.auth-tab')];
  const active = tabs.find((t) => t.classList.contains('active')), idle = tabs.find((t) => !t.classList.contains('active'));
  return {
    modalRadius: parseFloat(cs(modal).borderTopLeftRadius),
    modalInView: m.left >= 0 && m.right <= innerWidth + 0.5,
    pageScrollsSideways: document.documentElement.scrollWidth > innerWidth + 1,
    tabsDiffer: !!active && !!idle && cs(active).backgroundColor !== cs(idle).backgroundColor,
    activeTabContrast: active ? contrast(cs(active).color, bgOf(active)) : 0,
    googleShown: shown(google), googleRadius: parseFloat(cs(google).borderTopLeftRadius), googleUa: isUaButton(google),
    googleMark: !!google.querySelector('svg'), googleContrast: contrast(cs(google).color, bgOf(google)),
    orShown: shown(q('.auth-or')),
    confirmShown: shown(q('.auth-confirm')), termsShown: shown(q('.auth-terms')),
    inputHeight: idIn.getBoundingClientRect().height, inputRadius: parseFloat(cs(idIn).borderTopLeftRadius),
    inputContrast: contrast(cs(idIn).color, bgOf(idIn)),
    labelContrast: contrast(cs(q('.auth-field span')).color, bgOf(modal)),
    submitFull: Math.abs(submit.getBoundingClientRect().width - form.getBoundingClientRect().width) < 2,
    submitContrast: contrast(cs(submit).color, cs(submit).backgroundColor),
    submitBlue: (() => { const [r, g, b] = rgb(cs(submit).backgroundColor); return b > 150 && b > r + 60; })(),
    forgotShown: shown(q('.auth-forgot-link')), forgotUa: isUaButton(q('.auth-forgot-link')),
    forgotContrast: contrast(cs(q('.auth-forgot-link')).color, bgOf(modal)),
    noteContrast: contrast(cs(q('.auth-note')).color, bgOf(modal)),
    errorShown: shown(q('.auth-error')), errorPainted: opaque(cs(q('.auth-error')).backgroundColor),
    errorContrast: contrast(cs(q('.auth-error')).color, bgOf(q('.auth-error'))),
    forgotFormShown: shown(q('.auth-forgot')), mainFormShown: shown(form), tabsShown: shown(q('.auth-tabs')),
    providersShown: shown(q('.auth-providers')), backShown: shown(q('.auth-back')), backUa: isUaButton(q('.auth-back')),
    closeSide: close.left + close.width / 2 < m.left + m.width / 2 ? 'left' : 'right',
    dir: document.documentElement.dir || 'ltr',
  };
});

for (const [theme, lang, w, h, phone] of [['dark', 'en', 1280, 900], ['light', 'en', 1280, 900], ['dark', 'ar', 1280, 900], ['light', 'en', 390, 844, true], ['dark', 'ar', 390, 844, true]]) {
  console.log(`\n— ${theme}, ${lang}, ${w}px —`);
  const { ctx, p, errs } = await open(theme, lang, w, h, phone);

  let s = await read(p);
  check('the dialog is a rounded card', s.modalRadius >= 12, `${s.modalRadius}px`);
  check('it fits the screen, no sideways scroll', s.modalInView && !s.pageScrollsSideways);
  check('the active tab stands out and reads', s.tabsDiffer && s.activeTabContrast >= 4.5, s.activeTabContrast.toFixed(1));
  check('"Continue with Google" is a styled pill with the G', s.googleShown && s.googleRadius >= 16 && !s.googleUa && s.googleMark);
  check('…and its text reads', s.googleContrast >= 4.5, s.googleContrast.toFixed(1));
  check('the "or" divider shows', s.orShown);
  check('Sign in has no "Confirm password" and no terms line', !s.confirmShown && !s.termsShown);
  check('inputs are tall and rounded', s.inputHeight >= 40 && s.inputRadius >= 8, `${s.inputHeight}px / ${s.inputRadius}px`);
  check('input text and labels read', s.inputContrast >= 4.5 && s.labelContrast >= 4.5, `${s.inputContrast.toFixed(1)} / ${s.labelContrast.toFixed(1)}`);
  check('the submit button is a full-width blue button that reads', s.submitFull && s.submitBlue && s.submitContrast >= 4.5, s.submitContrast.toFixed(1));
  check('"Forgot password?" is a link, not a grey browser button', s.forgotShown && !s.forgotUa && s.forgotContrast >= 4.5);
  check('the note reads', s.noteContrast >= 4.5, s.noteContrast.toFixed(1));
  check(`the close button sits at the ${s.dir === 'rtl' ? 'left' : 'right'}`, s.closeSide === (s.dir === 'rtl' ? 'left' : 'right'), s.closeSide);

  await p.click('.auth-tab[data-mode="signup"]');
  s = await read(p);
  check('Create account shows "Confirm password" and the terms line', s.confirmShown && s.termsShown);
  check('…and no "Forgot password?"', !s.forgotShown);

  await p.click('.auth-tab[data-mode="signin"]');
  await p.click('.auth-form .auth-submit');
  s = await read(p);
  check('an empty submit shows a painted error box that reads', s.errorShown && s.errorPainted && s.errorContrast >= 4.5, s.errorContrast.toFixed(1));

  await p.click('.auth-forgot-link');
  s = await read(p);
  check('Forgot password swaps in the reset form', s.forgotFormShown && !s.mainFormShown && !s.tabsShown);
  check('…without "Continue with Google" above it', !s.providersShown);
  check('"Back to sign in" is a link, not a grey browser button', s.backShown && !s.backUa);
  await p.click('.auth-back');
  s = await read(p);
  check('and going back restores the Google button', s.providersShown && s.mainFormShown && s.tabsShown);

  check('no page errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

// The same dialog in the editor, which styles it from floodlight.css. There a
// global `label { align-items: center }` shrank the password box to its content
// and centred every label.
for (const lang of ['en', 'ar']) {
  console.log(`\n— the editor, ${lang} —`);
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 }, storageState: { cookies: [], origins: [{ origin: B, localStorage: [
    { name: 'tifo_lang_v1', value: lang }, { name: 'tifo_consent_v1', value: 'essential' }, { name: 'tifo_onboarded_v1', value: '1' }] }] } });
  const p = await ctx.newPage();
  await p.route('**/api/auth/providers', (r) => r.fulfill({ contentType: 'application/json', body: '{"providers":["google"]}' }));
  await p.goto(B + '/app', { waitUntil: 'networkidle', timeout: 120000 });
  await p.waitForFunction(() => document.getElementById('signin'), null, { timeout: 60000 });
  await p.evaluate(() => document.getElementById('signin').click());
  await p.waitForSelector('.auth-providers:not([hidden])', { timeout: 10000 }).catch(() => {});
  const layout = () => p.evaluate(() => {
    const fields = [...document.querySelectorAll('.auth-form .auth-field:not([hidden])')];
    const form = document.querySelector('.auth-form').getBoundingClientRect();
    const rtl = document.documentElement.dir === 'rtl';
    return fields.map((f) => {
      const box = (f.querySelector('.pwf-box') || f.querySelector('input')).getBoundingClientRect();
      const lab = f.querySelector('span').getBoundingClientRect();
      return { fullWidth: Math.abs(box.width - form.width) < 2, labelAtStart: rtl ? Math.abs(lab.right - form.right) < 2 : Math.abs(lab.left - form.left) < 2 };
    });
  });
  let f = await layout();
  check('every box spans the form', f.length === 2 && f.every((x) => x.fullWidth), JSON.stringify(f));
  check('labels sit at the start, not centred', f.every((x) => x.labelAtStart));
  const overlap = await p.evaluate(() => {
    const a = document.querySelector('.auth-close').getBoundingClientRect(), b = document.querySelector('.auth-brand');
    const r = document.createRange(); r.selectNodeContents(b); const t = r.getBoundingClientRect();
    return !(a.right <= t.left || a.left >= t.right || a.bottom <= t.top || a.top >= t.bottom);
  });
  check('the close button stays clear of the logo', !overlap);
  await p.click('.auth-tab[data-mode="signup"]');
  f = await layout();
  check('the same on Create account (password + confirm)', f.length === 3 && f.every((x) => x.fullWidth && x.labelAtStart), JSON.stringify(f));
  await p.click('.auth-tab[data-mode="signin"]');
  await p.click('.auth-forgot-link');
  check('Forgot password hides "Continue with Google"', await p.evaluate(() => document.querySelector('.auth-providers').hidden));
  await ctx.close();
}

await browser.close();
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
