/**
 * Dev-only: the AI panel's state card at every outcome, on desktop and phone.
 *   npx tsx scripts/ai-panel-shots.mts   → preview-out/ai-ui/*.png
 *
 * Renders the REAL page and the real stylesheet, then drives the card markup
 * directly, so what is captured is what a user would see.
 */
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer, type ViteDevServer } from 'vite';
import { chromium, type Page } from 'playwright';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(ROOT, 'preview-out/ai-ui');

const CARDS: Array<[string, string, string, string, string[]]> = [
  ['1-success', 'good', 'ti-circle-check', 'Designed with Super AI', []],
  ['2-degraded', 'warn', 'ti-alert-triangle',
    'Designed — but the picture could not be generated',
    ['Try again', 'Keep this design']],
  ['3-quota', 'warn', 'ti-alert-triangle',
    "You've used all 10 premium designs this hour",
    ['Use the Quick Designer', 'Premium free in 4:12']],
  ['4-failed', 'bad', 'ti-alert-circle', 'The design could not be generated',
    ['Try again', 'Use the Quick Designer']],
  ['5-stopped', 'info', 'ti-info-circle', 'Stopped', ['Start again']],
];
const BODY: Record<string, string> = {
  '2-degraded': 'The stand it was meant to fill is bare, so this one was free — your design count has not changed. The image service turned the request down.',
  '3-quota': 'Your allowance resets in about 5 min. The Quick Designer is free and instant, and its designs are fully editable too.',
  '4-failed': 'Something went wrong on the way to the model. Nothing was used.',
  '5-stopped': 'Nothing was generated and no design was used.',
};

const vite: ViteDevServer = await createServer({ root: ROOT, server: { port: 5221 }, logLevel: 'error' });
await vite.listen(5221);
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' }).catch(() => chromium.launch());

if (existsSync(OUT)) rmSync(OUT, { recursive: true });
mkdirSync(OUT, { recursive: true });

for (const [device, width, height] of [['desktop', 420, 900], ['phone', 380, 820]] as const) {
  const page: Page = await browser.newPage({ viewport: { width, height } });
  await page.goto('http://127.0.0.1:5221/index.html', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(1200);
  // Clear whatever is actually on top, rather than guessing at class names:
  // ask the browser what sits at the card's centre and remove it until the card
  // is what answers. Consent bar, onboarding, tour, modals — all of them.
  await page.evaluate(() => {
    const el = document.getElementById('ai-state');
    if (!el) return;
    el.hidden = false;
    for (let i = 0; i < 12; i++) {
      const r = el.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      if (!hit || hit === el || el.contains(hit)) break;
      if (hit === document.body || hit === document.documentElement) break;
      // Remove the outermost ancestor of whatever is covering it — but never
      // walk up into <body>/<html>, which would delete the page.
      let n: HTMLElement = hit as HTMLElement;
      while (n.parentElement && n.parentElement !== document.body && n.parentElement !== document.documentElement) {
        n = n.parentElement;
      }
      if (n === document.body || n === document.documentElement || n.contains(el)) break;
      n.remove();
    }
  });
  await page.waitForTimeout(150);
  for (const [name, tone, icon, title, actions] of CARDS) {
    const overflow = await page.evaluate(
      ([t, ic, ti, acts, body]) => {
        const panel = document.getElementById('ctx-ai') as HTMLElement | null;
        const el = document.getElementById('ai-state') as HTMLElement | null;
        document.documentElement.style.setProperty('--panel-w', '420px');
        if (!panel || !el) return { ok: false, overflow: 0, small: 0, chain: [] as string[] };
        // Force the whole ancestor chain visible — the panel lives behind a
        // context switch and, on phones, behind a sheet.
        for (let n: HTMLElement | null = panel; n && n !== document.body; n = n.parentElement) {
          // '' reverts to the stylesheet, which for these ancestors is none.
          // The panel's display:none is !important in places, so inline alone loses.
          if (getComputedStyle(n).display === 'none') n.style.setProperty('display', 'block', 'important');
          n.style.setProperty('visibility', 'visible', 'important');
          n.style.setProperty('opacity', '1', 'important');
          n.style.setProperty('transform', 'none', 'important');
          n.classList.remove('ctx-hidden');
          n.hidden = false;
          if (n.classList.contains('panel')) n.classList.add('open');
        }
        // Isolate the card: this shot is about the card, not the whole panel.
        for (const id of ['ai-examples', 'ai-clubs', 'ai-result', 'ai-progress']) {
          const n = document.getElementById(id) as HTMLElement | null;
          if (n) n.style.display = 'none';
        }
        el.hidden = false;
        panel.style.width = `${Math.min(window.innerWidth - 24, 400)}px`;
        el.dataset.tone = t as string;
        (el.querySelector('.ai-state-icon') as HTMLElement).className = `ai-state-icon ti ${ic}`;
        (el.querySelector('.ai-state-title span') as HTMLElement).textContent = ti as string;
        (el.querySelector('.ai-state-body') as HTMLElement).textContent = (body as string) ?? '';
        const box = el.querySelector('.ai-state-actions') as HTMLElement;
        box.innerHTML = '';
        for (const a of acts as string[]) {
          const b = document.createElement('button');
          b.type = 'button';
          if (a === (acts as string[])[0]) b.className = 'primary';
          b.textContent = a;
          box.appendChild(b);
        }
        // Does anything spill out of the card, and is every target big enough?
        const cr = el.getBoundingClientRect();
        if (cr.width === 0 || cr.height === 0) {
          const chain: string[] = [];
          for (let n: HTMLElement | null = el; n && n !== document.body; n = n.parentElement) {
            const cs = getComputedStyle(n);
            chain.push(`${n.tagName}#${n.id || '-'}.${n.className || '-'} d=${cs.display} v=${cs.visibility} h=${n.hidden}`);
          }
          return { ok: false, overflow: -1, small: -1, chain };
        }
        let overflowPx = 0;
        let small = 0;
        for (const b of Array.from(box.querySelectorAll('button'))) {
          const r = b.getBoundingClientRect();
          overflowPx = Math.max(overflowPx, Math.max(0, r.right - cr.right), Math.max(0, cr.left - r.left));
          if (r.height < (window.innerWidth <= 767 ? 44 : 32) - 0.5) small++;
        }
        return { ok: true, overflow: Math.round(overflowPx), small, chain: [] as string[] };
      },
      [tone, icon, title, actions, BODY[name] ?? ''] as [string, string, string, string[], string],
    );
    if (!overflow.ok) { console.log('  invisible:', (overflow.chain ?? []).slice(0, 6).join('\n    ')); continue; }
    // Overlays can reappear (the consent bar is re-rendered), so clear right
    // before each shot, not once at load.
    await page.evaluate(() => {
      for (const n of Array.from(document.body.children)) {
        const e = n as HTMLElement;
        if (e.id === 'main' || e.tagName === 'SCRIPT' || e.tagName === 'STYLE') continue;
        const cs = getComputedStyle(e);
        if (cs.position === 'fixed' || cs.position === 'absolute') e.remove();
      }
    });
    const el = await page.$('#ai-state');
    if (el) { await el.scrollIntoViewIfNeeded(); await el.screenshot({ path: `${OUT}/${device}-${name}.png` }); }
    console.log(`${device.padEnd(8)} ${name.padEnd(12)} overflow ${overflow.overflow}px  undersized targets ${overflow.small}`);
  }
  await page.close();
}
await browser.close();
await vite.close();
console.log(`\nwrote ${OUT}`);
