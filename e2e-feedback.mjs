/** The feedback path, driven the way a person would. */
import { chromium } from 'playwright';
const B='http://127.0.0.1:8911';
const browser=await chromium.launch({executablePath:'/opt/pw-browsers/chromium',args:['--use-gl=swiftshader','--enable-unsafe-swiftshader']}).catch(()=>chromium.launch());
const UA='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const ctx=await browser.newContext({viewport:{width:1280,height:900},userAgent:UA});
const page=await ctx.newPage();
const errs=[]; page.on('pageerror',e=>errs.push(String(e.message).slice(0,200)));
let pass=0,fail=0; const check=(n,ok,x='')=>{(ok?pass++:fail++);console.log(`  ${ok?'PASS':'FAIL'}  ${n}${x?'  '+x:''}`)};
const waitFor=(fn,arg=null,ms=30000)=>page.waitForFunction(fn,arg,{timeout:ms}).then(()=>true).catch(()=>false);
const setVal=(sel,v)=>page.evaluate(([s,val])=>{const el=document.querySelector(s);
  const proto=el.tagName==='TEXTAREA'?HTMLTextAreaElement:HTMLInputElement;
  Object.getOwnPropertyDescriptor(proto.prototype,'value').set.call(el,val);
  el.dispatchEvent(new Event('input',{bubbles:true}));},[sel,v]);

// --- reachable from a public page without an account ---
await page.goto(B+'/',{waitUntil:'domcontentloaded'});
await page.waitForTimeout(1200);
check('a visitor can reach it without an account', await page.evaluate(()=>!!document.getElementById('foot-feedback')));
await page.evaluate(()=>document.getElementById('foot-feedback').click());
check('the form opens', await waitFor(()=>!!document.querySelector('.fb-backdrop')));

// --- it shows what it will attach, and that is real ---
const shown = await page.evaluate(()=>document.querySelector('.fb-ctx-line')?.textContent||'');
check('it states the diagnostics before sending', /Chrome/.test(shown) && /Windows/.test(shown), JSON.stringify(shown));
check('a honeypot field exists but is off-screen', await page.evaluate(()=>{
  const hp=document.getElementById('fb-website'); if(!hp) return false;
  return hp.getBoundingClientRect().left < -1000;
}));

// --- the time-trap must not punish a real person ---
await page.evaluate(()=>document.querySelector('.fb-kind[data-kind="bug"]').click());
check('choosing "something broke" reveals the reproduction box', await page.evaluate(()=>!document.querySelector('.fb-steps-wrap').hidden));
await page.evaluate(()=>document.querySelector('.fb-kind[data-kind="idea"]').click());
check('and an idea does not ask for reproduction steps', await page.evaluate(()=>document.querySelector('.fb-steps-wrap').hidden));

await page.evaluate(()=>document.querySelector('.fb-kind[data-kind="bug"]').click());
await setVal('#fb-message','The save button does nothing on my phone');
await setVal('#fb-steps','painted the north stand then pressed save');
// Short messages are refused before anything is sent.
await setVal('#fb-message','no');
await page.evaluate(()=>document.querySelector('.fb-send').click());
check('a too-short message is refused in the form', await waitFor(()=>{
  const e=document.querySelector('.fb-error'); return e && !e.hidden;}));

await setVal('#fb-message','The save button does nothing on my phone');
await page.waitForTimeout(2200);   // clear the two-second trap like a human would
await page.evaluate(()=>document.querySelector('.fb-send').click());
check('a real report is accepted', await waitFor(()=>!!document.querySelector('.fb-done')));

// --- and it actually arrived, with the right shape ---
const stored = await page.evaluate(async ()=>{
  const r = await fetch('/api/feedback', {method:'POST',headers:{'content-type':'application/json'},
    body: JSON.stringify({kind:'bug',message:'instant bot submission',elapsedMs:30})});
  return r.status;
});
check('an instant submission is silently dropped', stored===200, `status=${stored}`);

console.log(`\n  ${pass} passed, ${fail} failed`);
console.log('  pageerrors:', errs.length?errs:'none');
await browser.close(); process.exit(fail?1:0);
