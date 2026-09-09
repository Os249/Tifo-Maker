/**
 * The claim path: paint -> save (local) -> take the offer -> sign up -> the
 * work lands on the new account.
 *
 * Every wait here polls for the OUTCOME rather than sleeping a fixed time.
 * Under software rendering (swiftshader) the main thread is busy enough that a
 * fixed 2.5s wait fires before the claim finishes, which reads as a broken
 * feature when the feature is merely slow.
 */
import { chromium } from 'playwright';
const B='http://127.0.0.1:8911';
const browser=await chromium.launch({executablePath:'/opt/pw-browsers/chromium',args:['--use-gl=swiftshader','--enable-unsafe-swiftshader']}).catch(()=>chromium.launch());
const ctx=await browser.newContext({viewport:{width:1400,height:900}});
const page=await ctx.newPage();
const errs=[]; page.on('pageerror',e=>errs.push(String(e.message).slice(0,200)));
const ready=()=>page.waitForFunction(()=>{const s=document.getElementById('stat');return s&&/seats/.test(s.textContent||'');},null,{timeout:90000});
let pass=0,fail=0; const check=(n,ok,x='')=>{(ok?pass++:fail++);console.log(`  ${ok?'PASS':'FAIL'}  ${n}${x?'  '+x:''}`)};
const waitFor=(fn,arg=null,ms=60000)=>page.waitForFunction(fn,arg,{timeout:ms}).then(()=>true).catch(()=>false);
const paint=()=>page.evaluate(()=>{
  const c=document.querySelector('#canvas-host canvas'); const r=c.getBoundingClientRect();
  const ev=(t,x,y)=>c.dispatchEvent(new PointerEvent(t,{pointerId:1,isPrimary:true,bubbles:true,cancelable:true,composed:true,clientX:x,clientY:y,buttons:t==='pointerup'?0:1,pointerType:'mouse'}));
  const cx=r.left+r.width*0.4, cy=r.top+r.height*0.45;
  ev('pointerdown',cx,cy); for(let i=0;i<25;i++) ev('pointermove',cx+i*4,cy+i*3); ev('pointerup',cx+100,cy+75);
});

const EMAIL = `fan${Date.now()}@example.test`;
await page.goto(B+'/app',{waitUntil:'domcontentloaded'}); await ready(); await page.waitForTimeout(900);
await paint();

// Wait for the debounced draft to actually hit localStorage.
await waitFor(()=>!!localStorage.getItem('tifo_draft_v1'));
await page.evaluate(()=>document.getElementById('doc-title').value='Derby night');
await page.evaluate(()=>document.getElementById('save').click());

// The offer appears only after a local save succeeded.
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
  set('.auth-form input[name=password]', 'hunter22pass');
}, EMAIL);
await page.evaluate(()=>document.querySelector('.auth-form .auth-submit').click());

const modalGone = await waitFor(()=>!document.querySelector('.auth-backdrop'));
check('account created and modal closed', modalGone);

// The interim "Moving your tifo into your account..." also contains "account",
// so assert the FINAL wording, not merely a mention of one.
const claimed = await waitFor(()=>/now in your account/i.test(document.getElementById('message')?.textContent||''));
check('draft was claimed onto the account', claimed,
  JSON.stringify(await page.evaluate(()=>document.getElementById('message')?.textContent)));

const gotId = await waitFor(()=>!!JSON.parse(localStorage.getItem('tifo_draft_v1')||'{}').designId);
check('draft now carries the account design id', gotId,
  String(await page.evaluate(()=>JSON.parse(localStorage.getItem('tifo_draft_v1')||'{}').designId)).slice(0,8));

// The design really is on the server.
const mine = await page.evaluate(async ()=>{
  const t=localStorage.getItem('tifo_token_v1');
  const r=await fetch('/api/designs',{headers:t?{authorization:'Bearer '+t}:{}}); return r.ok?(await r.json()).length:-1;
});
check('the design is saved server-side', mine>=1, `designs=${mine}`);

// Sign in with the EMAIL in a clean session.
const page2=await (await browser.newContext()).newPage();
const login = await page2.request.post(B+'/api/auth/login',{data:{username:EMAIL,password:'hunter22pass'}});
check('can sign back in with the email', login.status()===200, `status=${login.status()}`);

console.log(`\n  ${pass} passed, ${fail} failed`);
console.log('  pageerrors:', errs.length?errs:'none');
await browser.close(); process.exit(fail?1:0);
