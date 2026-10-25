/* Operator-run staging gate. Real page, text composer, provider and images; no mocked responses.
   Screenshots at two widths reuse each answer, so 30 cases spend 30 turns, not 60.
   Qualitative comparison with the public reference remains a human review gate. */
'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),cp=require('node:child_process');
const {cancellationPayload}=require('./staging_turn');
const {auditContrast}=require('./frame_contrast');
const {recompute}=require('./recompute_cases');
const args=process.argv.slice(2),option=n=>args.includes(n)?args[args.indexOf(n)+1]:null;
const {chromium}=require('playwright'),origin='https://stage.battemohammad.com';
const root=path.resolve(__dirname,'..'),casesFile=path.join(root,'tests/fixtures/generative30.json');
async function runGate(options){
const {cookie,cases,output}=options;fs.mkdirSync(output,{recursive:true});
const report={kind:'Real isolated staging page and model. No fixture responses. 320/390/430px screenshots share each answer.',
  origin,cases_sha256:crypto.createHash('sha256').update(fs.readFileSync(casesFile)).digest('hex'),rows:[],qualitative_review:'REQUIRED: compare the same 30 questions with the reference demo; do not infer parity from this runner.'};
if(options.kind)report.kind=options.kind;
const save=()=>fs.writeFileSync(path.join(output,'browser.json'),JSON.stringify(report,null,2)+'\n');
function evidence(wire){return JSON.parse(cp.execFileSync('python3',[path.join(root,'tools/generative_evidence.py')],{input:JSON.stringify({wire}),encoding:'utf8',maxBuffer:4*1024*1024}));}
function deadline(promise,ms){let timer;return Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('turn deadline exceeded')),ms);})]).finally(()=>clearTimeout(timer));}
let browser=options.browser;
try{
  if(!browser)browser=await chromium.launch({executablePath:options.executablePath,headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
  for(const entry of cases){
    const context=await browser.newContext({viewport:{width:390,height:950},hasTouch:true,colorScheme:'dark'});
    await context.addCookies([{name:'jl',value:cookie.slice(3),url:origin,secure:true,httpOnly:true,sameSite:'Lax'}]);
    const row={...entry,errors:[],requests:[],screenshots:[],network_failures:[],http_failures:[],image_broker:[],phase:'preflight'};let opened,requestData;const start=Date.now();
    try{
      const read=options.readStatus||((ctx,url)=>ctx.request.get(url,{headers:{Origin:origin}}));
      const health=await read(context,origin+'/healthz');if(!health.ok()||(await health.json()).turns)throw Error('staging is busy or unavailable');
      const validator=await read(context,origin+'/api/openui/health'),validatorState=await validator.json();
      report.validator=validatorState;if(!validator.ok()||!validatorState.ok)throw Error('validator preflight failed: '+(validatorState.error||'no service validator'));
      const build=await (await read(context,origin+'/build')).json();
      if(report.build&&report.build.js!==build.js)throw Error('build changed during the run');report.build=build;
      await context.route('**/*',route=>{const r=route.request(),url=new URL(r.url());
        const same=url.origin===origin,write=['/stream','/reset','/timeline','/cancel','/api/sessions','/api/artifacts/code'].includes(url.pathname);
        if((same&&!/^\/(?:art(?:\/|$)|api\/(?:devices|pair|sessions\/clear))/.test(url.pathname)&&(r.method()==='GET'||(r.method()==='POST'&&write)))||
           (r.method()==='GET'&&['https://upload.wikimedia.org','https://thumb.wikimedia.org'].includes(url.origin)))return route.continue();
        return route.abort();
      });
      if(options.configureContext)await options.configureContext(context);
      row.phase='page-load';
      const page=await context.newPage();page.on('pageerror',e=>row.errors.push('page: '+e.message));
      page.on('requestfailed',r=>row.network_failures.push({url:r.url(),method:r.method(),resource:r.resourceType(),phase:row.phase,error:r.failure()?.errorText}));
      page.on('response',async r=>{if(r.status()>=400)row.http_failures.push({url:r.url(),status:r.status()});if(new URL(r.url()).pathname==='/api/openui/images')try{row.image_broker.push({url:r.url(),status:r.status(),body:await r.json()});}catch{}});
      row.runtime_headers=[];page.on('response',response=>{if(new URL(response.url()).pathname==='/api/openui/runtime')row.runtime_headers.push(response.headers());});
      page.on('request',r=>{const u=new URL(r.url());if(u.origin===origin)row.requests.push({method:r.method(),path:u.pathname});});
      await page.goto(origin,{waitUntil:'domcontentloaded'});await page.waitForFunction(()=>typeof window.__jarvisDraw==='function');
      await page.evaluate(()=>{const original=window.__jarvisTurnId;window.__jarvisTurnId=function(turn,conv,attached,q,tid){window.__gateOpened={turn,conv,tid};return original.apply(this,arguments);};});
      // The legacy mode switch is intentionally hidden. The visible composer submit handler
      // arms text mode itself; exercise that path rather than clicking the hidden voice control.
      row.phase='composer';
      await page.locator('#newchat').click();await page.locator('#q').fill(entry.question);
      const responsePromise=page.waitForResponse(r=>r.url()===origin+'/stream'&&r.request().method()==='POST',{timeout:15000});
      const modelStart=Date.now();await page.locator('#send').click();const response=await responsePromise;requestData=response.request().postDataJSON();
      row.phase='stream';
      if(requestData.mode!=='text'||!/^[a-f0-9]{32}$/i.test(requestData.conv||''))throw Error('not a named text conversation');
      if(report.rows.some(r=>r.conv===requestData.conv))throw Error('conversation reused');row.conv=requestData.conv;
      const text=await deadline(response.text(),120000),captured=evidence(text),priorErrors=row.errors;Object.assign(row,captured);row.errors=priorErrors.concat(captured.errors);opened=row.events.find(e=>e.event==='open')?.data;
      row.model_seconds=(Date.now()-modelStart)/1000;
      if(opened?.conv!==row.conv)throw Error('turn namespace mismatch');
      row.finished=row.events.some(e=>e.event==='done');if(!row.finished)throw Error('no done event');
      row.agent_started=row.events.some(e=>e.event==='work'&&e.data.state==='start');
      if(row.agent_started)row.errors.push('a frozen inline/public question entered the general task agent');
      if(row.server_status==='unknown')row.errors.push('server supplied no terminal verdict');
      if(row.unlabelled_openui)row.errors.push('unlabelled OpenUI code is not a rendered program');
      const contract=JSON.parse(fs.readFileSync(path.join(root,'tests/fixtures/parity-contract.json')));
      row.expected_shape=contract.rules[entry.id];
      if(row.expected_shape==='composed'&&!row.programs.length)row.errors.push('required composition absent');
      if(row.expected_shape==='prose'&&row.programs.length)row.errors.push('prose-only case received composition');
      row.answer=row.text;
      row.phase='render';
      await page.waitForFunction(()=>document.querySelector('.turn[data-ta]'),undefined,{timeout:10000});
      await page.waitForFunction(()=>window.JarvisOpenUI&&[...window.JarvisOpenUI.records].filter(r=>r.node.isConnected).every(r=>r.mounted||r.failed),undefined,{timeout:20000});
      await page.waitForFunction(()=>[...window.JarvisOpenUI.records].filter(r=>r.node.isConnected).every(r=>!r.mediaPending),undefined,{timeout:60000});
      row.frames=await page.evaluate(()=>[...window.JarvisOpenUI.records].filter(r=>r.node.isConnected).map(r=>({failed:!!r.failed,pending:r.mediaPending,missing:r.mediaFailed,ready:r.ready,mounted:r.mounted})));
      if(row.frames.some(r=>r.failed||r.pending||r.missing))row.errors.push('frame or requested media incomplete');
      row.visible=await page.locator('.turn .t-a').allTextContents();
      if(/```openui|jarvis-context:|root\s*=\s*Col\(/.test(row.visible.join('\n')))row.errors.push('raw UI payload reached the reader');
      row.browser_presentation_errors=await page.locator('[data-presentation-errors]').evaluateAll(nodes=>nodes.flatMap(n=>{try{return JSON.parse(n.dataset.presentationErrors);}catch{return [];}}));
      row.contrast=[];for(const frame of page.frames().filter(f=>f.url().includes('/api/openui/runtime')))row.contrast.push(...await frame.evaluate(auditContrast));
      if(row.contrast.some(c=>!c.passed))row.errors.push('frame contrast below acceptance threshold');
      row.views=[];
      for(const width of [320,390,430]){
        await page.setViewportSize({width,height:950});await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
        const file=entry.id+'-'+width+'.png';await page.screenshot({path:path.join(output,file),fullPage:true});row.screenshots.push(file);
        const frames=[];for(const frame of page.frames().filter(f=>f.url().includes('/api/openui/runtime'))){frames.push(await frame.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth,images:[...document.images].map(img=>({alt:img.alt,loaded:img.complete&&img.naturalWidth>0})),labels:[...document.querySelectorAll('input,select,textarea')].map(el=>({label:el.labels?.[0]?.textContent||el.getAttribute('aria-label'),type:el.type,value:el.value}))})));}
        row.views.push({width,frames});if(frames.some(f=>f.scroll>f.width+1))row.errors.push('frame overflow at '+width);
      }
      if(['factual-media','ranked'].includes(entry.category)&&!row.views[0].frames.some(f=>f.images.some(i=>i.loaded)))row.errors.push('expected photographs not loaded');
      if(['g01','g02'].includes(entry.id)&&(row.programs.length||row.unlabelled_openui))row.errors.push('greeting or explicit plain answer received UI code');
      // The natural quote must compute locally, without another provider request.
      if(['g17','g18','g21'].includes(entry.id)&&!row.frames.length)row.errors.push('required adjustable calculation or supplied-data chart is absent');
      if(entry.id==='g21'&&row.frames.length&&!(await page.frameLocator('.jr-openui-frame').locator('.iui-chart svg[role="img"]').count()))row.errors.push('supplied-data chart did not mount');
      row.shape_signature=[];for(const frame of page.frames().filter(f=>f.url().includes('/api/openui/runtime')))row.shape_signature.push(await frame.evaluate(()=>({forms:document.forms.length,charts:document.querySelectorAll('.iui-chart').length,photos:document.images.length,inputs:[...document.querySelectorAll('input,select,textarea')].map(n=>({type:n.type,tag:n.tagName})),buttons:document.querySelectorAll('button').length})));
      if(options.forceBindingInspection)for(const frame of page.frames().filter(f=>f.url().includes('/api/openui/runtime')))await frame.evaluate(()=>{delete window.JarvisOpenUIInspection;document.querySelectorAll('[data-state-binding]').forEach(n=>n.removeAttribute('data-state-binding'));});
      const beforeProbe=row.requests.filter(r=>r.path==='/stream').length;row.recomputation=await recompute(page,entry.id,row.programs);if(row.requests.filter(r=>r.path==='/stream').length!==beforeProbe)throw Error('local recomputation sent a model turn');
      if(entry.id==='g12'&&row.frames.length){
        const frame=page.frameLocator('.jr-openui-frame'),fields=frame.locator('input:not([type=hidden]),select,textarea');
        const count=await fields.count();if(count!==5)throw Error('clarifying form requires five relevant fields; got '+count);
        const supplied=[];
        for(let i=0;i<count;i++){
          const field=fields.nth(i),tag=await field.evaluate(n=>n.tagName),type=await field.getAttribute('type'),label=await field.getAttribute('aria-label');
          let value=type==='date'?'2026-10-31':await field.getAttribute('inputmode')==='decimal'?'150000':['Jinja','Saturday','Two adults','UGX 150,000','Nature and food'][i];
          if(tag==='SELECT'){value=await field.locator('option:not([disabled])').first().getAttribute('value');await field.selectOption(value);}else await field.fill(value);
          supplied.push({label,value});
        }
        await frame.getByRole('button').last().click();await page.waitForFunction(values=>values.every(v=>document.querySelector('#q').value.includes(v)),supplied.map(f=>f.value),{timeout:5000});const draft=await page.locator('#q').inputValue();
        if(!supplied.every(f=>draft.includes(f.value)))throw Error('clarifying form omitted a supplied answer from its draft');
        const next=page.waitForResponse(r=>r.url()===origin+'/stream'&&r.request().method()==='POST',{timeout:15000});
        row.followup_pending=true;await page.locator('#send').click();const response=await next;requestData=response.request().postDataJSON();const followup=evidence(await deadline(response.text(),120000));row.followup_pending=false;
        row.clarifying_form={initial_answer:row.answer,fields:supplied,draft,followup_question:response.request().postDataJSON().q,followup};
        fs.writeFileSync(path.join(output,'clarifying-form-transcript.json'),JSON.stringify(row.clarifying_form,null,2));
        if(followup.server_status!=='ok')throw Error('clarifying followup did not finish successfully');
      }
      row.seconds=(Date.now()-start)/1000;
      row.phase='complete';
    }catch(e){
      if(row.followup_pending){row.finished=false;opened=null;}
      row.error_phase=row.phase;
      row.errors.push(String(e.message).split(cookie).join("[REDACTED]"));row.seconds=(Date.now()-start)/1000;
      if(!opened&&typeof context.pages()[0]!=='undefined')opened=await context.pages()[0].evaluate(()=>window.__gateOpened).catch(()=>null);
      if(!row.finished&&options.allowCancel){
        const payload=cancellationPayload(opened,requestData);
        if(payload){try{
          const cancel=options.cancelTurn||((ctx,data)=>ctx.request.post(origin+'/cancel',{headers:{Origin:origin},data}));
          const response=await cancel(context,payload);row.cancel_status=response.status();
        }catch(error){row.cancel_error=error.message;}}
        else row.cancel_skipped='no verified conversation and turn id; no stop sent';
      }
    }finally{report.rows.push(row);save();await context.close();}
    console.log(entry.id+' '+(row.errors.length?'FAIL':'MECHANISMS OK')+' '+row.seconds+'s');
    if(!row.finished){report.stopped='incomplete turn; no more turns started';save();break;}
  }
  report.completed=report.rows.length===cases.length;report.mechanism_failures=report.rows.filter(r=>r.errors.length).length;save();
}catch(e){report.stopped=e.message;save();}
finally{if(browser&&!options.browser)await browser.close();}
return report;
}
module.exports={runGate};
if(require.main===module){
  if(args.includes('--help')){console.log('node tools/staging_generative_browser.js --run --cookie-file PRIVATE_FILE --report-dir DIRECTORY [--browser CHROMIUM] [--limit 30] [--ids g01,g17] [--allow-cancel]');process.exit(0);}
  if(!args.includes('--run')||!option('--cookie-file')||!option('--report-dir'))throw Error('Explicit --run, private cookie file and report directory required. This spends real model turns.');
  const cookieFile=option('--cookie-file');if(fs.statSync(cookieFile).mode&0o077)throw Error('Cookie file must be owner-only.');
  const cookie=fs.readFileSync(cookieFile,'utf8').trim();if(!/^jl=[A-Za-z0-9_-]+$/.test(cookie))throw Error('Expected a single jl cookie.');
  const ids=option('--ids')?new Set(option('--ids').split(',')):null;
  const all=JSON.parse(fs.readFileSync(casesFile)).cases,selected=all.filter(c=>!ids||ids.has(c.id)).slice(0,Number(option('--limit')||30));
  if(!selected.length||(ids&&[...ids].some(id=>!all.some(c=>c.id===id))))throw Error('Select at least one known frozen case');
  runGate({cookie,cases:selected,output:path.resolve(option('--report-dir')),executablePath:option('--browser')||undefined,allowCancel:args.includes('--allow-cancel')})
    .then(report=>{process.exitCode=!report.completed||report.mechanism_failures?1:0;}).catch(error=>{console.error(error.message);process.exitCode=1;});
}
