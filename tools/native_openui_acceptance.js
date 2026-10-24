/* Actual production page, OpenUI parser/Renderer, iframe CSP and local recomputation.
   Provider answers and Wikimedia API/image bytes are explicitly fixtures, never model proof. */
'use strict';
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process'),assert=require('node:assert/strict');
const {chromium}=require('playwright');
const args=process.argv.slice(2),option=n=>args.includes(n)?args[args.indexOf(n)+1]:null;
const root=path.resolve(option('--root')||path.join(__dirname,'..')),report=option('--report'),screens=option('--screenshots');
const app='https://jarvis-openui.invalid',fixtures=JSON.parse(fs.readFileSync(path.join(root,'tests/fixtures/openui-lang.json')));
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
   if(url.pathname==='/')return route.fulfill({contentType:'text/html',body:fs.readFileSync(path.join(root,'index_v1.html'))});
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
  const{page,context}=await pageAt(390);try{const full='The supplied total is UGX 288,000.\n\n```openui\n'+code+(caseName==='stream cut'?'':'\n```');await draw(page,full);await page.getByText('The visual part of this answer could not be displayed.').waitFor();const text=await page.locator('.t-a').innerText();assert.ok(text.includes('288,000'));assert.ok(!text.includes('MUST_NOT_PRINT')&&!text.includes('root =')&&!text.includes('secret'));return{text};}finally{await context.close();}
 });
 await check('reference timeline, popover and reactive checklist compose without a template',async()=>{const{page,context}=await pageAt(320);try{await draw(page,answer(fixtures.plan));const f=await frameReady(page);await f.getByText('Your afternoon').waitFor();await f.getByRole('button',{name:'Why this order?'}).click();await f.getByText('Start with understanding, then make something concrete.').waitFor();await f.locator('summary').click();await f.getByLabel('Brief read').check();await f.getByLabel('Draft ready').check();await f.getByText('Ready to review').waitFor();await shot(page,'plan-320');return{timeline:true,popover:true,reactiveChecklist:true};}finally{await context.close();}});
 await check('failed photo lookup marks an actual settled turn TEXT ONLY',async()=>{const{page,context}=await pageAt(390);try{
  await page.route('**/api/openui/images?**',r=>r.fulfill({status:502,json:{photos:[]}}));const text=answer(fixtures.images);
  await page.evaluate(({q,text})=>{window.__jarvisTurnStart(q,'d'.repeat(32));window.__jarvisReply(text);window.__jarvisTurnEnd(text);},{q:fixtures.images.question,text});
  const f=await frameReady(page);await f.getByText('Photograph unavailable: Burj Khalifa Dubai').waitFor();await page.waitForFunction(()=>document.querySelector('.turn[data-openui-partial="true"]'));
  await page.getByText(/TEXT ONLY/).first().waitFor();return{partial:true,photoUnavailable:true};
 }finally{await context.close();}});
 await check('disabled interactive preference prevents a frame and image fetch',async()=>{const{page,context}=await pageAt(390);try{
  await page.route('**/api/response/context/**',r=>r.fulfill({json:{ok:true,prefs:{interactive:false}}}));const before=requests.length;await draw(page,answer(fixtures.images));
  await page.getByText('The visual part of this answer could not be displayed.').waitFor();assert.equal(await page.locator('.jr-openui-frame').count(),0);assert.equal(requests.slice(before).filter(r=>r.path==='/api/openui/images').length,0);return{framePrevented:true,imageRequests:0};
 }finally{await context.close();}});
 await check('form action prepares a draft and never sends another model turn',async()=>{const{page,context}=await pageAt(390);try{
  const text='Choose a destination.\n```openui\n$destination = "Entebbe"\nroot = Col([Form([Input($destination, "Destination"), Button("Plan trip", @ToAssistant("Help me plan this trip"))])])\n```';const before=requests.length;
  await draw(page,text);const f=await frameReady(page);await f.getByLabel('Destination',{exact:true}).fill('Jinja');await f.getByRole('button',{name:'Plan trip'}).click();await page.waitForFunction(()=>document.getElementById('q').value.includes('Jinja'));
  const draft=await page.locator('#q').inputValue();assert.equal(requests.slice(before).filter(r=>r.path==='/stream').length,0);return{draft,additionalTurns:0};
 }finally{await context.close();}});
 await check('touching every legacy table header never changes names, numbers or row order',async()=>{const{page,context}=await pageAt(390);try{await draw(page,'| Name | Height |\n| --- | --- |\n| Burj Khalifa | 828 |\n| Merdeka 118 | 679 |');const rows=()=>page.locator('tbody tr').allTextContents(),original=await rows();for(const header of await page.locator('th').all())await header.tap();assert.deepEqual(await rows(),original);assert.equal(await page.locator('th[role=button]').count(),0);return{before:original,after:await rows()};}finally{await context.close();}});
})().catch(e=>{checks.push({name:'startup',status:'FAIL',detail:e.stack});}).finally(async()=>{if(browser)await browser.close();const result={kind:photoEvidence.length?'Offline provider output; actual Wikimedia photo metadata and downloaded bytes from separate live read-only retrieval.':'Offline production browser integration; provider outputs and photos are fixtures.',browser:browser?.version(),passed:checks.filter(r=>r.status==='PASS').length,total:checks.length,checks,requests,diagnostics};if(report){fs.mkdirSync(path.dirname(path.resolve(report)),{recursive:true});fs.writeFileSync(report,JSON.stringify(result,null,2)+'\n');}process.exitCode=checks.some(c=>c.status!=='PASS')?1:0;});
