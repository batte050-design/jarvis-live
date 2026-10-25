/* Exercise the real browser harness and production page with local wire/photo fixtures.
   Includes an open event without a numeric turn and both cancellation failure paths. */
'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),cp=require('node:child_process'),assert=require('node:assert/strict');
const {chromium}=require('playwright'),{runGate}=require('../tools/staging_generative_browser'),{cancellationPayload}=require('../tools/staging_turn');
const args=process.argv.slice(2),opt=n=>args.includes(n)?args[args.indexOf(n)+1]:undefined;
const root=path.resolve(__dirname,'..'),origin='https://stage.battemohammad.com';
const frozen=JSON.parse(fs.readFileSync(path.join(root,'tests/fixtures/generative30.json'))).cases;
const captured=JSON.parse(fs.readFileSync(path.join(root,'tests/fixtures/r3-captured.json'))).rows;
const quote=JSON.parse(fs.readFileSync(path.join(root,'tests/fixtures/openui-lang.json'))).quote;
const productionPage=JSON.parse(cp.execFileSync('python3',['tests/page_policy.py'],{cwd:root,encoding:'utf8'}));
quote.code=quote.code.replaceAll('Inspections','A').replaceAll('Price per inspection (UGX)','B').replaceAll('Discount','C');
const runtime=JSON.parse(cp.execFileSync('python3',['-c',`import json,response_openui as o;html,headers=o.document('${origin}');print(json.dumps({'html':html,'headers':headers}))`],{cwd:root,encoding:'utf8',maxBuffer:8*1024*1024}));
const work=fs.mkdtempSync(path.join(os.tmpdir(),'jarvis-harness-')),checks=[];let browser;
function check(name,fn){return Promise.resolve().then(fn).then(detail=>{checks.push({name,status:'PASS',detail});console.log('PASS '+name);}).catch(e=>{checks.push({name,status:'FAIL',detail:e.stack});console.error('FAIL '+name+': '+e.message);});}
const ok=data=>({ok:()=>true,json:async()=>data});
const readStatus=async(ctx,url)=>ok(url.endsWith('/healthz')?{ok:true,turns:0}:url.endsWith('/api/openui/health')?{ok:true,validator:{ok:true,components:52}}:{js:'local-test',css:'local-test'});
async function fixtures(context,incomplete=false,editableBill=false){
 await context.route('**/*',async route=>{const req=route.request(),url=new URL(req.url());
  if(url.origin==='https://upload.wikimedia.org')return route.fulfill({contentType:'image/png',body:fs.readFileSync(path.join(root,'tests/fixtures/photo-test.png'))});
  if(url.origin!==origin)return route.abort();
  if(url.pathname==='/stream'){
   const body=req.postDataJSON(),entry=frozen.find(c=>c.question===body.q),tid=body.tid||'f'.repeat(16);
   const bill='At the original figures, each person pays UGX 38,250.\n```openui\n$bill = 153000\n$people = 4\n$tip = 0\nroot = Col([Form([Input($bill, "Bill amount", "number"), Input($people, "People", "number"), Slider($tip, 0, 100, 1, "Tip", "%")]), Title(@Format($bill * (1 + $tip / 100) / @Clamp($people, 1, 100), "currency", 0, "UGX"))])\n```';
   if(!entry)return route.fulfill({contentType:'text/event-stream',body:[['open',{conv:body.conv,tid}],['text',{text:'I will use those five details to plan your day.'}],['done',{status:'ok'}]].map(([event,data])=>'event: '+event+'\ndata: '+JSON.stringify(data)+'\n\n').join('')});
   const clarification='Where and when would you like to go?\n```openui\n$place = ""\n$date = ""\n$group = ""\n$budget = ""\n$interest = ""\nroot = Col([Form([Input($place, "Location"), Input($date, "Date"), Input($group, "Group"), Input($budget, "Budget"), Input($interest, "Interests"), Button("Plan", @ToAssistant("Plan using these answers"))])])\n```';
   const answer=entry.id==='g12'?clarification:entry.id==='g01'?'Hello — how can I help?':entry.id==='g17'?quote.prose+'\n```openui\n'+quote.code+'```':entry.id==='g18'&&editableBill?bill:captured.find(r=>r.id===entry.id).answer;
   const events=[['open',{conv:body.conv,tid}],['format',{mode:'text',shape:'prose'}]];
   if(!incomplete)events.push(['tok',{d:answer,conv:body.conv,tid}],['text',{text:answer,conv:body.conv,tid}],['done',{status:'ok',evidence_version:3,conv:body.conv,tid}]);
   return route.fulfill({contentType:'text/event-stream',body:events.map(([event,data])=>'event: '+event+'\ndata: '+JSON.stringify(data)+'\n\n').join('')});
  }
  if(req.method()==='POST')return route.fulfill({json:{ok:true}});
  if(url.pathname==='/')return route.fulfill({contentType:'text/html',headers:productionPage.headers,body:productionPage.html});
  if(url.pathname==='/api/openui/runtime')return route.fulfill({contentType:'text/html',headers:runtime.headers,body:runtime.html});
  if(url.pathname.startsWith('/api/response/context/'))return route.fulfill({json:{ok:true,prefs:{interactive:true,agent:false,data:false,remember:true}}});
  if(url.pathname==='/api/openui/images')return route.fulfill({json:{photos:[{url:'https://upload.wikimedia.org/fixture.png',title:url.searchParams.get('q'),page:'https://commons.wikimedia.org/wiki/File:Fixture',author:'Fixture',license:'CC BY 4.0',licenseUrl:'https://creativecommons.org/licenses/by/4.0/',retrieved:'2026-10-24T00:00:00Z'}]}});
  if(url.pathname.startsWith('/static/')||url.pathname.startsWith('/vendor/')){
   const file=path.resolve(root,'.'+url.pathname);if(!file.startsWith(root+path.sep)||!fs.existsSync(file))return route.fulfill({status:404,body:''});
   return route.fulfill({contentType:{'.js':'application/javascript','.css':'text/css','.woff2':'font/woff2'}[path.extname(file)]||'application/octet-stream',body:fs.readFileSync(file)});
  }
  return route.fulfill({json:{ok:true,sessions:[],turns:[],devices:[],rows:[],ui:{mode:'device',density:'normal',autoplay:false}}});
 });
}
(async()=>{
 browser=await chromium.launch({executablePath:opt('--browser'),headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
 await check('five-field form feeds every answer into an explicitly sent followup',async()=>{
  const report=await runGate({browser,cookie:'jl=fixture',cases:frozen.filter(c=>c.id==='g12'),output:path.join(work,'clarification'),readStatus,configureContext:ctx=>fixtures(ctx),kind:'OFFLINE: five-field response and followup are fixtures.'});
  assert.equal(report.mechanism_failures,0,JSON.stringify(report.rows[0].errors));const transcript=report.rows[0].clarifying_form;assert.equal(transcript.fields.length,5);assert.ok(transcript.fields.every(f=>transcript.followup_question.includes(f.value)));assert.equal(transcript.followup.server_status,'ok');return{fields:5,followup:'ok',scope:'fixture mechanism, real model still pending'};
 });
 await check('cancellation requires a real matching conversation and tid',()=>{
  const request={mode:'text',conv:'a'.repeat(32),tid:'b'.repeat(16)};
  assert.equal(cancellationPayload(undefined,undefined),null);
  assert.equal(cancellationPayload({},{}),null);
  assert.equal(cancellationPayload({conv:request.conv,turn:4},request),null);
  assert.equal(cancellationPayload({conv:'c'.repeat(32),tid:request.tid},request),null);
  assert.deepEqual(cancellationPayload({conv:request.conv,tid:request.tid},request),{tid:request.tid});
 });
 await check('real harness completes greeting, adjustable quote, captured media and supplied chart without numeric open.turn',async()=>{
  const report=await runGate({browser,cookie:'jl=fixture',cases:frozen.filter(c=>['g01','g17','g06','g21'].includes(c.id)),output:path.join(work,'batch'),forceBindingInspection:true,readStatus,configureContext:fixtures,kind:'OFFLINE: real harness/page/renderer; quote/greeting are fixtures, media/chart programs are captured r2 output; photo responses are fixtures.'});
  assert.equal(report.completed,true,JSON.stringify(report));assert.equal(report.mechanism_failures,0,JSON.stringify(report.rows.map(r=>({id:r.id,errors:r.errors,phase:r.error_phase}))));
  assert.equal(report.rows.length,4);assert.equal(report.rows.find(r=>r.id==='g17').recomputation.edits.length,3);assert.ok(report.rows.every(r=>r.screenshots.length===3));
  return{completed:4,viewports:[320,390,430],screenshots:12,quantity:5,total:360000,network:'fixtures only'};
 });
 await check('captured bill controls recompute locally under the repaired runtime',async()=>{
  const context=await browser.newContext({viewport:{width:390,height:950}});try{
   await fixtures(context);const page=await context.newPage();await page.goto(origin,{waitUntil:'domcontentloaded'});await page.waitForFunction(()=>typeof window.__jarvisDraw==='function');
   await page.evaluate(answer=>{window.__jarvisMode('text');window.__jarvisModes=()=>({mode:'text'});window.__jarvisConvId=()=> 'd'.repeat(32);const node=window.__jarvisDraw(answer),turn=document.createElement('section');turn.className='turn';turn.append(node);document.querySelector('#content').replaceChildren(turn);},captured.find(r=>r.id==='g18').answer);
   const frame=page.frameLocator('.jr-openui-frame');await frame.getByLabel('Number of people',{exact:true}).fill('5');await frame.getByText(/UGX 30,600/).waitFor();
   return{people:5,perPerson:30600,scope:'Captured r2 bill program replay; bill amount remains fixed in that old program, and the r3 prompt requires all inputs editable.'};
  }finally{await context.close();}
 });
 await check('browser gate edits bill amount, people and tip without another model turn',async()=>{
  const report=await runGate({browser,cookie:'jl=fixture',cases:frozen.filter(c=>c.id==='g18'),output:path.join(work,'editable-bill'),forceBindingInspection:true,readStatus,configureContext:ctx=>fixtures(ctx,false,true),kind:'OFFLINE: editable bill output and network are fixtures.'});
  assert.equal(report.mechanism_failures,0,JSON.stringify(report.rows.map(r=>r.errors)));assert.equal(report.rows[0].recomputation.edits.length,3);return report.rows[0].recomputation;
 });
 await check('a setup failure preserves its cause and sends no unverified cancellation',async()=>{
  let stops=0;const report=await runGate({browser,cookie:'jl=fixture',cases:[frozen[0]],output:path.join(work,'setup-failure'),readStatus:async()=>({ok:()=>false}),allowCancel:true,cancelTurn:async()=>{stops++;throw Error('must not run');}});
  assert.equal(stops,0);assert.ok(report.rows[0].errors.includes('staging is busy or unavailable'));assert.ok(report.rows[0].cancel_skipped);return{stops,originalErrorRetained:true};
 });
 await check('failed service validator preflight sends zero model turns',async()=>{
  let pages=0;const report=await runGate({browser,cookie:'jl=fixture',cases:[frozen[0]],output:path.join(work,'validator-failure'),readStatus:async(ctx,url)=>url.endsWith('/healthz')?ok({ok:true,turns:0}):ok({ok:false,error:'validator_runtime_missing'}),configureContext:async()=>{pages++;},allowCancel:true});
  assert.equal(pages,0);assert.equal(report.rows[0].requests.length,0);assert.ok(report.rows[0].errors.some(e=>e.includes('validator_runtime_missing')));return{pageLoads:0,modelTurns:0};
 });
 await check('an incomplete owned stream uses tid-only cancellation and survives a cancellation error',async()=>{
  let payload;const report=await runGate({browser,cookie:'jl=fixture',cases:[frozen[0]],output:path.join(work,'incomplete'),readStatus,configureContext:ctx=>fixtures(ctx,true),allowCancel:true,cancelTurn:async(ctx,data)=>{payload=data;throw Error('fixture cancellation offline');}});
  assert.ok(payload&&typeof payload.tid==='string');assert.equal('turn' in payload,false);assert.ok(report.rows[0].errors.includes('no done event'));assert.equal(report.rows[0].cancel_error,'fixture cancellation offline');return{payloadKeys:Object.keys(payload),originalErrorRetained:true};
 });
})().catch(e=>{checks.push({name:'startup',status:'FAIL',detail:e.stack});console.error(e.message);}).finally(async()=>{
 if(browser)await browser.close();const result={kind:'Offline real-browser harness integration; not patched staging proof.',passed:checks.filter(c=>c.status==='PASS').length,total:checks.length,checks};
 if(opt('--report'))fs.writeFileSync(opt('--report'),JSON.stringify(result,null,2)+'\n');fs.rmSync(work,{recursive:true,force:true});process.exitCode=checks.some(c=>c.status==='FAIL')?1:0;
});
