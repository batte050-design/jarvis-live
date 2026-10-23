'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {painter,snapshot}=require('./response_painter');
const args=process.argv.slice(2),root=path.resolve(args.includes('--root')?args[args.indexOf('--root')+1]:path.join(__dirname,'..'));
const basePath=args.includes('--base-v1')?args[args.indexOf('--base-v1')+1]:null;
const only=args.includes('--case')?args[args.indexOf('--case')+1]:null;
const manifest=JSON.parse(fs.readFileSync(path.join(root,'response-capabilities.json'))),makeParent=require(path.join(root,'static/response-parent'));
const makeCore=require(path.join(root,'static/response-core')),makeStore=require(path.join(root,'static/response-store'));
const spec=()=>({type:'widget',version:1,id:'quote',component:'quote-estimator',fallback:'Estimate the cost from quantity, price and discount.'});
const fence=s=>'```ui\n'+JSON.stringify(s)+'\n```';
const pending=[];let checks=0;
async function check(group,name,fn){if(only&&only!==group)return;await fn();console.log('PASS',name);checks++;}
function environment(){
 const p=painter(root,null),document=p.document,storage=new Map(),calls=[],data={ok:true,account:'owner',epoch:'a'.repeat(64),prefs:{...manifest.defaults,remember:false},enabled:true,canConfigure:true,widgetOrigin:'https://widgets.example.test',manifest:'b'.repeat(64),runtime:'c'.repeat(64)};
 const store={installation:async()=> 'install',prune:async()=>{},get:async()=>null,put:async(s,k,c,v)=>storage.set(k,v),clear:async()=>{},remove:async()=>{}};
 let conv='d'.repeat(32);
 const host={document,crypto:require('node:crypto').webcrypto,console:{warn(){}},location:{origin:'https://app.example.test'},innerHeight:800,
  __jarvisConvId:()=>conv,__jarvisModes:()=>({mode:'text'}),__jarvisGone:()=>[],__jarvisLiveTurn:()=>null,
  JarvisResponseCore:makeCore,JarvisResponseStore:()=>store,addEventListener(){},setInterval(){},MutationObserver:class{observe(){}},matchMedia:()=>({matches:false}),localStorage:{getItem:()=>''},
  fetch:async(url,opts)=>{calls.push({url,opts});return {ok:true,json:async()=>structuredClone(data)};},ask(){throw Error('rendering started a turn');}};
 const broker=makeParent(host,{manifest,hash:data.manifest,runtime:data.runtime});p.context.window.JarvisResponses=broker;
 const e={p,broker,data,host,calls,storage,setConv(id){conv=id;},cleanup(){document.body.replaceChildren();broker.sweep();}};pending.push(e);return e;
}
async function mounted(e,answer){const r=[...e.broker.records].find(r=>answer.contains(r.node));assert.ok(r,'declared component registered');await e.broker.activate(r);assert.ok(r.frame,'frame created');
 e.broker.message({source:r.frame.contentWindow,origin:'null',data:{type:'ready',nonce:r.nonce,manifest:e.data.manifest}});
 e.broker.message({source:r.frame.contentWindow,origin:'null',data:{type:'mounted',nonce:r.nonce}});assert.equal(r.frame.hidden,false);return r;}
