import {canonicalProgram} from './normalise';
export {formulaStates} from './normalise';
import {createParser} from '@openuidev/lang-core';
import {library, type Receipt} from './library';
const parser=createParser(library.toJSONSchema());
const INPUTS=new Set(['Input','Slider','Checkbox','TextArea','Select','RadioGroup','DatePicker','SegmentedControl','Timer']);
const TRANSFORMS=new Set(['Filter','Sort','Take','Slice','Unique','Reverse','GroupBy','Pivot','Top','Between','Cumulative','MovingAvg']);
export function validateProgram(code:string,final=true,receipts:Receipt[]=[]){
  if(typeof code!=='string'||new TextEncoder().encode(code).length>65536)throw Error('Answer exceeds the visual response limit.');
  if(/\b(?:Query|Mutation)\s*\(/.test(code))throw Error('This answer requests an unavailable data operation.');
  const initial=parser.parse(code);if(initial.meta.statementCount>256)throw Error('Too many statements.');
  const canonicalCode=canonicalProgram(code,initial),result=canonicalCode===code?initial:parser.parse(canonicalCode);
  if(result.meta.statementCount>256)throw Error('Too many statements.');
  if(final&&(!result.root||result.meta.incomplete||result.meta.unresolved.length||result.meta.errors.length))throw Error(
    'Invalid OpenUI: '+[!result.root?'missing root':'',result.meta.incomplete?'incomplete program':'',result.meta.unresolved.length?'unresolved: '+result.meta.unresolved.join(', '):'',...result.meta.errors.slice(0,12).map(e=>e.component+e.path+': '+e.message)].filter(Boolean).join('; ').slice(0,2000));
  let count=0;const seen=new Set<object>();
  function sourced(v:any):boolean{
    if(v?.k!=='Comp')return false;
    if(v.name==='Receipt')return v.args?.length===1&&v.args[0]?.k==='Str'&&receipts.some(r=>r.id===v.args[0].v&&r.rows.length>0);
    return TRANSFORMS.has(v.name)&&sourced(v.args?.[0])&&v.args.slice(1).every((arg:any)=>['Str','Num','Bool','Null'].includes(arg.k));
  }
  function visit(v:any,depth=0){
    if(depth>64||++count>10000)throw Error('Answer is too complex.');
    if(!v||typeof v!=='object'||seen.has(v))return;seen.add(v);
    if(v.type==='element'){
      if(!library.components[v.typeName])throw Error('Unsupported primitive.');
      const component=library.components[v.typeName];
      function dynamic(value:any):boolean{return !!(value&&typeof value==='object'&&(value.type==='element'||typeof value.k==='string'||Object.values(value).some(dynamic)));}
      if(final)for(const[key,value]of Object.entries(v.props)){
        const schema=component.props.shape[key];
        // Positional calls use null to leave an optional slot at its default while setting
        // a later argument (e.g. Chart currency with a numeric axis and explicit height).
        if(value===null&&schema?.isOptional())continue;
        if(!dynamic(value)&&schema&&!schema.safeParse(value).success)throw Error('Invalid '+v.typeName+'.'+key+' property.');
      }
      if(v.typeName==='Chart'){
        // A receipt lookup (possibly transformed by @functions) is the only source of plotted data.
        if(!sourced(v.props.data))throw Error('A dated data receipt is required for this chart.');
      }
    }
    for(const [key,child]of Object.entries(v)){if(['__proto__','prototype','constructor'].includes(key))throw Error('Invalid property.');visit(child,depth+1);}
  }
  if(result.root)visit(result.root);
  return Object.assign(result,{canonicalCode});
}
