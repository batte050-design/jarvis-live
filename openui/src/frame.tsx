import React, {useState, useEffect} from 'react';
import {createRoot} from 'react-dom/client';
import {Renderer, type ActionEvent} from '@openuidev/react-lang';
import {library,setReceipts,setPhotoLookup,setPhotoFailure,type Receipt,type Photo} from './library';
import {validateProgram} from './guard';
import './reference/components/theme.css';
import './reference/components/components.css';
import './frame.css';

declare global{interface Window{JarvisOpenUIBootstrap:{parentOrigin:string}}}
const nonce=location.hash.slice(1),origin=window.JarvisOpenUIBootstrap.parentOrigin;
let serial=0, currentRevision=0;
const pending=new Map<string,{resolve:(v:Photo[])=>void;timer:ReturnType<typeof setTimeout>}>();
const send=(type:string,value:object={})=>parent.postMessage({channel:'jarvis-openui',nonce,type,...value},origin);
setPhotoFailure(()=>send('partial'));
setPhotoLookup(query=>new Promise(resolve=>{if(pending.size>=8)return resolve([]);const id=String(++serial),timer=setTimeout(()=>{pending.delete(id);resolve([]);},15000);pending.set(id,{resolve,timer});send('images',{id,query});}));
function Frame(){
  const [answer,setAnswer]=useState<{code:string;final:boolean;receipts:Receipt[];numeric:boolean}|null>(null),[error,setError]=useState('');
  useEffect(()=>{
    const receive=(event:MessageEvent)=>{const d=event.data;
      if(event.source!==parent||event.origin!==origin||!d||d.channel!=='jarvis-openui'||d.nonce!==nonce)return;
      if(d.type==='images'){const p=pending.get(d.id);if(p){clearTimeout(p.timer);pending.delete(d.id);p.resolve(Array.isArray(d.photos)?d.photos:[]);}return;}
      if(d.type!=='render'||!Number.isSafeInteger(d.revision)||d.revision<=currentRevision||typeof d.code!=='string')return;
      currentRevision=d.revision;
      try{setReceipts(Array.isArray(d.receipts)?d.receipts:[]);const parsed=validateProgram(d.code,!!d.final,d.receipts);setError('');setAnswer({code:d.code,final:!!d.final,receipts:d.receipts??[],numeric:Object.values(parsed.stateDeclarations).some(v=>typeof v==='number')});document.documentElement.dataset.theme=d.theme==='light'?'light':'dark';}
      catch{setError('The visual part of this answer could not be displayed.');send('failed',{revision:currentRevision});}
    };
    const link=(event:MouseEvent)=>{const anchor=(event.target as Element)?.closest('a');if(anchor){event.preventDefault();if(event.isTrusted)send('link',{url:anchor.href});}};
    addEventListener('click',link);addEventListener('message',receive);send('ready');return()=>{removeEventListener('message',receive);removeEventListener('click',link);};
  },[]);
  useEffect(()=>{const node=document.querySelector('#openui-root')!;let raf=0,last=-1;const resize=()=>{cancelAnimationFrame(raf);raf=requestAnimationFrame(()=>{const height=Math.ceil(node.getBoundingClientRect().height+16);if(height!==last){last=height;send('height',{height});}});};
    const observer=new ResizeObserver(resize);observer.observe(node);resize();return()=>{observer.disconnect();cancelAnimationFrame(raf);};},[]);
  const onAction=(event:ActionEvent)=>{
    // State actions run in the OpenUI store. Host actions only prepare a draft; they never send a turn.
    if(event.type==='continue_conversation')send('draft',{text:event.humanFriendlyMessage,values:event.formState??{}});
    if(event.type==='open_url')send('link',{url:event.params.url});
    if(event.type==='CopyToClipboard')send('copy',{text:event.params.text});
  };
  return <>{error?<p role="status">{error}</p>:answer&&<Renderer response={answer.code} library={library} isStreaming={false} publishObservability={false} onAction={onAction}
    onError={errors=>{if(answer.final&&errors.some(e=>e.severity!=='warning')){setError('The visual part of this answer could not be displayed.');send('failed',{revision:currentRevision});}}}
    onStateUpdate={()=>send('edited')}/>}
    {!error&&answer?.receipts.filter(r=>r.id!=='editable-inputs'||answer.numeric).map(r=><p className="jl-receipt" key={r.id}>{r.credit}</p>)}</>;
}
createRoot(document.getElementById('openui-root')!).render(<Frame/>);
