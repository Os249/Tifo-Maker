/**
 * Dev-only: the "build one from a real ground" block, on a phone and a desktop,
 * in both languages.
 *   npx tsx scripts/stadium-import-shots.mts   → preview-out/stadium-import/*.png
 *
 * Overpass is stubbed with a real footprint, so this exercises the whole path —
 * search, pick, estimate, provenance table — without depending on somebody
 * else's API being up, and without hitting it repeatedly while iterating.
 *
 * It reports layout faults rather than relying on my eye: horizontal overflow
 * is the one that has actually bitten before, and it bit in Arabic first.
 */
import { mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer, type ViteDevServer } from 'vite';
import { chromium, type Page } from 'playwright';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(ROOT, 'preview-out/stadium-import');
const LS_KEY = 'tifo_lang_v1';

const osm = JSON.parse(readFileSync(resolve(ROOT, 'scripts/data/amman-osm.json'), 'utf8')) as {
  stadium: { id: number; geom: Array<[number, number]>; tags: Record<string, string> };
};
const OVERPASS_REPLY = JSON.stringify({
  elements: [{
    id: osm.stadium.id,
    tags: { ...osm.stadium.tags, capacity: '17619' },
    geometry: osm.stadium.geom.map(([lon, lat]) => ({ lon, lat })),
  }],
});

const vite: ViteDevServer = await createServer({ root: ROOT, server: { port: 5229 }, logLevel: 'error' });
await vite.listen(5229);
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' }).catch(() => chromium.launch());
if (existsSync(OUT)) rmSync(OUT, { recursive: true });
mkdirSync(OUT, { recursive: true });

const CASES = [['phone', 380, 1000], ['desktop', 1280, 1000]] as const;
let bad = 0;

for (const [device, width, height] of CASES) {
  for (const lang of ['en', 'ar'] as const) {
    const page: Page = await browser.newPage({ viewport: { width, height } });
    // Onboarding modal, tour and cookie banner all sit over the panel; a shot
    // with them up shows nothing. Skipping them is what a returning user sees.
    await page.addInitScript(([k, l]) => {
      try {
        localStorage.setItem(k as string, l as string);
        localStorage.setItem('tifo_onboarded_v1', '1');
        localStorage.setItem('tifo_tour_v2', '1');
        localStorage.setItem('tifo_consent_v1', 'essential');
      } catch { /* private mode */ }
    }, [LS_KEY, lang] as [string, string]);
    await page.route('**/overpass*/**', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: OVERPASS_REPLY }));
    await page.route('**/api/interpreter', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: OVERPASS_REPLY }));

    await page.goto('http://127.0.0.1:5229/', { waitUntil: 'networkidle', timeout: 120000 });

    // Getting to the block differs by device, and that is the app working as
    // designed rather than a problem: desktop has a rail and a Properties
    // sidebar, while the phone lends the very same #ctx-stadium-config section
    // into a bottom sheet under More -> Stadium (see ui/mobileShell.ts).
    //
    // No named inner functions in any page.evaluate body below: tsx compiles
    // these with esbuild's keepNames on, which emits __name() calls that only
    // exist in the bundle, not in the page. The browser answers
    // "__name is not defined" and the whole harness dies on the first click.
    const opened = await page.evaluate((isPhone) => {
      if (isPhone) {
        let more: HTMLElement | null = null;
        for (const b of Array.from(document.querySelectorAll<HTMLElement>('.m-tab, [data-tab]'))) {
          if (/more|المزيد/i.test(b.textContent ?? '')) more = more ?? b;
        }
        if (!more) return false;
        more.click();
        return true;
      }
      let clicked = false;
      for (const sel of ['[data-rail="stadium"]', '#rail-stadium', '[title*="Stadium" i]']) {
        const el = document.querySelector<HTMLElement>(sel);
        if (el && !clicked) { el.click(); clicked = true; }
      }
      return clicked;
    }, width < 600);
    if (!opened) console.log(`  ${device}/${lang}: could not open the panel — capturing the page as-is`);
    await page.waitForTimeout(450);

    if (width < 600) {
      await page.evaluate(() => {
        for (const b of Array.from(document.querySelectorAll<HTMLElement>('.m-tool'))) {
          if (/stadium|الملعب|ملعب/i.test(b.textContent ?? '')) { b.click(); return; }
        }
      });
      await page.waitForTimeout(450);
    }

    await page.evaluate(() => {
      for (const b of Array.from(document.querySelectorAll('button'))) {
        if (/^(custom|مخصّصة)$/i.test((b.textContent ?? '').trim())) { b.click(); return; }
      }
    });
    await page.waitForTimeout(400);

    // Drive it through the data-tm hooks, not placeholder text: the Custom tab
    // has a second stadium-name box above this one, and matching on text put
    // "Amman" in the wrong form while this harness still reported success.
    const ran = await page.evaluate(async () => {
      const name = document.querySelector<HTMLInputElement>('[data-tm="osm-search"]');
      const find = document.querySelector<HTMLButtonElement>('[data-tm="osm-find"]');
      if (!name || !find) return 'import block not mounted';
      name.value = 'Amman';
      name.dispatchEvent(new Event('input', { bubbles: true }));
      find.click();
      await new Promise((r) => setTimeout(r, 1200));
      const build = document.querySelector<HTMLButtonElement>('[data-tm="osm-build"]');
      if (!build || (build.offsetParent === null)) return 'search produced nothing to estimate';
      build.click();
      await new Promise((r) => setTimeout(r, 500));
      const report = document.querySelector<HTMLElement>('[data-tm="osm-report"]');
      if (!report || report.style.display === 'none') return 'no provenance report';
      // The whole point of the block: it must say which numbers are guesses.
      const txt = report.textContent ?? '';
      // At least one guess AND at least one non-guess: the table earns its place
      // by DISTINGUISHING them. On the footprint path nothing is 'measured' —
      // that only comes from imagery — so accept derived as the non-guess, which
      // is why checking for 'measured' alone failed the Arabic run.
      const owns = /guessed|مخمّن/.test(txt) && /derived|measured|محسوب|مقيس/.test(txt);
      if (!owns) return 'report is missing its confidence labels';
      // And it must be in the reader's language throughout. The notes come from
      // core, which has no i18n, so they shipped as English prose inside the
      // Arabic panel until they were keyed — a screenshot caught that, and this
      // is what stops it coming back.
      if (document.documentElement.dir === 'rtl' && /the plan is row 0|stadium-sized default|built against/.test(txt)) {
        return 'English provenance notes leaked into the Arabic panel';
      }
      return 'ok';
    });
    console.log(`${device}/${lang}: ${ran}`);
    if (ran !== 'ok') bad++;

    // Frame the block, not the top of the panel. By its hook, not its text: on
    // the phone the panel is lent into a bottom sheet and a text search matches
    // the sheet's own wrapper before it matches the report.
    await page.evaluate(() => {
      document.querySelector<HTMLElement>('[data-tm="osm-report"]')?.scrollIntoView({ block: 'center' });
    });
    await page.waitForTimeout(300);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    if (overflow > 1) { console.log(`  FAIL ${device}/${lang}: ${overflow}px of horizontal overflow`); bad++; }

    await page.screenshot({ path: `${OUT}/${device}-${lang}.png`, fullPage: false });
    await page.close();
  }
}

await browser.close();
await vite.close();
console.log(bad === 0 ? `\nOK — wrote ${OUT}` : `\n${bad} problem(s); shots in ${OUT}`);
if (bad > 0) process.exit(1);
