/* Runs INSIDE the iframe; composite ancestor backgrounds before checking contrast. */
function auditContrast(){
 const canvas=document.createElement('canvas');canvas.width=canvas.height=1;const ctx=canvas.getContext('2d',{willReadFrequently:true});
 const pixel=colors=>{ctx.clearRect(0,0,1,1);for(const c of colors){ctx.fillStyle=c;ctx.fillRect(0,0,1,1);}return [...ctx.getImageData(0,0,1,1).data].slice(0,3);};
 const luminance=rgb=>rgb.map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4;}).reduce((a,v,i)=>a+v*[.2126,.7152,.0722][i],0);
 const ratio=(a,b)=>{a=luminance(a);b=luminance(b);return(Math.max(a,b)+.05)/(Math.min(a,b)+.05);};
 const ground=document.documentElement.dataset.theme==='light'?'#f5f4f0':'#111315',results=[];
 for(const node of document.querySelectorAll('label,.iui-label,.iui-caption,.iui-text,.jl-receipt,input,select,textarea,.iui-range,button svg,.iui-icon svg')){
  if(!node.getClientRects().length)continue;const ancestors=[];for(let n=node;n;n=n.parentElement)ancestors.unshift(getComputedStyle(n).backgroundColor);
  const bg=pixel([ground,...ancestors]),style=getComputedStyle(node),control=node.matches('input[type=range],svg');
  const fg=node.matches('input[type=range]')?style.getPropertyValue('--iui-range-track'):style.color,measured=ratio(pixel([ground,...ancestors,fg]),bg),required=control?3:4.5;
  results.push({element:node.tagName,label:(node.getAttribute('aria-label')||node.textContent||'').slice(0,100),ratio:measured,required,passed:measured>=required});
 }return results;
}
module.exports={auditContrast};
