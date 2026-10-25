/* Deliberately small DOM double for deterministic component/broker unit tests. */
'use strict';
class Node {
  constructor(tag,doc,type=1) { this.tagName=tag.toUpperCase();this.ownerDocument=doc;this.nodeType=type;this.children=[];this.parentNode=null;this.attributes={};this.dataset={};this.style={};this.listeners={};this.hidden=false;this.disabled=false;this._text='';this.className='';this.value='';this.checked=false;
    if(tag==='iframe') this.contentWindow={sent:[],postMessage(d,origin){this.sent.push({data:d,origin});}};
  }
  get parentElement(){return this.parentNode && this.parentNode.nodeType===1 ? this.parentNode : null;}
  get nodeValue(){return this.nodeType===3 ? this._text : null;}
  get classList(){const node=this;return {add(...names){node.className=[...new Set(node.className.split(/\s+/).filter(Boolean).concat(names))].join(' ');},remove(name){node.className=node.className.split(/\s+/).filter(n=>n!==name).join(' ');},contains(name){return node.className.split(/\s+/).includes(name);}};}
  get innerHTML(){return this._html||'';}
  set innerHTML(html){
    this.textContent='';this._html=String(html);const stack=[this],tokens=String(html).match(/<[^>]*>|[^<]+/g)||[];
    for(const token of tokens){if(token.startsWith('</')){if(stack.length>1)stack.pop();continue;}if(token.startsWith('<')){const tag=/^<([a-z0-9-]+)/i.exec(token);if(!tag)continue;const n=this.ownerDocument.createElement(tag[1]);for(const m of token.matchAll(/([a-z-]+)="([^"]*)"/gi))n.setAttribute(m[1],m[2]);stack.at(-1).appendChild(n);if(!token.endsWith('/>')&&!['input','img','br','hr','meta'].includes(tag[1]))stack.push(n);}else stack.at(-1).appendChild(this.ownerDocument.createTextNode(token));}
  }
  get nextSibling(){if(!this.parentNode)return null;return this.parentNode.children[this.parentNode.children.indexOf(this)+1]||null;}
  get childNodes(){return this.children;} get firstChild(){return this.children[0]||null;}
  get textContent(){return this._text+this.children.map(c=>c.textContent).join('');}
  set textContent(v){this._text=String(v);this.children.forEach(c=>c.parentNode=null);this.children=[];}
  get isConnected(){let n=this;while(n){if(n===this.ownerDocument.documentElement)return true;n=n.parentNode;}return false;}
  insertAdjacentHTML(where,html){if(where!=='beforeend')throw Error('unsupported test insertion');const n=this.ownerDocument.createElement('div');n.innerHTML=html;while(n.firstChild)this.appendChild(n.firstChild);}
  setAttribute(k,v){this.attributes[k]=String(v);if(k==='class')this.className=String(v);if(k==='id')this.id=String(v);if(k.startsWith('data-'))this.dataset[k.slice(5).replace(/-([a-z])/g,(_,c)=>c.toUpperCase())]=String(v);}
  getAttribute(k){return this.attributes[k]??null;}
  removeAttribute(k){delete this.attributes[k];}
  appendChild(n){return this.insertBefore(n,null);}
  insertBefore(n,b){if(n.nodeType===11){for(const c of [...n.children])this.insertBefore(c,b);return n;} if(n.parentNode)n.remove();let i=b?this.children.indexOf(b):-1;if(i<0)i=this.children.length;this.children.splice(i,0,n);n.parentNode=this;return n;}
  replaceChild(n,old){this.insertBefore(n,old);this.removeChild(old);return old;}
  removeChild(n){let i=this.children.indexOf(n);if(i<0)throw Error('not child');this.children.splice(i,1);n.parentNode=null;return n;}
  remove(){if(this.parentNode)this.parentNode.removeChild(this);}
  replaceChildren(...nodes){this.textContent='';nodes.forEach(n=>this.appendChild(n));}
  contains(n){return n===this||this.children.some(c=>c.contains(n));}
  matches(sel){if(sel.includes(','))return sel.split(',').some(s=>this.matches(s.trim()));if(sel==='*')return true;if(sel[0]==='.')return this.className.split(/\s+/).includes(sel.slice(1));return this.tagName.toLowerCase()===sel.toLowerCase();}
  closest(sel){let n=this;while(n){if(n.matches(sel))return n;n=n.parentNode;}return null;}
  querySelectorAll(sel){let out=[];for(const c of this.children){if(c.matches(sel))out.push(c);out.push(...c.querySelectorAll(sel));}return out;}
  querySelector(sel){return this.querySelectorAll(sel)[0]||null;}
  addEventListener(type,fn){(this.listeners[type]||=[]).push(fn);}
  async fire(type,extra={}){const e={type,target:this,currentTarget:this,isTrusted:false,button:0,isPrimary:true,pointerId:1,...extra};for(const fn of this.listeners[type]||[])await fn(e);return e;}
  dispatchEvent(e){this.fire(e.type,e);return true;}
  focus(){this.ownerDocument.activeElement=this;}
  checkValidity(){return true;}
  get valueAsNumber(){return Number(this.value);}
}
class Document {
  constructor(){this.documentElement=new Node('html',this);this.body=new Node('body',this);this.documentElement.appendChild(this.body);this.activeElement=null;this.defaultView={requestAnimationFrame(fn){queueMicrotask(fn);return 1;}};}
  createTreeWalker(root){const all=[];function visit(n){for(const c of n.childNodes){if(c.nodeType===3)all.push(c);visit(c);}}visit(root);return {nextNode(){return all.shift()||null;}};}
  createElement(tag){return new Node(tag,this);} createElementNS(ns,tag){return new Node(tag,this);}
  createDocumentFragment(){return new Node('fragment',this,11);} createTextNode(s){const n=new Node('text',this,3);n.textContent=s;return n;}
  getElementById(id){return [this.documentElement,...this.documentElement.querySelectorAll('*')].find(n=>n.id===id)||null;}
}
module.exports={Node,Document};
