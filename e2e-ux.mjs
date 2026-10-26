/** Cross-page UX regression checks. Uses the local in-memory server on :8911. */
import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';
const B = process.env.BASE ?? 'http://127.0.0.1:8911';
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' }).catch(() => chromium.launch());
let passed = 0;
const errors = [];
const check = (name, value) => {
  if (!value) throw new Error(name);
  passed++;
  console.log(`PASS ${name}`);
};
try {
  for (const config of (process.argv.includes('--editor-only') ? [] : [
    { lang: 'en', theme: 'light', width: 1366, height: 900 },
    { lang: 'ar', theme: 'dark', width: 390, height: 844 },
    { lang: 'en', theme: 'light', width: 320, height: 740 },
  ])) {
    const ctx = await browser.newContext({ viewport: { width: config.width, height: config.height } });
    await ctx.addInitScript(({ lang, theme }) => {
      localStorage.setItem('tifo_lang_v1', lang);
      localStorage.setItem('tifo_theme_v1', theme);
      localStorage.setItem('tifo_consent_v1', 'essential');
      localStorage.setItem('tifo_guide_v1', 'done');
      // Exercise denial rather than assuming clipboard permission is granted.
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => { throw new Error('Denied'); } } });
    }, config);
    const p = await ctx.newPage();
    p.on('pageerror', (error) => errors.push(error.message));
    let failFeed = true;
    await p.route(/\/api\/gallery(?:\?|$)/, async (route) => {
      if (failFeed) await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Temporary test outage' }) });
      else await route.continue();
    });
    await p.goto(`${B}/community`);
    await p.locator('#grid-error').waitFor({ state: 'visible' });
    check(`${config.lang}/${config.width}: feed failure remains visible`, await p.locator('#grid-retry').isVisible());
    failFeed = false;
    await p.locator('#grid-retry').click();
    await p.locator('.card-open').first().waitFor();
    check('retry recovers the existing feed', !await p.locator('#grid-error').isVisible());
    const publicHref = await p.locator('.card-open').first().getAttribute('href');
    await p.locator('.card-open').first().press('Enter');
    await p.locator('#modal-root [role="dialog"]').waitFor();
    check('Enter opens an accessible tifo dialog', await p.locator('#modal-root [role="dialog"]').isVisible());
    check('preview isolates the page', await p.locator('main').evaluate((el) => el.inert));
    await p.locator('#share-btn').click();
    await p.locator('.sm-card').waitFor();
    await p.locator('.sm-x').press('Shift+Tab');
    check('share focus wraps inside the dialog', await p.evaluate(() => document.activeElement?.closest('.sm-card') !== null));
    await p.locator('.sm-copy').click();
    await p.waitForFunction(() => !!document.querySelector('.sm-status')?.textContent);
    check('copy denial gives actionable feedback', await p.locator('.sm-status').innerText().then((s) => /manually|يدوي/.test(s)));
    check('copy denial selects a usable link', await p.locator('.sm-link').evaluate((el) => el.selectionEnd > el.selectionStart));
    await p.locator('.sm-qrbtn').click();
    await p.locator('.sm-qr img').waitFor();
    check('QR expansion is announced', await p.locator('.sm-qrbtn').getAttribute('aria-expanded') === 'true');
    await p.locator('.sm-qrbtn').press('Escape');
    check('Escape closes only the top dialog', await p.locator('#modal-root [role="dialog"]').isVisible() && !await p.locator('.sm-card').count());
    check('nested close returns focus to Share', await p.locator('#share-btn').evaluate((el) => el === document.activeElement));
    await p.locator('#modal-close').press('Escape');
    check('closing preview restores page interaction', !await p.locator('main').evaluate((el) => el.inert));
    const search = p.locator('#user-search');
    await search.fill('zzzz-no-tifo-matches-this');
    await p.locator('#grid-empty').waitFor({ state: 'visible' });
    check('empty search explains recovery', /search|البحث/.test(await p.locator('#grid-empty p').innerText()));
    await search.fill('');
    await p.locator('.card-open').first().waitFor();
    check('clearing search restores designs', await p.locator('.card-open').count() > 0);
    await p.goto(`${B}/reset`);
    check('missing reset token does not ask for a password', !await p.locator('#reset-form').isVisible());
    await p.locator('#reset-recover').click();
    await p.locator('.auth-forgot').waitFor({ state: 'visible' });
    check('reset recovery opens the email request form', await p.locator('input[name="femail"]').isVisible());
    await p.locator('.auth-close').press('Escape');
    check('auth close restores focus to recovery', await p.locator('#reset-recover').evaluate((el) => el === document.activeElement));
    await p.goto(`${B}/account`);
    check('account has language and theme controls', await p.locator('#lang-toggle').isVisible() && await p.locator('#theme-toggle').isVisible());
    check('account fits the viewport', await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await p.goto(`${B}/legal#privacy`);
    const expected = config.lang === 'ar' ? 'privacy-ar' : 'privacy';
    check('legal links resolve in the visible language', await p.locator(`#${expected}`).isVisible() && (await p.url()).endsWith(`#${expected}`));
    await p.goto(`${B}${publicHref}`);
    await p.locator('#s-share').waitFor({ timeout: 60000 });
    check('public design opens from its card link', await p.locator('#s-share').isVisible());
    await p.goto(`${B}/s/${publicHref.split('/').at(-1)}`);
    await p.locator('#sel-section').waitFor({ timeout: 60000 });
    await p.locator('#sel-section').selectOption(await p.locator('#sel-section option').nth(1).getAttribute('value'));
    await p.locator('#sel-row').selectOption(await p.locator('#sel-row option').nth(1).getAttribute('value'));
    await p.locator('#sel-seat').selectOption(await p.locator('#sel-seat option').nth(1).getAttribute('value'));
    check('fans can resolve a seat from a public QR link', await p.locator('#seat-go').isEnabled());
    await p.locator('#seat-go').click();
    check('fan instruction fits a phone', await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await p.goto(`${B}/community`);
    await p.locator('.card-share').first().waitFor();
    const oldLabel = await p.locator('.card-share').first().getAttribute('aria-label');
    if (config.width < 861) {
      await p.locator('.mnav-burger').click();
      await p.locator('.mnav-drawer .lang-toggle').click();
    } else await p.locator('#lang-toggle').click();
    await p.waitForFunction((old) => {
      const label = document.querySelector('.card-share')?.getAttribute('aria-label');
      return !!label && label !== old;
    }, oldLabel);
    check('language switching updates existing card actions', await p.locator('.card-share').first().getAttribute('aria-label') !== oldLabel);
    await ctx.close();
  }
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  await ctx.addInitScript(() => {
    localStorage.setItem('tifo_consent_v1', 'essential');
    localStorage.setItem('tifo_banner_tour_v1', '1');
    localStorage.setItem('tifo_post_offered_v1', '1');
    // A club start is a first tifo: without this the guide opens after the
    // reveal and puts the view tabs away, whenever the timing lets it.
    localStorage.setItem('tifo_guide_v1', 'done');
  });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errors.push(e.message));
  await p.goto(`${B}/projects?new=1`);
  await p.getByRole('button', { name: 'Al Hilal Kingdom Arena', exact: true }).click();
  await p.getByRole('button', { name: 'Make my tifo', exact: true }).click();
  await p.waitForFunction(() => /seats/.test(document.querySelector('#stat')?.textContent ?? ''), null, { timeout: 60000 });
  await p.locator('#panel-tab-paint').click();
  await p.locator('#panel-tab-paint').press('End');
  check('End selects the final panel tab', await p.locator('#rail-save').getAttribute('aria-selected') === 'true');
  check('only the selected tab is in the Tab sequence', await p.locator('.panel-tabs .ptab').evaluateAll((els) => els.filter((el) => el.tabIndex === 0).length === 1));
  await p.locator('#rail-save').press('Home');
  check('Home returns to the Paint tab', await p.locator('#panel-tab-paint').getAttribute('aria-selected') === 'true');
  await p.locator('#rail-save').click();
  await p.locator('#export-qr').click();
  check('private/local QR explains the publication requirement', /Publish/.test(await p.locator('#message').innerText()));
  check('QR guidance focuses the relevant action', await p.locator('#publish-design').evaluate((el) => el === document.activeElement));
  const csvDownload = p.waitForEvent('download');
  await p.locator('#export-csv').click();
  const csv = await readFile(await (await csvDownload).path(), 'utf8');
  check('CSV export contains seat records', csv.split('\n').length > 100);
  const pdfDownload = p.waitForEvent('download', { timeout: 60000 });
  await p.locator('#export-pdf').click();
  const pdf = await readFile(await (await pdfDownload).path());
  check('distribution export downloads a real PDF', pdf.subarray(0, 5).toString() === '%PDF-');
  await p.locator('#view-3d').click();
  check('active view is exposed to assistive technology', await p.locator('#view-3d').getAttribute('aria-pressed') === 'true');
  await p.locator('#match-day').click();
  await p.locator('.mds-help.show').waitFor();
  check('simulator intro contains focus', await p.evaluate(() => !!document.activeElement?.closest('.mds-help')));
  await p.locator('.mds-help button').press('Escape');
  check('Escape dismisses intro without leaving simulator', await p.locator('.mds-overlay').isVisible() && await p.locator('.mds-help').evaluate((el) => el.inert));
  check('simulator isolates editor controls', await p.locator('main').evaluate((el) => el.inert));
  await p.keyboard.press('Escape');
  await p.locator('.mds-overlay').waitFor({ state: 'detached' });
  check('simulator close restores editor and focus', !await p.locator('main').evaluate((el) => el.inert) && await p.locator('#match-day').evaluate((el) => el === document.activeElement));
  await ctx.close();
  check('no uncaught page errors', errors.length === 0);
  console.log(`${passed} passed; page errors: ${JSON.stringify(errors)}`);
} finally { await browser.close(); }
