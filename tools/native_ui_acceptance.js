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
const checks=[],requests=[],diagnostics=[];
let browser;
async function check(name,fn){try{const detail=await fn();checks.push({name,status:'PASS',detail});console.log('PASS '+name);}catch(e){checks.push({name,status:'FAIL',detail:e.stack});console.error('FAIL '+name+': '+e.message);}}
async function pageAt(width,theme='dark'){
  const context=await browser.newContext({viewport:{width,height:900},colorScheme:theme});
  await context.route('**/*',async route=>{
    const request=route.request(),url=new URL(request.url());requests.push({method:request.method(),origin:url.origin,path:url.pathname});
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
      if(screens)await page.screenshot({path:path.join(screens,'table-'+width+'-'+theme+'.png')});
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
      if(screens)await page.screenshot({path:path.join(screens,'native-quote-stream.png')});
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
})().catch(e=>{checks.push({name:'browser-startup',status:'BLOCKED',detail:e.message});console.error(e.message);}).finally(async()=>{
  if(browser)await browser.close();
  const result={kind:'Offline real-browser acceptance; all network responses are local fixtures.',browser:browser?browser.version():null,checks,requests,diagnostics,passed:checks.filter(r=>r.status==='PASS').length,total:checks.length};
  if(report){fs.mkdirSync(path.dirname(path.resolve(report)),{recursive:true});fs.writeFileSync(report,JSON.stringify(result,null,2)+'\n');}
  process.exitCode=checks.some(r=>r.status!=='PASS')?1:0;
});
