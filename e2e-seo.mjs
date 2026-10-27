/**
 * Discoverability: what a crawler gets from /community, and what a human gets
 * a moment later. The two must not be the same list rendered twice.
 */
import { chromium } from 'playwright';
import { gzipSync } from 'node:zlib';
const B='http://127.0.0.1:8911';
const browser=await chromium.launch({executablePath:'/opt/pw-browsers/chromium',args:['--use-gl=swiftshader','--enable-unsafe-swiftshader']}).catch(()=>chromium.launch());
const UA='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const ctx=await browser.newContext({viewport:{width:1280,height:900},userAgent:UA});
const page=await ctx.newPage();
const errs=[]; page.on('pageerror',e=>errs.push(String(e.message).slice(0,200)));
let pass=0,fail=0; const check=(n,ok,x='')=>{(ok?pass++:fail++);console.log(`  ${ok?'PASS':'FAIL'}  ${n}${x?'  '+x:''}`)};

const U='ultra'+Date.now().toString(36);
// A password the policy accepts. This was 'hunter22pass', which the password
// policy now refuses as too common — so registration failed, no design was
// ever created, and five checks below failed for a reason none of them named.
const PW='harbor-kite-moss-31';
const reg=await page.request.post(B+'/api/auth/register',{data:{username:U,password:PW,email:U+'@example.test',acceptedVersion:'2025-01-01'}});
if(!reg.ok()) throw new Error(`could not register the test account: ${reg.status()} ${await reg.text()}`);
const H={authorization:'Bearer '+(await reg.json()).token,'content-type':'application/json'};
const tpl=(await (await page.request.get(B+'/api/templates')).json())[0];
const cells=new Uint8Array(tpl.seatCount); for(let i=0;i<cells.length;i++) cells[i]=i%4;
const cellsGzB64=gzipSync(Buffer.from(cells)).toString('base64');
const PALETTE=['#262a33','#1c5fd9','#f2f1ec','#e8b73a'];
const mk=async(title)=>{
  const r=await page.request.post(B+'/api/designs',{headers:H,data:{title,templateId:tpl.id,templateVersion:tpl.version,palette:PALETTE,cellsGzB64}});
  const d=await r.json();
  await page.request.patch(B+`/api/designs/${d.id}`,{headers:H,data:{isPublic:true}});
  return d;
};
const TAG=Date.now().toString(36);
const NAME_A=`Riyadh derby ${TAG}`, NAME_B=`North stand mosaic ${TAG}`;
const a=await mk(NAME_A); const b=await mk(NAME_B);

