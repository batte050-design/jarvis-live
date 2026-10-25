/* Real Chromium, real painter/broker/opaque frame. All server facts and streams here are fixtures.
   No external requests, credentials or live model calls. */
'use strict';
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process'),assert=require('node:assert/strict');
const {chromium}=require('playwright');
const args=process.argv.slice(2),option=n=>args.includes(n)?args[args.indexOf(n)+1]:null;
const root=path.resolve(option('--root')||path.join(__dirname,'..')),report=option('--report'),screens=option('--screenshots');
const app='https://jarvis-native.invalid',widget='https://jarvis-widget.invalid';
const assets=JSON.parse(cp.execFileSync('python3',['-c',
  "import json,response_layer as l,response_authoring as a,response_sources as s\nh,headers=l.document('https://jarvis-native.invalid')\nwith s.turn('Chart my figures: January 10, February 20, March 15.') as e:\n r=e.retrieve({'provider':'user_input','symbol':'','start':'','end':'','period':'month'});chart=a.emit('emit_chart',{'title':'Supplied figures','chart':'bar','points':r['points'],'source':r['source']})\nprint(json.dumps({'html':h,'headers':headers,'hash':l.assets()[1],'runtime':l.assets()[2],'chart':chart,'quote':a.emit('emit_quote',{'title':'Quote','currency':'UGX','quantity':2,'unit_price':10000,'discount_percent':0})}))"],{cwd:root,encoding:'utf8'}));
