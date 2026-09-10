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
const reg=await page.request.post(B+'/api/auth/register',{data:{username:U,password:'hunter22pass',email:U+'@example.test',acceptedVersion:'2025-01-01'}});
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
await page.goto(B+'/app',{waitUntil:'domcontentloaded'});
await page.waitForFunction(()=>{const s=document.getElementById('stat');return s&&/seats/.test(s.textContent||'');},null,{timeout:90000});
await page.waitForTimeout(1200);
// Sign in as the same account the designs belong to.
await page.evaluate(([t])=>localStorage.setItem('tifo_token_v1',t), [ (await (await page.request.post(B+'/api/auth/login',{data:{username:U,password:'hunter22pass'}})).json()).token ]);
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

console.log(`\n  ${pass} passed, ${fail} failed`);
console.log('  pageerrors:', errs.length?errs:'none');
await browser.close(); process.exit(fail?1:0);
