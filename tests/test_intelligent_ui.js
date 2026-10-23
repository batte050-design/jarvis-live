/* Regressions through the actual production painter, not a replacement Markdown parser. */
'use strict';
const assert = require('node:assert/strict');
const {painter} = require('./response_painter');
const p = painter(require('node:path').resolve(__dirname, '..'));
let checks = 0;
function check(name, fn) { fn(); checks++; console.log('PASS ' + name); }
const table = (header, rows) => '| ' + header.join(' | ') + ' |\n| ' + header.map(()=>'---').join(' | ') + ' |\n' + rows.map(r=>'| '+r.join(' | ')+' |').join('\n');
const values = node => node.querySelectorAll('td').map(n=>n.textContent);

check('weather keeps all five columns, units and exact values', () => {
  const n = p.draw(table(['Day', 'High °C', 'Low °C', 'Rain mm', 'Wet %'], [['Sat 24',27,19,0.7,51],['Sun 25',26,19,4.4,86]]));
  assert.equal(n.querySelectorAll('th').length, 5);
  assert.deepEqual(values(n), ['Sat 24','27','19','0.7','51','Sun 25','26','19','4.4','86']);
  const region=n.querySelector('.rc-tw');
  assert.equal(region.getAttribute('tabindex'),'0');
  assert.equal(region.getAttribute('role'),'region');
  assert.match(region.getAttribute('aria-label'),/scroll horizontally/);
  assert.ok(n.querySelectorAll('th').every(th=>th.getAttribute('scope')==='col'));
});
check('omitted rank header no longer shifts Building, City, Height and Year', () => {
  const n = p.draw(table(['Building','City','Height m','Year'], [[1,'Burj Khalifa','Dubai',828,2010],[2,'Merdeka 118','Kuala Lumpur',679,2023]]));
  assert.deepEqual(n.querySelectorAll('th').map(n=>n.textContent),['#','Building','City','Height m','Year']);
  assert.deepEqual(values(n).slice(0,5),['1','Burj Khalifa','Dubai','828','2010']);
});
check('explicit rank and empty leading rank label remain intact', () => {
  for(const rank of ['#','']) {
    const n=p.draw(table([rank,'Name','Height'],[[1,'Burj Khalifa',828],[2,'Merdeka 118',679]]));
    assert.equal(n.querySelectorAll('th').length,3);
    assert.equal(n.querySelectorAll('.rc-table-fallback').length,0);
  }
});
check('ambiguous extra cells fall back without invented column associations', () => {
  const n=p.draw(table(['Name','Value'],[['Dubai','Burj Khalifa',828],['Kuala Lumpur','Merdeka 118',679]]));
  assert.equal(n.querySelectorAll('table').length,0);
  assert.equal(n.querySelectorAll('.rc-table-fallback').length,1);
  for(const word of ['Name','Value','Dubai','Burj Khalifa','828','Kuala Lumpur','679']) assert.ok(n.textContent.includes(word),word);
});
check('short rows retain every supplied cell without shifting a later row', () => {
  const n=p.draw(table(['Name','City','Height'],[['Burj Khalifa','Dubai',828],['Merdeka 118',679]]));
  assert.equal(n.querySelectorAll('table').length,0);
  assert.ok(n.textContent.includes('Merdeka 118 · 679'));
});
check('literal escaped pipes including inline code stay in their original cell', () => {
  const n=p.draw(table(['Name','Value'],[['A \\| B',2],['`C \\| D`',3]]));
  assert.deepEqual(values(n),['A | B','2','C | D','3']);
  assert.equal(n.querySelectorAll('code').length,1);
});
check('even and odd backslash runs preserve delimiter semantics', () => {
  assert.deepEqual(Array.from(p.context.tableCells('| A\\\\| B |')),['A\\\\','B']);
  assert.deepEqual(Array.from(p.context.tableCells('| A\\\\\\| B |')),['A\\\\| B']);
  assert.deepEqual(Array.from(p.context.tableCells('| A | B\\|')),['A','B|']);
});
check('source notes and headings survive malformed-table fallback', () => {
  const n=p.draw('### Buildings | Name | Height |\n| --- | --- |\n| Burj Khalifa | Dubai | 828 |\n| Merdeka 118 | Kuala Lumpur | 679 |\n| Source: supplied test data | |');
  assert.ok(n.textContent.includes('Buildings'));
  assert.ok(n.textContent.includes('Source: supplied test data'));
  assert.equal(n.querySelectorAll('.rc-table-fallback').length,1);
});
check('valid tables still sort whole rows by their proper numeric column', () => {
  const n=p.draw(table(['Name','Height'],[['Merdeka 118',679],['Burj Khalifa',828]]));
  const th=n.querySelectorAll('th')[1];
  th.fire('click'); assert.deepEqual(values(n),['Merdeka 118','679','Burj Khalifa','828']);
  th.fire('keydown',{key:'Enter',preventDefault(){}}); assert.deepEqual(values(n),['Burj Khalifa','828','Merdeka 118','679']);
});
check('stream reconciliation converges to a complete correctly labeled table', () => {
  const text=table(['Building','City','Height'],[[1,'Burj Khalifa','Dubai',828],[2,'Merdeka 118','Kuala Lumpur',679]]);
  const answer=p.document.createElement('div');
  for(let cut=1;cut<=text.length;cut++) p.settle(answer,text.slice(0,cut),false);
  p.settle(answer,text,true);
  assert.equal(answer.querySelectorAll('th').length,4);
  assert.equal(answer.querySelectorAll('.rc-table-fallback').length,0);
  assert.ok(answer.textContent.includes('Kuala Lumpur'));
});
check('table content never becomes executable HTML', () => {
  const n=p.draw(table(['Name','Value'],[['<img src=x onerror=alert(1)>',2],['[bad](javascript:alert)',3]]));
  assert.equal(n.querySelectorAll('img').length,0);
  assert.ok(n.querySelectorAll('a').every(a=>a.getAttribute('href')===null));
});
check('ordinary arithmetic, lists, steps, comparisons and metrics remain distinct', () => {
  const fence = v=>'```ui\n'+JSON.stringify(v)+'\n```';
  assert.equal(p.draw('20,000 × 365 = **7,300,000 UGX**.').querySelectorAll('table').length,0);
  assert.equal(p.draw('- **One** detail\n- **Two** detail').querySelectorAll('li').length,2);
  for(const spec of [
    {type:'steps',steps:[{label:'Intake',detail:'Air enters.'},{label:'Compression',detail:'Piston rises.'}]},
    {type:'compare',columns:[{name:'Phone A',points:['Battery: 39 h']},{name:'Phone B',points:['Battery: 31 h']}]},
    {type:'metrics',items:[{label:'Year total',value:'7,300,000',unit:'UGX'}]}
  ]) {
    const n=p.draw(fence(spec));
    assert.equal(n.querySelectorAll('table').length,0);
    assert.ok(n.textContent.length>0);
    assert.ok(!n.textContent.includes('"type"'));
  }
});
console.log(checks+' intelligent UI checks passed');
