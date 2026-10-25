/* Run the repository's actual painter functions; no mirrored Markdown renderer. */
'use strict';
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {Document}=require('./response_dom');
function painter(root,broker,sourceOverride){
 const source=sourceOverride||fs.readFileSync(path.join(root,'static/v1.js'),'utf8'),document=new Document();
 const window={JarvisResponses:broker},context={document,window,NodeFilter:{SHOW_TEXT:4},textMode:true,answerSettled:false,console,URL,TextEncoder,Event:class{},setTimeout,clearTimeout,
  OUTBOX_RE:/\[\[file:([^\]\n]+)\]\]/g,OUTBOX:'jl_outbox',FILE_KINDS:{txt:'text',pdf:'pdf'},SVGNS:'http://www.w3.org/2000/svg',imgLookupCache:{},imgPending:0,frames:[],WIDGET_HOST:'widgets.example.test'};
 const extract=name=>{const m=source.match(new RegExp('^  function '+name+'\\([^\\n]*\\) \\{[\\s\\S]*?^  \\}','m'));if(!m)throw Error('missing function '+name);return m[0];};
 // All helper declarations, and the painter's own fixed tables and regular expressions, verbatim.
 const start=source.indexOf('  var INLINE_RE ='),end=source.indexOf('  // The confirmation he taps',start);
 let code=source.slice(start,end)+'\n';
 for(const name of ['pill','structLine','hasStructure','braceDepth','splitBlocks','settleBody','streamFold','streamReset','streamRender','paintBodyInto','fileKind','fileGlyph','outboxBytes','fileHandOff','outboxOpen','outboxCard','outboxLinks'])code+=extract(name)+'\n';
 vm.createContext(context);vm.runInContext(code,context);
 return {context,document,draw(text,shape='prose',el=document.createElement('div')){context.paintBodyInto(el,text,true,shape);return el;},settle(el,text,finished=false){context.answerSettled=finished;context.settleBody(el,text,'prose');}};
}
function snapshot(node){return {tag:node.tagName,cls:node.className,text:node._text,attrs:node.attributes,value:node.value,disabled:node.disabled,html:node._html||'',children:node.childNodes.map(snapshot)};}
module.exports={painter,snapshot};
