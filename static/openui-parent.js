/* Streamed OpenUI boundary. Same-origin authenticated reads; no automatic assistant turns. */
(function(host){'use strict';
  var doc=host.document,held=new WeakMap(),records=new Set();
  function split(text){var out=[],last=0,re=/^(`{3,}|~{3,})([^\n]*)\n/gm,m;
    while((m=re.exec(text))){var marker=m[1],tag=m[2].trim(),start=re.lastIndex,closer=new RegExp('^'+marker[0]+'{'+marker.length+',}[ \\t]*(?:\\n|$)','gm');closer.lastIndex=start;var end=closer.exec(text),stop=end?closer.lastIndex:text.length;
      if(tag==='openui'||tag==='openui-lang'){out.push({text:text.slice(last,m.index)});var code=text.slice(start,end?end.index:text.length),receipts=[];
        var meta=/^\/\/ jarvis-context: ([A-Za-z0-9+/=]+)\n/.exec(code);if(meta){try{receipts=JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(meta[1]),c=>c.charCodeAt(0))));}catch(_){}code=code.slice(meta[0].length);}
        out.push({code:code,closed:!!end,receipts:receipts});last=stop;}
      re.lastIndex=stop;
    }if(out.length)out.push({text:text.slice(last)});return out;
  }
  function active(r){return r.node.isConnected&&(!host.__jarvisModes||host.__jarvisModes().mode==='text')&&(!host.__jarvisConvId||String(host.__jarvisConvId())===r.conv);}
  function post(r,value){if(r.ready&&r.frame&&active(r))r.frame.contentWindow.postMessage(Object.assign({channel:'jarvis-openui',nonce:r.nonce},value),'*');}
  function update(r){post(r,{type:'render',code:r.code,final:r.final,receipts:r.receipts,revision:++r.revision,theme:doc.documentElement.dataset.theme||(host.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light')});}
  function status(r){var turn=r.node.closest('.turn');if(!turn)return;var siblings=Array.from(records).filter(v=>v.node.closest('.turn')===turn),state=siblings.some(v=>v.failed||v.mediaFailed)?'partial':siblings.some(v=>!v.mounted||v.mediaPending)?'pending':'';
    turn.dataset.openuiPartial=state==='partial'?'true':'false';turn.dataset.openuiStatus=state;
    host.dispatchEvent(new CustomEvent('jarvis:openui-status',{detail:{turn:turn.dataset.id,status:state}}));}
  function failed(r,diagnostic){r.failed=true;r.mounted=false;r.frame.hidden=true;r.frame.style.display='none';
    r.diagnostic=diagnostic||{phase:'mount',code:'frame_unavailable',message:'The interactive answer did not load.'};
    if(!r.notice){r.notice=doc.createElement('p');r.notice.className='jr-openui-error';r.notice.setAttribute('role','status');r.node.append(r.notice);}
    r.notice.textContent=r.diagnostic.message;r.node.dataset.presentationErrors=JSON.stringify([r.diagnostic]);status(r);}

  function dispose(r){clearTimeout(r.watchdog);records.delete(r);}
  async function drain(r){while(r.queue.length&&r.pending<3&&active(r)){
    var item=r.queue.shift();r.pending++;(async function(item){var photos=[],controller=new AbortController(),timer=setTimeout(()=>controller.abort(),20000);
      try{var response=await host.fetch('/api/openui/images?q='+encodeURIComponent(item.query)+'&conv='+encodeURIComponent(r.conv),{credentials:'same-origin',redirect:'error',signal:controller.signal});if(response.ok){var value=await response.json();if(Array.isArray(value.photos))photos=value.photos.slice(0,4);}}
      catch(_){}finally{clearTimeout(timer);r.pending--;if(active(r))post(r,{type:'images',id:item.id,photos:photos});drain(r);}
    })(item);
  }}

  function mount(node){var nonce=Array.from(host.crypto.getRandomValues(new Uint8Array(16)),n=>n.toString(16).padStart(2,'0')).join('');var frame=doc.createElement('iframe');
    frame.className='jr-openui-frame';frame.title='Interactive answer';frame.setAttribute('sandbox','allow-scripts');frame.setAttribute('referrerpolicy','no-referrer');frame.style.cssText='display:block;width:100%;border:0;height:120px;background:transparent';frame.src='/api/openui/runtime?v='+encodeURIComponent(host.JarvisOpenUIStamp||'')+'#'+nonce;
    var r={node:node,frame:frame,nonce:nonce,ready:false,mounted:false,revision:0,code:'',final:false,receipts:[],conv:String(host.__jarvisConvId?host.__jarvisConvId():''),hits:0,pending:0,queue:[],mediaPending:0,mediaFailed:0};records.add(r);status(r);
    r.watchdog=setTimeout(function(){if(!r.ready&&active(r))failed(r);},15000);
    host.fetch('/api/response/context/'+encodeURIComponent(r.conv),{credentials:'same-origin',cache:'no-store'}).then(function(response){if(!response.ok)throw Error('preferences');return response.json();}).then(function(context){
      if(!context.ok||!context.prefs||context.prefs.interactive!==true)throw Error('interactive answers disabled');
      if(active(r))node.append(frame);
    }).catch(function(){failed(r);});return r;
  }
  host.addEventListener('securitypolicyviolation',function(event){if(event.effectiveDirective==='frame-src')records.forEach(r=>{if(active(r)&&!r.ready&&String(event.blockedURI||'').includes('/api/openui/runtime'))failed(r,{phase:'mount',code:'frame_csp_blocked',message:'The page policy blocked the interactive answer.'});});});
  host.addEventListener('message',async function(event){var d=event.data;if(!d||d.channel!=='jarvis-openui'||event.origin!=='null')return;var r=Array.from(records).find(v=>v.frame&&event.source===v.frame.contentWindow&&d.nonce===v.nonce);
    if(!r||!active(r))return;
    if(d.type==='ready'){if(!r.ready){r.ready=true;update(r);}return;}
    if(d.type==='height'&&Number.isFinite(d.height)){r.frame.style.height=Math.max(48,Math.min(12000,d.height))+'px';return;}
    if(d.type==='failed'&&d.revision===r.revision){failed(r,{phase:'render',code:/^[a-z_]{1,80}$/.test(d.diagnostic?.code)?d.diagnostic.code:'browser_render_failed',message:'The interactive answer could not render.',errors:Array.isArray(d.diagnostic?.errors)?d.diagnostic.errors.slice(0,5):[]});return;}
    if((d.type==='mounted'||d.type==='media')&&d.revision===r.revision){
      if(d.type==='mounted'){r.failed=false;r.mounted=true;r.diagnostic=null;if(r.notice){r.notice.remove();r.notice=null;}delete r.node.dataset.presentationErrors;r.frame.hidden=false;r.frame.style.display='block';clearTimeout(r.watchdog);}
      r.mediaPending=Math.max(0,Math.min(52,Number(d.pending)||0));r.mediaFailed=Math.max(0,Math.min(52,Number(d.failed)||0));status(r);return;
    }
    if(d.type==='images'&&typeof d.query==='string'&&d.query.length>=2&&d.query.length<=200&&typeof d.id==='string'&&d.id.length<20){
      if(r.hits>=12){post(r,{type:'images',id:d.id,photos:[]});return;}
      r.hits++;r.queue.push({id:d.id,query:d.query});drain(r);return;
    }
    if(d.type==='draft'&&typeof d.text==='string'&&d.text.length<=2000){var composer=doc.getElementById('q');if(composer){composer.value=d.text+'\n\nForm values:\n'+JSON.stringify(d.values||{}).slice(0,4000);composer.dispatchEvent(new Event('input',{bubbles:true}));composer.focus();}return;}
    // Links and clipboard require a visible, trusted parent gesture. The frame cannot synthesize it.
    if((d.type==='link'||d.type==='copy')&&typeof(d.url||d.text)==='string'){var value=String(d.url||d.text).slice(0,4000),button=doc.createElement('button');button.type='button';button.textContent=d.type==='link'?'Open link':'Copy';
      button.addEventListener('click',function(e){if(!e.isTrusted||!active(r))return;if(d.type==='copy')host.navigator.clipboard.writeText(value);else{try{var url=new URL(value);if(url.protocol==='https:')host.open(url.href,'_blank','noopener,noreferrer');}catch(_){}}button.remove();});r.node.append(button);}
  });
  host.JarvisOpenUI={signOut:function(){records.forEach(r=>{r.failed=true;r.frame.remove();r.node.textContent='Interactive answer closed.';});records.clear();},handles:function(text,el){return !!(held.has(el)||split(String(text)).length);},paint:function(el,text,plain,final){
    var parts=split(String(text)),state=held.get(el);if(!parts.length){if(state){state.forEach(s=>{if(s.record)dispose(s.record);});held.delete(el);}plain(el,text);return;}
    if(!state){el.replaceChildren();state=[];held.set(el,state);}
    parts.forEach(function(part,i){var kind=Object.prototype.hasOwnProperty.call(part,'code')?'ui':'text',slot=state[i];
      if(!slot||slot.kind!==kind){if(slot&&slot.record)dispose(slot.record);var node=doc.createElement('div');node.className=kind==='ui'?'jr-openui':'jr-openui-prose';if(slot)slot.node.replaceWith(node);else el.append(node);slot={node:node,kind:kind};state[i]=slot;if(kind==='ui')slot.record=mount(node);}
      if(kind==='text'){if(slot.text!==part.text){plain(slot.node,part.text);slot.text=part.text;}}
      else{var r=slot.record,isFinal=!!final;if(r.code!==part.code||r.final!==isFinal){r.code=part.code;r.final=isFinal;r.receipts=part.receipts;update(r);}}
    });while(state.length>parts.length){var old=state.pop();if(old.record)dispose(old.record);old.node.remove();}
  },records:records};
  new MutationObserver(function(){records.forEach(r=>{if(!r.node.isConnected&&r.ready)dispose(r);});}).observe(doc.documentElement,{childList:true,subtree:true});
})(window);
