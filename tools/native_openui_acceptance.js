/* Actual production page, OpenUI parser/Renderer, iframe CSP and local recomputation.
   Provider answers and Wikimedia API/image bytes are explicitly fixtures, never model proof. */
'use strict';
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process'),assert=require('node:assert/strict');
const {chromium}=require('playwright');
const args=process.argv.slice(2),option=n=>args.includes(n)?args[args.indexOf(n)+1]:null;
const root=path.resolve(option('--root')||path.join(__dirname,'..')),report=option('--report'),screens=option('--screenshots');
const app='https://jarvis-openui.invalid',fixtures=JSON.parse(fs.readFileSync(path.join(root,'tests/fixtures/openui-lang.json')));
const productionPage=JSON.parse(cp.execFileSync('python3',['tests/page_policy.py'],{cwd:root,encoding:'utf8'}));
const runtime=JSON.parse(cp.execFileSync('python3',['-c',`import json,response_openui as o;h,headers=o.document('${app}');print(json.dumps({'html':h,'headers':headers}))`],{cwd:root,encoding:'utf8',maxBuffer:8*1024*1024}));
const receipt={id:'editable-inputs',rows:[],credit:'Calculated locally from your supplied figures; recorded this turn: 2026-10-24T12:00:00Z'};
const meta='// jarvis-context: '+Buffer.from(JSON.stringify([receipt])).toString('base64')+'\n';
const answer=f=>f.prose+'\n\n```openui\n'+meta+f.code+'```\n';
const photoEvidence=option('--photo-evidence')?JSON.parse(fs.readFileSync(option('--photo-evidence'))).results:[];
const checks=[],requests=[],diagnostics=[];let browser;
async function check(name,fn){try{const detail=await fn();checks.push({name,status:'PASS',detail});console.log('PASS '+name);}catch(e){checks.push({name,status:'FAIL',detail:e.stack});console.error('FAIL '+name+': '+e.message);}}
async function pageAt(width,theme='dark'){
 const context=await browser.newContext({viewport:{width,height:1000},colorScheme:theme,hasTouch:true});
 await context.route('**/*',async route=>{const req=route.request(),url=new URL(req.url());requests.push({method:req.method(),path:url.pathname,origin:url.origin});
   if(req.method()!=='GET')return route.fulfill({status:403,body:'No writes in this offline test'});
   if(['https://upload.wikimedia.org','https://thumb.wikimedia.org'].includes(url.origin)){
     const photo=photoEvidence.find(r=>r.photos?.[0]?.url===req.url()&&r.localFile);return route.fulfill({contentType:photo?'image/jpeg':'image/png',body:fs.readFileSync(photo?photo.localFile:path.join(root,'tests/fixtures/photo-test.png'))});
   }
   if(url.origin!==app)return route.abort();
   if(url.pathname==='/api/openui/runtime')return route.fulfill({contentType:'text/html',headers:runtime.headers,body:runtime.html});
   if(url.pathname.startsWith('/api/response/context/'))return route.fulfill({json:{ok:true,prefs:{interactive:true,agent:false,data:false,remember:true}}});
   if(url.pathname==='/api/openui/images'){const subject=url.searchParams.get('q'),actual=photoEvidence.find(r=>r.query===subject&&r.localFile);if(actual)return route.fulfill({json:{photos:[actual.photos[0]]}});return route.fulfill({json:{photos:[{url:'https://upload.wikimedia.org/test-photo.png',title:subject,page:'https://commons.wikimedia.org/wiki/File:Fixture',author:'Offline test photographer',license:'CC BY 4.0',licenseUrl:'https://creativecommons.org/licenses/by/4.0/',retrieved:'2026-10-24T12:00:00Z'}]}});}
   if(url.pathname==='/')return route.fulfill({contentType:'text/html',headers:productionPage.headers,body:productionPage.html});
   if(url.pathname.startsWith('/static/')||url.pathname.startsWith('/vendor/')){const file=path.resolve(root,'.'+url.pathname);if(!file.startsWith(root+path.sep)||!fs.existsSync(file))return route.fulfill({status:404,body:''});return route.fulfill({contentType:{'.js':'application/javascript','.css':'text/css','.woff2':'font/woff2'}[path.extname(file)]||'application/octet-stream',body:fs.readFileSync(file)});}
   return route.fulfill({json:{ok:true,sessions:[],turns:[],devices:[],rows:[],ui:{mode:'device',density:'normal',autoplay:false}}});
 });
 const page=await context.newPage();page.on('pageerror',e=>diagnostics.push(e.message));
 await page.goto(app,{waitUntil:'domcontentloaded'});await page.waitForFunction(()=>typeof window.__jarvisDraw==='function'&&window.JarvisOpenUI);
 await page.evaluate(theme=>{document.documentElement.dataset.theme=theme;window.__jarvisMode('text');window.__jarvisModes=()=>({mode:'text'});window.__jarvisConvId=()=> 'd'.repeat(32);},theme);
 return{page,context};
}
async function draw(page,text){await page.evaluate(text=>{const node=window.__jarvisDraw(text);const turn=document.createElement('section');turn.className='turn';turn.dataset.id='f'.repeat(16);node.className='t-a';turn.append(node);document.querySelector('#content').replaceChildren(turn);},text);}
async function frameReady(page){await page.locator('.jr-openui-frame').waitFor({state:'visible'});const f=page.frameLocator('.jr-openui-frame');await f.locator('#openui-root').waitFor();return f;}
async function shot(page,name){if(!screens)return;await page.evaluate(()=>{window.scrollTo(0,0);const c=document.getElementById('content');if(c)c.scrollTop=0;});await page.screenshot({path:path.join(screens,name+'.png'),fullPage:true});}
(async()=>{
 if(screens)fs.mkdirSync(screens,{recursive:true});browser=await chromium.launch({executablePath:option('--browser')||undefined,headless:true,args:['--no-sandbox','--disable-dev-shm-usage','--disable-gpu']});
 await check('all editable fields have explicit names and visible fallback labels under the enforced page CSP',async()=>{
  const{page,context}=await pageAt(320);try{
   const text='Change the figures.\n```openui\n$count = 4\n$rate = 80000\n$discount = 10\n$notes = ""\n$choice = "a"\n$date = "2026-10-24"\nroot = Col([Input($count, null, "number"), Input($rate, "Rate", "number"), Slider($discount, 0, 100), TextArea($notes), Select($choice, ["a", "b"]), DatePicker($date)])\n```';
   await draw(page,text);const f=await frameReady(page);const fields=await f.locator('input,textarea,select').evaluateAll(nodes=>nodes.map(n=>({name:n.getAttribute('aria-label'),id:n.id,labels:[...n.labels].map(l=>l.textContent)})));
   assert.equal(fields.length,6);assert.ok(fields.every(n=>n.name&&n.id&&n.labels.some(l=>l.trim())),JSON.stringify(fields));
   const count=f.locator('input').first();assert.equal(await count.getAttribute('aria-label'),'Count');await count.fill('5');assert.equal(await count.inputValue(),'5');return{fields,enforcedCSP:productionPage.headers['Content-Security-Policy']};
  }finally{await context.close();}
 });
 await check('captured real-model bill mounts and recalculates all three inputs',async()=>{
  const{page,context}=await pageAt(390);try{const captured=JSON.parse(fs.readFileSync(path.join(root,'tests/fixtures/r4-captured.json'))).rows[0];await draw(page,captured.answer);const f=await frameReady(page);await f.getByLabel('Bill (UGX)',{exact:true}).fill('200000');await f.getByLabel('People',{exact:true}).fill('5');await f.getByRole('slider',{name:'Tip',exact:true}).press('Home');await f.getByText(/40,000/).first().waitFor();return{perPerson:40000,scope:'Real r3 model output replay under r4 runtime, not an r4 staging turn'};}finally{await context.close();}
 });
 await check('recovered blank fuel answer renders and recomputes after calculated-state lowering',async()=>{
  const{page,context}=await pageAt(390);try{const row=JSON.parse(fs.readFileSync(path.join(root,'tests/fixtures/r6-derived-live.json')));await draw(page,row.answer);const f=await frameReady(page);const probe=await require('./recompute_cases').recompute(page,'g19',[row.program]);assert.equal(probe.edits.length,4);await f.getByLabel('Distance each way (km)',{exact:true}).fill('60');await f.getByText(/\$15\.00(?!\d)/).first().waitFor();await f.getByLabel('Fuel economy (km per litre)',{exact:true}).fill('10');await f.getByText(/\$18\.00(?!\d)/).first().waitFor();return{distance:60,economy:10,total:18};}finally{await context.close();}
 });
 await check('grouped rate replaces and restores after slider focus without magnitude changes',async()=>{
  const{page,context}=await pageAt(390);try{await draw(page,answer(fixtures.quote));const f=await frameReady(page);await f.getByRole('slider').focus();const rate=f.getByLabel('Price per inspection (UGX)',{exact:true});await rate.fill('100000');await rate.press('Tab');assert.equal(Number((await rate.inputValue()).replace(/,/g,'')),100000);await f.getByText(/\b360,000(?![,\d])/).first().waitFor();await rate.fill('80000');await rate.press('Tab');assert.equal(Number((await rate.inputValue()).replace(/,/g,'')),80000);await f.getByText(/\b288,000(?![,\d])/).first().waitFor();return{rate:80000,total:288000};}finally{await context.close();}
 });
 await check('empty root cannot acknowledge a mounted interface',async()=>{
  const{page,context}=await pageAt(390);try{await draw(page,'Readable finding.\n```openui\nroot = Col([])\n```');await page.waitForFunction(()=>document.querySelector('.turn[data-openui-partial="true"]'));const records=await page.evaluate(()=>[...window.JarvisOpenUI.records].map(r=>({mounted:r.mounted,failed:r.failed})));assert.ok(records.every(r=>!r.mounted&&r.failed));return{records};}finally{await context.close();}
 });
 for(const width of [320,390,430])for(const theme of ['dark','light'])await check('Lang calculator '+width+'px '+theme+'; 288000 to 360000 locally',async()=>{
  const{page,context}=await pageAt(width,theme);try{const before=requests.length;await draw(page,answer(fixtures.quote));const f=await frameReady(page);
   await f.getByText(/288,000/,{exact:false}).first().waitFor();const input=f.getByLabel('Inspections',{exact:true});await input.fill('5');await f.getByText(/360,000/,{exact:false}).first().waitFor();
   await f.locator('summary').click();await f.getByText(/400,000/).waitFor();
   const measure=await f.locator('#openui-root').evaluate(async el=>{await document.fonts.ready;return{width:innerWidth,scrollWidth:document.documentElement.scrollWidth,labels:[...el.querySelectorAll('.iui-label,.iui-slider-head label')].map(n=>parseFloat(getComputedStyle(n).fontSize)),targets:[...el.querySelectorAll('input:not([type=range]),summary')].map(n=>({height:n.getBoundingClientRect().height,width:n.getBoundingClientRect().width})),range:el.querySelector('input[type=range]')?.getBoundingClientRect().height,text:el.textContent};});
   assert.ok(measure.labels.length===3&&measure.labels.every(v=>v>=12),JSON.stringify(measure));assert.ok(measure.targets.every(t=>t.height>=44&&t.width>=44),JSON.stringify(measure));assert.ok(measure.range>=44);assert.ok(measure.scrollWidth<=measure.width+1,JSON.stringify(measure));
   assert.equal(requests.slice(before).filter(r=>r.path==='/stream').length,0);await shot(page,'quote-'+width+'-'+theme);return{...measure,additionalTurns:0};
  }finally{await context.close();}
 });
 for(const width of [320,390,430])await check('exact buildings prompt mounts loaded photographs and credits '+width+'px',async()=>{
  const{page,context}=await pageAt(width);try{await draw(page,answer(fixtures.images));const f=await frameReady(page);await f.locator('img').nth(2).waitFor();
   await f.locator('img').first().evaluate(img=>img.complete?Promise.resolve():new Promise(resolve=>img.addEventListener('load',resolve,{once:true})));
   await f.locator('img').first().evaluate(img=>new Promise(resolve=>{const read=()=>parseFloat(getComputedStyle(img).opacity)>=.99?resolve():requestAnimationFrame(read);read();}));
   const detail=await f.locator('#openui-root').evaluate(el=>({images:[...el.querySelectorAll('img')].map(n=>({alt:n.alt,loaded:n.complete&&n.naturalWidth>0,opacity:parseFloat(getComputedStyle(n).opacity),visible:getComputedStyle(n).visibility!=='hidden'&&getComputedStyle(n).display!=='none',width:n.getBoundingClientRect().width,height:n.getBoundingClientRect().height})),credits:[...el.querySelectorAll('figcaption')].map(n=>n.textContent),scroll:el.querySelector('.iui-carousel-track')?.scrollWidth,viewport:innerWidth,page:document.documentElement.scrollWidth}));
   assert.equal(detail.images.length,3);assert.ok(detail.images.every(n=>n.loaded&&n.opacity>=.99&&n.visible&&n.width>100&&n.height>100),JSON.stringify(detail.images));detail.credits.forEach((credit,i)=>{const expected=photoEvidence.find(r=>r.query===detail.images[i].alt)?.photos?.[0]?.license||'CC BY 4.0';assert.ok(credit.includes(expected)&&credit.includes('retrieved'),'missing actual photo license: '+expected);});assert.ok(detail.page<=detail.viewport+1,JSON.stringify(detail));
   await shot(page,'buildings-'+width);return{prompt:fixtures.images.question,...detail,photoBytes:photoEvidence.length?'Actual Wikimedia photos downloaded by response_images.search; model output remains a fixture':'Local PNG fixture, not a successful live Wikimedia request'};
  }finally{await context.close();}
 });
 await check('editable calculator renders before the fence closes and retains focus/value through streaming settle',async()=>{
  const{page,context}=await pageAt(390);try{
   const prefix='At your original figures, the total is UGX 288,000.\n\n```openui\n'+meta+'$quantity = 4\n$price = 80000\n$discount = 10\nroot = Col([Title(@Format($quantity * $price * (1 - $discount / 100), "currency", 0, "UGX")), Form([Input($quantity, "Inspections", "number"), Input($price, "Price per inspection (UGX)", "number"), Slider($discount, 0, 100, 1, "Discount", "%")]), extra])\n';
   const suffix='extra = Caption("You can keep editing these figures.")\n```\n',full=prefix+suffix,cut=prefix.length;
   await page.evaluate(()=>window.__jarvisTurnStart('Four inspections at UGX 80,000 with 10% off.','d'.repeat(32)));
   await page.evaluate(s=>window.__jarvisReply(s),prefix);const f=await frameReady(page);const field=f.getByLabel('Inspections',{exact:true});await field.fill('5');await f.getByText(/360,000/).first().waitFor();await field.focus();
   await page.evaluate(()=>{window.__testOpenUIFrame=document.querySelector('.jr-openui-frame');});
   await page.evaluate(s=>window.__jarvisReply(s),full.slice(cut));await page.evaluate(s=>window.__jarvisTurnEnd(s),full);
   assert.equal(await field.inputValue(),'5');assert.equal(await page.evaluate(()=>document.querySelector('.jr-openui-frame')===window.__testOpenUIFrame),true);
   const focused=await field.evaluate(el=>document.activeElement===el);assert.equal(focused,true);await f.getByText(/360,000/).first().waitFor();return{mountedBeforeClosingFence:true,retainedValue:5,retainedFocus:focused,sameFrame:true};
  }finally{await context.close();}
 });
 await check('two-sentence fuel answer stays native prose without a control apology',async()=>{const{page,context}=await pageAt(390);try{await draw(page,fixtures.plain.text);assert.equal(await page.locator('.jr-openui-frame').count(),0);assert.equal(await page.locator('.t-a').innerText(),fixtures.plain.text);return{prompt:fixtures.plain.question,text:fixtures.plain.text};}finally{await context.close();}});
 for(const[caseName,code]of [['malformed','root = Col([Text({"secret":"MUST_NOT_PRINT"})])'],['rejected primitive','root = Col([FakeSlider("MUST_NOT_PRINT")])'],['stream cut','root = Col([Input($qty, "MUST_NOT_PRINT"']])await check(caseName+' falls back to readable text without payload or success',async()=>{
  const{page,context}=await pageAt(390);try{const full='The supplied total is UGX 288,000.\n\n```openui\n'+code+(caseName==='stream cut'?'':'\n```');await draw(page,full);await page.waitForFunction(()=>document.querySelector('.turn[data-openui-partial="true"]'));const text=await page.locator('.t-a').innerText();assert.ok(text.includes('288,000'));assert.ok(!text.includes('MUST_NOT_PRINT')&&!text.includes('root =')&&!text.includes('secret'));assert.ok(await page.locator('[data-presentation-errors]').count());return{text,browserDiagnostic:true};}finally{await context.close();}
 });
 await check('reference timeline, popover and reactive checklist compose without a template',async()=>{const{page,context}=await pageAt(320);try{await draw(page,answer(fixtures.plan));const f=await frameReady(page);await f.getByText('Your afternoon').waitFor();await f.getByRole('button',{name:'Why this order?'}).click();await f.getByText('Start with understanding, then make something concrete.').waitFor();await f.locator('summary').click();await f.getByLabel('Brief read').check();await f.getByLabel('Draft ready').check();await f.getByText('Ready to review').waitFor();await shot(page,'plan-320');return{timeline:true,popover:true,reactiveChecklist:true};}finally{await context.close();}});
 await check('stalled image advances to its next credited candidate with a timeout reason',async()=>{
  const{page,context}=await pageAt(390);try{const photo={title:'Fixture',page:'https://commons.wikimedia.org/wiki/File:Fixture',author:'Fixture',license:'CC BY 4.0',licenseUrl:'https://creativecommons.org/licenses/by/4.0/',retrieved:'2026-10-25T00:00:00Z'};await page.route('**/api/openui/images?**',r=>r.fulfill({json:{photos:[{...photo,url:'https://upload.wikimedia.org/stalled.png'},{...photo,url:'https://upload.wikimedia.org/working.png'}]}}));await page.route('https://upload.wikimedia.org/stalled.png',()=>{});await draw(page,'Photo.\n```openui\nroot = Col([SearchImage("Fixture subject")])\n```');const f=await frameReady(page);await f.locator('[data-photo-status="loaded"]').waitFor({timeout:18000});const attempts=JSON.parse(await f.locator('[data-photo-attempts]').getAttribute('data-photo-attempts'));assert.ok(attempts.some(a=>a.reason==='download_timeout'));return{recovered:true,attempts};}finally{await context.close();}
 });
 await check('failed photo lookup marks an actual settled turn PARTIAL',async()=>{const{page,context}=await pageAt(390);try{
  await page.route('**/api/openui/images?**',r=>r.fulfill({status:502,json:{photos:[]}}));const text=answer(fixtures.images);
  await page.evaluate(({q,text})=>{window.__jarvisTurnStart(q,'d'.repeat(32));window.__jarvisReply(text);window.__jarvisTurnEnd(text);},{q:fixtures.images.question,text});
  const f=await frameReady(page);await f.getByText('Photograph unavailable: Burj Khalifa Dubai').waitFor();await page.waitForFunction(()=>document.querySelector('.turn[data-openui-partial="true"]'));
  await page.getByText(/PARTIAL/).first().waitFor();return{partial:true,photoUnavailable:true};
 }finally{await context.close();}});
 await check('disabled interactive preference prevents a frame and image fetch',async()=>{const{page,context}=await pageAt(390);try{
  await page.route('**/api/response/context/**',r=>r.fulfill({json:{ok:true,prefs:{interactive:false}}}));const before=requests.length;await draw(page,answer(fixtures.images));
  await page.waitForFunction(()=>document.querySelector('.turn[data-openui-partial="true"]'));assert.equal(await page.locator('.jr-openui-frame').count(),0);assert.equal(requests.slice(before).filter(r=>r.path==='/api/openui/images').length,0);return{framePrevented:true,imageRequests:0};
 }finally{await context.close();}});
 await check('five-field clarifying form prepares all answers without sending a model turn',async()=>{const{page,context}=await pageAt(390);try{
  const text='Choose a destination.\n```openui\n$destination = "Entebbe"\n$date = "Saturday"\n$group = "Two adults"\n$budget = "UGX 150,000"\n$interests = "Nature"\nroot = Col([Form([Input($destination, "Destination"), Input($date, "Date"), Input($group, "Group"), Input($budget, "Budget"), Input($interests, "Interests"), Button("Plan trip", @ToAssistant("Help me plan this trip"))])])\n```';const before=requests.length;
  await draw(page,text);const f=await frameReady(page);await f.getByLabel('Destination',{exact:true}).fill('Jinja');await f.getByRole('button',{name:'Plan trip'}).click();await page.waitForFunction(()=>document.getElementById('q').value.includes('Jinja'));
  const draft=await page.locator('#q').inputValue();for(const value of ["Jinja","Saturday","Two adults","UGX 150,000","Nature"])assert.ok(draft.includes(value),value);assert.equal(requests.slice(before).filter(r=>r.path==='/stream').length,0);return{draft,additionalTurns:0};
 }finally{await context.close();}});
 await check('five simultaneous photo requests all finish through the bounded queue',async()=>{const{page,context}=await pageAt(390);try{
  const names=['Building one','Building two','Building three','Building four','Building five'];
  await page.route('**/api/openui/images?**',async r=>{await new Promise(resolve=>setTimeout(resolve,400));return r.fallback();});
  const text='Five buildings.\n```openui\nroot = Col(['+names.map(n=>'SearchImage('+JSON.stringify(n)+')').join(',')+'])\n```';
  await draw(page,text);const f=await frameReady(page);await f.locator('figure[data-photo-status="loaded"]').nth(4).waitFor();
  assert.equal(await f.locator('img').count(),5);assert.equal(await page.locator('.turn[data-openui-status=""]').count(),1);return{requested:5,loaded:5};
 }finally{await context.close();}});
 await check('a final failed frame recovers in place and retains an edited input',async()=>{const{page,context}=await pageAt(390);try{
  await page.evaluate(()=>{window.__uiTrace=[];addEventListener('message',e=>{if(e.data?.channel==='jarvis-openui')window.__uiTrace.push({type:e.data.type,revision:e.data.revision});});});
  const full=answer(fixtures.quote);await page.evaluate(q=>{window.__jarvisTurnStart(q,'d'.repeat(32));window.__jarvisTerm({kind:'run',tool:'fixture',line:'Fixture read',title:'Fixture read'});window.__jarvisTerm({kind:'ok',tool:'fixture',line:'Fixture read',title:'Fixture read'});},fixtures.quote.question);
  await page.evaluate(s=>window.__jarvisReply(s),full);const f=await frameReady(page);const input=f.getByLabel('Inspections',{exact:true});await input.fill('5');
  await page.evaluate(()=>{window.__sameFrame=document.querySelector('.jr-openui-frame');const el=document.querySelector('.turn .t-a');window.JarvisOpenUI.paint(el,'Useful fact.\n```openui\nroot = Bad("SECRET")\n```',()=>{},true);});
  await page.waitForFunction(()=>document.querySelector('.turn[data-openui-partial="true"]'));
  await page.evaluate(s=>window.__jarvisSetReply(s),full);await page.evaluate(s=>window.__jarvisTurnEnd(s),full);
  try{await f.getByText(/360,000/).first().waitFor({timeout:5000});}catch(e){throw Error(JSON.stringify(await page.evaluate(()=>({trace:window.__uiTrace,records:[...window.JarvisOpenUI.records].map(r=>({failed:r.failed,revision:r.revision,mounted:r.mounted,code:r.code.slice(0,100)}))}))));}assert.equal(await input.inputValue(),'5');
  assert.ok(await page.evaluate(()=>window.__sameFrame===document.querySelector('.jr-openui-frame')));await page.getByText(/WORKED/).first().waitFor();
  return{sameFrame:true,retainedValue:5,recovered:true};
 }finally{await context.close();}});
 for(const type of ['native','OpenUI'])await check('touching every '+type+' table header preserves cells and row order',async()=>{const{page,context}=await pageAt(390);try{
  await draw(page,type==='native'?'| Name | Height |\n| --- | --- |\n| Burj Khalifa | 828 |\n| Merdeka 118 | 679 |':'Buildings.\n```openui\nroot = Col([Table(["Name", "Height"], [["Burj Khalifa", 828], ["Merdeka 118", 679]])])\n```');
  const target=type==='native'?page:await frameReady(page);await target.locator('tbody tr').first().waitFor();const rows=()=>target.locator('tbody tr').allTextContents(),original=await rows();
  for(const header of await target.locator('th').all())await header.tap();assert.deepEqual(await rows(),original);assert.equal(await target.locator('th[role=button]').count(),0);return{before:original,after:await rows()};
 }finally{await context.close();}});
})().catch(e=>{checks.push({name:'startup',status:'FAIL',detail:e.stack});}).finally(async()=>{if(browser)await browser.close();const result={kind:photoEvidence.length?'Offline provider output; actual Wikimedia photo metadata and downloaded bytes from separate live read-only retrieval.':'Offline production browser integration; provider outputs and photos are fixtures.',browser:browser?.version(),passed:checks.filter(r=>r.status==='PASS').length,total:checks.length,checks,requests,diagnostics};if(report){fs.mkdirSync(path.dirname(path.resolve(report)),{recursive:true});fs.writeFileSync(report,JSON.stringify(result,null,2)+'\n');}process.exitCode=checks.some(c=>c.status!=='PASS')?1:0;});
