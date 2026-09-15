/**
 * Dev-only: the account page at phone, tablet and desktop, in both languages.
 *   npx tsx scripts/account-shots.mts   → preview-out/account/*.png
 *
 * Drives the REAL page and stylesheet with a stubbed /api/me, so what is
 * captured is what a signed-in person sees. Reports layout faults rather than
 * relying on my eye: horizontal overflow, and touch targets under 44px.
 */
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer, type ViteDevServer } from 'vite';
import { chromium, type Page } from 'playwright';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(ROOT, 'preview-out/account');
const LS_KEY = 'tifo_lang_v1';
const TOK_KEY = 'tifo_token_v1';

const vite: ViteDevServer = await createServer({ root: ROOT, server: { port: 5223 }, logLevel: 'error' });
await vite.listen(5223);
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' }).catch(() => chromium.launch());
if (existsSync(OUT)) rmSync(OUT, { recursive: true });
mkdirSync(OUT, { recursive: true });

const CASES = [
  ['phone', 380, 900],
  ['tablet', 768, 1024],
  ['desktop', 1280, 1000],
] as const;

let bad = 0;
for (const [device, width, height] of CASES) {
  for (const lang of ['en', 'ar'] as const) {
    for (const verified of [false, true]) {
      const page: Page = await browser.newPage({ viewport: { width, height } });
      await page.addInitScript(
        ([lk, l, tk]) => {
          try { localStorage.setItem(lk as string, l as string); localStorage.setItem(tk as string, 'stub-token'); } catch { /* ignore */ }
        },
        [LS_KEY, lang, TOK_KEY] as [string, string, string],
      );
      // Stub the account so the page renders its signed-in state.
      await page.route('**/api/me', (route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ id: 'u1', username: 'os99', email: 'osamah@example.com', emailVerified: verified, isAdmin: false }),
        }),
      );
      await page.goto('http://127.0.0.1:5223/account.html', { waitUntil: 'networkidle', timeout: 60000 });
      await page.waitForTimeout(400);

      const report = await page.evaluate(() => {
        const doc = document.documentElement;
        const overflow = Math.max(0, doc.scrollWidth - doc.clientWidth);
        const phone = window.innerWidth <= 599;
        const small: string[] = [];
        for (const el of Array.from(document.querySelectorAll('button, input, a'))) {
          const r = (el as HTMLElement).getBoundingClientRect();
          if (r.width === 0 || r.height === 0) continue;
          if (r.height < (phone ? 44 : 32) - 0.5) small.push(`${el.tagName.toLowerCase()}#${el.id || (el.className || '?')}@${Math.round(r.height)}px`);
        }
        // Name what actually sticks out, rather than leaving it to guesswork.
        const wide: string[] = [];
        for (const el of Array.from(document.querySelectorAll('*'))) {
          const r = (el as HTMLElement).getBoundingClientRect();
          if (r.right > doc.clientWidth + 0.5) wide.push(`${el.tagName.toLowerCase()}#${el.id || (el.className || '?')}+${Math.round(r.right - doc.clientWidth)}`);
        }
        const codeVisible = !(document.getElementById('ac-verify') as HTMLElement | null)?.hidden;
        return { overflow, small, wide: wide.slice(0, 4), codeVisible, badge: document.getElementById('ac-email-badge')?.textContent ?? '' };
      });
      const tag = `${device}-${lang}-${verified ? 'verified' : 'unverified'}`;
      if (report.overflow > 0 || report.small.length > 0) bad++;
      console.log(
        `${tag.padEnd(28)} overflow ${String(report.overflow).padStart(3)}px ${report.wide.join(' ')}` +
        `  small ${report.small.join(' ') || '0'}  badge "${report.badge}"`,
      );
      await page.screenshot({ path: `${OUT}/${tag}.png`, fullPage: true });
      await page.close();
    }
  }
}
await browser.close();
await vite.close();
console.log(bad === 0 ? '\nno layout faults' : `\n${bad} layouts with faults`);
