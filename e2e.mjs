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

// The bug that starved every number below it: Save sat ~580px under the fold in
// a side panel, so most people who painted never saw it. Check the sizes real
// visitors actually use, including a phone.
for (const vp of [{width:1366,height:768},{width:1920,height:1080},{width:390,height:844}]) {
  await page.setViewportSize(vp);
  await page.waitForTimeout(400);
  const r = await page.evaluate(()=>{
    const b=document.getElementById('save-top');
    if(!b) return null;
    const q=b.getBoundingClientRect();
    return {onScreen:q.top>=0&&q.bottom<=innerHeight&&q.left>=0&&q.right<=innerWidth,
            top:Math.round(q.top), w:Math.round(q.width), h:Math.round(q.height)};
  });
  check(`Save is on screen at ${vp.width}x${vp.height}`, !!r && r.onScreen, JSON.stringify(r));
  // Comfortable-target guidance is ~44px; a 56px header caps that, so 36 is the
  // floor worth holding. Anything near 27 is a miss waiting to happen.
  check(`Save is a real tap target at ${vp.width}x${vp.height}`, !!r && r.h>=36 && r.w>=36, r?`${r.w}x${r.h}`:'missing');
  // A bounding-box-inside-the-viewport check passed while the header children
  // were overlapping each other, with Save painted over the "Split" tab. Boxes
  // being on screen is not the same as a layout that works.
  const clash = await page.evaluate(()=>{
    const ids=['doc-title','save-top','lang-toggle','signin','avatar','view-2d','view-3d','view-split'];
    const boxes=ids.map(id=>{const e=document.getElementById(id); if(!e) return null;
      const r=e.getBoundingClientRect(); return r.width>0&&r.height>0?{id,r}:null;}).filter(Boolean);
    const hits=[];
    for(let i=0;i<boxes.length;i++) for(let j=i+1;j<boxes.length;j++){
      const a=boxes[i].r,b=boxes[j].r;
      const ov=Math.max(0,Math.min(a.right,b.right)-Math.max(a.left,b.left))
             * Math.max(0,Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top));
      if(ov>16) hits.push(`${boxes[i].id}/${boxes[j].id}`);
    }
    return hits;
  });
  check(`header controls do not overlap at ${vp.width}x${vp.height}`, clash.length===0, clash.join(', ')||'clean');
}
await page.setViewportSize({width:1400,height:900});
await page.waitForTimeout(400);

// Save, signed out. Scroll the panel back to the top first: that is the state
// that used to render the offer far below the fold, so the in-view assertion
// below is a real guard rather than one the layout satisfies by luck.
await page.evaluate(()=>{
  const p=document.getElementById('save').closest('.panel'); if(p) p.scrollTop=0;
  document.scrollingElement.scrollTop=0;
});
await page.waitForTimeout(300);
await page.evaluate(()=>document.getElementById('save-top').click());
await page.waitForTimeout(1200);
const after = await page.evaluate(()=>({
  msg: document.getElementById('message')?.textContent||'',
  offer: !document.getElementById('account-offer')?.hidden,
  text: (document.getElementById('account-offer')?.innerText||'').replace(/\s+/g,' ').slice(0,110),
}));
check('Save works signed out (no modal, no wall)', /this browser/i.test(after.msg), JSON.stringify(after.msg));
check('account is offered AFTER the save', after.offer, after.text);

// An offer below the fold is the same as no offer: pressing Save without
// scrolling used to leave it ~700px under the viewport.
const offerInView = await page.evaluate(()=>{
  const o=document.getElementById('account-offer'); if(!o||o.hidden) return null;
  const r=o.getBoundingClientRect();
  return {top:Math.round(r.top), bottom:Math.round(r.bottom), vh:innerHeight, inView:r.top>=0 && r.bottom<=innerHeight};
});
check('the offer is scrolled into view', !!offerInView?.inView, JSON.stringify(offerInView));

// Dismissible without consequence.
await page.evaluate(()=>document.querySelector('#account-offer .ao-dismiss')?.click());
await page.waitForTimeout(300);
check('offer can be dismissed', await page.evaluate(()=>document.getElementById('account-offer')?.hidden===true));
check('work still kept after dismissing', !!(await sig()));

console.log(`\n  ${pass} passed, ${fail} failed`);
console.log('  pageerrors:', errs.length?errs:'none');
await browser.close();
process.exit(fail?1:0);
