/* Acceptance-only state dataflow probes; never select controls by label text. */
async function recompute(page,id,programs=[]){
 if(!['g17','g18','g19','g20','g22','g23','g30'].includes(id))return null;
 const edits=[],inspections=[];let frameIndex=0;
 const restored=async(output,before)=>{for(let i=0;i<50;i++){if(await output()===before)return;await new Promise(r=>setTimeout(r,100));}throw Error("Restored input did not restore derived output");};
 for(const frame of page.frames().filter(f=>f.url().includes('/api/openui/runtime'))){
  let info=await frame.evaluate(()=>window.JarvisOpenUIInspection);if(!info)info=await require('./binding_inspection').inspect(frame,programs[frameIndex]);frameIndex++;if(!info)throw Error('No state binding inspection');inspections.push(info.inspection||'Runtime state-binding attributes');
  const output=()=>frame.evaluate(()=>{const w=document.createTreeWalker(document.querySelector('#openui-root'),NodeFilter.SHOW_TEXT),a=[];let n;while(n=w.nextNode())if(n.parentElement.getClientRects().length&&getComputedStyle(n.parentElement).visibility!=='hidden'&&!n.parentElement.closest('input,select,textarea,label,output,.iui-field,.iui-slider,.jl-receipt'))a.push(n.textContent);return a.join(' ').replace(/\s+/g,' ').trim();});
  for(const state of info.formulaStates){const value=info.states[state];if(!['number','boolean','string'].includes(typeof value))throw Error('Unsupported formula state value: '+state);
   const fields=frame.locator('[data-state-binding]:visible'),matches=await fields.evaluateAll((ns,key)=>ns.map((n,i)=>n.dataset.stateBinding===key?i:-1).filter(i=>i>=0),state);if(!matches.length)throw Error('Formula state has no reachable editable control: '+state);const input=fields.nth(matches[0]);if(!await input.isEnabled())throw Error('Disabled formula input: '+state);await input.scrollIntoViewIfNeeded();const before=await output(),tag=await input.evaluate(n=>n.tagName),type=await input.getAttribute('type');
   if(tag==='BUTTON'||type==='radio'||type==='checkbox'||tag==='SELECT'){
    let restore,changed;
    if(type==='checkbox'){const checked=await input.isChecked();await input.setChecked(!checked);changed=!checked;restore=()=>input.setChecked(checked);}
    else if(tag==='SELECT'){const old=await input.inputValue(),options=await input.locator('option:not([disabled])').evaluateAll(ns=>ns.map(n=>n.value).filter(Boolean)),next=options.find(v=>v!==old);if(next===undefined)throw Error('No alternate selection for '+state);await input.selectOption(next);changed=next;restore=()=>input.selectOption(old);}
    else{let oldIndex,nextIndex;for(const i of matches){const f=fields.nth(i),selected=tag==='BUTTON'?await f.getAttribute('aria-checked')==='true':await f.isChecked();if(selected)oldIndex=i;else if(nextIndex===undefined)nextIndex=i;}if(oldIndex===undefined||nextIndex===undefined)throw Error('No alternate bound option for '+state);const next=fields.nth(nextIndex);await next.click();changed=await next.getAttribute('data-option-value')||'option index '+nextIndex;restore=()=>fields.nth(oldIndex).click();}
    await frame.waitForFunction(old=>{const w=document.createTreeWalker(document.querySelector('#openui-root'),NodeFilter.SHOW_TEXT),a=[];let n;while(n=w.nextNode())if(n.parentElement.getClientRects().length&&getComputedStyle(n.parentElement).visibility!=='hidden'&&!n.parentElement.closest('input,select,textarea,label,output,.iui-field,.iui-slider,.jl-receipt'))a.push(n.textContent);return a.join(' ').replace(/\s+/g,' ').trim()!==old;},before,{timeout:5000});const after=await output();if(after===before)throw Error('Bound option did not change derived output: '+state);edits.push({state,from:value,to:changed,output_before:before,output_after:after,passed:true});await restore();await restored(output,before);continue;
   }
   if(typeof value!=='number'&&!Number.isFinite(Number(value)))throw Error('Unsupported free-text formula probe: '+state);
   const original=await input.inputValue();let changed;
   if(await input.getAttribute('type')==='range'){const max=await input.getAttribute('max');await input.press(Number(original)===Number(max)?'Home':'End');changed=await input.inputValue();}
   else{changed=String(Number(value)+Math.max(1,Math.round(Math.abs(Number(value))*.25)));await input.focus();await input.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));await input.fill(changed);await input.press('Tab');if(Number((await input.inputValue()).replace(/,/g,''))!==Number(changed))throw Error('Entered value mismatch for '+state);}
   await frame.waitForFunction(old=>{const w=document.createTreeWalker(document.querySelector('#openui-root'),NodeFilter.SHOW_TEXT),a=[];let n;while(n=w.nextNode())if(n.parentElement.getClientRects().length&&getComputedStyle(n.parentElement).visibility!=='hidden'&&!n.parentElement.closest('input,select,textarea,label,output,.iui-field,.iui-slider,.jl-receipt'))a.push(n.textContent);return a.join(' ').replace(/\s+/g,' ').trim()!==old;},before,{timeout:5000});
   const after=await output();if(!after)throw Error('Formula change blanked the renderer');edits.push({state,from:original,to:changed,output_before:before,output_after:after,passed:true});
   if(await input.getAttribute('type')==='range'){await input.press('Home');const step=Number(await input.getAttribute('step')||1),min=Number(await input.getAttribute('min')||0),count=Math.round((Number(original)-min)/step);if(count>1000)throw Error('Range restore exceeds keyboard budget');for(let i=0;i<count;i++)await input.press('ArrowRight');}
   else{await input.focus();await input.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));await input.fill(String(value));await input.press('Tab');if(Number((await input.inputValue()).replace(/,/g,''))!==Number(value))throw Error('Value restore mismatch for '+state);}
   await restored(output,before);
  }
 }
 if(!edits.length)throw Error('No formula bindings found');return{passed:true,edits,inspections};
}
module.exports={recompute};
