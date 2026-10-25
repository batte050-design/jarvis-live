/** Compatibility lowering for read-only calculated state defaults unsupported by the SDK store. */
export const inputs=new Set(['Input','Slider','Checkbox','TextArea','Select','RadioGroup','DatePicker','SegmentedControl','Timer']);
export function canonicalProgram(code:string,parsed:any){
 const derived=Object.entries(parsed.stateDeclarations).filter(([,v]:any)=>v&&typeof v==='object'&&typeof v.k==='string').map(([k])=>k);
 if(!derived.length)return code;
 const editable=new Set<string>(),seen=new Set<object>();let count=0;
 function refs(v:any){if(!v||typeof v!=='object')return;if(v.k==='StateRef')editable.add(v.n);Object.values(v).forEach(refs);}
 function visit(v:any,depth=0){if(!v||typeof v!=='object'||seen.has(v))return;if(depth>64||++count>10000)throw Error('Answer is too complex.');seen.add(v);if(v.type==='element'&&inputs.has(v.typeName))refs(v.props.value??v.props.checked??v.props.seconds);if(v.k==='Comp'&&(inputs.has(v.name)||['Set','Reset'].includes(v.name)))refs(v.args?.[0]);Object.values(v).forEach(c=>visit(c,depth+1));}visit(parsed.root);
 const aliases=new Map<string,string>();let serial=0;
 for(const name of derived){if(editable.has(name))throw Error('Editable state '+name+' needs a literal initial value; calculated values use ordinary names, without $.');let alias;do{alias='_jarvisDerived'+serial++;}while(code.includes(alias));aliases.set(name,alias);}
 let previous='';
 return code.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\/\/[^\n]*|\/\*[\s\S]*?\*\/|\$[A-Za-z_][A-Za-z_0-9]*|[A-Za-z_][A-Za-z_0-9$]*|\S/g,(t,offset)=>{
  if(t.startsWith('//')||t.startsWith('/*'))return t;
  const next=code.slice(offset+t.length).replace(/^(?:\s|\/\/[^\n]*|\/\*[\s\S]*?\*\/)*/,'')[0];
  const objectKey=(previous==='{'||previous===',')&&next===':';
  const out=objectKey?t:(aliases.get(t)??t);previous=t;return out;
 });
}
export function formulaStates(result:any){
 const refs=new Set<string>(),seen=new Set<object>(),expanding=new Set<string>();
 function scan(v:any,formula=false){if(!v||typeof v!=='object'||seen.has(v))return;seen.add(v);if(v.type==='element'&&inputs.has(v.typeName))return;
  const derived=formula||v.k==='BinOp'||v.k==='UnaryOp'||(v.k==='Comp'&&!inputs.has(v.name));
  if(derived&&v.k==='StateRef'){const decl=result.stateDeclarations[v.n];if(decl&&typeof decl==='object'&&typeof decl.k==='string'){if(expanding.has(v.n))throw Error('Cyclic derived state');expanding.add(v.n);scan(decl,true);expanding.delete(v.n);}else refs.add(v.n);}
  Object.values(v).forEach(c=>scan(c,derived));
 }scan(result.root);return [...refs].sort();
}
