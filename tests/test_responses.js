'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const argv=process.argv.slice(2),root=path.resolve(argv.includes('--root')?argv[argv.indexOf('--root')+1]:path.join(__dirname,'..'));
const group=argv.includes('--group')?argv[argv.indexOf('--group')+1]:'all';
assert.ok(fs.existsSync(path.join(root,'response-capabilities.json')),'declarative responses are unavailable');
const manifest=JSON.parse(fs.readFileSync(path.join(root,'response-capabilities.json'),'utf8'));
const makeCore=require(path.join(root,'static/response-core.js')),core=makeCore(manifest),{Document}=require('./response_dom.js');
const optional=name=>fs.existsSync(path.join(root,name))?require(path.join(root,name)):null;
const makeRuntime=optional('static/response-runtime.js'),makeParent=optional('static/response-parent.js'),makeStore=optional('static/response-store.js');
const copy=v=>JSON.parse(JSON.stringify(v));
const componentFilter=argv.includes('--component')?argv[argv.indexOf('--component')+1]:null;
assert.ok(['all','validator','components','broker','store'].includes(group),'unknown test group');
let checks=0;
function check(name,fn){return Promise.resolve().then(fn).then(()=>{checks++;console.log('PASS',name);});}
function template(component='quote-estimator'){return {type:'widget',version:1,id:'one',component,fallback:'Readable answer',actions:[{id:'ask',class:'AGENT',label:'Discuss',question:'Review this.'}]};}
function app(kind,output,inputs=[]){return {type:'widget',version:1,id:'one',component:kind,inputs,graph:[],outputs:[output],fallback:'Readable output'};}
const number={id:'n',kind:'number',label:'Number',default:3,min:1,max:10,step:1};
const select={id:'choice',kind:'select',label:'Answer',default:'a',options:[{label:'First',value:'a'},{label:'Second',value:'b'}]};
const environments=[];
const examples={
 'quote-estimator':template(),
 'bill-splitter':template('bill-splitter'),
 'budget-planner':template('budget-planner'),
 table:app('table',{kind:'table',columns:[{label:'Quantity'}],rows:[[{ref:'n'}]]},[number]),
 chart:app('chart',{kind:'chart',chart:'line',points:[{label:'A',value:{ref:'n'}},{label:'B',value:5}]},[number]),
 map:app('map',{kind:'map',points:[{label:'Kampala',lat:0.3476,lon:32.5825}]}),
 quiz:app('quiz',{kind:'quiz',question:'Pick the second option',input:'choice',answer:'b',explanation:'Second is correct.'},[select]),
 diagram:app('diagram',{kind:'diagram',shapes:[{id:'box',kind:'rect',x:20,y:20,width:80,height:60,color:'accent',action:'pick',label:'Pick'}]},[number])
};
// These local renderer examples are explicitly synthetic, never measured series.
examples['budget-planner'].source={kind:'illustration'};examples.chart.source={kind:'illustration'};
examples.diagram.actions=[{id:'pick',class:'LOCAL',label:'Pick',set:{input:'n',value:7}}];
async function validation(){
 await check('all templates and outputs validate',()=>{for(const [name,s] of Object.entries(examples)){const r=core.validate(s);assert.equal(r.ok,true,name+': '+r.reason);}});
 await check('unknown/malformed specs reject atomically',()=>{
  for(const raw of ['{','[]','null',JSON.stringify({...template(),component:'missing'}),JSON.stringify({...template(),onclick:'attack'}),JSON.stringify({...template(),fallback:' '}),'{"type":"widget","__proto__":{}}']){const r=core.validate(raw);assert.equal(r.ok,false);assert.equal(r.text,raw);}
  const cyc={};cyc.self=cyc;assert.equal(core.validate(cyc).ok,false);
 });
 await check('legacy components reject invalid or over-cap contents before rendering',()=>{
  for(const s of [{type:'chart',data:[['A',1],['B','invalid']]},{type:'metrics',items:[{label:'Valid',value:1},{label:'',value:0}]},{type:'sources',items:[{url:'javascript:alert(1)',title:'Bad'}]},{type:'image',url:'https://',caption:'Bad'}, {type:'steps',steps:Array.from({length:9},()=>({label:'Step'}))}])assert.equal(core.validate(s).ok,false);
  assert.equal(core.validate({type:'chart',data:[['A',1],['B',2]]}).ok,true);
 });
 await check('unknown input, action and operation denied',()=>{
  let s=copy(examples.table);s.graph=[{id:'x',op:'eval',args:['attack']}];assert.equal(core.validate(s).ok,false);
  s=copy(examples.diagram);s.outputs[0].shapes[0].action='notDeclared';assert.equal(core.validate(s).ok,false);
  s=template();s.actions[0].class='TOOL';assert.equal(core.validate(s).ok,false);
  s=template();s.actions=[{id:'fetch',class:'DATA',label:'Fetch',endpoint:'anything',input:'price',query:{}}];assert.equal(core.validate(s).ok,false);
 });
 await check('graphs reject forward references, bad types and zero division',()=>{
  for(const g of [{id:'x',op:'add',args:[{ref:'later'},2]},{id:'n',op:'add',args:[1,2]},{id:'x',op:'div',args:[1,0]},{id:'x',op:'add',args:['x',2]}]){const s=copy(examples.table);s.graph=[g];assert.equal(core.validate(s).ok,false);}
 });
 await check('every admission budget is configuration',()=>{
  for(const key of ['componentBytes','responseBytes','components','nodes','depth','domNodes','inputsPerComponent','inputsPerResponse','derived','operations','tableCells','chartPoints','svgPrimitives','hotspots','actions'])assert.ok(Number.isFinite(manifest.budgets[key]),key);
  for(const [key,s] of [['componentBytes',template()],['nodes',template()],['depth',template()],['domNodes',template()],['inputsPerResponse',template()],['operations',template()],['tableCells',examples.table],['chartPoints',examples.chart],['svgPrimitives',examples.diagram],['hotspots',examples.diagram]]){
   const m=copy(manifest);m.budgets[key]=0;const r=makeCore(m).validate(s);assert.equal(r.ok,false,key);
  }
  let admit=core.ledger(),r=core.validate(template());assert.equal(admit('one',r),true);assert.equal(admit('one',r),true);assert.equal(admit('two',r),false,'duplicate component id denied');
  const m=copy(manifest);m.budgets.components=1;admit=makeCore(m).ledger();r=makeCore(m).validate(template());assert.equal(admit('one',r),true);const other=template();other.id='two';assert.equal(admit('two',makeCore(m).validate(other)),false);
 });
 await check('strict messages and rate limits',()=>{
  const nonce='1'.repeat(32);assert.equal(core.message({type:'mounted',nonce}),true);
  for(const d of [{type:'mounted',nonce,extra:1},{type:'jarvis:ask',nonce,text:'go'},{type:'change',nonce,revision:1},{type:'mounted',nonce:'bad'}])assert.equal(core.message(d),false);
  let time=0,bucket=core.bucket(1,2,()=>time);assert.equal(bucket(),true);assert.equal(bucket(),true);assert.equal(bucket(),false);time=1000;assert.equal(bucket(),true);
 });
 await check('dates and all control kinds enforce types',()=>{
  const controls=[{id:'d',kind:'date',label:'Date',default:'2026-10-23'},{id:'t',kind:'toggle',label:'Toggle',default:false},{id:'s',kind:'text',label:'Text',default:'safe',maxLength:20},{...number,kind:'range'},select];
  const s=app('application',{kind:'text',value:{ref:'s'}},controls),r=core.validate(s);assert.equal(r.ok,true,r.reason);
  assert.throws(()=>core.inputs(r.spec,{...r.initial,d:'2026-02-30'}));assert.throws(()=>core.inputs(r.spec,{...r.initial,t:'true'}));assert.throws(()=>core.inputs(r.spec,{...r.initial,s:'x'.repeat(21)}));
 });
}
async function components(){
 for(const [name,s] of Object.entries(examples).filter(([name])=>!componentFilter||name===componentFilter))await check(name+' renders and recomputes',async()=>{
  const r=core.validate(s);assert.ok(r.ok,r.reason);const document=new Document(),messages=[];
  const view=makeRuntime(core,document,d=>messages.push(d));view.policy({...manifest.defaults,agent:true});view.mount(r.spec,r.initial,document.body);
  assert.ok(document.body.textContent.length>0);assert.equal(document.body.querySelectorAll('script').length,0);
  if(name==='quote-estimator'){view.update('quantity',10,true);view.update('price',10000,true);view.update('discount',1000,true);await new Promise(setImmediate);assert.equal(core.evaluate(r.spec,view.snapshot()).total,90000);assert.ok(document.body.textContent.includes('90,000'));}
  if(name==='bill-splitter'){view.update('people',4,true);await new Promise(setImmediate);assert.equal(core.evaluate(r.spec,view.snapshot()).perPerson,25000);}
  if(name==='budget-planner'){view.update('income',2000000,true);await new Promise(setImmediate);assert.equal(core.evaluate(r.spec,view.snapshot()).remaining,1400000);}
  if(name==='table'){view.update('n',7,true);await new Promise(setImmediate);assert.ok(document.body.querySelector('td').textContent.includes('7'));}
  if(name==='chart')assert.equal(document.body.querySelectorAll('polyline').length,1);
  if(name==='map')assert.ok(document.body.textContent.includes('Kampala'));
  if(name==='quiz'){view.update('choice','b',true);await new Promise(setImmediate);assert.ok(document.body.textContent.includes('Correct.'));}
  if(name==='diagram'){view.intent('pick');await new Promise(setImmediate);assert.equal(view.snapshot().n,7);assert.equal(document.body.querySelectorAll('button').length,2);}
  assert.equal(messages.some(d=>d.type==='ask'),false); view.destroy();
 });
 if(componentFilter){assert.ok(Object.hasOwn(examples,componentFilter),'unknown component');return;}
 await check('actual frame bootstrap validates parent messages and preserves state on appearance changes',()=>{
  const document=new Document(),main=document.createElement('main');main.id='response-root';document.body.appendChild(main);const messages=[],listeners={},parent={postMessage(d,origin){messages.push({data:d,origin});}},nonce='1'.repeat(32),hash='2'.repeat(64);
  const context=vm.createContext({document,parent,location:{hash:'#nonce='+nonce},JarvisResponseBootstrap:{manifest,hash,parentOrigin:'https://app.example.test'},URLSearchParams,TextEncoder,Intl,Date,setTimeout,clearTimeout,console,addEventListener(type,fn){listeners[type]=fn;}});
  vm.runInContext(fs.readFileSync(path.join(root,'static/response-core.js'),'utf8'),context);vm.runInContext(fs.readFileSync(path.join(root,'static/response-runtime.js'),'utf8'),context);
  assert.equal(messages[0].data.type,'ready');const init={type:'init',nonce,manifest:hash,spec:template(),inputs:{quantity:1,price:10000,discount:0},theme:'dark',scale:1,policy:manifest.defaults};
  listeners.message({source:parent,origin:'https://wrong.example.test',data:init});assert.equal(main.children.length,0);
  listeners.message({source:parent,origin:'https://app.example.test',data:init});assert.ok(main.querySelector('input'));assert.ok(messages.some(m=>m.data.type==='mounted'));
  listeners.message({source:parent,origin:'https://app.example.test',data:{type:'theme',nonce,theme:'light',scale:1.25}});assert.equal(document.documentElement.style.fontSize,'20px');assert.equal(document.getElementById('input-price').value,'10000');listeners.pagehide();
 });
 await check('money rounds consistently and split allocations sum exactly',()=>{
  let s=template();s.initial={quantity:1,price:1,discount:5000};let r=core.validate(s),v=core.evaluate(r.spec,r.initial);assert.equal(v.total+v.saving,v.subtotal);
  s=template('bill-splitter');s.initial={bill:100001,people:3,tip:1};r=core.validate(s);v=core.evaluate(r.spec,r.initial);assert.equal(v.regularPeople*v.perPerson+v.extraPeople*v.extraShare,v.total);assert.equal(Number.isInteger(v.total),true);
 });
 await check('currency fields display major units while calculations retain minor units',async()=>{
  const s=template();s.props={currency:'USD'};const r=core.validate(s),doc=new Document(),view=makeRuntime(core,doc,()=>{});view.policy(manifest.defaults);view.mount(r.spec,r.initial,doc.body);const price=doc.getElementById('input-price');assert.equal(price.value,'100');price.value='12.34';await price.fire('input');assert.equal(view.snapshot().price,1234);view.destroy();
 });
 await check('temporarily empty numeric fields remain editable and block AGENT intent',async()=>{
  const r=core.validate(template()),document=new Document(),messages=[],view=makeRuntime(core,document,d=>messages.push(d));view.policy({...manifest.defaults,agent:true});view.mount(r.spec,r.initial,document.body);
  const price=document.getElementById('input-price');price.value='';await price.fire('input');view.intent('ask');assert.equal(messages.filter(m=>m.type==='fault').length,0);assert.equal(messages.filter(m=>m.type==='intent').length,0);assert.ok(messages.some(m=>m.type==='draft'&&m.editing));
  price.value='10000';await price.fire('input');view.intent('ask');assert.ok(messages.some(m=>m.type==='draft'&&!m.editing));view.destroy();
 });
 await check('model markup stays text and AGENT emits intent only',async()=>{
  const s=template();s.props={title:'<img src=x onerror=attack()>'};const r=core.validate(s),doc=new Document(),messages=[];const view=makeRuntime(core,doc,m=>messages.push(m));
  view.policy({...manifest.defaults,agent:true});view.mount(r.spec,r.initial,doc.body);view.intent('ask');assert.equal(messages.filter(m=>m.type==='intent').length,1);assert.equal(doc.body.querySelectorAll('img').length,0);assert.ok(doc.body.textContent.includes('<img'));view.destroy();
 });
}
function environment(overrides={},capabilities=manifest){
 const document=new Document(),calls=[],storage=new Map(),data={ok:true,account:'owner',epoch:'a'.repeat(64),prefs:{...manifest.defaults,agent:true},enabled:true,canConfigure:true,widgetOrigin:'https://widgets.example.test',manifest:'b'.repeat(64),runtime:'c'.repeat(64)};
 const store={installation:async()=> 'install',prune:async()=>{},get:async(s,k)=>storage.get(s+k)||null,put:async(s,k,c,v)=>{storage.set(s+k,v);},clear:async()=>storage.clear(),remove:async()=>{}};
 const host={document,crypto:require('node:crypto').webcrypto,indexedDB:{},location:{origin:'https://app.example.test'},console:{warn(){}},innerHeight:800,
  __jarvisConvId:()=> 'd'.repeat(32),__jarvisModes:()=>({mode:'text'}),__jarvisGone:()=>[],__jarvisLiveTurn:()=>null,
  JarvisResponseCore:makeCore,JarvisResponseStore:()=>store,addEventListener(){},setInterval(){},MutationObserver:class{observe(){}},
  matchMedia:()=>({matches:false}),localStorage:{getItem:()=>''},fetch:async(url,opts)=>{calls.push({url,opts});return {ok:true,json:async()=>copy(data)};},ask(q,mode){calls.push({q,mode});},...overrides};
 const broker=makeParent(host,{manifest:capabilities,hash:data.manifest,runtime:data.runtime});
 const e={host,document,calls,storage,store,data,broker};environments.push(e);return e;
}
async function ready(e,s=template()){
 const turn=e.document.createElement('div');turn.className='turn';turn.dataset.id='stable-turn';const answer=e.document.createElement('div');answer.className='t-a';turn.appendChild(answer);e.document.body.appendChild(turn);
 const d=e.broker.fence(JSON.stringify(s));answer.appendChild(d.node);const r=[...e.broker.records].at(-1);await e.broker.activate(r);
 await new Promise(setImmediate);
 e.broker.message({source:r.frame.contentWindow,origin:'null',data:{type:'ready',nonce:r.nonce,manifest:e.data.manifest}});
 assert.equal(r.fallback.hidden,false,'fallback stays until mounted');
 e.broker.message({source:r.frame.contentWindow,origin:'null',data:{type:'mounted',nonce:r.nonce}});assert.equal(r.frame.hidden,false);
 return r;
}
async function brokerTests(){
 await check('registration, handshake and strict source boundary',async()=>{
  const e=environment(),r=await ready(e),valid={type:'intent',nonce:r.nonce,revision:0,action:'ask'};
  for(const event of [{source:{},origin:'null',data:valid},{source:r.frame.contentWindow,origin:'https://widgets.example.test',data:valid},{source:r.frame.contentWindow,origin:'null',data:{...valid,nonce:'a'.repeat(32)}},{source:r.frame.contentWindow,origin:'null',data:{...valid,text:'attack'}}])e.broker.message(event);
  assert.equal(r.review.children.length,0);assert.equal(e.calls.some(c=>c.q),false);
  e.broker.message({source:r.frame.contentWindow,origin:'null',data:valid});assert.ok(r.review.querySelector('button'));assert.equal(e.calls.some(c=>c.q),false);
 });
 await check('synthetic, expired, reused and mismatched gestures fail; valid gesture submits once',async()=>{
  const e=environment(),r=await ready(e);e.broker.review(r,r.result.spec.actions[0]);const b=r.review.querySelector('button');
  await b.fire('pointerdown');await b.fire('click',{isTrusted:true});assert.equal(e.calls.filter(c=>c.q).length,0);
  await b.fire('pointerdown',{isTrusted:true});r.token.at-=manifest.budgets.gestureTTLms+1;await b.fire('click',{isTrusted:true});assert.equal(e.calls.filter(c=>c.q).length,0);
  await b.fire('pointerdown',{isTrusted:true});await b.fire('click',{isTrusted:true,pointerId:2});assert.equal(e.calls.filter(c=>c.q).length,0);
  await b.fire('pointerdown',{isTrusted:true});await b.fire('click',{isTrusted:true});await b.fire('click',{isTrusted:true});assert.equal(e.calls.filter(c=>c.q).length,1);assert.equal(e.calls.find(c=>c.q).mode,'text');
 });
 await check('state edits, policy changes, busy lanes and navigation invalidate review',async()=>{
  for(const change of [e=>{e.host.__jarvisConvId=()=> 'e'.repeat(32);},e=>{e.data.prefs.agent=false;},e=>{e.host.__jarvisLiveTurn=()=>({conv:'d'.repeat(32)});},(e,r)=>{r.revision++;}]){
   const e=environment(),r=await ready(e);e.broker.review(r,r.result.spec.actions[0]);const b=r.review.querySelector('button');await b.fire('pointerdown',{isTrusted:true});change(e,r);await b.fire('click',{isTrusted:true});assert.equal(e.calls.filter(c=>c.q).length,0);
  }
 });
 await check('a finished engine context does not block reviewed questions',async()=>{
  const e=environment({__jarvisLiveTurn:()=>({conv:'d'.repeat(32),alive:false})}),r=await ready(e);e.broker.review(r,r.result.spec.actions[0]);assert.ok(r.review.querySelector('button'));
 });
 await check('checkpoint ACK follows durable completion and replay revisions are ignored',async()=>{
  const e=environment(),r=await ready(e);let finish;e.store.put=()=>new Promise(resolve=>finish=resolve);
  const event={source:r.frame.contentWindow,origin:'null',data:{type:'change',nonce:r.nonce,revision:1,inputs:{quantity:2,price:10000,discount:0}}};
  e.broker.message(event);await new Promise(setImmediate);assert.equal(r.acked,0);e.broker.message(event);assert.equal(r.revision,1);finish();await r.pending;assert.equal(r.acked,1);
 });
 await check('storage failure degrades to readable current values',async()=>{
  const e=environment(),r=await ready(e);e.store.put=async()=>{throw Error('quota');};e.broker.message({source:r.frame.contentWindow,origin:'null',data:{type:'change',nonce:r.nonce,revision:1,inputs:{quantity:3,price:10000,discount:0}}});await r.pending;assert.equal(r.dead,true);assert.ok(r.node.textContent.includes('quantity')||r.node.textContent.includes('Quantity'));assert.equal(r.node.querySelectorAll('iframe').length,0);
 });
 await check('same component restores checkpoint after reload without a turn',async()=>{
  const e=environment(),r=await ready(e);e.broker.message({source:r.frame.contentWindow,origin:'null',data:{type:'change',nonce:r.nonce,revision:1,inputs:{quantity:7,price:10000,discount:0}}});await r.pending;
  r.node.remove();const restored=await ready(e);assert.equal(restored.values.quantity,7);assert.equal(e.calls.some(c=>c.q),false);
 });
 await check('streaming reconciliation preserves completed frames and rejects incomplete fences',async()=>{
  const e=environment(),turn=e.document.createElement('div'),answer=e.document.createElement('div');turn.className='turn';turn.dataset.id='t';answer.className='t-a';turn.appendChild(answer);e.document.body.appendChild(turn);
  const raw=JSON.stringify(template());
  function paint(text){e.broker.reconcile(answer,target=>{target.appendChild(e.broker.fence(raw).node);const p=e.document.createElement('p');p.textContent=text;target.appendChild(p);});}
  paint('More');const node=answer.querySelector('.jr-component'),r=[...e.broker.records][0];await e.broker.activate(r);const frame=r.frame;assert.ok(frame);
  paint('More text');assert.equal(answer.querySelector('.jr-component'),node);assert.equal(r.frame,frame);assert.equal(frame.parentNode,node);
  assert.equal(e.broker.handles('```ui\n'+raw+'\n```'),true);assert.equal(e.broker.handles('```ui\n'+raw),false);
 });
 await check('aggregate response budget rejects to readable fallback before mount',()=>{
  const e=environment(),el=e.document.createElement('div');const raw=JSON.stringify(template());
  e.broker.reconcile(el,target=>{target.appendChild(e.broker.fence(raw).node);target.appendChild(e.broker.fence(raw).node);});
  assert.equal(el.querySelectorAll('.jr-component').length,1);assert.ok(el.textContent.endsWith('Readable answer'));assert.equal(el.textContent.includes('"type":"widget"'),false);assert.equal([...e.broker.records].length,1);
 });
 if(group==='all') await check('real fence admission uses readable fallback before heuristic fallback',()=>{
  const e=environment(),source=fs.readFileSync(path.join(root,'static/v1.js'),'utf8');const a=source.indexOf('  function fenceBlock('),b=source.indexOf('  function uiBlock(',a);
  const context={document:e.document,textMode:true,window:{JarvisResponses:e.broker},uiTxt:String,parseSpec(s){try{return JSON.parse(s);}catch(_){return null;}},
   specFallback(){throw Error('heuristic fallback reached');},specLines(){throw Error('heuristic lines reached');},isSpec(){return false;},codeBlock(){throw Error('code fallback reached');}};
  const draw=vm.runInNewContext(source.slice(a,b)+'\nfenceBlock;',context),raw='{"type":"widget","component":"unknown","version":1,"rows":[["[[file:trap.html]]"]]}';const node=draw('ui',raw);assert.equal(node.textContent,'This interactive response could not be displayed.');assert.equal(node.querySelectorAll('a').length,0);
 });
 if(group==='all') await check('file marker rewriting skips literal rejections and component reviews',()=>{
  const e=environment(),source=fs.readFileSync(path.join(root,'static/v1.js'),'utf8'),a=source.indexOf('  function outboxLinks('),b=source.indexOf('  function paintBodyInto(',a);
  const pre=e.broker.plain('[[file:trap.html]]');e.document.body.appendChild(pre);let once=false;
  e.document.createTreeWalker=()=>({nextNode(){if(once)return null;once=true;return {nodeValue:'[[file:trap.html]]',parentElement:pre,parentNode:pre};}});
  const fn=vm.runInNewContext(source.slice(a,b)+'\noutboxLinks;',{document:e.document,NodeFilter:{SHOW_TEXT:4},textMode:true,OUTBOX_RE:/\[\[file:([^\]\n]+)\]\]/g,outboxCard(){throw Error('rejection executed a file action');}});
  fn(pre);assert.equal(pre.textContent,'[[file:trap.html]]');
 });
 await check('interactive off/on restores current values with a fresh frame and no turn',async()=>{
  const e=environment();e.data.prefs.remember=false;const rows=e.document.createElement('div');rows.id='attachrows';e.document.body.appendChild(rows);
  const old=e.host.fetch;e.host.fetch=async(url,opts)=>{if(opts&&opts.method==='POST'){Object.assign(e.data.prefs,JSON.parse(opts.body));return {ok:true,json:async()=>({ok:true})};}return old(url,opts);};
  const r=await ready(e);e.broker.sweep();await new Promise(setImmediate);e.broker.sweep();
  e.broker.message({source:r.frame.contentWindow,origin:'null',data:{type:'change',nonce:r.nonce,revision:1,inputs:{quantity:7,price:10000,discount:0}}});await r.pending;
  const toggle=rows.querySelectorAll('input').find(i=>i.dataset.preference==='interactive');assert.ok(toggle);toggle.checked=false;await toggle.fire('change',{isTrusted:true});assert.equal(r.dead,true);
  toggle.checked=true;await toggle.fire('change',{isTrusted:true});await new Promise(setImmediate);const restored=[...e.broker.records].at(-1);assert.ok(restored);assert.equal(restored.values.quantity,7);assert.notEqual(restored.nonce,r.nonce);assert.equal(e.calls.some(c=>c.q),false);
 });
 await check('sign-out invalidates frames and clears only response checkpoints',async()=>{
  const e=environment(),r=await ready(e);let clears=0;e.store.clear=async()=>{clears++;};await e.broker.signOut();assert.equal(r.dead,true);assert.ok(clears>0);assert.equal(e.calls.some(c=>c.q),false);
 });
 await check('DATA is denied with empty allowlist',async()=>{const e=environment(),r=await ready(e);const before=e.calls.length;await e.broker.data(r,{class:'DATA',endpoint:'anything'});assert.equal(e.calls.length,before);});
}
async function dataTests(){
 await check('allowlisted DATA omits credentials, rejects redirects and validates bounded JSON',async()=>{
  const m=copy(manifest);m.dataEndpoints.price={method:'GET',path:'/public/price',query:{type:'object',properties:{unit:{type:'string'}},required:['unit'],additionalProperties:false},response:{type:'number',minimum:0,maximum:10000000}};
  const e=environment({},m);e.data.prefs.data=true;const s=template();s.actions.push({id:'priceData',class:'DATA',label:'Price',endpoint:'price',input:'price',query:{unit:'one'}});const r=await ready(e,s),oldFetch=e.host.fetch;
  e.host.fetch=async(url,opts)=>{if(String(url).startsWith('/api/response/'))return oldFetch(url,opts);e.calls.push({url,opts});return {ok:true,headers:new Headers({'content-type':'application/json'}),body:new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('25000'));c.close();}})};};
  await e.broker.data(r,r.result.spec.actions[1]);const request=e.calls.at(-1);assert.equal(request.opts.credentials,'omit');assert.equal(request.opts.redirect,'error');assert.equal(request.opts.mode,'same-origin');assert.equal(new URL(request.url).origin,e.host.location.origin);assert.ok(r.frame.contentWindow.sent.some(m=>m.data.type==='data'&&m.data.value===25000));
  const count=r.frame.contentWindow.sent.length;r.revision=1;e.host.fetch=async()=>({ok:true,headers:new Headers({'content-type':'text/html'}),body:null});await e.broker.data(r,r.result.spec.actions[1]);assert.equal(r.frame.contentWindow.sent.length,count);
 });
 await check('legacy choices reach the legacy renderer without a component shell',()=>{
  const e=environment(),s={type:'choices',options:[{label:'First',value:'first question'},{label:'Second',value:'second question'}]},decision=e.broker.fence(JSON.stringify(s));
  assert.equal(decision.handled,false);assert.equal(decision.node,undefined);assert.equal(e.broker.records.size,0);assert.equal(Object.hasOwn(manifest,'legacyAdapters'),false);
 });
 await check('a repeated checkpoint recovers a lost ACK without rewriting state',async()=>{
  const e=environment(),r=await ready(e);let writes=0;e.store.put=async()=>{writes++;};const event={source:r.frame.contentWindow,origin:'null',data:{type:'change',nonce:r.nonce,revision:1,inputs:{quantity:4,price:10000,discount:0}}};e.broker.message(event);await r.pending;e.broker.message(event);assert.equal(writes,1);assert.equal(r.frame.contentWindow.sent.filter(m=>m.data.type==='ack').length,2);
 });
}
async function storeTests(){
 await check('checkpoint capacity/expiry is bounded across namespaces',()=>{
  let now=1000;const store=makeStore(null,manifest.budgets,()=>now),row={key:'new',updated:now,expires:now+100,bytes:100};
  const result=store.plan([{key:'expired',expires:999,updated:1,bytes:1},{key:'large',expires:2000,updated:2,bytes:manifest.budgets.checkpointTotalBytes}],row);assert.ok(result.remove.includes('expired'));assert.ok(result.remove.includes('large'));
  assert.throws(()=>store.plan([], {...row,bytes:manifest.budgets.checkpointTotalBytes+1}));
 });
 await check('checkpoint payload and unavailable storage fail explicitly',async()=>{const store=makeStore(null,manifest.budgets);await assert.rejects(store.put('a','b','c',{s:'x'.repeat(manifest.budgets.checkpointBytes)}));await assert.rejects(store.get('a','b'));});
}
(async()=>{if(['all','validator'].includes(group))await validation();if(['all','components'].includes(group))await components();if(['all','broker'].includes(group))await brokerTests();if(['all','store'].includes(group))await storeTests();if(['all','broker'].includes(group))await dataTests();console.log(checks+' response checks passed');environments.forEach(e=>{e.document.body.replaceChildren();e.broker.sweep();});})().catch(e=>{console.error(e);process.exitCode=1;});
