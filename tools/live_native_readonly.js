/* Read an explicitly named review conversation. Never creates a turn or calls a write endpoint. */
'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const cp=require('node:child_process'),crypto=require('node:crypto');
const {chromium}=require('playwright'),args=process.argv.slice(2),get=k=>args.includes(k)?args[args.indexOf(k)+1]:null;
const origin=get('--origin'),conv=get('--conv'),cookieFile=get('--cookie-file'),profile=get('--profile'),report=get('--report');
if(origin!=='https://live.battemohammad.com'||!/^[0-9a-f]{32}$/.test(conv||'')||!cookieFile||!profile)throw Error('Explicit review origin, conversation, private cookie file and scratch profile required');
if(fs.statSync(cookieFile).mode&0o077)throw Error('Cookie file must be owner-only');
const cookie=fs.readFileSync(cookieFile,'utf8').trim();if(!cookie.startsWith('jl=')||/[\r\n]/.test(cookie))throw Error('Invalid private cookie header');
const requests=[],blocked=[];let context;
(async()=>{
  fs.mkdirSync(profile,{recursive:true,mode:0o700});
  const proxyUrl=process.env.HTTPS_PROXY||process.env.https_proxy;
  const proxy=proxyUrl?new URL(proxyUrl):null;
  const cert=process.env.CODEX_PROXY_CERT,trust=[];
  if(proxy&&cert&&fs.existsSync(cert)){
    // Trust only the supplied runtime proxy key, as the Python HTTPS client already does.
    // This does not disable verification for arbitrary certificates or additional origins.
    const pem=cp.execFileSync('openssl',['x509','-in',cert,'-pubkey','-noout']);
    const der=cp.execFileSync('openssl',['pkey','-pubin','-outform','DER'],{input:pem});
    trust.push('--ignore-certificate-errors-spki-list='+crypto.createHash('sha256').update(der).digest('base64'));
  }
  context=await chromium.launchPersistentContext(profile,{executablePath:get('--browser')||undefined,headless:true,viewport:{width:390,height:900},
    ...(proxy?{proxy:{server:proxy.origin,username:decodeURIComponent(proxy.username),password:decodeURIComponent(proxy.password)}}:{}),
    args:['--no-sandbox','--disable-dev-shm-usage','--disable-gpu','--remote-debugging-port=9222','--remote-debugging-address=127.0.0.1',...trust]});
  await context.addCookies([{name:'jl',value:cookie.slice(3),url:origin,secure:true,httpOnly:true,sameSite:'Lax'}]);
  await context.route('**/*',async route=>{
    const r=route.request(),u=new URL(r.url());
    const read=r.method()==='GET'&&((u.origin===origin&&(
      ['/', '/healthz','/build','/api/sessions','/api/v1/node/ui'].includes(u.pathname)||
      u.pathname==='/api/sessions/'+conv||u.pathname==='/api/response/context/'+conv||
      u.pathname.startsWith('/static/')||u.pathname.startsWith('/vendor/')))||
      (u.origin==='https://widgets.battemohammad.com'&&u.pathname.startsWith('/w/runtime/')));
    (read?requests:blocked).push({method:r.method(),origin:u.origin,path:u.pathname});
    if(!read)return route.abort();
    return route.continue(u.origin===origin?{headers:{...r.headers(),Origin:origin}}:{});
  });
  const page=await context.newPage();await page.goto(origin,{waitUntil:'domcontentloaded',timeout:45000});
  await page.waitForFunction(()=>typeof window.__jarvisDraw==='function'&&typeof window.__jarvisOpenSession==='function',{timeout:15000});
  await page.evaluate(conv=>{window.__jarvisMode('text');window.__jarvisModes=()=>({mode:'text'});window.__jarvisOpenSession(conv,'Review bill splitter');},conv);
  await page.locator('.jr-response-frame').waitFor({state:'visible',timeout:20000});
  const frame=page.frameLocator('.jr-response-frame');await frame.locator('#input-people').fill('4');
  await page.waitForFunction(conv=>[...window.JarvisResponses.records].some(r=>r.ready&&r.conv===conv&&r.node.isConnected&&r.values.people===4),conv);
  const records=await page.evaluate(()=>[...window.JarvisResponses.records].filter(r=>r.ready&&!r.dead&&r.node.isConnected&&r.node.closest('.turn')).map(r=>({ready:r.ready,component:r.result.spec.component,conv:r.conv,turn:r.node.closest('.turn').dataset.id,inputs:r.values})));
  assert.ok(records.some(r=>r.component==='bill-splitter'&&r.ready&&r.conv===conv&&r.inputs.people===4));
  return {status:'PASS',kind:'Actual deployed conversation and native iframe; automated input, not a human interaction test.',records,requests,blocked,live_posts:0};
})().then(r=>{if(report)fs.writeFileSync(report,JSON.stringify(r,null,2)+'\n');console.log(JSON.stringify({status:r.status,records:r.records,live_posts:0}));}).catch(e=>{
  if(report)fs.writeFileSync(report,JSON.stringify({status:'UNVERIFIED',reason:e.message,requests,blocked,live_posts:0},null,2)+'\n');
  console.error(e.message);process.exitCode=1;
}).finally(async()=>{if(context){await context.clearCookies();await context.close();}fs.rmSync(profile,{recursive:true,force:true});});
