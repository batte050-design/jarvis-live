/* Fixed opaque-frame component renderer. Model content is data, never markup. */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory;
  else {
    var config = root.JarvisResponseBootstrap, core = root.JarvisResponseCore(config.manifest);
    var nonce = new URLSearchParams(root.location.hash.slice(1)).get('nonce');
    if (!/^[0-9a-f]{32}$/.test(nonce || '')) return;
    function send(data) { data.nonce = nonce; root.parent.postMessage(data, config.parentOrigin); }
    var view = factory(core, root.document, send), initialized = false;
    root.addEventListener('message', function (event) {
      if (event.source !== root.parent || event.origin !== config.parentOrigin) return;
      var d = event.data;
      if (!d || typeof d !== 'object' || d.nonce !== nonce) return;
      try {
        if (core.bytes(JSON.stringify(d)) > core.budgets.componentBytes + core.budgets.checkpointBytes + core.budgets.messageBytes) return;
        if (d.type === 'init' && !initialized && Object.keys(d).sort().join() === 'inputs,manifest,nonce,policy,scale,spec,theme,type') {
          if (d.manifest !== config.hash || !['dark','light'].includes(d.theme)) return;
          var result = core.validate(d.spec);
          if (!result.ok || result.legacy) return;
          view.policy(d.policy);
          view.mount(result.spec, core.inputs(result.spec, d.inputs), root.document.getElementById('response-root'));
          initialized = true; view.theme(d.theme,d.scale); send({type:'mounted'});
        } else if (initialized && d.type === 'ack' && Object.keys(d).sort().join() === 'nonce,revision,type' && Number.isSafeInteger(d.revision)) view.ack(d.revision);
        else if (initialized && d.type === 'policy' && Object.keys(d).sort().join() === 'nonce,policy,type') view.policy(d.policy);
        else if (initialized && d.type === 'theme' && Object.keys(d).sort().join() === 'nonce,scale,theme,type' && ['dark','light'].includes(d.theme)) view.theme(d.theme,d.scale);
        else if (initialized && d.type === 'data' && Object.keys(d).sort().join() === 'action,nonce,revision,type,value' && Number.isSafeInteger(d.revision)) view.data(d.action, d.value, d.revision);
      } catch (_) { send({type:'fault', reason:'runtime validation'}); }
    });
    root.addEventListener('pagehide',function () { view.destroy(); });
    root.addEventListener('error', function () { send({type:'fault',reason:'runtime error'}); });
    root.addEventListener('unhandledrejection', function () { send({type:'fault',reason:'runtime rejection'}); });
    send({type:'ready',manifest:config.hash});
  }
})(typeof globalThis === 'object' ? globalThis : this, function (core, document, send) {
  'use strict';
  var spec, state, root, output, revision = 0, acknowledged = 0, dirty = false, timer = null, drawTimer = null;
  var drafts = new Set(), lastSent = '', controls = Object.create(null), agentButtons = [], pendingIntent = null, lastCheckpoint = 0, resizeTimer, ackTimer, inFlight = null, lastIntent = 0;
  var observer, host = document.defaultView || globalThis, B = core.budgets, policy = {interactive:false,data:false,agent:false,remember:false};
  function el(tag, text, cls) { var n = document.createElement(tag); if (text !== undefined) n.textContent = String(text); if (cls) n.className = cls; return n; }
  function svg(tag, attrs, text) {
    var n = document.createElementNS('http://www.w3.org/2000/svg', tag);
    Object.keys(attrs || {}).forEach(function (k) { n.setAttribute(k, String(attrs[k])); });
    if (text !== undefined) n.textContent = String(text);
    return n;
  }
  function format(value, kind) {
    if (kind === 'money') { var money = new Intl.NumberFormat(undefined,{style:'currency',currency:spec.props.currency || 'UGX'}); return money.format(value/Math.pow(10,money.resolvedOptions().maximumFractionDigits)); }
    if (kind === 'percent') return new Intl.NumberFormat(undefined, {maximumFractionDigits:2}).format(value) + '%';
    if (typeof value === 'number') return new Intl.NumberFormat(undefined, {maximumFractionDigits:2}).format(value);
    return String(value);
  }
  function resize() {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () { if (root) send({type:'resize',height:document.documentElement.scrollHeight}); }, 1000 / B.resizePerSecond);
  }
  function fault() { send({type:'fault',reason:'calculation or output'}); }
  function buttons() { agentButtons = agentButtons.filter(function (b) { return b.isConnected; }); agentButtons.forEach(function (b) { b.disabled = !policy.agent || drafts.size > 0 || dirty || acknowledged !== revision; }); }
  function retryCheckpoint() {
    clearTimeout(ackTimer);
    if (!inFlight) return;
    if (Date.now()-inFlight.at > B.checkpointAckTimeoutMs) { fault(); return; }
    send({type:'change',revision:inFlight.revision,inputs:core.clone(inFlight.inputs)});
    ackTimer = setTimeout(retryCheckpoint,B.checkpointAckMs);
  }
  function checkpoint() {
    clearTimeout(timer); timer = null;
    if (!dirty || acknowledged !== revision) return;
    dirty = false;
    var serialized = JSON.stringify(state);
    if (serialized === lastSent) { buttons(); return; }
    lastSent = serialized; revision++; lastCheckpoint = Date.now(); buttons();
    inFlight = {revision:revision,inputs:core.clone(state),at:Date.now()};
    retryCheckpoint();
  }
  function scheduleCheckpoint(final) {
    dirty = true; buttons();
    if (Date.now() - lastCheckpoint >= B.checkpointIntervalMs) checkpoint();
    else { clearTimeout(timer); timer = setTimeout(checkpoint, B.checkpointIntervalMs - (Date.now()-lastCheckpoint)); }
  }
  function draft(id, invalid) {
    var before = drafts.size > 0;
    if (invalid) drafts.add(id); else drafts.delete(id);
    buttons();
    if (before !== (drafts.size > 0)) send({type:'draft',editing:drafts.size > 0});
  }
  function update(id, value, final) {
    try {
      var i = spec.inputs.filter(function (x) { return x.id === id; })[0];
      if (!i) return;
      var candidate = Object.assign(Object.create(null), state); candidate[id] = core.inputValue(i, value);
      core.outputValues(spec, core.evaluate(spec, candidate));
      state = candidate;
      draft(id,false);
      var c = controls[id]; if (c.type === 'checkbox') c.checked = state[id]; else c.value = typeof state[id] === 'number' ? shown(i,state[id]) : String(state[id]);
      if (drawTimer === null) drawTimer = host.requestAnimationFrame(function () { drawTimer = null; paint(); });
      scheduleCheckpoint(final); pendingIntent = null;
    } catch (_) { fault(); }
  }
  function intent(id) {
    var a = spec.actions.filter(function (x) { return x.id === id; })[0];
    if (!a || drafts.size > 0 || a.class === 'AGENT' && !policy.agent || a.class === 'DATA' && !policy.data) return;
    if (a.class === 'LOCAL') { update(a.set.input, a.set.value, true); return; }
    if (dirty || acknowledged !== revision) { pendingIntent = id; checkpoint(); return; }
    if (Date.now()-lastIntent < B.agentIntervalMs) return;
    lastIntent = Date.now(); send({type:'intent',action:id,revision:revision});
  }
  function scale(i) { return i.display === 'money' ? Math.pow(10,new Intl.NumberFormat(undefined,{style:'currency',currency:spec.props.currency || 'UGX'}).resolvedOptions().maximumFractionDigits) : 1; }
  function shown(i,value) { return String(value/scale(i)); }
  function input(i, target) {
    var label = el('label', undefined, 'jr-control'), title = el('span', i.label + (i.display === 'money' ? ' (' + (spec.props.currency || 'UGX') + ')' : '')), c;
    label.appendChild(title);
    if (i.kind === 'select') {
      c = el('select'); i.options.forEach(function (o) { var option = el('option',o.label); option.value = o.value; c.appendChild(option); });
    } else {
      c = el('input'); c.type = {range:'range',stepper:'number',number:'number',toggle:'checkbox',text:'text',date:'date'}[i.kind];
      if (['range','stepper','number'].includes(i.kind)) { c.min = shown(i,i.min); c.max = shown(i,i.max); c.step = shown(i,i.step); }
      if (i.kind === 'text') c.maxLength = i.maxLength || B.inputTextBytes;
    }
    c.id = 'input-' + i.id; c.setAttribute('aria-label',i.label);
    if (c.type === 'checkbox') c.checked = state[i.id]; else c.value = typeof state[i.id] === 'number' ? shown(i,state[i.id]) : String(state[i.id]);
    controls[i.id] = c;
    function read(final) {
      var v = c.type === 'checkbox' ? c.checked : ['range','stepper','number'].includes(i.kind) ? c.valueAsNumber : c.value;
      if (typeof c.checkValidity === 'function' && !c.checkValidity() || ['range','stepper','number'].includes(i.kind) && (!Number.isFinite(v) || c.value.trim() === '')) { draft(i.id,true); return; }
      if (i.display === 'money') v = Math.round(v*scale(i));
      try { core.inputValue(i,v); } catch (_) { draft(i.id,true); return; }
      update(i.id, v, final);
    }
    c.addEventListener('input',function () { read(false); }); c.addEventListener('change',function () { read(true); });
    if (i.kind === 'stepper') {
      var row = el('div',undefined,'jr-stepper');
      [-1,1].forEach(function (direction) {
        var b = el('button',direction < 0 ? '−' : '+'); b.type = 'button';
        b.setAttribute('aria-label',(direction < 0 ? 'Decrease ' : 'Increase ') + i.label);
        b.addEventListener('click',function () { update(i.id,Math.max(i.min,Math.min(i.max,state[i.id] + direction * i.step)),true); });
        if (direction < 0) row.appendChild(b); else { row.appendChild(c); row.appendChild(b); }
      }); label.appendChild(row);
    } else label.appendChild(c);
    if (i.kind === 'range') { var out = el('output',format(i.display === 'basisPoints' ? state[i.id]/100 : state[i.id],i.display === 'basisPoints' ? 'percent' : 'number')); out.htmlFor = c.id; label.appendChild(out); controls[i.id + '-output'] = out; }
    target.appendChild(label);
  }
  function hotspot(wrap, x, y, label, action) {
    var b = el('button',undefined,'jr-hotspot'); b.type = 'button'; b.setAttribute('aria-label',label);
    var half = B.tapTargetPixels/2;
    b.style.left = 'clamp(' + half + 'px,' + String(x / B.coordinateMax * 100) + '%,calc(100% - ' + half + 'px))';
    b.style.top = 'clamp(' + half + 'px,' + String(y / B.coordinateMax * 100) + '%,calc(100% - ' + half + 'px))';
    b.appendChild(el('span',label,'jr-sr'));
    var a = spec.actions.find(function (v) { return v.id === action; });
    if (a.class === 'AGENT') agentButtons.push(b);
    b.disabled = a.class === 'AGENT' ? !policy.agent : a.class === 'DATA' ? !policy.data : false;
    b.addEventListener('click',function () { intent(action); }); wrap.appendChild(b);
  }
  function drawing(o, env) {
    var wrap = el('div',undefined,'jr-drawing'), layer = el('div',undefined,'jr-canvas'), S = B.coordinateMax; wrap.appendChild(layer);
    var canvas = svg('svg',{viewBox:'0 0 ' + S + ' ' + S,role:'img','aria-label':o.title || o.kind}); layer.appendChild(canvas);
    if (o.kind === 'map') {
      canvas.appendChild(svg('rect',{x:0,y:0,width:S,height:S,class:'jr-map-ground'}));
      [0.25,0.5,0.75].forEach(function (p) {
        canvas.appendChild(svg('line',{x1:p*S,y1:0,x2:p*S,y2:S,class:'jr-grid'}));
        canvas.appendChild(svg('line',{x1:0,y1:p*S,x2:S,y2:p*S,class:'jr-grid'}));
      });
      o.points.forEach(function (p) {
        var lat = core.resolve(p.lat,env), lon = core.resolve(p.lon,env), x = (lon+180)/360*S, y = (90-lat)/180*S;
        canvas.appendChild(svg('circle',{cx:x,cy:y,r:5,class:'jr-accent'}));
        canvas.appendChild(svg('text',{x:Math.max(12,Math.min(S-12,x)),y:Math.max(16,Math.min(S-16,y-10)),'text-anchor':'middle',class:'jr-map-label'},p.label));
        if (p.action) hotspot(layer,x,y,p.label,p.action);
      });
    } else o.shapes.forEach(function (s) {
      function n(k) { return core.resolve(s[k],env); }
      var attrs = {class:'jr-' + (s.color || 'ink')}, tag = s.kind;
      if (tag === 'circle') Object.assign(attrs,{cx:n('x'),cy:n('y'),r:n('r')});
      else if (tag === 'line') Object.assign(attrs,{x1:n('x'),y1:n('y'),x2:n('x2'),y2:n('y2')});
      else if (tag === 'polyline') attrs.points = s.points.map(function (p) { return p.join(','); }).join(' ');
      else { Object.assign(attrs,{x:n('x'),y:n('y')}); if (tag === 'rect') Object.assign(attrs,{width:n('width'),height:n('height'),rx:3}); }
      canvas.appendChild(svg(tag,attrs,tag === 'text' ? s.text : undefined));
      if (s.action) {
        var xy = s.points ? s.points[0] : [n('x') + (s.kind === 'rect' ? n('width')/2 : 0),n('y') + (s.kind === 'rect' ? n('height')/2 : 0)];
        hotspot(layer,xy[0],xy[1],s.label || s.id,s.action);
      }
    });
    if (o.kind === 'map') {
      var list = el('ul'); o.points.forEach(function (p) { list.appendChild(el('li',p.label + ': ' + format(core.resolve(p.lat,env)) + ', ' + format(core.resolve(p.lon,env)))); }); wrap.appendChild(list);
    }
    return wrap;
  }
  function chart(o, env) {
    var wrap = el('figure'), S = B.coordinateMax, H = 180;
    var canvas = svg('svg',{viewBox:'0 0 ' + S + ' ' + H,role:'img','aria-label':o.title || 'Chart'});
    var values = o.points.map(function (p) { return core.resolve(p.value,env); });
    var low = Math.min(0,...values), high = Math.max(0,...values); if (high === low) high = low+1;
    function y(v) { return 20 + (high-v)/(high-low)*(H-55); }
    var zero = y(0), step = (S-20)/values.length;
    canvas.appendChild(svg('line',{x1:10,y1:zero,x2:S-10,y2:zero,class:'jr-axis'}));
    if (o.chart === 'line') canvas.appendChild(svg('polyline',{points:values.map(function (v,i) { return (10+step*(i+0.5)) + ',' + y(v); }).join(' '),class:'jr-chart-line'}));
    values.forEach(function (v,i) {
      var x = 10 + step*(i+0.5);
      canvas.appendChild(o.chart === 'bar' ? svg('rect',{x:x-step*0.3,y:Math.min(y(v),zero),width:step*0.6,height:Math.max(1,Math.abs(y(v)-zero)),class:'jr-accent'}) : svg('circle',{cx:x,cy:y(v),r:3,class:'jr-accent'}));
    });
    wrap.appendChild(canvas);
    var list = el('ul',undefined,'jr-chart-values'); o.points.forEach(function (p) { list.appendChild(el('li',p.label + ': ' + format(core.resolve(p.value,env)))); }); wrap.appendChild(list);
    return wrap;
  }
  function paint() {
    try {
      var env = core.outputValues(spec,core.evaluate(spec,state)), fragment = document.createDocumentFragment();
      spec.inputs.forEach(function (i) { var out = controls[i.id + '-output']; if (out) out.textContent = format(i.display === 'basisPoints' ? state[i.id]/100 : state[i.id],i.display === 'basisPoints' ? 'percent' : 'number'); });
      spec.outputs.forEach(function (o) {
        var n;
        if (o.kind === 'text') n = el('p',(o.label ? o.label + ': ' : '') + format(core.resolve(o.value,env)));
        else if (o.kind === 'metrics') {
          n = el('dl',undefined,'jr-metrics'); o.items.forEach(function (m) { var d = el('div'); d.appendChild(el('dt',m.label)); d.appendChild(el('dd',format(core.resolve(m.value,env),m.format))); n.appendChild(d); });
        } else if (o.kind === 'table') {
          n = el('div',undefined,'jr-table-scroll'); var table = el('table'), head = el('thead'), hr = el('tr');
          o.columns.forEach(function (c) { var th = el('th',c.label); th.scope = 'col'; hr.appendChild(th); }); head.appendChild(hr); table.appendChild(head);
          var body = el('tbody'); o.rows.forEach(function (row) { var tr = el('tr'); row.forEach(function (v,i) { tr.appendChild(el('td',format(core.resolve(v,env),o.columns[i].format))); }); body.appendChild(tr); }); table.appendChild(body); n.appendChild(table);
        } else if (o.kind === 'chart') n = chart(o,env);
        else if (o.kind === 'map' || o.kind === 'diagram') n = drawing(o,env);
        else if (o.kind === 'quiz') {
          n = el('fieldset'); n.appendChild(el('legend',o.question));
          var i = spec.inputs.filter(function (i) { return i.id === o.input; })[0];
          i.options.forEach(function (option) {
            var b = el('button',option.label); b.type = 'button'; b.setAttribute('aria-pressed',String(state[i.id] === option.value));
            b.addEventListener('click',function () { update(i.id,option.value,true); }); n.appendChild(b);
          });
          var chosen = state[i.id]; n.appendChild(el('p',chosen === o.answer ? 'Correct. ' + (o.explanation || '') : 'Choose an answer, or try another choice.'));
        }
        fragment.appendChild(n);
      });
      if (!fragment.textContent.trim() && !fragment.querySelector('svg')) fragment.appendChild(el('p',spec.fallback));
      if (fragment.querySelectorAll('*').length > B.domNodes) throw new Error('DOM budget');
      var focused = document.activeElement, oldButtons = Array.from(output.querySelectorAll('button')), focusedIndex = oldButtons.indexOf(focused);
      output.replaceChildren(fragment); buttons();
      if (focusedIndex >= 0) { var replacement = output.querySelectorAll('button')[focusedIndex]; if (replacement) replacement.focus(); }
      resize();
    } catch (_) { fault(); }
  }
  function mount(s, values, target) {
    spec = s; state = core.inputs(spec,values); lastSent = JSON.stringify(state); root = target;
    var form = el('div',undefined,'jr-inputs'); root.replaceChildren();
    if (spec.props.title) root.appendChild(el('h2',spec.props.title));
    spec.inputs.forEach(function (i) { input(i,form); }); root.appendChild(form);
    output = el('div',undefined,'jr-outputs'); root.appendChild(output);
    var actions = el('div',undefined,'jr-actions');
    spec.actions.forEach(function (a) {
      var b = el('button',a.label); b.type = 'button';
      if (a.class === 'AGENT') agentButtons.push(b);
      b.addEventListener('click',function () { intent(a.id); }); actions.appendChild(b);
    });
    root.appendChild(actions); buttons(); paint();
    if (host.ResizeObserver) { observer = new host.ResizeObserver(resize); observer.observe(root); }
  }
  return { mount:mount, update:update, intent:intent,
    policy:function (p) {
      if (!p || Object.keys(p).sort().join() !== Object.keys(core.manifest.defaults).sort().join() || Object.keys(p).some(function (k) { return typeof p[k] !== 'boolean'; })) throw new Error('policy schema');
      policy = core.clone(p); buttons(); if (spec) paint();
    },
    ack:function (r) { if (r === revision) { acknowledged = r; inFlight = null; clearTimeout(ackTimer); buttons(); if (dirty) scheduleCheckpoint(false); else if (pendingIntent) { var a = pendingIntent; pendingIntent = null; intent(a); } } },
    data:function (id,value,r) { if (dirty || r !== revision) return; var a = spec.actions.filter(function (x) { return x.id === id && x.class === 'DATA'; })[0]; if (a && core.manifest.dataEndpoints[a.endpoint]) update(a.input,value,true); },
    theme:function (v,scale) { var a = core.manifest.appearance; if (!Number.isFinite(scale) || scale < a.scaleMin || scale > a.scaleMax) throw new Error('text scale'); document.documentElement.setAttribute('data-theme',v); document.documentElement.style.fontSize = String(a.fontPixels*scale)+'px'; resize(); },
    snapshot:function () { return core.clone(state); },
    destroy:function () { if (observer) observer.disconnect(); clearTimeout(timer); clearTimeout(resizeTimer); clearTimeout(ackTimer); if (drawTimer !== null && host.cancelAnimationFrame) host.cancelAnimationFrame(drawTimer); } };
});