// --- what a crawler sees, before any JavaScript ---
const raw=await (await page.request.get(B+'/community')).text();
const body=raw.split(/<body[^>]*>/i)[1]||'';
const designLinks=(body.match(/href="\/t\/[^"]*"/g)||[]);
check('the feed ships real design links', designLinks.length>=2, `${designLinks.length} links`);
check('anchor text names the design', body.includes(NAME_A) && body.includes(NAME_B));
check('links use the canonical /t/ url', !/href="\/d\//.test(body));

// --- a private design must stay out of it ---
const priv=await page.request.post(B+'/api/designs',{headers:H,data:{title:'Secret plan',templateId:tpl.id,templateVersion:tpl.version,palette:PALETTE,cellsGzB64}});
const privId=(await priv.json()).id;
const raw2=await (await page.request.get(B+'/community')).text();
check('a private design is never listed', !raw2.includes(privId) && !raw2.includes('Secret plan'));

// --- descriptions differ per design ---
const desc=async(id)=>{const t=await (await page.request.get(B+`/t/${id}`)).text();return (t.match(/<meta name="description" content="([^"]*)"/i)||[])[1]||'';};
const da=await desc(a.id), db=await desc(b.id);
check('each design describes itself', da!==db && da.length>20, JSON.stringify(da.slice(0,80)));
check('the description names the tifo and its maker', da.includes(NAME_A) && da.includes('@'+U));

// --- the Arabic twins (performance plan P3.3): the same page in each language, each naming both ---
const head = async (path) => (await (await page.request.get(B + path)).text()).split(/<\/head>/i)[0];
const alts = (h) => Object.fromEntries([...h.matchAll(/<link rel="alternate" hreflang="([^"]+)" href="([^"]+)"/g)].map((m) => [m[1], new URL(m[2]).pathname]));
const canon = (h) => { const m = /<link rel="canonical" href="([^"]+)"/.exec(h); return m ? new URL(m[1]).pathname : null; };
for (const [en, ar, canonical] of [['/', '/ar/', true], ['/community', '/ar/community', true], ['/clubs', '/ar/clubs', true], ['/legal', '/ar/legal', true],
                                   ['/app?design=' + a.id, '/ar/app?design=' + a.id, true], [`/t/${a.id}`, `/ar/t/${a.id}`, true], [`/s/${a.id}`, `/ar/s/${a.id}`, true],
                                   ['/reset', '/ar/reset', false], ['/account', '/ar/account', false], ['/projects', '/ar/projects', false]]) {
  const want = { en: en.split('?')[0], ar: ar.split('?')[0], 'x-default': en.split('?')[0] };
  const he = await head(en), ha = await head(ar);
  check(`${en} and ${ar} name each other (hreflang en, ar, x-default)`, JSON.stringify(alts(he)) === JSON.stringify(want) && JSON.stringify(alts(ha)) === JSON.stringify(want), JSON.stringify(alts(ha)));
  if (canonical) check(`${ar}: its canonical is itself, ${en}: itself`, canon(he) === want.en && canon(ha) === want.ar, `${canon(he)} / ${canon(ha)}`);
  else check(`${ar}: a noindex page carries no canonical`, canon(he) === null && canon(ha) === null);
}
{
  const hd = await head(`/ar/d/${a.id}`);
  check('/ar/d/:id points at /ar/t/:id', canon(hd) === `/ar/t/${a.id}` && alts(hd).ar === `/ar/t/${a.id}` && alts(hd).en === `/t/${a.id}`, `${canon(hd)}`);
  const ht = await head(`/ar/t/${a.id}`);
  check('the Arabic page describes the design in Arabic, naming it and its maker', /[؀-ۿ]/.test((ht.match(/<meta name="description" content="([^"]*)"/) || [])[1] || '') && ht.includes(NAME_A) && ht.includes('@' + U));
  check('and says it is Arabic', /<html[^>]*lang="ar"[^>]*dir="rtl"/.test(ht) && ht.includes('og:locale" content="ar_AR"'));
  const feedAr = await (await page.request.get(B + '/ar/community')).text();
  const arBody = feedAr.split(/<body[^>]*>/i)[1] || '';
  check('the Arabic feed links the Arabic design pages', arBody.includes(`href="/ar/t/${a.id}"`) && !/href="\/t\//.test(arBody));
  check('and never a private design', !feedAr.includes(privId) && !feedAr.includes('Secret plan'));
  check('the tifo-spec has no Arabic twin (it is English only)', (await page.request.get(B + '/ar/tifo-spec')).status() === 404 && alts(await head('/tifo-spec')).ar === undefined);
  const sm = await (await page.request.get(B + '/sitemap.xml')).text();
  check('the sitemap declares the xhtml namespace', sm.includes('xmlns:xhtml="http://www.w3.org/1999/xhtml"'));
  const entry = (p) => sm.split('<url>').find((u) => u.includes(`<loc>${B}${p}</loc>`)) || '';
  for (const p of ['/', '/ar/', '/community', '/ar/community', `/t/${a.id}`, `/ar/t/${a.id}`]) {
    const e = entry(p);
    const l = Object.fromEntries([...e.matchAll(/<xhtml:link rel="alternate" hreflang="([^"]+)" href="([^"]+)"\/>/g)].map((m) => [m[1], new URL(m[2]).pathname]));
    const base = p.replace(/^\/ar(?=\/)/, '') || '/';
    check(`sitemap: ${p} is listed with en, ar and x-default`, e && l.en === base && l.ar === (base === '/' ? '/ar/' : '/ar' + base) && l['x-default'] === base, JSON.stringify(l));
  }
  check('sitemap: never a private design', !sm.includes(privId));
}

// --- and a human does not see the list twice ---
await page.goto(B+'/community',{waitUntil:'domcontentloaded'});
await page.waitForFunction(()=>document.querySelectorAll('#gallery-grid .tifo-card').length>0,{timeout:30000}).catch(()=>{});
const after=await page.evaluate((NAME)=>({
  seoListStillThere: !!document.getElementById('seo-feed'),
  cards: document.querySelectorAll('#gallery-grid .tifo-card').length,
  titlesOnScreen: document.body.innerText.split(NAME).length - 1,
}), NAME_A);
check('the crawler list is removed once the grid renders', !after.seoListStillThere);
check('the interactive grid took over', after.cards>=2, `${after.cards} cards`);
check('no design is shown twice', after.titlesOnScreen===1, `"${NAME_A}" x${after.titlesOnScreen}`);

// --- the publish dialog must ask for a name, so nothing ships as "Untitled tifo" ---
await page.goto(B+'/app?new=1',{waitUntil:'domcontentloaded'});
await page.waitForFunction(()=>{const s=document.getElementById('stat');return s&&/seats/.test(s.textContent||'');},null,{timeout:90000});
await page.waitForTimeout(1200);
// Sign in as the same account the designs belong to.
await page.evaluate(([t])=>localStorage.setItem('tifo_token_v1',t), [ (await (await page.request.post(B+'/api/auth/login',{data:{username:U,password:PW}})).json()).token ]);
await page.reload({waitUntil:'domcontentloaded'});
await page.waitForFunction(()=>{const s=document.getElementById('stat');return s&&/seats/.test(s.textContent||'');},null,{timeout:90000});
await page.waitForTimeout(1500);

await page.evaluate(()=>{ document.getElementById('doc-title').value=''; document.getElementById('publish-design').click(); });
const dialogUp = await page.waitForFunction(()=>!!document.querySelector('#pub-title'),null,{timeout:45000}).then(()=>true).catch(()=>false);
check('publish asks for a name', dialogUp);
if (dialogUp){
  const prefill = await page.evaluate(()=>document.querySelector('#pub-title').value);
  check('the name is prefilled, not blank', prefill.length>0, JSON.stringify(prefill));
  await page.evaluate(()=>{
    const el=document.querySelector('#pub-title');
    const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;
    set.call(el,'Kop wall of flame'); el.dispatchEvent(new Event('input',{bubbles:true}));
    document.querySelector('.pub-go').click();
  });
  const named = await page.waitForFunction(()=>document.getElementById('doc-title')?.value==='Kop wall of flame',null,{timeout:60000}).then(()=>true).catch(()=>false);
  check('the chosen name is applied to the design', named,
    JSON.stringify(await page.evaluate(()=>document.getElementById('doc-title')?.value)));
}

// --- launch checks (26 Oct 2026, from isreadyforlaunch.com's report on the home page) ---
// A description that fits a search result, robots that allow big previews, a
// web app manifest, schema.org data that parses, and pictures that say what
// they show — in both languages.
for (const [path, lang] of [['/', 'en'], ['/ar/', 'ar']]) {
  const html = await (await page.request.get(B + path)).text();
  const h = html.split(/<\/head>/i)[0];
  const d = (h.match(/<meta name="description" content="([^"]*)"/i) || [])[1] || '';
  check(`${path}: the description fits a search result (80-160 characters)`, d.length >= 80 && d.length <= 160, `${d.length}`);
  check(`${path}: and is in the page's language`, lang === 'ar' ? /[؀-ۿ]/.test(d) : !/[؀-ۿ]/.test(d), d.slice(0, 60));
  check(`${path}: robots allow indexing and large previews`, /<meta name="robots" content="index,follow,max-image-preview:large"/i.test(h));
  check(`${path}: the web app manifest is linked`, /<link rel="manifest" href="\/manifest\.webmanifest"/i.test(h));
  const ld = [...h.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/gi)].map((m) => { try { return JSON.parse(m[1]); } catch { return null; } });
  const types = ld.flatMap((x) => (x?.['@graph'] ?? [x]).map((g) => g?.['@type']));
  check(`${path}: schema.org data parses and names the site, the organisation and the app`, ld.length >= 1 && ld.every(Boolean) && ['WebSite', 'Organization', 'WebApplication'].every((t) => types.includes(t)), JSON.stringify(types));
  const hero = (html.match(/<img class="hero-still"[^>]*>/i) || [''])[0];
  const alt = (hero.match(/\salt="([^"]*)"/) || [])[1] || '';
  check(`${path}: the hero picture says what it shows`, alt.length > 10 && (lang === 'ar' ? /[؀-ۿ]/.test(alt) : /tifo/i.test(alt)), alt);
  const noAlt = (html.match(/<img\b(?![^>]*\salt=)[^>]*>/gi) || []);
  check(`${path}: every picture has an alt (empty only for decoration)`, noAlt.length === 0, noAlt.slice(0, 2).join(' '));
}
{
  const r = await page.request.get(B + '/manifest.webmanifest');
  let m = null;
  try { m = JSON.parse(await r.text()); } catch { /* */ }
  check('the manifest is served as a manifest', r.ok() && /application\/manifest\+json/.test(r.headers()['content-type'] || ''), r.headers()['content-type']);
  const icons = m?.icons ?? [];
  const okIcons = [];
  for (const i of icons) { const ir = await page.request.get(B + i.src); if (ir.ok() && /image\/png/.test(ir.headers()['content-type'] || '')) okIcons.push(i.sizes); }
  check('it names the app, opens on the projects, and its 192 and 512 icons are there', m?.name === 'TifoMaker' && m?.start_url === '/projects' && m?.display === 'standalone' && okIcons.includes('192x192') && okIcons.includes('512x512'), JSON.stringify({ name: m?.name, start: m?.start_url, okIcons }));
}

console.log(`\n  ${pass} passed, ${fail} failed`);
console.log('  pageerrors:', errs.length?errs:'none');
await browser.close(); process.exit(fail?1:0);
