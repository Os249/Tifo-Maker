/**
 * Growth: tagged links, Post it, and phones. Built after the 29 Sep 2026 review.
 *
 *   npm run test:growth      (needs `npm run build` first: it serves dist/)
 *
 *   1. Phones and desktops get a still stadium, in the HTML, not the 3D
 *      engine, until they tap it; thumbnails wait for the scroll; Arabic
 *      browsers get Arabic; tags leave the address bar.
 *   2. A tagged visit is counted by name, a shared-link visit under "Shared by
 *      visitors", and "Links opened" counts it (it read 0 forever before).
 *   3. First run: Start from your club draws the bowl, opens the stadium, and
 *      the one-time "Post it?" card offers the picture, whose links are tagged.
 *   4. Publishing opens the share window with tagged links.
 *   5. The admin link builder makes the link you asked for.
 */
import { spawn } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import { chromium } from 'playwright';

const PORT = 8917;
const B = `http://127.0.0.1:${PORT}`;
const PW = 'e2e growth admin password 2026';
const server = spawn(process.execPath, ['--import', 'tsx', 'server/src/server.ts'], {
  env: { ...process.env, PORT: String(PORT), NODE_ENV: 'development', DATABASE_URL: '', RESEND_API_KEY: '', AI_ADMIN_PASSWORD: PW, ADMIN_USERNAMES: '' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const out = [];
server.stdout.on('data', (d) => out.push(String(d)));
server.stderr.on('data', (d) => out.push(String(d)));
const stop = () => { try { server.kill(); } catch { /* gone */ } };
process.on('exit', stop);
let up = false;
for (let i = 0; i < 90; i++) {
  if (await fetch(`${B}/health`).then((r) => r.ok).catch(() => false)) { up = true; break; }
  await new Promise((r) => setTimeout(r, 500));
}
if (!up) { console.error('server never came up on ' + B + '\n' + out.join('')); stop(); process.exit(1); }

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { (ok ? pass++ : fail++); console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${x ? '  — ' + x : ''}`); };
const api = async (path, token, body, method = 'POST', headers = {}) => {
  const r = await fetch(B + path, { method, headers: { 'content-type': 'application/json', ...headers, ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const t = await r.text();
  try { return JSON.parse(t); } catch { return t; }
};
const unlock = (await api('/api/ai/unlock', null, { password: PW })).token;
const admin = (path) => api(path, null, undefined, 'GET', { 'x-ai-unlock': unlock });

// Headless Chrome says so in its user agent, and the visit log files that under
// bots, where it would be invisible to every number this suite reads.
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const DESKTOP = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const PHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, userAgent: IPHONE };
const WIDE = { viewport: { width: 1400, height: 900 }, userAgent: DESKTOP };

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] }).catch(() => chromium.launch());
const errs = [];
const open = async (opts, ls = []) => {
  const ctx = await browser.newContext({ locale: 'en-US', ...opts });
  await ctx.addInitScript((pairs) => { try { for (const [k, v] of pairs) localStorage.setItem(k, v); } catch { /* */ } }, [['tifo_consent_v1', 'all'], ...ls]);
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errs.push(String(e.message).slice(0, 200)));
  return p;
};
const until = (p, fn, arg = null, ms = 60000) => p.waitForFunction(fn, arg, { timeout: ms }).then(() => true).catch(() => false);

// ---------------------------------------------------------------------------
console.log('\n— 1. the home page on a phone —');
{
  const p = await open(PHONE);
  const asked = [];
  p.on('request', (r) => asked.push(r.url()));
  await p.goto(`${B}/?utm_source=x&utm_medium=post&utm_campaign=reveal-1`, { waitUntil: 'load' });
  const still = await until(p, () => { const i = document.querySelector('#hero-3d img.hero-still'); return !!i && i.complete && i.naturalWidth > 0; }, null, 20000);
  await p.waitForTimeout(2500);
  check('the hero is the still picture', still);
  check('and the 3D engine was never downloaded', !asked.some((u) => /preview3d-.*\.js/.test(u)), asked.filter((u) => /preview3d/.test(u)).join(' '));
  check('the tags have left the address bar', await p.evaluate(() => !/utm_/.test(location.search)), await p.evaluate(() => location.href));
  check('the gallery is not fetched before anyone scrolls to it', !asked.some((u) => u.includes('/api/gallery')));
  const cta = await p.evaluate(() => { const a = document.getElementById('ground-go'); return a ? Math.round(a.getBoundingClientRect().bottom) : 9999; });
  check('"Start" is on the first screen, above the cookie bar', cta < 844 * 0.62, `bottom at ${cta}px of 844`);
  await p.evaluate(() => document.getElementById('showcase')?.scrollIntoView());
  const fetched = await until(p, () => performance.getEntriesByType('resource').some((e) => e.name.includes('/api/gallery')), null, 15000);
  check('scrolling there fetches it', fetched);
  const tapped = await p.evaluate(() => { window.scrollTo(0, 0); document.querySelector('#hero-3d img.hero-still')?.click(); return true; });
  const live = tapped && await until(p, () => !!document.querySelector('#hero-3d canvas'), null, 60000);
  check('a tap on the still starts the live stadium', live);
  check('no horizontal scroll on a phone', await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  await p.context().close();
}
{
  // Desktops too get the picture first, since performance plan P1.14: the live
  // stadium cost them 183 KB gz and seconds of main thread before anyone had
  // asked for it. A click on the picture, or on a club, starts it.
  const p = await open(WIDE);
  const asked = [];
  p.on('request', (r) => asked.push(r.url()));
  await p.goto(`${B}/`, { waitUntil: 'load' });
  const html = await (await fetch(`${B}/`)).text();
  check('the hero picture is in the page itself, fetched first',
    /<img class="hero-still"[^>]*fetchpriority="high"/.test(html) && /<img class="hero-still"[^>]*srcset="[^"]*640w/.test(html));
  const shown = await until(p, () => { const i = document.querySelector('#hero-3d img.hero-still'); return !!i && i.complete && i.naturalWidth > 0 && getComputedStyle(document.getElementById('hero-3d')).opacity === '1'; }, null, 20000);
  await p.waitForTimeout(2500);
  check('a desktop gets the still picture, visible', shown);
  check('and no 3D engine until it is asked for', !asked.some((u) => /preview3d-.*\.js/.test(u)), asked.filter((u) => /preview3d/.test(u)).join(' '));
  check('a 1x desktop takes the 640 px copy', await p.evaluate(() => /\/hero\/[a-z0-9-]+-640\.webp$/.test(document.querySelector('#hero-3d img.hero-still')?.currentSrc ?? '')));
  await p.evaluate(() => document.querySelector('#hero-3d img.hero-still')?.click());
  const live = await until(p, () => !!document.querySelector('#hero-3d canvas') && !document.querySelector('#hero-3d img.hero-still'), null, 60000);
  check('a click on it starts the live 3D stadium', live && asked.some((u) => /preview3d-.*\.js/.test(u)));
  await p.context().close();
}
{
  const p = await open(WIDE);
  await p.goto(`${B}/`, { waitUntil: 'load' });
  await p.evaluate(() => document.querySelector('.hero-club[data-club="hilal"]')?.click());
  const live = await until(p, () => !!document.querySelector('#hero-3d canvas') && document.querySelector('.hero-club.on')?.dataset.club === 'hilal', null, 60000);
  check('on a desktop, a club chip starts the live stadium on that club', live && p.url() === `${B}/`, p.url());
  await p.context().close();
}
{
  // The page is for every fan. The hero opens on a different club between
  // visits; the closing band is the site's own, whoever visits (it once took
  // the colours of the last club a visitor started, and read as that club's
  // site); the showcase leads with named designs, each with a way to start
  // from it.
  const clubs = new Set();
  for (let i = 0; i < 16; i++) clubs.add((await (await fetch(`${B}/`)).text()).match(/id="hero-3d" data-club="([a-z0-9-]+)"/)?.[1]);
  check('the hero opens on a different club between visits', clubs.size >= 3 && !clubs.has(undefined), [...clubs].join(', '));
  const p = await open(WIDE);
  await p.goto(`${B}/`, { waitUntil: 'load' });
  const club = await p.evaluate(() => document.getElementById('hero-3d')?.dataset.club);
  const said = await p.evaluate(() => ({
    still: document.querySelector('#hero-3d img.hero-still')?.getAttribute('src'),
    chip: document.querySelector('.hero-club.on')?.dataset.club,
    make: document.getElementById('hero-make')?.getAttribute('href'),
  }));
  check('and the whole hero says that club', said.still === `/hero/${club}.webp` && said.chip === club && said.make === `/projects?new=1&club=${club}`, JSON.stringify(said));
  await p.evaluate(() => document.getElementById('final-cta')?.scrollIntoView());
  await p.waitForTimeout(800);
  const plain = await p.evaluate(() => {
    const band = document.getElementById('final-cta');
    return { club: band?.dataset.club ?? null, other: document.getElementById('final-other')?.hidden, go: document.getElementById('final-go')?.getAttribute('href') };
  });
  check('a first visit gets the closing band in the site colour, starting any club', plain.club === null && plain.other === true && plain.go === '/projects?new=1', JSON.stringify(plain));
  await p.evaluate(() => document.getElementById('showcase')?.scrollIntoView());
  const cards = await until(p, () => document.querySelectorAll('#showcase-grid .showcase-card').length > 0, null, 20000);
  const shown = await p.evaluate(() => [...document.querySelectorAll('#showcase-grid .showcase-card')].map((c) => ({
    open: c.querySelector('a.showcase-open')?.getAttribute('href') ?? '',
    use: c.querySelector('a.showcase-use')?.getAttribute('href') ?? null,
    title: c.querySelector('.showcase-title, h3')?.textContent?.trim() ?? '',
  })));
  check('the showcase shows at most four designs, each opening its page', cards && shown.length <= 4 && shown.every((c) => /^\/community\?t=/.test(c.open)), JSON.stringify(shown).slice(0, 200));
  check('and a remixable one can be started from', shown.some((c) => c.use && /^\/d\//.test(c.use)), JSON.stringify(shown.map((c) => c.use)));
  check('no "Untitled" design is on show', !shown.some((c) => /^(untitled|my tifo)/i.test(c.title)), shown.map((c) => c.title).join(' | '));
  await p.context().close();

  const back = await open(WIDE, [['tifo_last_club_v1', 'ittihad'], ['tifo_projects_v1', JSON.stringify([{ id: 'l0123456789abcde', title: 'Al Ittihad at the Jewel', updatedAt: Date.now() }])]]);
  await back.goto(`${B}/`, { waitUntil: 'load' });
  await back.evaluate(() => document.getElementById('final-cta')?.scrollIntoView());
  await back.waitForTimeout(1200);
  const band = await back.evaluate(() => {
    const el = document.getElementById('final-cta');
    const cs = getComputedStyle(el);
    const solid = getComputedStyle(document.documentElement).getPropertyValue('--blue-solid').trim();
    return { bg: cs.backgroundColor, solid, club: el.dataset.club ?? null, go: document.getElementById('final-go')?.getAttribute('href'), text: document.getElementById('final-go')?.textContent?.trim(), sub: document.getElementById('final-sub')?.textContent?.trim(), other: document.getElementById('final-other')?.hidden, otherHref: document.getElementById('final-other')?.getAttribute('href') };
  });
  check('a returning fan gets the same band, in no club\'s colours', band.club === null && band.go === '/projects?new=1' && !/Ittihad|Hilal/.test(`${band.text} ${band.sub}`) && band.bg === 'rgb(28, 111, 224)', JSON.stringify(band));
  check('with one neutral way back to their projects', band.other === false && band.otherHref === '/projects', JSON.stringify(band));
  await back.context().close();
}
{
  const ar = await open({ ...PHONE, locale: 'ar-SA' });
  await ar.goto(`${B}/`, { waitUntil: 'load' });
  const a = await ar.evaluate(() => ({ dir: document.documentElement.dir, lang: document.documentElement.lang, cta: document.getElementById('ground-go')?.textContent?.trim() }));
  check('an Arabic browser gets Arabic, right to left', a.dir === 'rtl' && a.lang === 'ar' && /[؀-ۿ]/.test(a.cta ?? ''), JSON.stringify(a));
  await ar.context().close();
  const chose = await open({ ...PHONE, locale: 'ar-SA' }, [['tifo_lang_v1', 'en']]);
  await chose.goto(`${B}/`, { waitUntil: 'load' });
  check('but a language picked with the toggle wins', await chose.evaluate(() => document.documentElement.dir === 'ltr' && document.documentElement.lang === 'en'));
  await chose.context().close();
  const en = await open({ ...PHONE, locale: 'en-GB' });
  await en.goto(`${B}/`, { waitUntil: 'load' });
  check('and an English browser keeps English', await en.evaluate(() => document.documentElement.lang === 'en'));
  await en.context().close();
}

// ---------------------------------------------------------------------------
console.log('\n— 2. what the visit log makes of tagged links —');
{
  const p = await open(PHONE);
  await p.goto(`${B}/?utm_source=whatsapp&utm_medium=share&utm_campaign=tifo`, { waitUntil: 'load' });
  await p.waitForTimeout(600);
  await p.context().close();
  const tr = await admin('/api/admin/traffic?days=7');
  check('your tagged link shows up by name', (tr.campaigns ?? []).some((c) => c.key === 'x / reveal-1'), JSON.stringify(tr.campaigns));
  check('a link passed on from a share button is "Shared by visitors", by platform', (tr.shared ?? []).some((c) => c.key === 'whatsapp'), JSON.stringify(tr.shared));
  check('and it is a source of its own', (tr.sources ?? []).some((s) => s.key === 'shared'), JSON.stringify(tr.sources));
  const sh = await admin('/api/admin/shares?days=7');
  check('"Links opened" counts it (it read 0 forever before)', sh.opens >= 1 && (sh.platforms ?? []).some((x) => x.key === 'whatsapp' && x.opens >= 1), JSON.stringify({ opens: sh.opens, platforms: sh.platforms }));
}

// ---------------------------------------------------------------------------
console.log('\n— 3. first run: start from your club, then post it —');
for (const [label, opts] of [['desktop', WIDE], ['phone', PHONE]]) {
  const p = await open(opts, [['tifo_news_banners_v1', '1'], ['tifo_news_leagues_v2', '1']]);
  await p.goto(`${B}/projects?new=1&e2e`, { waitUntil: 'domcontentloaded' });
  const dialog = await until(p, () => document.querySelectorAll('.st-club').length >= 8, null, 90000);
  check(`${label}: the start flow asks "Who do you support?"`, dialog && await p.evaluate(() => document.getElementById('np-h')?.textContent === 'Who do you support?'));
  const first = await p.evaluate(() => document.activeElement?.id === 'np-h');
  check(`${label}: and the question has the focus (no keyboard popping up on a phone)`, !!first);
  await p.evaluate(() => document.querySelector('.st-club[data-club="hilal"]')?.click());
  await until(p, () => document.querySelector('.st-opt.on')?.dataset.start === 'club', null, 10000);
  await p.evaluate(() => document.getElementById('st-go')?.click());
  const inStadium = await until(p, () => { const h = document.getElementById('preview-host'); return !!h && !h.hidden && !!h.querySelector('canvas'); }, null, 90000);
  check(`${label}: two taps draw the bowl and open the stadium`, inStadium);
  await until(p, () => /[?&]local=/.test(location.search), null, 30000);
  // Read off the swatches ("Swatch #0033A0, 9,700 seats"): the editor was
  // opened by the start flow, so the page has no test hook to read the store.
  const design = await p.evaluate(() => {
    const labels = [...document.querySelectorAll('#palette .swatch')].map((b) => b.getAttribute('aria-label') || '');
    const seats = labels.reduce((n, l) => n + Number((l.match(/, ([\d,]+) /) || [, '0'])[1].replace(/,/g, '')), 0);
    const total = Number(((document.getElementById('stat')?.textContent || '').match(/· ([\d,]+) /) || [, '1'])[1].replace(/,/g, ''));
    return { pal: labels.join(' ').toLowerCase(), painted: seats / total, local: /[?&]local=/.test(location.search) };
  });
  check(`${label}: in the club's colours, kept as a project`, design.pal.includes('#0033a0') && design.painted > 0.5 && design.local, JSON.stringify(design).slice(0, 200));
  // The first project: the guided first tifo (src/ui/guide.ts), after the
  // reveal, in place of the one-time "Post it?" card.
  const guided = await until(p, () => !!document.querySelector('.gd'), null, 45000);
  check(`${label}: the first tifo opens the four-step guide`, guided);
  const g1 = await p.evaluate(() => ({ h: document.querySelector('.gd-h')?.textContent, steps: document.querySelectorAll('.gd-steps li').length, nudge: !!document.querySelector('.pm-nudge'), spot: !!document.querySelector('.gd-spot') }));
  check(`${label}: step 1 is the club's colours, lit up, with no second card on top`, g1.h === 'Your club’s colours' && g1.steps === 4 && !g1.nudge, JSON.stringify(g1));
  const step = async (n, title) => {
    await p.evaluate(() => document.querySelector('.gd-next')?.click());
    return until(p, (t) => document.querySelector('.gd-h')?.textContent === t, title, 15000);
  };
  // Step 2 is the seats: on a phone the Design view; on a desktop Split (26 Oct
  // 2026), the seats docked under the stadium so the paint shows in both.
  const s2 = await step(2, 'Make it yours') && await until(p, (phone) => !document.getElementById('canvas-host')?.hidden && (phone
    ? document.getElementById('preview-host')?.hidden === true
    : document.getElementById('view-split')?.classList.contains('active') && !document.getElementById('preview-host')?.hidden), label === 'phone', 15000);
  check(`${label}: Next puts them on the seats to make it theirs`, s2);
  const s3 = await step(3, 'See it in the stadium') && await until(p, (phone) => !document.getElementById('preview-host')?.hidden && (phone || document.getElementById('view-3d')?.classList.contains('active')), label === 'phone', 15000);
  check(`${label}: then back in the stadium`, s3);
  if (label === 'phone') {
    check('phone: Post it sits beside Match Day', await until(p, () => { const b = document.querySelector('.m-md .m-post'); return !!b && b.getBoundingClientRect().width > 0; }, null, 10000));
    const clash = await p.evaluate(() => {
      const r = (el) => el && getComputedStyle(el).display !== 'none' ? el.getBoundingClientRect() : null;
      const a = r(document.querySelector('.m-md')); const z = r(document.querySelector('.zoom-pill'));
      return !!a && !!z && a.right > z.left && a.left < z.right && a.bottom > z.top && a.top < z.bottom;
    });
    check('phone: and nothing on the stadium view overlaps it', !clash);
  }
  const s4 = await step(4, 'Show your group');
  check(`${label}: the last step's button is Post it`, s4 && await p.evaluate(() => /Post it/.test(document.querySelector('.gd-next')?.textContent ?? '')));
  await p.evaluate(() => { window.__opened = []; window.open = (u) => { window.__opened.push(String(u)); return null; }; });
  await p.evaluate(() => document.querySelector('.gd-next')?.click());
  const pic = await until(p, () => { const i = document.querySelector('.pm-overlay img.pm-pic'); return !!i && i.complete && i.naturalWidth === 1080 && i.naturalHeight === 1350; }, null, 60000);
  check(`${label}: the picture is made, 1080×1350`, pic);
  const drawn = pic && await p.evaluate(() => {
    const img = document.querySelector('.pm-overlay img.pm-pic');
    const c = document.createElement('canvas'); c.width = 108; c.height = 135;
    const g = c.getContext('2d'); g.drawImage(img, 0, 0, 108, 135);
    const d = g.getImageData(0, 0, 108, 108).data; let bright = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] > 180) bright++;
    return bright / (108 * 108);
  });
  check(`${label}: and it shows the stadium, not a blank`, drawn > 0.04, String(drawn));
  const buttons = await p.evaluate(() => [...document.querySelectorAll('.pm-overlay .pm-b, .pm-overlay .pm-main')].map((b) => b.textContent.trim()));
  check(`${label}: Download, Post on X, WhatsApp and Copy link are offered`, ['Download', 'Post on X', 'WhatsApp', 'Copy link'].every((w) => buttons.some((b) => b.includes(w))), buttons.join(' | '));
  await p.evaluate(() => [...document.querySelectorAll('.pm-overlay .pm-b')].find((b) => b.textContent.includes('Post on X'))?.click());
  const xLink = await p.evaluate(() => window.__opened[0] ?? '');
  const inner = decodeURIComponent(new URL(xLink || 'https://x.invalid/').searchParams.get('url') ?? '');
  check(`${label}: the X link is tagged as a shared post`, /utm_source=x&utm_medium=share&utm_campaign=post/.test(inner), inner);
  if (label === 'desktop') {
    const dl = p.waitForEvent('download', { timeout: 15000 }).catch(() => null);
    await p.evaluate(() => [...document.querySelectorAll('.pm-overlay .pm-b')].find((b) => b.textContent.includes('Download'))?.click());
    const file = await dl;
    check('desktop: Download saves a PNG named after the tifo', !!file && /-tifomaker\.png$/.test(file.suggestedFilename()), file?.suggestedFilename());
  }
  await p.keyboard.press('Escape');
  check(`${label}: Escape closes it`, await until(p, () => !document.querySelector('.pm-overlay'), null, 5000));
  check(`${label}: the guide is done and remembered`, await p.evaluate(() => !document.querySelector('.gd') && localStorage.getItem('tifo_guide_v1') === 'done' && !document.body.classList.contains('guided')));
  // And the one-time card does not follow it: back in 3D later, nothing.
  await p.evaluate(async () => { document.getElementById('view-2d')?.click(); await new Promise((r) => setTimeout(r, 300)); document.getElementById('view-3d')?.click(); });
  await p.waitForTimeout(2600);
  check(`${label}: and no "Post it?" card after it`, await p.evaluate(() => !document.querySelector('.pm-nudge')));
  await p.context().close();
}
{
  // Someone who has had the guide (or left it for Free mode) gets the one-time
  // "Post it?" card on their next club tifo, as before, and only once.
  const p = await open(WIDE, [['tifo_news_banners_v1', '1'], ['tifo_news_leagues_v2', '1'], ['tifo_guide_v1', 'free']]);
  await p.goto(`${B}/projects?new=1&e2e`, { waitUntil: 'domcontentloaded' });
  await until(p, () => document.querySelectorAll('.st-club').length >= 8, null, 90000);
  await p.evaluate(() => document.querySelector('.st-club[data-club="nassr"]')?.click());
  await until(p, () => document.querySelector('.st-opt.on')?.dataset.start === 'club', null, 10000);
  await p.evaluate(() => document.getElementById('st-go')?.click());
  const nudge = await until(p, () => !!document.querySelector('.pm-nudge'), null, 45000);
  check('after the guide: the one-time "Post it?" card appears instead', nudge && await p.evaluate(() => !document.querySelector('.gd')));
  check('offering "Paint it" beside "Post it"', await p.evaluate(() => document.querySelector('.pm-nudge .pm-b')?.textContent.trim() === 'Paint it'));
  const blue = await p.evaluate(() => {
    const solid = (el) => { if (!el) return false; const c = getComputedStyle(el).backgroundColor.match(/\d+/g)?.map(Number) ?? [0, 0, 0]; return c[2] > 180 && c[0] < 80; };
    return { post: solid(document.getElementById('post-tifo')), save: solid(document.getElementById('save-top')), signup: solid(document.getElementById('signin')), next: document.documentElement.dataset.next };
  });
  check('the header has one blue button: Post it, once the work is kept', blue.post && !blue.save && !blue.signup && blue.next === 'post', JSON.stringify(blue));
  await p.evaluate(() => document.querySelector('.pm-nudge .pm-x, .pm-nudge [aria-label="Close"]')?.click());
  await p.evaluate(async () => { document.getElementById('view-2d')?.click(); await new Promise((r) => setTimeout(r, 300)); document.getElementById('view-3d')?.click(); });
  await p.waitForTimeout(2600);
  check('the card is shown only once', await p.evaluate(() => !document.querySelector('.pm-nudge')));
  await p.context().close();
}
{
  const funnel = await admin('/api/funnel?days=7');
  const n = (k) => (funnel.steps ?? []).find((s) => s.name === k)?.sessions ?? 0;
  check('the funnel counts "Opened Post it" and "Shared it"', n('post_opened') >= 2 && n('shared') >= 2, JSON.stringify({ post_opened: n('post_opened'), shared: n('shared') }));
  check('and the guide: started and followed to Post it', n('guide_started') >= 2 && n('guide_done') >= 2, JSON.stringify({ guide_started: n('guide_started'), guide_done: n('guide_done') }));
}

// ---------------------------------------------------------------------------
console.log('\n— 4. publishing opens the share window, with tagged links —');
{
  const stamp = Date.now().toString(36).slice(-5);
  const reg = await api('/api/auth/register', null, { username: `pub${stamp}`, password: 'harbor-kite-moss-31', email: `pub${stamp}@example.test`, acceptedVersion: 'test' });
  const p = await open(WIDE, [['tifo_token_v1', reg.token], ['tifo_onboarded_v1', '1'], ['tifo_news_banners_v1', '1'], ['tifo_news_leagues_v2', '1'], ['tifo_post_nudge_v1', '1']]);
  await p.goto(`${B}/app?new=1`, { waitUntil: 'domcontentloaded' });
  await until(p, () => /[?&]project=/.test(location.search), null, 90000);
  await p.evaluate(() => document.getElementById('publish-design')?.click());
  const dlg = await until(p, () => !!document.querySelector('.pub-go'), null, 30000);
  if (dlg) await p.evaluate(() => document.querySelector('.pub-go')?.click());
  const modal = await until(p, () => !!document.querySelector('.sm-overlay .sm-link'), null, 30000);
  check('the share window opens as soon as it is published', dlg && modal);
  const link = await p.evaluate(() => document.querySelector('.sm-overlay .sm-link')?.value ?? '');
  check('its link is the tifo page, tagged', /\/t\/[0-9a-f-]{36}\?utm_source=copy&utm_medium=share&utm_campaign=tifo$/.test(link), link);
  await p.context().close();
}

// ---------------------------------------------------------------------------
console.log('\n— 5. the admin link builder —');
{
  const p = await open({ viewport: { width: 1360, height: 1000 } });
  await p.goto(`${B}/admin`, { waitUntil: 'networkidle' });
  await p.fill('#p', PW);
  await p.click('#login-form button');
  await p.waitForSelector('#tabs .tab', { timeout: 30000 });
  await p.click('.tab[data-tab="traffic"]');
  const has = await until(p, () => !!document.getElementById('lb-url'), null, 15000);
  check('Where from has the link builder', has);
  await p.selectOption('#lb-platform', 'tiktok');
  await p.selectOption('#lb-spot', 'bio');
  await p.selectOption('#lb-page', '/projects?new=1');
  await p.fill('#lb-name', 'Reveal Video 1');
  const url = await p.inputValue('#lb-url');
  check('it builds the link asked for', url === `${B}/projects?new=1&utm_source=tiktok&utm_medium=bio&utm_campaign=reveal-video-1`, url);
  const shared = await p.evaluate(() => [...document.querySelectorAll('.card .lt')].some((e) => e.textContent === 'Shared by visitors'));
  check('and "Shared by visitors" has its own panel', shared);
  const badge = await p.evaluate(() => document.querySelector('.tab[data-tab="traffic"] .pill')?.textContent ?? '');
  check('the Where from tab badge shows page views again', /\d/.test(badge), badge);
  await p.context().close();
}

await browser.close();
stop();
if (errs.length) console.log('page errors:\n  ' + [...new Set(errs)].join('\n  '));
check('no page errors', errs.length === 0);
console.log(`\ngrowth: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
