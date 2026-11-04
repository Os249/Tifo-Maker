/**
 * Dev-only: the LED boards (Pro) in Match Day, for looking at.
 *   npm run build && node scripts/led-shots.mjs OUTDIR
 *
 * Boots its own server (PRO_MODE=preview, port 8951), signs a fan on the list
 * up, puts a club kit with a crest in the browser, and on three grounds with
 * big screens, in English and in Arabic: words on the boards in the sponsor
 * style (the kit's crest beside them), the big screens showing the boards,
 * and three frames: before the reveal, during it, after it.
 */
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright';

const OUT = process.argv[2] || 'preview-out/led-shots';
mkdirSync(OUT, { recursive: true });
const PORT = 8951;
const B = `http://127.0.0.1:${PORT}`;
const GROUNDS = (process.env.GROUNDS || 'jewel-jeddah-60k-rb,alawwal-park-26k-rb,alfaisal-jeddah-27k').split(',');
const LANGS = (process.env.LANGS || 'en,ar').split(',');
const out = [];
const server = spawn(process.execPath, ['--import', 'tsx', 'server/src/server.ts'], {
  env: { ...process.env, PORT: String(PORT), NODE_ENV: 'development', DATABASE_URL: '', RESEND_API_KEY: '', GEMINI_API_KEY: '', PRO_MODE: 'preview', PRO_PREVIEW_USERS: 'led_fan' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stdout.on('data', (d) => out.push(String(d)));
server.stderr.on('data', (d) => out.push(String(d)));
process.on('exit', () => server.kill());
for (let i = 0; i < 120; i++) {
  if (await fetch(`${B}/health`).then((r) => r.ok).catch(() => false)) break;
  await new Promise((r) => setTimeout(r, 500));
}
const api = async (path, token, init = {}) => {
  const r = await fetch(B + path, { ...init, headers: { ...(init.body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) } });
  return { status: r.status, json: await r.json().catch(() => null) };
};
const codeFor = async (email) => {
  for (let i = 0; i < 40; i++) {
    const m = [...out.join('').matchAll(/\[email:dev\] to=(\S+) \|[\s\S]*?Your TifoMaker code: (\d{6})/g)].filter((x) => x[1] === email).pop();
    if (m) return m[2];
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
};
const email = 'led_fan@tifomaker-e2e.org';
const reg = await api('/api/auth/register', null, { method: 'POST', body: JSON.stringify({ username: 'led_fan', password: 'harbor-kite-moss-31', email, acceptedVersion: 'test' }) });
const token = reg.json?.token;
await api('/api/auth/verify/code', token, { method: 'POST', body: JSON.stringify({ code: await codeFor(email) }) });

/** A club kit with a crest, in this browser's IndexedDB (ui/clubKitStore's record), before the page reads it. */
const SEED_KIT = () => {
  const draw = async () => {
    const c = new OffscreenCanvas(256, 300);
    const g = c.getContext('2d');
    g.fillStyle = '#f2c230';
    g.beginPath(); g.moveTo(128, 8); g.lineTo(244, 48); g.lineTo(232, 190); g.quadraticCurveTo(200, 262, 128, 292); g.quadraticCurveTo(56, 262, 24, 190); g.lineTo(12, 48); g.closePath(); g.fill();
    g.fillStyle = '#123a8c';
    g.beginPath(); g.moveTo(128, 30); g.lineTo(222, 62); g.lineTo(212, 186); g.quadraticCurveTo(184, 246, 128, 270); g.quadraticCurveTo(72, 246, 44, 186); g.lineTo(34, 62); g.closePath(); g.fill();
    g.fillStyle = '#ffffff';
    g.beginPath();
    for (let i = 0; i < 10; i++) { const a = -Math.PI / 2 + (i * Math.PI) / 5; const r = i % 2 ? 30 : 72; g.lineTo(128 + Math.cos(a) * r, 150 + Math.sin(a) * r); }
    g.closePath(); g.fill();
    return c.convertToBlob({ type: 'image/png' });
  };
  const req = indexedDB.open('tifo_club_kits', 1);
  req.onupgradeneeded = () => { if (!req.result.objectStoreNames.contains('kits')) req.result.createObjectStore('kits'); };
  req.onsuccess = async () => {
    const blob = await draw();
    const tx = req.result.transaction('kits', 'readwrite');
    tx.objectStore('kits').put({ v: 1, name: 'Blue Waves', colors: ['#123a8c', '#f2c230', '#ffffff'], logos: [blob], font: '', at: 1 }, 'kledshots01');
  };
};

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const report = [];
for (const ground of GROUNDS) {
  for (const lang of LANGS) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    await ctx.addInitScript(([tok, lang, ground]) => {
      try {
        for (const [k, v] of Object.entries({
          tifo_consent_v1: 'essential', tifo_guide_v1: 'done', tifo_onboarded_v1: '1', tifo_news_banners_v1: '1', tifo_news_leagues_v2: '1',
          tifo_banner_tour_v1: '1', tifo_lang_v1: lang, mds_seen_intro: '1', mds_sound_v2: JSON.stringify({ on: false }), tifo_post_nudge_v1: '1',
          mds_led_v1: JSON.stringify({ messages: lang === 'ar' ? ['زعيم آسيا', 'الموج الأزرق', 'BLUE WAVES'] : ['BLUE WAVES', 'زعيم آسيا', 'FOREVER BLUE'], colour: '#123a8c' }),
          mds_led_style_v1: JSON.stringify({ template: 'sponsor', kit: 'kledshots01', home: '', away: '', homeGoals: 0, awayGoals: 0 }),
        })) localStorage.setItem(k, v);
        localStorage.setItem('tifo_token_v1', tok);
        if (!sessionStorage.getItem('e2e_started')) {
          sessionStorage.setItem('e2e_started', '1');
          sessionStorage.setItem('tifo_new_project', JSON.stringify({ title: 'Blue waves', templateId: ground, start: { kind: 'pattern', patternId: 'hoops', palette: ['#262a33', '#123a8c', '#f2c230', '#ffffff'] } }));
        }
      } catch { /* */ }
    }, [token, lang, ground]);
    await ctx.addInitScript(SEED_KIT);
    const p = await ctx.newPage();
    const errs = [];
    p.on('pageerror', (e) => errs.push(e.message.slice(0, 160)));
    await p.goto(`${B}${lang === 'ar' ? '/ar' : ''}/app?new=1&template=${ground}&e2e=1`, { waitUntil: 'networkidle', timeout: 240000 });
    await p.waitForFunction(() => /\d/.test(document.getElementById('stat')?.textContent || '') && !/generating/i.test(document.getElementById('stat')?.textContent || ''), null, { timeout: 240000 });
    await p.evaluate(() => document.getElementById('match-day')?.click());
    await p.waitForSelector('.mds-overlay canvas', { timeout: 240000 });
    await p.waitForFunction(() => window.__tifoMatchDay?.compileDone === true, null, { timeout: 300000 });
    await p.waitForFunction(() => !document.querySelector('.mds-section[data-sec="led"]')?.hidden, null, { timeout: 60000 });
    await p.evaluate(() => { const s = document.querySelector('.mds-section[data-sec="led"]'); if (!s.classList.contains('open')) s.querySelector('.mds-shead').click(); });
    // The kit's crest arrives with the kits, a moment after the section shows.
    await p.waitForFunction(() => document.querySelector('[data-k="led-kit"]')?.value === 'kledshots01', null, { timeout: 30000 }).catch(() => {});
    // On the pitch, six metres in front of the far touchline's boards, looking
    // up at the stand behind them: the boards across the bottom, the tifo above.
    const boardShot = () => p.evaluate(() => window.__tifoMatchDay.applyShot({ name: 'Boards', position: [0, 5, -14], target: [0, 4, -44], fov: 50 }));
    await boardShot();
    const screens = await p.evaluate(() => window.__tifoMatchDay.hasScreens());
    if (screens) await p.evaluate(() => { const s = document.querySelector('[data-k="screen-mode"]'); s.value = 'boards'; s.dispatchEvent(new Event('change', { bubbles: true })); });
    const still = async () => {
      const pngs = [];
      for (let i = 0; i < 40; i++) {
        await p.waitForTimeout(1500);
        const a = await p.$eval('.mds-overlay canvas', (c) => c.toDataURL('image/jpeg', 0.5).length);
        pngs.push(a);
        if (pngs.length >= 3 && pngs.at(-1) === pngs.at(-2) && pngs.at(-2) === pngs.at(-3)) return;
      }
    };
    await still();
    const tag = `${ground}-${lang}`;
    await p.screenshot({ path: `${OUT}/${tag}-1-before.jpg`, quality: 80, type: 'jpeg' });
    await p.evaluate(() => window.__tifoMatchDay.playReveal('wave', 6000));
    await p.waitForTimeout(3500);
    await p.screenshot({ path: `${OUT}/${tag}-2-during.jpg`, quality: 80, type: 'jpeg' });
    await still();
    await p.screenshot({ path: `${OUT}/${tag}-3-after.jpg`, quality: 80, type: 'jpeg' });
    // A big screen, from the middle of the pitch: it shows what the boards show.
    const aimed = await p.evaluate(() => {
      const sim = window.__tifoMatchDay;
      const tex = sim.venue?.screen?.texture;
      // The screens may be merged into one mesh with the building: the centre of
      // the vertices drawn with the screens' material, wherever they ended up.
      let at = null;
      sim.scene.traverse((o) => {
        if (at || !o.isMesh || !tex) return;
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        const k = mats.findIndex((m) => m?.map === tex);
        if (k < 0) return;
        const g = o.geometry;
        const pos = g.attributes.position;
        const idx = g.index;
        const groups = Array.isArray(o.material) && g.groups.length ? g.groups.filter((gr) => gr.materialIndex === k) : [{ start: 0, count: idx ? idx.count : pos.count }];
        // One screen: the first quad drawn with that material (several screens share it).
        let x = 0, y = 0, z = 0, n = 0;
        const gr = groups[0];
        for (let j = gr.start; j < gr.start + Math.min(6, gr.count); j++) { const v = idx ? idx.getX(j) : j; x += pos.getX(v); y += pos.getY(v); z += pos.getZ(v); n++; }
        if (!n) return;
        at = o.localToWorld(o.position.clone().set(x / n, y / n, z / n));
      });
      if (!at) return false;
      // From the pitch, two thirds of the way from the screen to the centre spot.
      sim.applyShot({ name: 'Screen', position: [at.x * 0.33, Math.max(3, at.y * 0.5), at.z * 0.33], target: [at.x, at.y, at.z], fov: 28 });
      return true;
    });
    if (aimed) {
      await still();
      await p.screenshot({ path: `${OUT}/${tag}-4-big-screen.jpg`, quality: 80, type: 'jpeg' });
    }
    const st = await p.evaluate(() => ({ board: window.__tifoMatchDay.boardFrame(), screen: window.__tifoMatchDay.screenMode(), kit: document.querySelector('[data-k="led-kit"]')?.value }));
    report.push({ tag, screens, ...st, errs });
    console.log(tag, JSON.stringify({ screens, ...st, errs }));
    await ctx.close();
  }
}
await browser.close();
server.kill();
process.exit(0);
