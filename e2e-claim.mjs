/**
 * The claim path: paint -> save (local) -> take the offer -> sign up -> the
 * work lands on the new account.
 *
 * Every wait here polls for the OUTCOME rather than sleeping a fixed time.
 * Under software rendering (swiftshader) the main thread is busy enough that a
 * fixed 2.5s wait fires before the claim finishes, which reads as a broken
 * feature when the feature is merely slow.
 */
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';

// Self-contained, like e2e-verify.mjs: it boots its own server on memory repos
// rather than assuming one is already listening. Needing a second terminal is
// how a check meant to run after every deploy quietly stops being run.
const PORT = 8911;
const B = `http://127.0.0.1:${PORT}`;
const server = spawn(process.execPath, ['--import', 'tsx', 'server/src/server.ts'], {
  env: { ...process.env, PORT: String(PORT), NODE_ENV: 'development', DATABASE_URL: '', RESEND_API_KEY: '' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const serverLog = [];
server.stdout.on('data', (d) => serverLog.push(String(d)));
server.stderr.on('data', (d) => serverLog.push(String(d)));
const stop = () => { try { server.kill(); } catch { /* already gone */ } };
process.on('exit', stop);
let up = false;
for (let i = 0; i < 90; i++) {
  if (await fetch(`${B}/health`).then((r) => r.ok).catch(() => false)) { up = true; break; }
  await new Promise((r) => setTimeout(r, 500));
}
if (!up) {
  // The usual cause is dist/ not being built yet, and the server says so.
  console.error('the server never came up on ' + B + '\n' + serverLog.join(''));
  stop();
  process.exit(1);
}
const browser=await chromium.launch({executablePath:'/opt/pw-browsers/chromium',args:['--use-gl=swiftshader','--enable-unsafe-swiftshader']}).catch(()=>chromium.launch());
const ctx=await browser.newContext({viewport:{width:1400,height:900}});
const page=await ctx.newPage();
const errs=[]; page.on('pageerror',e=>errs.push(String(e.message).slice(0,200)));
const ready=()=>page.waitForFunction(()=>{const s=document.getElementById('stat');return s&&/seats/.test(s.textContent||'');},null,{timeout:90000});
let pass=0,fail=0; const check=(n,ok,x='')=>{(ok?pass++:fail++);console.log(`  ${ok?'PASS':'FAIL'}  ${n}${x?'  '+x:''}`)};
const waitFor=(fn,arg=null,ms=60000)=>page.waitForFunction(fn,arg,{timeout:ms}).then(()=>true).catch(()=>false);
/**
 * Has the open project's draft been written? It is kept compressed in
 * IndexedDB now (src/core/draftStore.ts, performance plan P3.7), or as JSON
 * in localStorage in the old form; asked in the page, which it never changes.
 */
const DRAFT_SAVED = `(async () => {
  const id = new URLSearchParams(location.search).get('local');
  if (!id) return false;
  const key = 'tifo_proj_' + id;
  if (localStorage.getItem(key)) return true;
  return await new Promise((res) => {
    let rq;
    try { rq = indexedDB.open('tifo-drafts', 1); } catch { return res(false); }
    rq.onupgradeneeded = () => rq.transaction.abort();
    rq.onerror = () => res(false);
    rq.onsuccess = () => {
      const db = rq.result;
      if (!db.objectStoreNames.contains('drafts')) { db.close(); return res(false); }
      const q = db.transaction('drafts').objectStore('drafts').count(key);
      q.onsuccess = () => { db.close(); res(q.result > 0); };
      q.onerror = () => { db.close(); res(false); };
    };
  });
})()`;
/** Wait (polling from here: the store answers asynchronously) until the open project's draft is written. */
async function draftSaved(p, ms = 60000) {
  for (const end = Date.now() + ms; Date.now() < end; await p.waitForTimeout(250)) {
    if (await p.evaluate(DRAFT_SAVED).catch(() => false)) return true;
  }
  return false;
}
const paint=()=>page.evaluate(()=>{
  const c=document.querySelector('#canvas-host canvas'); const r=c.getBoundingClientRect();
  const ev=(t,x,y)=>c.dispatchEvent(new PointerEvent(t,{pointerId:1,isPrimary:true,bubbles:true,cancelable:true,composed:true,clientX:x,clientY:y,buttons:t==='pointerup'?0:1,pointerType:'mouse'}));
  const cx=r.left+r.width*0.4, cy=r.top+r.height*0.45;
  ev('pointerdown',cx,cy); for(let i=0;i<25;i++) ev('pointermove',cx+i*4,cy+i*3); ev('pointerup',cx+100,cy+75);
});

const EMAIL = `fan${Date.now()}@example.test`;
// A new project: the editor is always on a project now.
await page.goto(B+'/app?new=1',{waitUntil:'domcontentloaded'}); await ready(); await page.waitForTimeout(900);
await waitFor(()=>/[?&]local=/.test(location.search));
await paint();

// Wait for the debounced autosave to actually be written.
await draftSaved(page);
await page.evaluate(()=>document.getElementById('doc-title').value='Derby night');
await page.evaluate(()=>document.getElementById('save').click());
await page.waitForTimeout(800);
// The offer appears only after a local save succeeded, and from the second one.
await page.evaluate(()=>document.getElementById('save').click());

const offered = await waitFor(()=>{const o=document.getElementById('account-offer');return o&&!o.hidden&&!!o.querySelector('.ao-go');});
check('saving offers an account instead of demanding one', offered);

await page.evaluate(()=>document.querySelector('#account-offer .ao-go')?.click());
await waitFor(()=>!!document.querySelector('.auth-backdrop .auth-form'));
const fields = await page.evaluate(()=>Array.from(document.querySelectorAll('.auth-form .auth-field'))
  .filter(f=>f.offsetParent!==null).map(f=>f.querySelector('input')?.name));
check('sign-up asks for two fields only', fields.length===2, JSON.stringify(fields));
const hasCheckbox = await page.evaluate(()=>!!document.querySelector('.auth-form input[type=checkbox]'));
check('no accept-terms checkbox gate', !hasCheckbox);

await page.evaluate(()=>document.querySelector('.auth-tab[data-mode="signup"]').click());
await waitFor(()=>document.querySelector('.auth-tab[data-mode="signup"]')?.classList.contains('active'));
const termsVisible = await page.evaluate(()=>!document.querySelector('.auth-terms')?.hidden);
check('terms shown as a statement on sign-up', termsVisible);

// evaluate rather than page.fill: fill's actionability polling can take tens of
// seconds while the software renderer hogs the main thread.
await page.evaluate((email)=>{
  const set=(sel,v)=>{const el=document.querySelector(sel);const p=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;p.call(el,v);el.dispatchEvent(new Event('input',{bubbles:true}));};
  set('.auth-form input[name=identity]', email);
  set('.auth-form input[name=password]', 'harbor-kite-moss-31');
  set('.auth-form input[name=confirm]', 'harbor-kite-moss-31');
}, EMAIL);
await page.evaluate(()=>document.querySelector('.auth-form .auth-submit').click());

const modalGone = await waitFor(()=>!document.querySelector('.auth-backdrop'));
check('account created and modal closed', modalGone);

// The interim "Moving your tifo into your account..." also contains "account",
// so assert the FINAL wording, not merely a mention of one.
const claimed = await waitFor(()=>/now in your account/i.test(document.getElementById('message')?.textContent||''));
check('draft was claimed onto the account', claimed,
  JSON.stringify(await page.evaluate(()=>document.getElementById('message')?.textContent)));

// The local project became an account project: the page is on it, and this
// browser no longer holds the local copy.
const gotId = await waitFor(()=>/[?&]project=/.test(location.search) && JSON.parse(localStorage.getItem('tifo_projects_v1')||'[]').length===0);
check('the project is now an account project', gotId,
  String(await page.evaluate(()=>new URLSearchParams(location.search).get('project'))).slice(0,8));

// The design really is on the server.
const mine = await page.evaluate(async ()=>{
  const t=localStorage.getItem('tifo_token_v1');
  const r=await fetch('/api/designs',{headers:t?{authorization:'Bearer '+t}:{}}); return r.ok?(await r.json()).length:-1;
});
check('the design is saved server-side', mine>=1, `designs=${mine}`);

// Sign in with the EMAIL in a clean session.
const page2=await (await browser.newContext()).newPage();
const login = await page2.request.post(B+'/api/auth/login',{data:{username:EMAIL,password:'harbor-kite-moss-31'}});
check('can sign back in with the email', login.status()===200, `status=${login.status()}`);

// A project whose banners cannot be moved yet stays in this browser, whole.
// Moving local projects used to delete them here whether or not their banners
// and layers reached the account (audit round six), and scene saves now have
// a limit of their own, so "not right now" has to mean "next time".
{
  const ctx3 = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const p3 = await ctx3.newPage();
  p3.on('pageerror', (e) => errs.push(String(e.message).slice(0, 200)));
  const until = (fn, arg = null, ms = 60000) => p3.waitForFunction(fn, arg, { timeout: ms }).then(() => true).catch(() => false);
  await p3.goto(B + '/app?new=1', { waitUntil: 'domcontentloaded' });
  await p3.waitForFunction(() => /seats/.test(document.getElementById('stat')?.textContent || ''), null, { timeout: 90000 });
  await until(() => /[?&]local=/.test(location.search));
  await draftSaved(p3);
  const localId = await p3.evaluate(() => new URLSearchParams(location.search).get('local'));
  // Leave the editor first (its own autosave writes this key), then give the
  // project a banner of its own, which exists nowhere but this browser.
  await p3.goto(B + '/legal', { waitUntil: 'domcontentloaded' });
  const BANNERS = '{"version":1,"banners":[{"id":"r6-banner"}]}';
  await p3.evaluate(([id, b]) => localStorage.setItem(`tifo_proj_${id}_banners`, b), [localId, BANNERS]);
  const reg = await p3.request.post(B + '/api/auth/register', { data: { username: `mover${Date.now() % 1e8}`, password: 'harbor-kite-moss-31', email: `mover${Date.now()}@example.test`, acceptedVersion: 'test' } });
  const tok = (await reg.json()).token;
  await p3.evaluate((t) => localStorage.setItem('tifo_token_v1', t), tok);
  const accountDesigns = () => p3.request.get(B + '/api/designs', { headers: { authorization: 'Bearer ' + tok } }).then((r) => r.json());

  // The server is busy for scene saves (503 on both tries).
  let refused = 0;
  await p3.route('**/api/designs/*/scene', (route) => {
    if (route.request().method() !== 'PUT') return route.continue();
    refused++;
    return route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"internal error"}' });
  });
  // The page moves local projects first, then lists the account's.
  const listed = p3.waitForResponse((r) => r.url().includes('/api/projects'), { timeout: 120000 }).catch(() => null);
  await p3.goto(B + '/projects', { waitUntil: 'domcontentloaded' });
  await listed;
  const stillLocal = await p3.evaluate((id) => JSON.parse(localStorage.getItem('tifo_projects_v1') || '[]').some((p) => p.id === id) && !!localStorage.getItem(`tifo_proj_${id}_banners`), localId);
  check('a project whose banners could not move stays in this browser', refused > 0 && stillLocal, `scene PUTs refused=${refused}`);
  check('and no half copy is left in the account', (await accountDesigns()).length === 0, JSON.stringify(await accountDesigns()).slice(0, 120));

  // Next visit, the server takes it: the project moves, banners included.
  await p3.unroute('**/api/designs/*/scene');
  const listedAgain = p3.waitForResponse((r) => r.url().includes('/api/projects'), { timeout: 120000 }).catch(() => null);
  await p3.goto(B + '/projects', { waitUntil: 'domcontentloaded' });
  await listedAgain;
  const moved = await until(() => JSON.parse(localStorage.getItem('tifo_projects_v1') || '[]').length === 0, null, 30000);
  const mineNow = await accountDesigns();
  const scene = mineNow.length ? await p3.request.get(B + `/api/designs/${mineNow[0].id}/scene`, { headers: { authorization: 'Bearer ' + tok } }).then((r) => r.json()) : null;
  const banners = scene?.sceneGzB64
    ? JSON.parse((await import('node:zlib')).gunzipSync(Buffer.from(scene.sceneGzB64, 'base64')).toString()).banners
    : null;
  check('and moves on the next visit, banners included', moved && mineNow.length === 1 && JSON.stringify(banners) === BANNERS, JSON.stringify(banners));
  await ctx3.close();
}

/** A fresh browser with one local project in it, signed in to a new account. */
async function localProjectSignedIn(tag, bannersRaw) {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const pg = await ctx.newPage();
  pg.on('pageerror', (e) => errs.push(String(e.message).slice(0, 200)));
  await pg.goto(B + '/app?new=1', { waitUntil: 'domcontentloaded' });
  await pg.waitForFunction(() => /seats/.test(document.getElementById('stat')?.textContent || ''), null, { timeout: 90000 });
  await draftSaved(pg);
  const id = await pg.evaluate(() => new URLSearchParams(location.search).get('local'));
  await pg.goto(B + '/legal', { waitUntil: 'domcontentloaded' });
  await pg.evaluate(([i, b]) => localStorage.setItem(`tifo_proj_${i}_banners`, b), [id, bannersRaw]);
  const stamp = `${tag}${Date.now() % 1e8}`;
  const reg = await pg.request.post(B + '/api/auth/register', { data: { username: stamp, password: 'harbor-kite-moss-31', email: `${stamp}@example.test`, acceptedVersion: 'test' } });
  const tok = (await reg.json()).token;
  await pg.evaluate((t) => localStorage.setItem('tifo_token_v1', t), tok);
  const designs = () => pg.request.get(B + '/api/designs', { headers: { authorization: 'Bearer ' + tok } }).then((r) => r.json());
  const visitProjects = async () => {
    const listedP = pg.waitForResponse((r) => r.url().includes('/api/projects'), { timeout: 120000 }).catch(() => null);
    await pg.goto(B + '/projects', { waitUntil: 'domcontentloaded' });
    await listedP;
  };
  const isLocal = () => pg.evaluate((i) => JSON.parse(localStorage.getItem('tifo_projects_v1') || '[]').some((p) => p.id === i), id);
  return { ctx, pg, id, designs, visitProjects, isLocal };
}

// The copy could not be taken back out either (offline): the next visit removes
// it first instead of leaving a duplicate in the account.
{
  const BANNERS = '{"version":1,"banners":[{"id":"r6-orphan"}]}';
  const t = await localProjectSignedIn('orphan', BANNERS);
  await t.pg.route('**/api/designs/*/scene', (route) => route.request().method() === 'PUT' ? route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"internal error"}' }) : route.continue());
  await t.pg.route('**/api/designs/*', (route) => route.request().method() === 'DELETE' ? route.abort('failed') : route.continue());
  await t.pg.route('**/api/designs/*?permanent=1', (route) => route.abort('failed'));
  await t.visitProjects();
  const leftOver = (await t.designs()).length;
  check('a copy that could not be removed is remembered', (await t.isLocal()) && leftOver === 1 && !!(await t.pg.evaluate((i) => localStorage.getItem(`tifo_proj_${i}_orphan`), t.id)), `account=${leftOver}`);
  await t.pg.unrouteAll();
  await t.visitProjects();
  const after = await t.designs();
  check('and is removed before the project moves, so there is one copy', !(await t.isLocal()) && after.length === 1, `account=${after.length}`);
  await t.ctx.close();
}

// Banners the server will never take (too large even alone) keep the project
// here, and it is not copied again on every visit until they change.
{
  const t = await localProjectSignedIn('held', '{"version":1,"banners":[{"id":"r6-held"}]}');
  let puts = 0;
  await t.pg.route('**/api/designs/*/scene', (route) => {
    if (route.request().method() !== 'PUT') return route.continue();
    puts++;
    return route.fulfill({ status: 413, contentType: 'application/json', body: '{"error":"Request body is too large"}' });
  });
  await t.visitProjects();
  const putsFirst = puts;
  const firstCopies = (await t.designs()).length;
  await t.visitProjects();
  check('banners the server never takes keep the project here, and it is not copied again', (await t.isLocal()) && firstCopies === 0 && (await t.designs()).length === 0 && putsFirst > 0 && puts === putsFirst, `puts=${putsFirst}->${puts} copies=${firstCopies}`);
  await t.pg.unrouteAll();
  await t.pg.evaluate((i) => localStorage.setItem(`tifo_proj_${i}_banners`, '{"version":1,"banners":[{"id":"r6-held-smaller"}]}'), t.id);
  await t.visitProjects();
  check('and it moves once its banners change', !(await t.isLocal()) && (await t.designs()).length === 1);
  await t.ctx.close();
}

// A banners record this browser cannot read moves as no banners, as it always did.
{
  const t = await localProjectSignedIn('badbanners', '{not json');
  await t.visitProjects();
  const after = await t.designs();
  check('a project with unreadable banners still moves, once', !(await t.isLocal()) && after.length === 1, `account=${after.length}`);
  await t.ctx.close();
}

console.log(`\n  ${pass} passed, ${fail} failed`);
console.log('  pageerrors:', errs.length?errs:'none');
await browser.close(); stop(); process.exit(fail?1:0);
