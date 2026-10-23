'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const root=path.resolve(process.argv[2]||path.join(__dirname,'..')),source=fs.readFileSync(path.join(root,'static/v1.js'),'utf8');
const match=source.match(/^    function prestartTextChat\(\) \{[\s\S]*?^    \}/m);
assert.ok(match,'composer has no pre-start on first interaction');
let resets=0,requests=0;const context={textMode:true,q:{value:'Keep my draft'},pending:null,sessionId:'',prestartedTextConv:'',preparedTextConv:'',
 console:{warn(){}},freshSession:()=>true,setAutoBound(v){context.autoBound=v;},window:{__jarvisConvId:()=>context.sessionId},
 startNewConversation(){resets++;context.sessionId='a'.repeat(32);context.pending={id:context.sessionId};context.q.value='';},
 fetch(){requests++;return Promise.resolve({ok:false});}};
vm.createContext(context);vm.runInContext(match[0]+'\nprestartTextChat();prestartTextChat();',context);
(async()=>{await new Promise(setImmediate);assert.equal(resets,1);assert.equal(requests,1);assert.equal(context.q.value,'Keep my draft');assert.equal(context.preparedTextConv,'a'.repeat(32));
 const a=source.indexOf('        if (turning || (!freshSession() && !autoBound)) return;'),b=source.indexOf('        var typed = q.value;',a);assert.ok(a>=0&&b>a);
 context.turning=false;context.autoBound=true;vm.runInContext('(function(){'+source.slice(a,b)+'throw Error("send would remint the prestarted id");})();',context);assert.equal(context.autoBound,false);
 context.textMode=false;context.pending=null;vm.runInContext('prestartTextChat();',context);assert.equal(resets,1);assert.equal(requests,1);console.log('PASS real composer pre-start and send guard retain identity, including failed pre-start; voice bypassed');
})().catch(e=>{console.error(e);process.exitCode=1;});
