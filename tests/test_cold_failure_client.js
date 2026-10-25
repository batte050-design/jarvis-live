'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const root=path.resolve(process.argv[2]||path.join(__dirname,'..')),source=fs.readFileSync(path.join(root,'static/v1.js'),'utf8');
function fn(name){const marker=source.includes('  function '+name+'(')?'function '+name+'(':'window.'+name+' = function (';let start=source.indexOf(marker);assert.ok(start>=0,'missing '+name);if(marker.startsWith('window.'))start=source.indexOf('function',start);for(let end=source.indexOf('}',start);end>=0;end=source.indexOf('}',end+1)){const s=source.slice(start,end+1);try{new vm.Script('('+s+')');return s;}catch(_){}}throw Error('cannot extract '+name);}
function node(cls=''){return {className:cls,dataset:{},children:[],_text:'',style:{},get textContent(){return this._text+this.children.map(x=>x.textContent).join('');},set textContent(v){this._text=v;this.children=[];},setAttribute(k,v){this[k]=v;},appendChild(n){this.children.push(n);n.parent=this;},remove(){this.parent.children=this.parent.children.filter(n=>n!==this);},querySelector(sel){return this.children.find(n=>n.className.split(' ').includes(sel.slice(1)))||null;}};}
for(const message of ['The agent turn failed before a complete answer was produced. Please try again.']){
 const answer=node('t-a'),block=node('turn'),phases=[];block.appendChild(answer);answer.textContent='Partial answer. ';
 const context={textMode:true,liveBlock:block,answerText:'Partial answer.',captionText:'Partial answer.',turnText:'Partial answer.',turnConv:'a'.repeat(32),cap:node(),
 window:{__jarvisConvId:()=> 'a'.repeat(32)},document:{createElement:()=>node()},evBelongsHere:()=>true,turnAlreadyAnswered:()=>true,
 endFollow(){},canvasReleased(){},hideWorkingPill(){},setPhase(s){phases.push(s);},Date};vm.createContext(context);
 context.paintAgentFailure=vm.runInContext('('+fn('paintAgentFailure')+')',context);
 const fail=vm.runInContext('('+fn('fail')+')',context),end=vm.runInContext('('+fn('__jarvisTurnEnd')+')',context),pill=vm.runInContext('('+fn('paintPill')+')',context);
 fail(message);assert.equal(block.dataset.agentFailed,'1');assert.ok(answer.textContent.includes(message));assert.equal(answer.querySelector('.agent-failure').role,'alert');
 end('Partial answer.');pill(block,[{tool:'fixture'}],1200);assert.equal(context.answerText,'');assert.equal(context.captionText,'');assert.equal(block.querySelector('.t-meta'),null);assert.equal(phases.includes('worked'),false);
 context.textMode=false;fail('ordinary voice message');assert.equal(phases.at(-1),'worked','voice behavior changed');
 console.log('PASS actual text failure painter, failed settlement and badge guard; voice branch retained');
}
