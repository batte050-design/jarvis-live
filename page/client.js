/* Transport integration, not another renderer. Callbacks upsert the existing turn by ID. */
(function(root){
 'use strict';
 function createClient(callbacks,dependencies){
  const dep=dependencies||{},fetcher=dep.fetch||root.fetch.bind(root),Source=dep.EventSource||root.EventSource;
  const terminal=new Map(),active=new Map();
  function path(conv,turn){return '/api/page/turns/'+encodeURIComponent(conv)+'/'+encodeURIComponent(turn);}
  async function post(url,data){const response=await fetcher(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data),credentials:'same-origin'});if(!response.ok)throw Error('Page request failed ('+response.status+')');return response.json();}
  function apply(event,record,conv,turn){
   if(record.conv!==conv||record.turn!==turn)throw Error('Cross-conversation presentation refused');
   const key=conv+':'+turn,old=terminal.get(key),signature=JSON.stringify([event,record.id,record.payload_sha256||record.error_id]);
   if(old){if(old!==signature)throw Error('Conflicting terminal event');return;}
   if(!record.id||record.id!==turn+':terminal')throw Error('Invalid terminal identity');
   // Callback replaces the existing answer for (conv,turn); it must never append a new turn.
   if(event==='presentation')callbacks.presentation({conv,turn,id:record.id,payload:record.payload,sha256:record.payload_sha256});
   else callbacks.failure({conv,turn,id:record.id,message:record.message,error_id:record.error_id});
   terminal.set(key,signature);
  }
  function attach(conv,turn){
   const key=conv+':'+turn;if(active.has(key))active.get(key).close();
   const source=new Source(path(conv,turn)+'/events');active.set(key,source);
   for(const event of ['presentation','failure'])source.addEventListener(event,e=>{try{apply(event,JSON.parse(e.data),conv,turn);}catch(error){source.close();active.delete(key);callbacks.transportError?.(error);}});
   source.addEventListener('progress',e=>callbacks.progress?.({...JSON.parse(e.data),conv,turn}));
   source.addEventListener('approval_request',e=>{const request=JSON.parse(e.data);callbacks.approval?.({conv,turn,request,decide:decision=>post(path(conv,turn)+'/approval',{id:request.id,decision})});});
   source.addEventListener('end',e=>{source.close();active.delete(key);callbacks.end?.(JSON.parse(e.data));});
   // Native EventSource reconnects. A terminal event is replayable and idempotent.
   source.onerror=()=>callbacks.reconnecting?.({conv,turn});return source;
  }
  return {async start(conv,turn,question){await post('/api/page/turns',{conv,turn,question});return attach(conv,turn);},attach,
   cancel:(conv,turn)=>post(path(conv,turn)+'/cancel',{}),
   detach(conv,turn){const key=conv+':'+turn;active.get(key)?.close();active.delete(key);}};
 }
 if(typeof module!=='undefined')module.exports={createClient};else root.JarvisPageChannel={createClient};
})(typeof window==='undefined'?globalThis:window);
