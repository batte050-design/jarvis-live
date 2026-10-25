import React, {useState, useEffect, useRef} from 'react';
import {createRoot} from 'react-dom/client';
import {Renderer, type ActionEvent} from '@openuidev/react-lang';
import {library,setHarnessImages,setReceipts,setPhotoLookup,setPhotoStatus,type Receipt,type Photo} from './library';
import {validateProgram,formulaStates} from './guard';
import './reference/components/theme.css';
import './reference/components/components.css';
import './frame.css';

declare global{interface Window{JarvisOpenUIInspection?:{states:Record<string,unknown>;formulaStates:string[]};JarvisOpenUIBootstrap:{parentOrigin:string}}}
const nonce=location.hash.slice(1),origin=window.JarvisOpenUIBootstrap.parentOrigin;
let serial=0, currentRevision=0;
const pending=new Map<string,{resolve:(v:Photo[])=>void;timer:ReturnType<typeof setTimeout>}>();
const send=(type:string,value:object={})=>parent.postMessage({channel:'jarvis-openui',nonce,type,...value},origin);
const media=()=>{const nodes=[...document.querySelectorAll('.jl-photo')];return {pending:nodes.filter(n=>n.getAttribute('data-photo-status')==='pending').length,failed:nodes.filter(n=>n.getAttribute('data-photo-status')==='failed').length};};
setPhotoStatus(()=>send('media',{revision:currentRevision,...media()}));
setPhotoLookup(query=>new Promise(resolve=>{if(pending.size>=12)return resolve([]);const id=String(++serial),timer=setTimeout(()=>{pending.delete(id);resolve([]);},52000);pending.set(id,{resolve,timer});send('images',{id,query});}));
class RenderBoundary extends React.Component<{children:React.ReactNode;onFailure:(e:Error)=>void},{failed:boolean}>{
 state={failed:false};static getDerivedStateFromError(){return{failed:true};}
 componentDidCatch(error:Error){this.props.onFailure(error);}render(){return this.state.failed?null:this.props.children;}
}
function Frame(){
  const [answer,setAnswer]=useState<{code:string;final:boolean;receipts:Receipt[];numeric:boolean;revision:number}|null>(null),[error,setError]=useState(false);
  const editedState=useRef<Record<string,unknown>>({});
  useEffect(()=>{
    const receive=(event:MessageEvent)=>{const d=event.data;
      if(event.source!==parent||event.origin!==origin||!d||d.channel!=='jarvis-openui'||d.nonce!==nonce)return;
      if(d.type==='images'){const p=pending.get(d.id);if(p){clearTimeout(p.timer);pending.delete(d.id);p.resolve(Array.isArray(d.photos)?d.photos:[]);}return;}
      if(d.type!=='render'||!Number.isSafeInteger(d.revision)||d.revision<=currentRevision||typeof d.code!=='string')return;
      currentRevision=d.revision;
      try{setHarnessImages(d.harnessAuthored===true);setReceipts(Array.isArray(d.receipts)?d.receipts:[]);const parsed=validateProgram(d.code,!!d.final,d.receipts,d.harnessAuthored===true);window.JarvisOpenUIInspection={states:parsed.stateDeclarations,formulaStates:formulaStates(parsed)};setError(false);setAnswer({code:parsed.canonicalCode,final:!!d.final,receipts:d.receipts??[],numeric:Object.values(parsed.stateDeclarations).some(v=>typeof v==='number'),revision:d.revision});document.documentElement.dataset.theme=d.theme==='light'?'light':'dark';}
      catch{if(d.final){setError(true);send('failed',{revision:currentRevision,diagnostic:{phase:'validation',code:'browser_validation_failed',message:'The interactive answer did not pass browser validation.'}});}}
    };
    const link=(event:MouseEvent)=>{const anchor=(event.target as Element)?.closest('a');if(anchor){event.preventDefault();if(event.isTrusted)send('link',{url:anchor.href});}};
    addEventListener('click',link);addEventListener('message',receive);send('ready');return()=>{removeEventListener('message',receive);removeEventListener('click',link);};
  },[]);
  // A failed frame is hidden by the parent. Hidden iframes can suspend animation frames,
  // so the recovery acknowledgement must not depend on requestAnimationFrame.
  useEffect(()=>{if(!answer||error)return;const node=document.querySelector('#openui-root')!;let mounted=false;
    const check=()=>{const visible=[...node.children].filter(n=>!n.classList.contains('jl-receipt'));if(!mounted&&visible.some(n=>(n.textContent?.trim()||n.querySelector('input,button,img,svg,canvas')))){mounted=true;send('mounted',{revision:answer.revision,...media()});}};
    const observer=new MutationObserver(check);observer.observe(node,{childList:true,subtree:true,characterData:true});const initial=setTimeout(check,0),deadline=setTimeout(()=>{if(!mounted&&answer.final){setError(true);send('failed',{revision:answer.revision,diagnostic:{phase:'render',code:'empty_render',message:'The interactive answer rendered no content.'}});}},2000);
    return()=>{observer.disconnect();clearTimeout(initial);clearTimeout(deadline);};},[answer,error]);

  useEffect(()=>{const node=document.querySelector('#openui-root')!;let raf=0,last=-1;const resize=()=>{cancelAnimationFrame(raf);raf=requestAnimationFrame(()=>{const height=Math.ceil(node.getBoundingClientRect().height+16);if(height!==last){last=height;send('height',{height});}});};
    const observer=new ResizeObserver(resize);observer.observe(node);resize();return()=>{observer.disconnect();cancelAnimationFrame(raf);};},[]);
  const onAction=(event:ActionEvent)=>{
    // State actions run in the OpenUI store. Host actions only prepare a draft; they never send a turn.
    if(event.type==='continue_conversation')send('draft',{text:event.humanFriendlyMessage,values:event.formState??{}});
    if(event.type==='open_url')send('link',{url:event.params.url});
    if(event.type==='CopyToClipboard')send('copy',{text:event.params.text});
  };
  return <>{!error&&answer&&<RenderBoundary onFailure={()=>{setError(true);send('failed',{revision:answer.revision,diagnostic:{phase:'render',code:'renderer_crash',message:'The interactive answer could not render.'}});}}><Renderer response={answer.code} library={library} isStreaming={!answer.final} publishObservability={false} onAction={onAction} initialState={editedState.current}
    onError={errors=>{if(answer.revision===currentRevision&&answer.final&&errors.some(e=>e.severity!=='warning')){setError(true);send('failed',{revision:answer.revision,diagnostic:{phase:'render',code:'browser_render_failed',message:'The interactive answer could not render.',errors:errors.filter(e=>e.severity!=='warning').slice(0,5).map(e=>({code:String(e.code||'render_error').slice(0,80),message:String(e.message||'').slice(0,240)}))}});}}}
    onStateUpdate={state=>{editedState.current=state;send('edited');}}/></RenderBoundary>}
    {!error&&answer?.receipts.filter(r=>r.id!=='editable-inputs'||answer.numeric).map(r=><p className="jl-receipt" key={r.id}>{r.id==='editable-inputs'?'Calculated from your editable inputs.':r.credit.replace(/;?\s*(?:recorded this turn:|retrieved:?)\s*\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/gi,'')}</p>)}</>;
}
createRoot(document.getElementById('openui-root')!).render(<Frame/>);