const manifest=JSON.parse(fs.readFileSync(path.join(root,'response-capabilities.json')));
const extended=args.includes('--openui');
if(extended){
  const cases=JSON.parse(fs.readFileSync(path.join(root,'tests/fixtures/openui-cases.json')));
  for(const [name,c] of Object.entries(cases)){
    // Raw declarations are intentional: the exact-base browser must reject the new extension.
    assets[name+'Composed']={type:'widget',version:1,component:'application',id:'native-'+name,
      props:{title:c.title,currency:c.currency},...Object.fromEntries(['inputs','graph','outputs','actions','layout','fallback'].map(k=>[k,c[k]]))};
  }
  assets.naturalQuote=JSON.parse(cp.execFileSync('python3',['-c',"import json,response_authoring as a;print(json.dumps(a.emit('emit_quote',{'title':'Inspection quote','currency':'UGX','quantity':4,'unit_price':80000,'discount_percent':10})))"],{cwd:root,encoding:'utf8'}));
  assets.fx=JSON.parse(cp.execFileSync('python3',['-c',"import json,datetime as d,response_sources as s,response_authoring as a\nf=json.load(open('tests/fixtures/openui-fx.json'))\nwith s.turn('Compare USD vs UGX for the past 6 months.',network=True,fetch=lambda q:f['payload'],clock=lambda:d.datetime.fromisoformat(f['clock'].replace('Z','+00:00'))) as e:\n r=e.retrieve(f['request']);v=a.emit('emit_chart',{'title':r['title'],'chart':'line','points':r['points'],'source':r['source']});print(json.dumps(v))"],{cwd:root,encoding:'utf8'}));
}
const checks=[],requests=[],diagnostics=[];
let browser;
async function check(name,fn){try{const detail=await fn();checks.push({name,status:'PASS',detail});console.log('PASS '+name);}catch(e){checks.push({name,status:'FAIL',detail:e.stack});console.error('FAIL '+name+': '+e.message);}}
async function capture(page,options){
  await page.evaluate(()=>{window.scrollTo(0,0);document.querySelectorAll('*').forEach(n=>{if(n.scrollTop)n.scrollTop=0;});});
  return page.screenshot(options);
}
async function pageAt(width,theme='dark',partial=false){
  const context=await browser.newContext({viewport:{width,height:900},colorScheme:theme,hasTouch:true});
  await context.route('**/*',async route=>{
    const request=route.request(),url=new URL(request.url());requests.push({method:request.method(),origin:url.origin,path:url.pathname});
    if(request.method()==='POST'&&url.pathname==='/stream'&&partial){
      const conv='b'.repeat(32),tid='d'.repeat(16),text='The total is UGX 288,000. The interactive version could not be built; nothing here is adjustable.';
      const events=[['open',{turn:1,conv,tid}],['work',{state:'start'}],['note',{partial:true,text:''}],['tok',{d:text}],['text',{text}],['work',{state:'done'}],['done',{completed:true}]];
      return route.fulfill({contentType:'text/event-stream',body:events.map(([e,d],i)=>'event: '+e+'\ndata: '+JSON.stringify({...d,conv,tid,seq:i})+'\n\n').join('')});
    }
    if(request.method()!=='GET')return route.fulfill({status:403,body:'Offline fixture server: writes are disabled'});
    if(url.origin===widget&&url.pathname==='/w/runtime/'+assets.runtime)return route.fulfill({status:200,body:assets.html,headers:{...assets.headers,'Content-Type':'text/html'}});
    if(url.origin!==app)return route.abort();
    if(url.pathname==='/')return route.fulfill({status:200,contentType:'text/html',body:fs.readFileSync(path.join(root,'index_v1.html'),'utf8')});
    if(url.pathname.startsWith('/static/')||url.pathname.startsWith('/vendor/')){
      const file=path.resolve(root,'.'+url.pathname);if(!file.startsWith(root+path.sep)||!fs.existsSync(file))return route.fulfill({status:404,body:''});
      const ext=path.extname(file),mime={'.js':'application/javascript','.css':'text/css','.woff2':'font/woff2','.png':'image/png','.webp':'image/webp'}[ext]||'application/octet-stream';
      return route.fulfill({status:200,contentType:mime,body:fs.readFileSync(file)});
    }
    if(url.pathname.startsWith('/api/response/context/'))return route.fulfill({json:{ok:true,account:'native_test',epoch:'a'.repeat(64),prefs:{...manifest.defaults,remember:true},canConfigure:false,enabled:true,widgetOrigin:widget,manifest:assets.hash,runtime:assets.runtime}});
    if(url.pathname==='/build'){
      const m=fs.readFileSync(path.join(root,'index_v1.html'),'utf8').match(/name="jl-build" content="([^|]+)\|([^|]+)/);
      return route.fulfill({json:{js:m[2],css:m[1]}});
    }
    if(url.pathname==='/api/v1/node/ui')return route.fulfill({json:{ok:true,ui:{material:'ink',mode:'device',density:'normal',autoplay:false,transcript_turns:0}}});
    return route.fulfill({json:{ok:true,sessions:[],turns:[],devices:[],rows:[],steps:[]}});
  });
  const page=await context.newPage();page.on('pageerror',e=>diagnostics.push(e.message));
  await page.goto(app,{waitUntil:'domcontentloaded'});
  await page.waitForFunction(()=>typeof window.__jarvisDraw==='function');
  await page.evaluate(({theme})=>{
    document.documentElement.setAttribute('data-theme',theme);document.body.dataset.mode='text';
    window.__jarvisMode('text');window.__jarvisModes=()=>({mode:'text'});window.__jarvisConvId=()=> 'b'.repeat(32);
  },{theme});
  return {page,context};
}
const table='| Building | City | Height m | Completed | Rank |\n| --- | --- | --- | --- | --- |\n| Burj Khalifa | Dubai | 828 | 2010 | 1 |\n| Merdeka 118 | Kuala Lumpur | 679 | 2023 | 2 |\n| Shanghai Tower | Shanghai | 632 | 2015 | 3 |';
(async()=>{
  if(screens)fs.mkdirSync(screens,{recursive:true});
  browser=await chromium.launch({executablePath:option('--browser')||undefined,headless:true,args:['--no-sandbox','--disable-dev-shm-usage','--disable-gpu']});
  for(const width of [320,390,430])for(const theme of ['dark','light'])await check('five-column table '+width+'px '+theme,async()=>{
    const {page,context}=await pageAt(width,theme);
    try{
      await page.evaluate(text=>{
        const answer=window.__jarvisDraw(text),turn=document.createElement('section');turn.className='turn';turn.dataset.id='c'.repeat(16);answer.className='t-a';turn.append(answer);document.querySelector('#content').replaceChildren(turn);
      },table);
      await page.evaluate(()=>document.fonts.ready);
      const measurement=await page.evaluate(()=>{
        const wrap=document.querySelector('.rc-tw'),table=wrap.querySelector('table'),r=wrap.getBoundingClientRect(),p=wrap.parentElement.getBoundingClientRect();
        const words=[];
        for(const td of table.querySelectorAll('td:not(.num)'))for(const text of td.childNodes){
          if(text.nodeType!==Node.TEXT_NODE)continue;
          for(const match of text.textContent.matchAll(/\S+/g)){const range=document.createRange();range.setStart(text,match.index);range.setEnd(text,match.index+match[0].length);words.push({word:match[0],lines:range.getClientRects().length});}
        }
        const numbers=[...table.querySelectorAll('td.num')].map(td=>({value:td.textContent,whiteSpace:getComputedStyle(td).whiteSpace,clipped:td.scrollWidth>td.clientWidth+1}));
        wrap.scrollLeft=wrap.scrollWidth;const last=table.querySelector('tbody tr').lastElementChild.getBoundingClientRect();
        return {viewport:innerWidth,page:document.documentElement.scrollWidth,wrapper:{left:r.left,right:r.right,width:r.width},column:{left:p.left,right:p.right},scrollWidth:wrap.scrollWidth,clientWidth:wrap.clientWidth,scrollLeft:wrap.scrollLeft,lastRight:last.right,words,numbers,font:getComputedStyle(document.body).fontFamily};
      });
      assert.ok(measurement.page<=width+1,JSON.stringify(measurement));
      assert.ok(measurement.wrapper.left>=measurement.column.left-1&&measurement.wrapper.right<=measurement.column.right+1);
      assert.ok(measurement.scrollWidth>measurement.clientWidth&&measurement.scrollLeft>0);
      assert.ok(measurement.lastRight<=measurement.wrapper.right+1,'last column cannot be reached');
      assert.ok(measurement.words.every(w=>w.lines===1),'a name broke mid-word');
      assert.ok(measurement.numbers.every(n=>n.whiteSpace==='nowrap'&&!n.clipped),'a numeric cell broke or clipped');
      if(screens)await capture(page,{path:path.join(screens,'table-'+width+'-'+theme+'.png')});
      return measurement;
    }finally{await context.close();}
  });
  await check('native opaque frame keeps edited input while actual painter streams and settles',async()=>{
    const {page,context}=await pageAt(390);
    try{
      const text='Supplied quote.\n\n```ui\n'+JSON.stringify(assets.quote)+'\n```\n\n';
      await page.evaluate(text=>{window.__jarvisTurnStart('Offline native quote test.','b'.repeat(32));window.__jarvisReply(text);},text);
      const iframe=page.locator('.jr-response-frame');await iframe.waitFor({state:'visible',timeout:15000});
      const frame=page.frameLocator('.jr-response-frame');await frame.locator('#input-quantity').fill('7');
      await page.waitForFunction(()=>[...window.JarvisResponses.records].some(r=>r.ready&&r.values.quantity===7));
      await page.evaluate(()=>{window.__nativeTestFrame=document.querySelector('.jr-response-frame');});
      await page.evaluate(({text})=>{window.__jarvisReply('Further explanation while writing.\n');window.__jarvisTurnEnd(text+'Further explanation while writing.\n');},{text});
      diagnostics.push(JSON.stringify({phase:'after-settlement',frames:page.frames().map(f=>f.url()),state:await page.evaluate(()=>[...window.JarvisResponses.records].map(r=>({ready:r.ready,dead:r.dead,connected:r.node.isConnected,frameConnected:r.frame&&r.frame.isConnected,value:r.values.quantity,src:r.frame&&r.frame.src})))}));
      assert.equal(await page.evaluate(()=>document.querySelector('.jr-response-frame')===window.__nativeTestFrame),true);
      assert.equal(await frame.locator('#input-quantity').inputValue({timeout:3000}),'7');
      const mounted=await page.evaluate(()=>[...window.JarvisResponses.records].map(r=>({ready:r.ready,quantity:r.values.quantity,turn:r.node.closest('.turn').dataset.id,conv:r.conv})));
      assert.equal(mounted.length,1);assert.equal(mounted[0].ready,true);assert.match(mounted[0].turn,/^[0-9a-f]{8,40}$/);
      const style=await frame.locator('body').evaluate(el=>({font:getComputedStyle(el).fontFamily,accent:getComputedStyle(el).getPropertyValue('--accent').trim(),viewport:innerWidth,bodyWidth:el.scrollWidth,horizontal:el.scrollWidth>innerWidth+1,overflows:[...el.querySelectorAll('*')].filter(n=>n.getBoundingClientRect().right>innerWidth+1).map(n=>({tag:n.tagName,cls:n.className,right:n.getBoundingClientRect().right,text:n.textContent.slice(0,40)}))}));
      diagnostics.push(JSON.stringify({phase:'frame-style',style}));
      assert.equal(style.accent,'#BD765C');assert.equal(style.horizontal,false,JSON.stringify(style));
      if(screens)await capture(page,{path:path.join(screens,'native-quote-stream.png')});
      return {mounted,style,kind:'Real browser and real frame protocol; scripted answer, automated input; not human/live-provider proof.'};
    }finally{await context.close();}
  });
  await check('supplied-data chart mounts only after its complete declaration and displays its credit',async()=>{
    const {page,context}=await pageAt(320);
    try{
      const fence='```ui\n'+JSON.stringify(assets.chart)+'\n```\n\n',cut=Math.floor(fence.length/2);
      await page.evaluate(text=>{window.__jarvisTurnStart('Offline supplied chart test.','b'.repeat(32));window.__jarvisReply(text);},fence.slice(0,cut));
      assert.equal(await page.locator('.jr-response-frame').count(),0);
      assert.equal(await page.locator('.t-a').filter({hasText:'"component"'}).count(),0);
      await page.evaluate(text=>window.__jarvisReply(text),fence.slice(cut));
      await page.locator('.jr-response-frame').waitFor({state:'visible',timeout:15000});
      const frame=page.frameLocator('.jr-response-frame'),text=await frame.locator('body').innerText();
      assert.equal(await frame.locator('figure').count(),1);
      assert.match(text,/Source: your supplied figures/);assert.match(text,/recorded this turn:/);
      assert.ok(text.includes('January')&&text.includes('February')&&text.includes('March'));
      return {oneChart:true,credit:'reader-supplied, recorded this turn',completeBeforeMount:true};
    }finally{await context.close();}
  });
  if(extended){
    async function mount(page,spec){
      const fence='```ui\n'+JSON.stringify(spec)+'\n```\n\n',cut=Math.floor(fence.length/2);
      await page.evaluate(t=>{window.__jarvisTurnStart('Offline Open Intelligent UI acceptance.','b'.repeat(32));window.__jarvisReply(t);},fence.slice(0,cut));
      assert.equal(await page.locator('.jr-response-frame').count(),0,'partial declaration mounted');
      assert.equal(await page.locator('.t-a').filter({hasText:'"component"'}).count(),0,'raw JSON displayed');
      await page.evaluate(t=>window.__jarvisReply(t),fence.slice(cut));
      await page.locator('.jr-response-frame').waitFor({state:'visible',timeout:5000});
      const frame=page.frameLocator('.jr-response-frame');
      await frame.locator('body').evaluate(()=>document.fonts.ready);
      const height=await frame.locator('body').evaluate(()=>Math.ceil(Math.max(document.querySelector('main').scrollHeight,document.querySelector('main').getBoundingClientRect().height)+24));
      await page.waitForFunction(h=>Math.abs(document.querySelector('.jr-response-frame').getBoundingClientRect().height-Math.min(innerHeight*.7,Math.max(160,h)))<=2,height);
      await frame.locator('body').evaluate(()=>window.scrollTo(0,0));
      return {frame,fence};
    }
    await check('ordinary quote wording mounts primitive form, recomputes and survives streaming without a new turn',async()=>{
      const {page,context}=await pageAt(390);
      try{
        const {frame,fence}=await mount(page,assets.naturalQuote);
        assert.equal(await frame.locator('[data-primitive=Form]').count(),1);
        const dimensions=await frame.locator('body').evaluate(()=>({viewport:innerHeight,content:Math.ceil(Math.max(document.querySelector('main').scrollHeight,document.querySelector('main').getBoundingClientRect().height)+24)}));
        assert.ok(Math.abs(dimensions.viewport-Math.min(630,Math.max(160,dimensions.content)))<=2,'frame is clipped or retains excess height: '+JSON.stringify(dimensions));
        assert.equal(await frame.locator('#input-quantity').inputValue(),'4');assert.equal(await frame.locator('#input-price').inputValue(),'80000');
        assert.equal(await frame.locator('#input-discount').inputValue(),'1000');
        const before=requests.filter(r=>r.method==='POST'&&r.path==='/stream').length;
        await frame.locator('#input-quantity').fill('5');
        await page.waitForFunction(()=>[...window.JarvisResponses.records].some(r=>r.ready&&r.values.quantity===5));
        await frame.locator('.jr-metrics').filter({hasText:'360,000'}).waitFor();
        assert.match(await frame.locator('.jr-metrics').innerText(),/360,000/);
        await frame.locator('summary').click();assert.match(await frame.locator('table').innerText(),/400,000/);
        await page.evaluate(()=>{window.__openuiFrame=document.querySelector('.jr-response-frame');window.__jarvisReply('Extra explanation while streaming.');});
        await page.evaluate(t=>window.__jarvisTurnEnd(t+'Extra explanation while streaming.'),fence);
        assert.equal(await frame.locator('#input-quantity').inputValue(),'5');assert.equal(await page.evaluate(()=>document.querySelector('.jr-response-frame')===window.__openuiFrame),true);
        assert.equal(requests.filter(r=>r.method==='POST'&&r.path==='/stream').length,before);
        if(screens)await capture(page,{path:path.join(screens,'openui-quote-390.png')});
        return {initial:[4,80000,10],changedQuantity:5,total:360000,sameFrame:true,additionalTurns:0,dimensions};
      }finally{await context.close();}
    });
    await check('model-arranged grid and cards keep their input nodes on local recompute',async()=>{
      const {page,context}=await pageAt(430);
      try{
        const {frame,fence}=await mount(page,assets.quoteComposed);
        assert.equal(await frame.locator('[data-primitive=Grid]').count(),1);assert.equal(await frame.locator('[data-primitive=Card]').count(),1);
        await frame.locator('#input-price').fill('90000');
        await page.waitForFunction(()=>[...window.JarvisResponses.records].some(r=>r.ready&&r.values.price===90000));
        await frame.locator('.jr-metrics').filter({hasText:'324,000'}).waitFor();
        assert.match(await frame.locator('.jr-metrics').innerText(),/324,000/);
        await page.evaluate(t=>window.__jarvisTurnEnd(t),fence);
        if(screens)await capture(page,{path:path.join(screens,'openui-grid-430.png')});
        return {genericApplication:true,unitPrice:90000,total:324000};
      }finally{await context.close();}
    });
    await check('timeline and carousel are real scrollable native content',async()=>{
      const {page,context}=await pageAt(320);
      try{
        const {frame,fence}=await mount(page,assets.planComposed);
        assert.equal(await frame.locator('[data-primitive=Timeline] > li').count(),2);
        const geometry=await frame.locator('[data-primitive=Carousel]').evaluate(n=>{n.scrollLeft=n.scrollWidth;return {scroll:n.scrollWidth,width:n.clientWidth,left:n.scrollLeft,page:document.documentElement.scrollWidth,viewport:innerWidth};});
        assert.ok(geometry.scroll>geometry.width&&geometry.left>0);assert.ok(geometry.page<=geometry.viewport+1);
        await page.evaluate(t=>window.__jarvisTurnEnd(t),fence);
        if(screens)await capture(page,{path:path.join(screens,'openui-plan-320.png')});
        return geometry;
      }finally{await context.close();}
    });
    await check('text area, date, select, checkbox and local button are usable without a model turn',async()=>{
      const {page,context}=await pageAt(390);
      try{
        const {frame,fence}=await mount(page,assets.preferencesComposed);
        await frame.locator('#input-note').fill('Check brakes and lights');
        await frame.locator('#input-date').fill('2026-10-25');
        await frame.locator('#input-format').selectOption('detailed');
        await frame.getByRole('button',{name:'No photos',exact:true}).click();
        await frame.locator('[data-primitive=Card]').filter({hasText:'Photos excluded'}).waitFor();
        assert.equal(await frame.locator('#input-include').isChecked(),false);
        const result=await frame.locator('[data-primitive=Card]').innerText();
        assert.match(result,/Check brakes and lights/);assert.match(result,/2026-10-25/);assert.match(result,/detailed/);
        await page.evaluate(t=>window.__jarvisTurnEnd(t),fence);
        return {text:'Check brakes and lights',date:'2026-10-25',select:'detailed',photos:false,localButton:true};
      }finally{await context.close();}
    });
    for(const width of [320,390,430])for(const theme of ['dark','light'])await check('dated FX line chart, units and real touch targets '+width+'px '+theme,async()=>{
      const {page,context}=await pageAt(width,theme);
      try{
        const {frame,fence}=await mount(page,assets.fx);
        assert.equal(assets.fx.outputs[0].chart,'line');assert.equal(assets.fx.outputs[0].points.length,7);
        const sizes=await frame.locator('.jr-chart-points button').evaluateAll(nodes=>nodes.map(n=>{const r=n.getBoundingClientRect();return {w:r.width,h:r.height};}));
        assert.equal(sizes.length,assets.fx.outputs[0].points.length);assert.ok(sizes.every(r=>r.w>=44&&r.h>=44));
        assert.ok(await frame.locator('.jr-chart-tick').count()>=3);assert.ok(await frame.locator('.jr-chart-date').count()>=3);
        assert.equal(await frame.locator('.jr-chart-unit').textContent(),'UGX per USD');
        const dates=await frame.locator('.jr-chart-date').allTextContents();assert.ok(dates.includes('Apr')&&dates.includes('Oct'));
        await frame.locator('.jr-chart-points button').first().tap();assert.ok((await frame.locator('.jr-chart-selected').innerText()).startsWith(assets.fx.outputs[0].points[0].label+':'));
        const layout=await frame.locator('body').evaluate(n=>({width:innerWidth,page:document.documentElement.scrollWidth,tick:parseFloat(getComputedStyle(document.querySelector('.jr-chart-tick')).fontSize)*document.querySelector('.jr-chart').getBoundingClientRect().width/320}));
        assert.ok(layout.page<=layout.width+1);assert.ok(layout.tick>=12,'chart tick text too small: '+layout.tick);
        await page.evaluate(t=>window.__jarvisTurnEnd(t),fence);
        await frame.locator('body').evaluate(()=>window.scrollTo(0,0));
        if(screens)await capture(page,{path:path.join(screens,'openui-chart-'+width+'-'+theme+'.png')});
        return {targets:sizes,...layout,labels:dates,unit:'UGX per USD',touchSelection:assets.fx.outputs[0].points[0].label,kind:'Dated, scripted source fixture; not current exchange-rate evidence'};
      }finally{await context.close();}
    });
    await check('real SSE transport settles a missing control as TEXT ONLY',async()=>{
      const {page,context}=await pageAt(390,'dark',true);
      try{
        await page.evaluate(()=>window.ask('Offline partial response acceptance.','text'));
        await page.waitForFunction(()=>document.body.innerText.includes('TEXT ONLY'));
        assert.equal(await page.locator('.jr-response-frame').count(),0);
        const text=await page.locator('body').innerText();assert.ok(!text.includes('WORKED'));assert.ok(!text.includes('"component"'));assert.ok(!text.includes('Adjust the figures below'));
        if(screens)await capture(page,{path:path.join(screens,'openui-partial-390.png')});
        return {transport:'actual readSSE and painter, local scripted frames',badge:'TEXT ONLY',controls:0};
      }finally{await context.close();}
    });
  }
})().catch(e=>{checks.push({name:'browser-startup',status:'BLOCKED',detail:e.message});console.error(e.message);}).finally(async()=>{
  if(browser)await browser.close();
  const result={kind:'Offline real-browser acceptance; all network responses are local fixtures.',browser:browser?browser.version():null,checks,requests,diagnostics,passed:checks.filter(r=>r.status==='PASS').length,total:checks.length};
  if(report){fs.mkdirSync(path.dirname(path.resolve(report)),{recursive:true});fs.writeFileSync(report,JSON.stringify(result,null,2)+'\n');}
  process.exitCode=checks.some(r=>r.status!=='PASS')?1:0;
});