function turn(e){const node=e.p.document.createElement('div'),answer=e.p.document.createElement('div');node.className='turn';node.dataset.id='1234567890abcdef';answer.className='t-a';node.appendChild(answer);e.p.document.body.appendChild(node);return answer;}
(async()=>{
 await check('ordinary','ordinary answers do not enter reconciliation',()=>{
  const e=environment();let reconciles=0;const original=e.broker.reconcile;e.broker.reconcile=(...a)=>{reconciles++;return original(...a);};
  const corpus=['One paragraph.\n\nAnother **paragraph**.','[[file:report.txt]]','Before [[file:report.pdf]] after.',
   '```python\nprint("hello")\n```','```markdown\nA nested example:\n```js\nconst x = 1;\n```\n```',
   '| Item | Price |\n| --- | --- |\n| A | 10 |\n| B | 20 |','| Item | Price |\n| A | 10 |\n| B | 20 |',
   '### Heading\n\n- First\n- Second','1. First\n2. Second','> Quoted **words**.','A [link](https://example.test) and `code`.',
   '```json\n{"component":"quote-estimator","version":1}\n```','````markdown\n```ui\n{"component":"application","version":1}\n```\n````'];
  const baseline=basePath?painter(root,null,fs.readFileSync(basePath,'utf8')):painter(root,null);
  for(const text of corpus){assert.deepEqual(snapshot(e.p.draw(text)),snapshot(baseline.draw(text)),text);const el=e.p.document.createElement('div');e.p.settle(el,text,true);assert.deepEqual(snapshot(el),snapshot(baseline.draw(text)),'settle: '+text);}
  assert.equal(reconciles,0);console.log(corpus.length+' ordinary fixtures matched layer-off painter');
 });
 await check('legacy','legacy choices retain their actual option controls',async()=>{
  const e=environment(),legacy={type:'choices',options:[{label:'First',value:'one'},{label:'Second',value:'two'}]};
  assert.equal(e.broker.fence(JSON.stringify(legacy)).handled,false);assert.equal(Object.hasOwn(manifest,'legacyAdapters'),false);
  const node=e.p.draw(fence(legacy));assert.equal(node.querySelectorAll('.ui-choice').length,2);assert.equal(node.querySelectorAll('.jr-component').length,0);assert.equal(node.querySelectorAll('button').length,3);assert.equal(e.broker.records.size,0);
 });
 await check('fallback','rejections never show payloads or enter heuristic fallbacks',()=>{
  const e=environment(),bad=[{...spec(),component:'unknown',fallback:undefined},{...spec(),version:900,fallback:undefined},{...spec(),inputs:'invalid',fallback:'Keep these readable words.'}];
  for(const s of bad){const node=e.p.draw(fence(s));assert.equal(node.textContent,s.fallback||'This interactive response could not be displayed.');assert.equal(node.querySelectorAll('.jr-response-review').length,0);assert.equal(e.broker.records.size,0);}
  for(const raw of ['{','null','[]','{"component":"unknown","version":1','{"type":"widget","component":"unknown","version":1}']){const result=e.broker.fence(raw);assert.equal(result.node.textContent,'This interactive response could not be displayed.');}
  const incomplete=e.p.draw('```ui\n'+JSON.stringify(spec()));assert.equal(incomplete.querySelectorAll('.jr-component').length,0);assert.equal(e.broker.records.size,0);
  const noPlugin=painter(root,null);assert.equal(noPlugin.draw(fence(bad[0])).textContent,'This interactive response could not be displayed.');
  const tooLarge={...spec(),padding:'x'.repeat(manifest.budgets.componentBytes)};assert.equal(e.p.draw(fence(tooLarge)).textContent,tooLarge.fallback);
  const duplicate=e.p.draw(fence(spec())+'\n\n'+fence(spec()));assert.equal(duplicate.querySelectorAll('.jr-component').length,1);assert.equal(duplicate.textContent.includes('"component"'),false);
 });
 await check('ordinary','mixed answers preserve the frame, values and ordinary rich nodes across paints',async()=>{
  const e=environment(),answer=turn(e),text='A **quote**.\n\n'+fence(spec())+'\n\n[[file:report.txt]]\n\n```python\nprint(1)\n```\n\nMore';
  e.p.settle(answer,text,false);const r=await mounted(e,answer),frame=r.frame,node=r.node;
  e.broker.message({source:frame.contentWindow,origin:'null',data:{type:'change',nonce:r.nonce,revision:1,inputs:{quantity:7,price:10000,discount:0}}});await r.pending;
  // Removing or re-inserting the iframe or any ancestor would reset a native browsing context.
  const remove=answer.removeChild.bind(answer),insert=answer.insertBefore.bind(answer);
  answer.removeChild=n=>{assert.equal(n.contains(frame),false,'retained frame was detached');return remove(n);};
  answer.insertBefore=(n,b)=>{assert.equal(n.contains(frame),false,'retained frame was moved');return insert(n,b);};
  for(const finished of [false,true]){e.p.settle(answer,text+' words.',finished);assert.equal(r.frame,frame);assert.equal(r.node,node);assert.equal(r.values.quantity,7);assert.equal(answer.querySelectorAll('iframe').length,1);assert.equal(answer.querySelectorAll('.ofile').length,1);assert.equal(answer.querySelectorAll('.rc-code').length,1);assert.ok(answer.textContent.includes('More words.'));}
  const old=e.p.document.createElement('div');old.className='t-a';e.p.draw(text,'prose',old);assert.ok(old.querySelector('.jr-component'));
 });
 await check('mount','mount waits for real identity and accepts the app\'s 16-hex turn ID',async()=>{
  const e=environment(),answer=turn(e);e.setConv('current');e.p.draw(fence(spec()),'prose',answer);let r=[...e.broker.records][0];await e.broker.activate(r);assert.equal(r.dead,false);assert.equal(r.started,false);assert.equal(r.frame,undefined);
  e.setConv('d'.repeat(32));r=await mounted(e,answer);assert.equal(r.ready,true);assert.equal(e.calls.length,1);
 });
 await check('mount','detached probes remain readable and missing identity expires without a request',async()=>{
  const e=environment(),node=e.p.draw(fence(spec()));const r=[...e.broker.records][0];await e.broker.activate(r);assert.equal(r.frame,undefined);assert.equal(node.textContent,spec().fallback);assert.equal(e.calls.length,0);
  r.created-=manifest.budgets.frameReadyMs+1;e.broker.sweep();assert.equal(r.dead,true);assert.ok(node.textContent.startsWith(spec().fallback));assert.ok(node.textContent.includes('Quantity: 1'));assert.equal(node.textContent.includes('{'),false);
 });
 await check('fallback','unavailable frames and budget rejection remain readable on later paints',async()=>{
  const e=environment(),answer=turn(e);e.p.draw(fence(spec()),'prose',answer);const r=await mounted(e,answer);e.broker.message({source:r.frame.contentWindow,origin:'null',data:{type:'fault',nonce:r.nonce,reason:'runtime failure'}});assert.equal(r.dead,true);assert.ok(answer.textContent.includes(spec().fallback));e.p.draw(fence(spec())+'\n\nLater words.','prose',answer);assert.equal(answer.querySelectorAll('iframe').length,0);assert.equal(e.broker.records.size,0);assert.ok(answer.textContent.includes('Later words.'));
 });
 console.log(checks+' repair checks passed');
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>pending.forEach(e=>e.cleanup()));
