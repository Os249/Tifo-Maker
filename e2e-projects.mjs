/**
 * Projects: the Projects page, the Create panel, and the editor's side of it.
 *
 * Walks what a person does, in a real browser against a real server:
 *   as a guest     /app sends you to /projects; the panel creates a project in
 *                  this browser; pin, rename, duplicate, search, sort, trash,
 *                  undo, restore, delete forever; a copy onto another stadium;
 *                  a .tifo file; the one-draft world migrating forward;
 *   signing up     every local project moves into the account;
 *   signed in      account projects, their thumbnails, unsaved changes coming
 *                  back after a reload, a rename reaching the account on Save,
 *                  the AI gate (signed out / unverified / verified), a project
 *                  generated and named by the AI, Publish from the menu,
 *                  a published project leaving the feed while it is in the Trash,
 *                  opening your own design vs someone else's, a dead link.
 *
 * Self-contained like e2e-claim.mjs: it boots its own server on memory repos.
 * Needs a build first:  npm run build && node e2e-projects.mjs
 * Every wait polls for the outcome; nothing sleeps a fixed time to "let it settle".
 */
import { spawn } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';

const PORT = 8913;
const B = `http://127.0.0.1:${PORT}`;
const out = [];
const server = spawn(process.execPath, ['--import', 'tsx', 'server/src/server.ts'], {
  env: { ...process.env, PORT: String(PORT), NODE_ENV: 'development', DATABASE_URL: '', RESEND_API_KEY: '', GEMINI_API_KEY: '', AI_MODEL_PREMIUM: '' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stdout.on('data', (d) => out.push(String(d)));
server.stderr.on('data', (d) => out.push(String(d)));
const stop = () => { try { server.kill(); } catch { /* gone */ } };
process.on('exit', stop);
let up = false;
for (let i = 0; i < 90; i++) {
  if (await fetch(`${B}/health`).then((r) => r.ok).catch(() => false)) { up = true; break; }
  await new Promise((r) => setTimeout(r, 500));
}
if (!up) { console.error('server never came up\n' + out.join('')); stop(); process.exit(1); }

let pass = 0, fail = 0;
const check = (n, ok, x = '') => { (ok ? pass++ : fail++); console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${x ? '  ' + x : ''}`); };
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] }).catch(() => chromium.launch());
const errs = [];
const newPage = async (viewport = { width: 1366, height: 860 }) => {
  const ctx = await browser.newContext({ viewport });
  // The cookie banner is its own subject (e2e-consent); answer it up front.
  await ctx.addInitScript(() => { try { localStorage.setItem('tifo_consent_v1', 'essential'); } catch {} });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errs.push(String(e.message).slice(0, 200)));
  return p;
};
const waitFor = (p, fn, arg = null, ms = 60000) => p.waitForFunction(fn, arg, { timeout: ms }).then(() => true).catch(() => false);
const editorReady = (p) => waitFor(p, () => /seats/.test(document.getElementById('stat')?.textContent || ''), null, 120000);
const projectsReady = (p) => waitFor(p, () => {
  const s = document.getElementById('pj-status');
  return !!document.querySelector('.pj-card, .pj-empty:not([hidden])') && !(s && /Loading/.test(s.textContent || ''));
});
const paint = (p, fx = 0.4) => p.evaluate((fx) => {
  const c = document.querySelector('#canvas-host canvas'); const r = c.getBoundingClientRect();
  const ev = (t, x, y) => c.dispatchEvent(new PointerEvent(t, { pointerId: 1, isPrimary: true, bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, buttons: t === 'pointerup' ? 0 : 1, pointerType: 'mouse' }));
  for (const fy of [0.4, 0.45, 0.5, 0.55]) {
    const x0 = r.left + r.width * fx, y = r.top + r.height * fy;
    ev('pointerdown', x0, y); for (let i = 0; i < 30; i++) ev('pointermove', x0 + i * 6, y); ev('pointerup', x0 + 180, y);
  }
}, fx);
const cards = (p) => p.evaluate(() => [...document.querySelectorAll('.pj-card')].map((c) => ({
  key: c.dataset.key, name: c.querySelector('.pj-name')?.textContent?.trim(), pinned: c.classList.contains('pinned'),
  badges: [...c.querySelectorAll('.pj-badge')].map((b) => b.textContent.trim()), img: c.querySelector('.pj-thumb img')?.getAttribute('src') || null,
  meta: c.querySelector('.pj-meta')?.textContent?.replace(/\s+/g, ' ').trim(),
})));
const menu = async (p, name, label) => {
  await p.evaluate((name) => {
    const card = [...document.querySelectorAll('.pj-card')].find((c) => c.querySelector('.pj-name')?.textContent?.trim() === name);
    card?.querySelector('.pj-more')?.click();
  }, name);
  await waitFor(p, () => !!document.querySelector('.pj-menu'));
  return p.evaluate((label) => {
    const b = [...document.querySelectorAll('.pj-menu-item')].find((x) => x.textContent.trim() === label);
    b?.click();
    return !!b;
  }, label);
};
const setInput = (p, sel, v) => p.evaluate(([sel, v]) => {
  const el = document.querySelector(sel);
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}, [sel, v]);
const index = (p) => p.evaluate(() => JSON.parse(localStorage.getItem('tifo_projects_v1') || '[]'));
const api = async (path, token, init = {}) => {
  const r = await fetch(B + path, { ...init, headers: { ...(init.body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...(init.headers || {}) } });
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

// =====================================================================
console.log('\n— as a guest —');
const g = await newPage();
await g.goto(B + '/app', { waitUntil: 'domcontentloaded' });
await waitFor(g, () => location.pathname === '/projects');
check('a bare /app goes to the Projects page', new URL(g.url()).pathname === '/projects', g.url());
check('with nothing yet, the Create panel opens by itself', await waitFor(g, () => !!document.querySelector('.np-modal')));
const panel = await g.evaluate(() => ({
  name: document.getElementById('np-name')?.value,
  focused: document.activeElement?.id,
  stadiums: document.querySelectorAll('.np-stadium').length,
  picked: document.querySelector('.np-stadium.on')?.dataset.id,
  facts: document.getElementById('np-facts')?.textContent,
  buttons: [...document.querySelectorAll('#np-actions button')].map((b) => b.textContent.trim()),
  inertBehind: [...document.body.children].filter((el) => el.inert).length > 0,
}));
check('the name is filled in and focused', panel.name === 'My tifo' && panel.focused === 'np-name', JSON.stringify(panel.name));
check('every built stadium is offered', panel.stadiums === 44, String(panel.stadiums));
check('one is chosen, and what it means is spelled out', !!panel.picked && /seats · \d+ tiers? · \d+ sections/.test(panel.facts || '') || /1 tier/.test(panel.facts || ''), panel.facts);
check('two actions and no clutter: Generate with AI and Create project', panel.buttons.length === 2 && /Generate with AI/.test(panel.buttons[0]) && /Create project/.test(panel.buttons[1]), JSON.stringify(panel.buttons));
check('the page behind the panel is inert', panel.inertBehind);

// The AI side, signed out: still reachable, says what is needed, cannot generate.
await g.click('#np-to-ai');
await waitFor(g, () => !document.getElementById('np-gate')?.hidden);
const aiOut = await g.evaluate(() => ({
  gate: document.getElementById('np-gate')?.textContent, fix: document.querySelector('.np-gate-fix')?.textContent,
  gen: document.getElementById('np-generate')?.disabled, nameHidden: document.getElementById('np-name-sec')?.hidden,
  heading: document.getElementById('np-h')?.textContent,
}));
check('AI, signed out: the panel says an account with a verified email is needed', /verified email/i.test(aiOut.gate || ''), aiOut.gate);
check('…offers the one fix, and Generate stays off', aiOut.fix === 'Sign in' && aiOut.gen === true);
check('…and the prompt replaces the name (the AI names it)', aiOut.nameHidden === true && /Generate a tifo/.test(aiOut.heading || ''));
await g.click('#np-back');

// Search narrows the stadiums; Create.
await setInput(g, '#np-search', 'jewel');
check('stadium search narrows the list', await g.evaluate(() => document.querySelectorAll('.np-stadium').length) === 1);
await g.click('.np-stadium[data-id="jewel-jeddah-60k"]');
await setInput(g, '#np-search', '');
await setInput(g, '#np-name', 'Derby wall');
await g.click('#np-create');
await waitFor(g, () => location.pathname === '/app');
check('Create goes to the editor on a new project', /[?&]new=1/.test(g.url()) && /template=jewel-jeddah-60k/.test(g.url()), g.url());
await editorReady(g);
check('a first project gets the first-run guide', await waitFor(g, () => !!document.querySelector('.ob-modal')));
check('…which no longer asks for a name', await g.evaluate(() => !document.getElementById('ob-name')));
await g.evaluate(() => document.querySelector('.ob-start')?.click());
check('the project exists as soon as the guide closes', await waitFor(g, () => /[?&]local=l[a-z0-9]+/.test(location.search)), g.url());
let idx = await index(g);
const derby = idx.find((p) => p.title === 'Derby wall');
check('it is in this browser, with its stadium', !!derby && derby.templateId === 'jewel-jeddah-60k' && idx.length === 1, JSON.stringify(idx));
check('the header carries its name', await g.evaluate(() => document.getElementById('doc-title').value) === 'Derby wall');
check('there is a way back to all projects', await g.evaluate(() => document.getElementById('to-projects')?.getAttribute('href')) === '/projects');

await g.waitForTimeout(400);
await paint(g);
check('painting autosaves into the project', await waitFor(g, (id) => {
  const e = JSON.parse(localStorage.getItem('tifo_proj_' + id) || 'null'); return !!e && e.projectId === id;
}, derby.id));
check('and draws its card picture', await waitFor(g, (id) => (localStorage.getItem(`tifo_proj_${id}_thumb`) || '').startsWith('data:image/png'), derby.id, 20000));
check('the old single-draft key is not used any more', await g.evaluate(() => localStorage.getItem('tifo_draft_v1') === null));
const cellsA = await g.evaluate((id) => JSON.stringify(JSON.parse(localStorage.getItem('tifo_proj_' + id)).doc.layers[0].cellsRle.slice(0, 40)), derby.id);

// A second project: no guide the second time.
await g.goto(B + '/projects', { waitUntil: 'domcontentloaded' });
await projectsReady(g);
let cs = await cards(g);
check('the Projects page lists it, with a picture, stadium and badge', cs.length === 1 && cs[0].name === 'Derby wall' && /^data:image/.test(cs[0].img || '') && /Jewel of Jeddah/.test(cs[0].meta) && cs[0].badges.includes('Private'), JSON.stringify(cs[0]));
check('a guest is told the projects live in this browser only', await g.evaluate(() => /this browser only/.test(document.getElementById('pj-where').textContent)));
await g.click('#pj-new');
await waitFor(g, () => !!document.querySelector('.np-modal'));
await g.click('.np-stadium[data-id="kingdom-arena-26k"]');
await g.click('#np-create');
await waitFor(g, () => location.pathname === '/app');
await editorReady(g);
check('a second project skips the guide', await waitFor(g, () => /[?&]local=/.test(location.search)) && await g.evaluate(() => !document.querySelector('.ob-modal')));
check('and got the default name', await g.evaluate(() => document.getElementById('doc-title').value) === 'My tifo');
await paint(g, 0.3);
await waitFor(g, () => { const i = JSON.parse(localStorage.getItem('tifo_projects_v1') || '[]'); return i.length === 2; });

// Reopen the first: its seats come back exactly.
await g.goto(B + '/app?local=' + derby.id, { waitUntil: 'domcontentloaded' });
await editorReady(g);
const reopened = await g.evaluate(() => document.getElementById('doc-title').value);
const cellsB = await g.evaluate((id) => JSON.stringify(JSON.parse(localStorage.getItem('tifo_proj_' + id)).doc.layers[0].cellsRle.slice(0, 40)), derby.id);
check('opening a project brings back its name and its seats', reopened === 'Derby wall' && cellsA === cellsB);

// Page actions.
await g.goto(B + '/projects', { waitUntil: 'domcontentloaded' });
await projectsReady(g);
await g.evaluate(() => [...document.querySelectorAll('.pj-card')].find((c) => c.querySelector('.pj-name').textContent.trim() === 'Derby wall').querySelector('.pj-pin').click());
cs = await cards(g);
check('pinning puts it first, and it stays pinned', cs[0].name === 'Derby wall' && cs[0].pinned && (await index(g)).find((p) => p.id === derby.id).pinned);
await menu(g, 'My tifo', 'Rename');
await waitFor(g, () => !!document.querySelector('.dlg-input'));
await setInput(g, '.dlg-input', 'Final countdown');
await g.evaluate(() => document.querySelector('.dlg-confirm').click());
await waitFor(g, () => [...document.querySelectorAll('.pj-name')].some((n) => n.textContent.trim() === 'Final countdown'));
const renamed = (await index(g)).find((p) => p.title === 'Final countdown');
check('rename changes the card, the list and the saved copy', !!renamed && await g.evaluate((id) => JSON.parse(localStorage.getItem('tifo_proj_' + id)).title, renamed.id) === 'Final countdown');
await menu(g, 'Final countdown', 'Duplicate');
check('duplicate makes a copy', await waitFor(g, () => [...document.querySelectorAll('.pj-name')].some((n) => n.textContent.trim() === 'Final countdown (copy)')));
check('…with its own seats', (await index(g)).length === 3 && await g.evaluate(() => {
  const i = JSON.parse(localStorage.getItem('tifo_projects_v1')); const c = i.find((p) => p.title === 'Final countdown (copy)');
  return !!localStorage.getItem('tifo_proj_' + c.id);
}));
await setInput(g, '#pj-search', 'countdown');
check('search filters by name', (await cards(g)).length === 2);
await setInput(g, '#pj-search', 'zzz');
check('…and says so when nothing matches', await g.evaluate(() => /No projects match/.test(document.getElementById('pj-status').textContent)));
await setInput(g, '#pj-search', '');
await g.selectOption('#pj-sort', 'name');
cs = await cards(g);
check('sort by name, pinned still first', cs.map((c) => c.name).join('|') === 'Derby wall|Final countdown|Final countdown (copy)', cs.map((c) => c.name).join('|'));

await menu(g, 'Final countdown (copy)', 'Move to trash');
check('a private project goes to the Trash at once, with Undo', await waitFor(g, () => /trash/i.test(document.querySelector('.pj-toast')?.textContent || '') && !!document.querySelector('.pj-toast-act')));
check('…and leaves the list', !(await cards(g)).some((c) => c.name === 'Final countdown (copy)'));
await g.evaluate(() => document.querySelector('.pj-toast-act').click());
check('Undo brings it straight back', await waitFor(g, () => [...document.querySelectorAll('.pj-name')].some((n) => n.textContent.trim() === 'Final countdown (copy)')));
await menu(g, 'Final countdown (copy)', 'Move to trash');
await waitFor(g, () => !document.getElementById('pj-trash-btn').hidden);
check('a Trash button appears with its count', await g.evaluate(() => /Trash \(1\)/.test(document.getElementById('pj-trash-btn').textContent)));
await g.click('#pj-trash-btn');
cs = await cards(g);
check('the Trash shows it, with when it goes', cs.length === 1 && /Deletes in 30 days/.test(cs[0].meta), cs[0]?.meta);
check('…and says how long the Trash keeps things', await g.evaluate(() => /30 days/.test(document.getElementById('pj-trash-note').textContent)));
check('a trashed project cannot be opened from its card', await g.evaluate(() => !document.querySelector('.pj-card a.pj-name')));
await menu(g, 'Final countdown (copy)', 'Restore');
check('restore puts it back', await waitFor(g, () => document.querySelectorAll('.pj-card').length === 0) && !(await index(g)).find((p) => p.title === 'Final countdown (copy)').deletedAt);
await g.click('#pj-trash-btn');
await menu(g, 'Final countdown (copy)', 'Move to trash');
await g.click('#pj-trash-btn');
await menu(g, 'Final countdown (copy)', 'Delete forever');
await waitFor(g, () => !!document.querySelector('.dlg-confirm'));
check('delete forever asks first', await g.evaluate(() => /forever/.test(document.querySelector('.dlg-title').textContent)));
await g.evaluate(() => document.querySelector('.dlg-confirm').click());
const goneId = await waitFor(g, () => !JSON.parse(localStorage.getItem('tifo_projects_v1')).some((p) => p.title === 'Final countdown (copy)'));
check('…and then it is gone, seats and all', goneId && await g.evaluate(() => !Object.keys(localStorage).some((k) => k.startsWith('tifo_proj_') && !k.startsWith('tifo_proj_d_') && !JSON.parse(localStorage.getItem('tifo_projects_v1')).some((p) => k.startsWith('tifo_proj_' + p.id)))));
await g.click('#pj-trash-btn'); // back

// Download .tifo from the card.
const [dl] = await Promise.all([g.waitForEvent('download', { timeout: 15000 }).catch(() => null), menu(g, 'Derby wall', 'Download .tifo')]);
let tifoPath = null;
if (dl) { tifoPath = join(mkdtempSync(join(tmpdir(), 'pj-')), 'derby.tifo'); await dl.saveAs(tifoPath); }
check('a project downloads as a .tifo file', !!dl && /\.tifo$/.test(dl.suggestedFilename()), dl?.suggestedFilename());

// Import it back: a new project on its own stadium.
if (tifoPath) {
  await g.setInputFiles('input[type=file][accept*=".tifo"]', tifoPath);
  await waitFor(g, () => location.pathname === '/app');
  await editorReady(g);
  check('importing a .tifo makes a new project on its stadium', await waitFor(g, () => /[?&]local=/.test(location.search)) && /Jewel of Jeddah/.test(await g.evaluate(() => document.getElementById('stat').textContent)));
  check('…named after the file, with its seats', await g.evaluate(() => document.getElementById('doc-title').value) === 'Derby wall' && (await index(g)).filter((p) => p.title === 'Derby wall').length === 2);
}

// A copy onto another stadium, from the editor.
await g.goto(B + '/app?local=' + derby.id, { waitUntil: 'domcontentloaded' });
await editorReady(g);
await g.evaluate(() => { const s = document.getElementById('stadium'); s.value = 'generic-bowl-60k'; s.dispatchEvent(new Event('change')); });
check('changing stadium asks, and explains it makes a copy', await waitFor(g, () => /copy/i.test(document.querySelector('.dlg-title')?.textContent || '')));
await g.evaluate(() => document.querySelector('.dlg-cancel').click());
check('declining leaves the project and the select as they were', await g.evaluate((id) => location.search.includes(id) && document.getElementById('stadium').value !== 'generic-bowl-60k', derby.id));
await g.evaluate(() => { const s = document.getElementById('stadium'); s.value = 'generic-bowl-60k'; s.dispatchEvent(new Event('change')); });
await waitFor(g, () => !!document.querySelector('.dlg-confirm'));
await g.evaluate(() => document.querySelector('.dlg-confirm').click());
await waitFor(g, () => /[?&]new=1/.test(location.search) || /[?&]local=/.test(location.search) && !location.search.includes('x'));
await editorReady(g);
await waitFor(g, () => /[?&]local=/.test(location.search));
const copyTitle = await g.evaluate(() => document.getElementById('doc-title').value);
check('confirming makes a new project on the other stadium', /Derby wall \(Generic 60k bowl\)/.test(copyTitle) && /Generic 60k/.test(await g.evaluate(() => document.getElementById('stat').textContent)), copyTitle);
check('…and the original is untouched', (await index(g)).find((p) => p.id === derby.id)?.templateId === 'jewel-jeddah-60k');

// A dead local link.
await g.goto(B + '/app?local=lnotarealproject1', { waitUntil: 'domcontentloaded' });
await waitFor(g, () => location.pathname === '/projects');
check('a project link that no longer exists goes back to the list, and says why', await waitFor(g, () => /could not be opened/.test(document.querySelector('.pj-toast')?.textContent || '')));

// =====================================================================
console.log('\n— the one-draft world, migrated —');
const m = await newPage();
await m.goto(B + '/projects', { waitUntil: 'domcontentloaded' });
await m.evaluate(() => {
  const rle = [[1, 5000], [2, 5000]];
  localStorage.setItem('tifo_draft_v1', JSON.stringify({ v: 1, savedAt: Date.now() - 3600e3, templateId: 'generic-bowl-60k', templateVersion: 1, title: 'Old draft', designId: null,
    doc: { format: 'tifo', schemaVersion: 2, meta: { title: 'Old draft' }, stadium: { templateId: 'generic-bowl-60k', templateVersion: 1 }, palette: ['#262a33', '#1c5fd9', '#f2f1ec'], layers: [{ id: 'base', kind: 'cells', cellsRle: rle }] } }));
  localStorage.setItem('tifo_banners_v1', '{"v":1,"banners":[]}');
});
await m.reload({ waitUntil: 'domcontentloaded' });
await projectsReady(m);
check('a draft from before projects becomes a project', (await cards(m)).some((c) => c.name === 'Old draft'));
check('…and the old keys are cleared', await m.evaluate(() => !localStorage.getItem('tifo_draft_v1') && !localStorage.getItem('tifo_banners_v1')));

// =====================================================================
console.log('\n— signing up moves them into the account —');
const EMAIL = `pj${Date.now()}@example.test`;
await g.goto(B + '/projects', { waitUntil: 'domcontentloaded' });
await projectsReady(g);
const localCount = (await index(g)).filter((p) => !p.deletedAt).length;
await g.evaluate(() => document.getElementById('pj-keep').click());
await waitFor(g, () => !!document.querySelector('.auth-backdrop .auth-form'));
await g.evaluate(() => document.querySelector('.auth-tab[data-mode="signup"]')?.click());
await g.evaluate((email) => {
  const set = (sel, v) => { const el = document.querySelector(sel); if (!el) return; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); };
  set('.auth-form input[name=identity]', email); set('.auth-form input[name=password]', 'harbor-kite-moss-31'); set('.auth-form input[name=confirm]', 'harbor-kite-moss-31');
}, EMAIL);
await g.evaluate(() => document.querySelector('.auth-form .auth-submit').click());
check('signing up from the Projects page', await waitFor(g, () => !document.querySelector('.auth-backdrop')));
check('every project in this browser moves into the account', await waitFor(g, () => JSON.parse(localStorage.getItem('tifo_projects_v1') || '[]').length === 0 && /Saved in your account/.test(document.getElementById('pj-where').textContent) && document.querySelectorAll('.pj-card').length > 0));
const token = await g.evaluate(() => localStorage.getItem('tifo_token_v1'));
let acct = (await api('/api/projects', token)).json.projects;
check('…all of them, with their names', acct.length === localCount && acct.some((p) => p.title === 'Derby wall'), `${acct.length}/${localCount}`);
check('…the pin came with it', acct.find((p) => p.title === 'Derby wall' && p.pinned));
check('the page now says they are in the account', await waitFor(g, () => /Saved in your account/.test(document.getElementById('pj-where').textContent)));
// A private design's picture cannot be an <img src> to the API (no session on
// an image request), and the CSP refuses blob: images, so it arrives as data:.
check('account cards load their pictures with the session', await waitFor(g, () => {
  const imgs = [...document.querySelectorAll('.pj-thumb img')];
  return imgs.length > 0 && imgs.every((i) => (i.getAttribute('src') || '').startsWith('data:image/png') && i.naturalWidth > 0);
}), JSON.stringify(await g.evaluate(() => [...document.querySelectorAll('.pj-card')].map((c) => {
  const i = c.querySelector('.pj-thumb img'); return [c.querySelector('.pj-name').textContent, i ? (i.getAttribute('src') || 'pending').slice(0, 22) : 'none', i?.naturalWidth];
}))));

// Verify the email, for the AI below.
const code = await codeFor(EMAIL);
const v = await api('/api/auth/verify/code', token, { method: 'POST', body: JSON.stringify({ code }) });
check('(email verified for the AI checks)', v.status === 200, String(v.status));

// Open an account project, change it, reload: the unsaved change comes back.
const derbyAcct = acct.find((p) => p.title === 'Derby wall' && p.templateId === 'jewel-jeddah-60k');
await g.goto(B + '/app?project=' + derbyAcct.id, { waitUntil: 'domcontentloaded' });
await editorReady(g);
check('an account project opens as itself', await g.evaluate(() => document.getElementById('doc-title').value) === 'Derby wall');
await g.waitForTimeout(300);
await paint(g, 0.2);
check('an edit not yet saved is shown as such, not as "saved to your account"', await waitFor(g, () => /Unsaved changes/.test(document.getElementById('save-state-top')?.textContent || '')));
await g.evaluate(() => { const t = document.getElementById('doc-title'); t.value = 'Derby wall v2'; t.dispatchEvent(new Event('input', { bubbles: true })); });
await waitFor(g, (id) => JSON.parse(localStorage.getItem('tifo_proj_d_' + id) || '{}').title === 'Derby wall v2', derbyAcct.id);
await g.reload({ waitUntil: 'domcontentloaded' });
await editorReady(g);
check('after a reload the unsaved work comes back, and says so', await waitFor(g, () => /unsaved changes/.test(document.getElementById('message')?.textContent || '')) && await g.evaluate(() => document.getElementById('doc-title').value) === 'Derby wall v2');
await g.evaluate(() => document.getElementById('save-top').click());
check('Save puts it in the account', await waitFor(g, () => /Saved to your account/.test(document.getElementById('save-state-top')?.textContent || '') || /Saved to your account/.test(document.getElementById('message')?.textContent || '')));
acct = (await api('/api/projects', token)).json.projects;
check('…including the new name', acct.some((p) => p.id === derbyAcct.id && p.title === 'Derby wall v2'));

// =====================================================================
console.log('\n— the AI —');
await g.goto(B + '/projects', { waitUntil: 'domcontentloaded' });
await projectsReady(g);
await g.click('#pj-new');
await waitFor(g, () => !!document.querySelector('.np-modal'));
await g.click('#np-to-ai');
check('verified: the AI side is open for business', await waitFor(g, () => document.getElementById('np-generate') && !document.getElementById('np-generate').disabled));
await g.evaluate(() => document.getElementById('np-generate').click());
check('an empty prompt is caught in the panel', await g.evaluate(() => /Say what you want/.test(document.getElementById('np-prompt-err').textContent)));
await g.evaluate(() => document.querySelector('.np-example').click());
check('an example fills the prompt', await g.evaluate(() => document.getElementById('np-prompt').value.length > 10));
await setInput(g, '#np-prompt', 'Blue and white hoops for Al Hilal with a crescent');
await g.click('.np-stadium[data-id="generic-bowl-60k"]');
await g.evaluate(() => document.getElementById('np-generate').click());
await waitFor(g, () => location.pathname === '/app');
await editorReady(g);
// With no premium model configured (as here) the AI answers "busy" and the
// panel offers the Quick Designer: the path a person takes then. A premium
// answer skips this and lands straight on the result.
const choice = await waitFor(g, () => [...document.querySelectorAll('#ai-state button')].some((b) => /Quick Designer/.test(b.textContent)) || /[?&]project=/.test(location.search) && document.getElementById('doc-title').value !== 'My tifo', null, 90000);
check('the AI panel opens by itself and answers', choice);
await g.evaluate(() => [...document.querySelectorAll('#ai-state button')].find((b) => /Quick Designer/.test(b.textContent))?.click());
const aiDone = await waitFor(g, () => /[?&]project=/.test(location.search) && document.getElementById('doc-title').value !== 'My tifo' && /Saved to your account/.test((document.getElementById('save-state-top')?.textContent || '') + (document.getElementById('message')?.textContent || '')), null, 120000);
const aiTitle = await g.evaluate(() => document.getElementById('doc-title').value);
check('Generate makes the project and the AI draws it', aiDone, aiTitle);
check('the AI named it', !!aiTitle && aiTitle !== 'My tifo' && aiTitle !== 'Untitled tifo', aiTitle);
let aiProj = null;
for (let i = 0; i < 60 && !(aiProj && aiProj.title === aiTitle); i++) {
  aiProj = (await api('/api/projects', token)).json.projects.find((p) => p.origin === 'ai');
  if (!(aiProj && aiProj.title === aiTitle)) await new Promise((r) => setTimeout(r, 500));
}
check('it is saved in the account, badged as AI, under that name', !!aiProj && aiProj.title === aiTitle, JSON.stringify(aiProj?.title));
await g.goto(B + '/projects', { waitUntil: 'domcontentloaded' });
await projectsReady(g);
check('the card shows the AI badge', (await cards(g)).find((c) => c.name === aiTitle)?.badges.some((b) => /AI/.test(b)));

// Unverified account: told to verify.
const u2 = await api('/api/auth/register', null, { method: 'POST', body: JSON.stringify({ username: `unv${Date.now() % 100000}`, password: 'harbor-kite-moss-31', email: `unv${Date.now()}@example.test`, acceptedVersion: 'test' }) });
const un = await newPage();
await un.addInitScript((t) => { try { localStorage.setItem('tifo_token_v1', t); } catch {} }, u2.json.token);
await un.goto(B + '/projects?ai=1', { waitUntil: 'domcontentloaded' });
check('unverified: the AI side says to verify, and links to where that is done', await waitFor(un, () => /Verify your email/.test(document.getElementById('np-gate')?.textContent || '') && document.querySelector('.np-gate-fix')?.getAttribute('href') === '/account'));

// =====================================================================
console.log('\n— publishing and the Trash —');
await menu(g, aiTitle, 'Publish to the community');
await waitFor(g, () => location.pathname === '/app');
await editorReady(g);
check('Publish from the menu opens the publish dialog on that project', await waitFor(g, () => !!document.querySelector('.save-modal #pub-title')));
check('…with the project name offered as the public name', await g.evaluate((n) => document.getElementById('pub-title').value === n, aiTitle));
await g.evaluate(() => document.querySelector('.pub-actions button:not(.pub-cancel)')?.click());
const published = await (async () => { for (let i = 0; i < 60; i++) { const a = (await api('/api/projects', token)).json.projects.find((p) => p.id === aiProj.id); if (a?.isPublic) return true; await new Promise((r) => setTimeout(r, 500)); } return false; })();
check('…and publishing works from there', published);
const inFeed = async () => ((await api('/api/gallery?sort=recent&limit=120')).json || []).some((d) => d.id === aiProj.id);
check('it is in the community feed', await inFeed());
await g.goto(B + '/projects', { waitUntil: 'domcontentloaded' });
await projectsReady(g);
check('its card says Published', (await cards(g)).find((c) => c.name === aiTitle)?.badges.includes('Published'));
await menu(g, aiTitle, 'Move to trash');
check('trashing a published project asks first, and says it leaves the community', await waitFor(g, () => /community/.test(document.querySelector('.dlg-msg')?.textContent || '')));
await g.evaluate(() => document.querySelector('.dlg-confirm').click());
await waitFor(g, () => !!document.querySelector('.pj-toast'));
check('in the Trash it is out of the feed', !(await inFeed()));
await g.click('#pj-trash-btn');
await menu(g, aiTitle, 'Restore');
await waitFor(g, () => document.querySelectorAll('.pj-card').length === 0);
check('restored, it is published again', await inFeed());

// =====================================================================
console.log('\n— opening designs —');
// Your own design, "opened" from somewhere else, opens as itself.
await g.goto(B + `/app?new=1&from=${derbyAcct.id}`, { waitUntil: 'domcontentloaded' });
check('opening your own design opens it, not a copy of it', await waitFor(g, (id) => location.search === `?project=${id}`, derbyAcct.id));
// Someone else's public design (the starter library's) becomes a new project named after it.
const mineBefore = (await api('/api/projects', token)).json.projects.length;
const gal = (await api('/api/gallery?sort=recent&limit=40')).json.find((d) => d.id !== aiProj.id);
await g.goto(B + `/app?new=1&from=${gal.id}`, { waitUntil: 'domcontentloaded' });
await editorReady(g);
check("someone else's design opens as a new project of yours", await waitFor(g, () => /[?&]project=/.test(location.search)));
const afterTitle = await g.evaluate(() => document.getElementById('doc-title').value);
check('…named after it', afterTitle === gal.title, `${afterTitle} vs ${gal.title}`);
check('…and it is in your list', (await api('/api/projects', token)).json.projects.length >= mineBefore + 1);
// A dead account link.
await g.goto(B + '/app?project=00000000-0000-4000-8000-000000000000', { waitUntil: 'domcontentloaded' });
check('an account project that is not there goes back to the list', await waitFor(g, () => location.pathname === '/projects'));

// =====================================================================
console.log('\n— phone and Arabic —');
const ph = await newPage({ width: 390, height: 844 });
await ph.addInitScript(() => { try { localStorage.setItem('tifo_lang_v1', 'ar'); } catch {} });
await ph.goto(B + '/projects?new=1', { waitUntil: 'domcontentloaded' });
await waitFor(ph, () => !!document.querySelector('.np-modal'));
const phone = await ph.evaluate(() => ({
  dir: document.documentElement.dir, over: document.documentElement.scrollWidth - innerWidth,
  h: document.getElementById('np-h').textContent, create: document.getElementById('np-create').textContent,
  // offsetWidth, not the box: the panel scales in, and a box read mid-animation is 97% of it.
  modalW: document.querySelector('.np-modal').offsetWidth,
  room: document.querySelector('.np-backdrop').clientWidth,
}));
check('the panel is in Arabic, right to left', phone.dir === 'rtl' && phone.h === 'مشروع جديد' && /سوّ المشروع/.test(phone.create), JSON.stringify(phone));
check('on a phone it fills the width, nothing scrolls sideways', phone.modalW >= phone.room - 1 && phone.over <= 0, `${phone.modalW} of ${phone.room} / ${phone.over}`);

console.log(`\n  ${pass} passed, ${fail} failed`);
console.log('  pageerrors:', errs.length ? errs : 'none');
await browser.close(); stop(); process.exit(fail ? 1 : 0);
