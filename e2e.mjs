import { chromium } from 'playwright';
const B='http://127.0.0.1:8911';
const browser=await chromium.launch({executablePath:'/opt/pw-browsers/chromium',args:['--use-gl=swiftshader','--enable-unsafe-swiftshader']}).catch(()=>chromium.launch());
const page=await (await browser.newContext({viewport:{width:1400,height:900}})).newPage();
const errs=[]; page.on('pageerror',e=>errs.push(String(e.message).slice(0,200)));
const ready=()=>page.waitForFunction(()=>{const s=document.getElementById('stat');return s&&/seats/.test(s.textContent||'');},{timeout:45000});
const sig=()=>page.evaluate(()=>{const r=localStorage.getItem('tifo_draft_v1');if(!r)return null;const d=JSON.parse(r);
  const rle=d.doc?.layers?.[0]?.cellsRle??[];
  return {runs:rle.length, head:JSON.stringify(rle.slice(0,3)), title:d.title, designId:d.designId, kb:Math.round(r.length*2/1024)};});

let pass=0, fail=0;
const check=(name,ok,extra='')=>{ (ok?pass++:fail++); console.log(`  ${ok?'PASS':'FAIL'}  ${name}${extra?'  '+extra:''}`); };

await page.goto(B+'/app',{waitUntil:'domcontentloaded'}); await ready(); await page.waitForTimeout(1000);
check('no draft on a first visit', await page.evaluate(()=>!localStorage.getItem('tifo_draft_v1')));

// Paint with real pointer events (Pixi listens for these, not synthetic mouse).
await page.evaluate(()=>{
  const c=document.querySelector('#canvas-host canvas'); const r=c.getBoundingClientRect();
  const ev=(type,x,y)=>c.dispatchEvent(new PointerEvent(type,{pointerId:1,isPrimary:true,bubbles:true,
    cancelable:true,composed:true,clientX:x,clientY:y,buttons:type==='pointerup'?0:1,pointerType:'mouse'}));
  const cx=r.left+r.width*0.4, cy=r.top+r.height*0.4;
  ev('pointerdown',cx,cy);
  for(let i=0;i<25;i++) ev('pointermove',cx+i*4,cy+i*3);
  ev('pointerup',cx+100,cy+75);
});
await page.waitForTimeout(3000);
const a = await sig();
check('painting writes a draft', !!a, a?`${a.runs} runs, ${a.kb}KB`:'');

const state = await page.evaluate(()=>document.getElementById('draft-state')?.textContent||'');
check('saved-state says "this browser", not "saved"', /this browser/i.test(state), JSON.stringify(state));

// Reload: the whole point.
await page.reload({waitUntil:'domcontentloaded'}); await ready(); await page.waitForTimeout(1500);
const b = await sig();
check('draft survives a reload', !!b && b.head===a.head, b?`${b.runs} runs`:'');
const msg = await page.evaluate(()=>document.getElementById('message')?.textContent||'');
check('user is told their work came back', /restored/i.test(msg), JSON.stringify(msg));

// Save, signed out.
await page.evaluate(()=>document.getElementById('save').click());
await page.waitForTimeout(1200);
const after = await page.evaluate(()=>({
  msg: document.getElementById('message')?.textContent||'',
  offer: !document.getElementById('account-offer')?.hidden,
  text: (document.getElementById('account-offer')?.innerText||'').replace(/\s+/g,' ').slice(0,110),
}));
check('Save works signed out (no modal, no wall)', /this browser/i.test(after.msg), JSON.stringify(after.msg));
check('account is offered AFTER the save', after.offer, after.text);

// Dismissible without consequence.
await page.evaluate(()=>document.querySelector('#account-offer .ao-dismiss')?.click());
await page.waitForTimeout(300);
check('offer can be dismissed', await page.evaluate(()=>document.getElementById('account-offer')?.hidden===true));
check('work still kept after dismissing', !!(await sig()));

console.log(`\n  ${pass} passed, ${fail} failed`);
console.log('  pageerrors:', errs.length?errs:'none');
await browser.close();
process.exit(fail?1:0);
