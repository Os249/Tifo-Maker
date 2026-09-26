/**
 * The cookie banner on a first visit, with the Start dialog open.
 *
 * Reported (Sept 2026): on the editor's first visit neither "Accept all" nor
 * "Essential only" did anything. The Start dialog makes everything else on the
 * page inert for keyboard and screen-reader users — and the cookie banner,
 * appended to <body> before it, went inert with the rest. The banner also sat
 * on top of the dialog's own Start button.
 *
 * Every click here is a real mouse click at the button's centre, not
 * `element.click()`: a scripted click goes straight to the element and would
 * have passed while the real thing was blocked.
 *
 * Needs the server on :8911 with a built dist (npm run build; PORT=8911 npm run server).
 */
import { chromium } from 'playwright';

const B = 'http://127.0.0.1:8911';
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] })
  .catch(() => chromium.launch());
let pass = 0, fail = 0;
const check = (n, ok, x = '') => { (ok ? pass++ : fail++); console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${x ? '  — ' + x : ''}`); };

/** A brand-new visitor: nothing chosen, never onboarded. */
async function firstVisit(w, h, lang = 'en', phone = false) {
  const ctx = await browser.newContext({
    viewport: { width: w, height: h },
    ...(phone ? { deviceScaleFactor: 2, isMobile: true, hasTouch: true } : {}),
    storageState: { cookies: [], origins: [{ origin: B, localStorage: [{ name: 'tifo_lang_v1', value: lang }] }] },
  });
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', (e) => errs.push(e.message.slice(0, 160)));
  await p.goto(B + '/app', { waitUntil: 'networkidle', timeout: 120000 });
  await p.waitForSelector('.ob-backdrop', { timeout: 60000 });
  await p.waitForSelector('#consent-bar', { timeout: 60000 });
  await p.waitForTimeout(800);
  return { ctx, p, errs };
}
/** What is actually under the centre of an element — the thing a click would hit. */
const hitOk = (p, sel) => p.evaluate((s) => {
  const el = document.querySelector(s);
  if (!el) return false;
  const r = el.getBoundingClientRect();
  const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  return !!top && (top === el || el.contains(top)) && !el.closest('[inert]');
}, sel);
const realClick = async (p, sel) => {
  const box = await p.locator(sel).boundingBox();
  await p.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await p.waitForTimeout(400);
};
const consent = (p) => p.evaluate(() => localStorage.getItem('tifo_consent_v1'));

for (const [label, w, h, phone] of [['desktop 1916x902 (the report)', 1916, 902, false], ['laptop 1366x768', 1366, 768, false], ['phone 390x844', 390, 844, true]]) {
  console.log(`\n— ${label} —`);
  for (const [btn, want] of [['.consent-all', 'all'], ['.consent-bar button:not(.consent-all)', 'essential']]) {
    const { ctx, p, errs } = await firstVisit(w, h, 'en', phone);
    const name = want === 'all' ? 'Accept all' : 'Essential only';
    check(`${name} is not inert under the Start dialog`, await p.evaluate(() => !document.getElementById('consent-bar').closest('[inert]')));
    check(`${name} is what a click there actually hits`, await hitOk(p, btn));
    // The dialog's own buttons are above the banner, not underneath it.
    const clear = await p.evaluate(() => {
      const bar = document.getElementById('consent-bar').getBoundingClientRect();
      return [...document.querySelectorAll('.ob-actions button')].every((b) => b.getBoundingClientRect().bottom <= bar.top + 1);
    });
    check('the Start dialog\'s buttons sit above the banner', clear);
    check('and "Start designing" is clickable with the banner up', await hitOk(p, '.ob-start'));
    await realClick(p, btn);
    check(`clicking ${name} records "${want}"`, (await consent(p)) === want, String(await consent(p)));
    check('and the banner goes away', await p.evaluate(() => !document.getElementById('consent-bar')));
    check('the dialog takes back the room it gave the banner', await p.evaluate(() => !document.documentElement.style.getPropertyValue('--consent-h')));
    check('the Start dialog is still there to answer', await p.evaluate(() => !!document.querySelector('.ob-backdrop')));
    check('no page errors', errs.length === 0, errs.join(' | '));
    await ctx.close();
  }
}

console.log('\n— with the keyboard —');
{
  const { ctx, p, errs } = await firstVisit(1366, 768);
  let reached = false;
  for (let i = 0; i < 30 && !reached; i++) {
    await p.keyboard.press('Tab');
    reached = await p.evaluate(() => !!document.activeElement?.closest('#consent-bar'));
  }
  check('Tab reaches the cookie banner from inside the Start dialog', reached);
  await p.evaluate(() => document.querySelector('#consent-bar .consent-all').focus());
  await p.keyboard.press('Enter');
  await p.waitForTimeout(300);
  check('and Enter answers it', (await consent(p)) === 'all');
  let stayed = true;
  for (let i = 0; i < 25; i++) {
    await p.keyboard.press('Tab');
    if (!(await p.evaluate(() => !!document.activeElement?.closest('.ob-backdrop')))) stayed = false;
  }
  check('once answered, Tab stays inside the dialog again', stayed);
  check('no page errors', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

console.log('\n— one scroll, not four —');
{
  const { ctx, p } = await firstVisit(1916, 902);
  const scrollers = await p.evaluate(() => [...document.querySelectorAll('.ob-modal *')]
    .filter((e) => /(auto|scroll)/.test(getComputedStyle(e).overflowY) && e.scrollHeight > e.clientHeight + 1).length);
  check('the Start dialog has at most one scrolling area', scrollers <= 1, `${scrollers} scrolling areas`);
  await ctx.close();
}

console.log('\n— in Arabic —');
{
  const { ctx, p } = await firstVisit(1366, 768, 'ar');
  check('قبول الكل can be clicked', await hitOk(p, '.consent-all'));
  await realClick(p, '.consent-all');
  check('and records the choice', (await consent(p)) === 'all');
  await ctx.close();
}

await browser.close();
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
