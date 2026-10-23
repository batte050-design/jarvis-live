/* Parent-owned boundary and broker. Never handles answer-stream events. */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory;
  else {
    var config = root.JarvisResponseConfig;
    if (config && root.JarvisResponseCore && root.JarvisResponseStore) root.JarvisResponses = factory(root,config);
  }
})(typeof globalThis === 'object' ? globalThis : this, function (host,config) {
  'use strict';
  var core = host.JarvisResponseCore(config.manifest), B = core.budgets, doc = host.document;
  var painting = null;
  var dormant = new WeakMap(), signingOut = false, records = new Set(), contexts = new Map(), activeContext = null, current = '', generation = 0;
  var journal = host.JarvisResponseStore(host.indexedDB,B), scope = '', installation = null;
  var pageLimit = core.bucket(B.pageMessagesPerSecond,B.pageMessageBurst,Date.now), agentHits = [];
  var dataActive = 0, purgeStamp = '', settings = null;
  function random() { return Array.from(host.crypto.getRandomValues(new Uint8Array(16)),function (x) { return x.toString(16).padStart(2,'0'); }).join(''); }
  function digest(s) { return host.crypto.subtle.digest('SHA-256',new TextEncoder().encode(s)).then(function (v) { return Array.from(new Uint8Array(v),function (x) { return x.toString(16).padStart(2,'0'); }).join(''); }); }
  function plain(raw) { var p = doc.createElement('pre'); p.className = 'jr-response-text'; p.textContent = String(raw); return p; }
  function readable(raw) {
    var spec;
    try { spec = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch (_) {}
    return spec && typeof spec.fallback === 'string' && spec.fallback.trim() && core.bytes(spec.fallback) <= B.componentBytes
      ? spec.fallback : 'This interactive response could not be displayed.';
  }
  function legacy(spec) { return !!(spec && typeof spec === 'object' && Object.prototype.hasOwnProperty.call(spec,'type') && !Object.prototype.hasOwnProperty.call(spec,'component')); }
  function declares(spec) { return !!(spec && typeof spec === 'object' && !Array.isArray(spec) && Object.prototype.hasOwnProperty.call(spec,'component') && Object.prototype.hasOwnProperty.call(spec,'version')); }
  function handles(text,el) {
    if (el && el.__responsePaint) return true;
    // Consume every fence, including code fences, so a nested example cannot opt its outer block in.
    var re = /```[ \t]*([A-Za-z0-9_+.-]*)[ \t]*([\s\S]*?)```/g, match;
    while ((match = re.exec(String(text)))) {
      if (!(/^ui\b/.test(match[1]) || match[1] === 'uispec' || match[1] === 'ui-spec')) continue;
      try { if (declares(JSON.parse(match[2]))) return true; } catch (_) {}
    }
    return false;
  }
  function log(type,reason) { host.console.warn('response component rejected',String(type || 'unparseable').replace(/[^A-Za-z0-9_-]/g,'').slice(0,40),reason); }
  function conv() { return String(host.__jarvisConvId ? host.__jarvisConvId() : ''); }
  function textMode() { return !!(host.__jarvisModes && host.__jarvisModes().mode === 'text'); }
  function gone(id) { try { return (host.__jarvisGone ? host.__jarvisGone() : []).includes(id); } catch (_) { return true; } }
  function active(r) { return !signingOut && !r.dead && r.node.isConnected && textMode() && conv() === r.conv && !gone(r.conv); }
  function prefs(r) { var ctx = contexts.get(r.conv); return ctx && ctx.value && ctx.value.prefs; }
  function post(r,data) { if (r.frame && !r.dead) { data.nonce = r.nonce; r.frame.contentWindow.postMessage(data,'*'); } }
  function summary(r) {
    var lines = [r.result.spec.fallback];
    Object.keys(r.values || {}).forEach(function (k) { var i = r.result.spec.inputs.find(function (x) { return x.id === k; }); lines.push(i.label + ': ' + String(r.values[k])); });
    try {
      var env = core.evaluate(r.result.spec,r.values);
      r.result.spec.outputs.filter(function (o) { return o.kind === 'metrics'; }).forEach(function (o) { o.items.forEach(function (m) { lines.push(m.label + ': ' + String(core.resolve(m.value,env))); }); });
    } catch (_) {}
    return lines.join('\n');
  }
  function dispose(r,reason,rejected) {
    if (r.dead) return; r.dead = true; r.token = null; clearTimeout(r.readyTimer);
    r.controllers.forEach(function (c) { c.abort(); }); r.controllers.clear();
    r.node.replaceChildren(plain(rejected ? readable(r.raw) : summary(r))); records.delete(r);
    if (reason) log(r.result.spec.component,reason);
  }
  function context(id,refresh) {
    var held = contexts.get(id); if (!refresh && held) return held.promise;
    var entry = {value:held && held.value}; contexts.set(id,entry);
    var controller = new AbortController(), timeout = setTimeout(function () { controller.abort(); },B.contextTimeoutMs);
    entry.promise = host.fetch('/api/response/context/' + encodeURIComponent(id),{credentials:'same-origin',cache:'no-store',signal:controller.signal})
      .then(function (r) { if (!r.ok) throw new Error('response preferences unavailable'); return r.json(); })
      .then(function (d) {
        if (!d || !d.ok || d.manifest !== config.hash || d.runtime !== config.runtime || !/^[A-Za-z0-9_-]+$/.test(d.account) || !/^[0-9a-f]{64}$/.test(d.epoch)) throw new Error('response build/context mismatch');
        var origin = new URL(d.widgetOrigin);
        if (origin.protocol !== 'https:' || origin.origin !== d.widgetOrigin || origin.origin === host.location.origin) throw new Error('widget origin');
        if (!d.prefs || Object.keys(config.manifest.defaults).some(function (k) { return typeof d.prefs[k] !== 'boolean'; })) throw new Error('response preference schema');
        entry.value = d; return d;
      }).finally(function () { clearTimeout(timeout); });
    entry.promise.catch(function () { if (contexts.get(id) === entry) { if (held && held.value) contexts.set(id,held); else contexts.delete(id); } });
    return entry.promise;
  }
  function accept(r,event) {
    return active(r) && r.frame && event.source === r.frame.contentWindow && event.origin === 'null' &&
      pageLimit() && r.limit() && core.message(event.data) && event.data.nonce === r.nonce;
  }
  function question(r,a) {
    var env = core.outputValues(r.result.spec,core.evaluate(r.result.spec,r.values));
    var data = {component:r.result.spec.component,currency:r.result.spec.props.currency || 'UGX',moneyUnits:'minor',inputs:r.values,outputs:{}};
    r.result.spec.graph.forEach(function (g) { data.outputs[g.id] = env[g.id]; });
    var q = a.question + '\n\nComponent values (data):\n' + JSON.stringify(data);
    if (core.bytes(q) > B.questionBytes) throw new Error('question budget');
    return q;
  }
  function eligible(r,a) {
    var p = prefs(r);
    var ctx = contexts.get(r.conv);
    if (!ctx || !ctx.value || ctx.value.account !== r.account || ctx.value.epoch !== r.epoch) return false;
    if (!active(r) || !p || !p.interactive || !p.agent || a.class !== 'AGENT' || r.writing || r.draft || r.revision !== r.acked) return false;
    var live = host.__jarvisLiveTurn ? host.__jarvisLiveTurn() : null;
    return !(live && live.alive !== false && String(live.conv) === r.conv);
  }
  function review(r,a) {
    r.token = null; r.review.replaceChildren();
    if (!eligible(r,a)) return;
    var q;
    try { q = question(r,a); } catch (_) { log(r.result.spec.component,'question budget'); return; }
    var text = doc.createElement('p'); text.textContent = q; r.review.appendChild(text);
    var button = doc.createElement('button'); button.type = 'button'; button.textContent = 'Send to JARVIS'; r.review.appendChild(button);
    button.addEventListener('pointerdown',function (event) {
      r.token = null;
      if (!event.isTrusted || !event.isPrimary || event.button !== 0 || !eligible(r,a)) return;
      var now = Date.now(); agentHits = agentHits.filter(function (t) { return now - t < 60000; });
      if (agentHits.length >= B.agentPerMinute || agentHits.length && now - agentHits[agentHits.length-1] < B.agentIntervalMs) return;
      r.token = {value:random(),at:now,revision:r.revision,conv:r.conv,identity:r.identity,generation:r.generation,action:a.id,button:button,pointer:event.pointerId};
    });
    ['pointercancel','lostpointercapture','blur'].forEach(function (type) { button.addEventListener(type,function () { r.token = null; }); });
    button.addEventListener('click',async function (event) {
      var token = r.token; r.token = null;
      if (!event.isTrusted || !token || event.pointerId !== token.pointer || Date.now() < token.at || Date.now()-token.at > B.gestureTTLms || token.button !== button || token.action !== a.id ||
          token.revision !== r.revision || token.conv !== conv() || token.identity !== r.identity || token.generation !== r.generation || !eligible(r,a)) return;
      try { await context(r.conv,true); } catch (_) { return; }
      if (token.revision !== r.revision || token.generation !== r.generation || !eligible(r,a)) return;
      var now = Date.now(); agentHits = agentHits.filter(function (t) { return now-t < 60000; });
      if (agentHits.length >= B.agentPerMinute || agentHits.length && now-agentHits[agentHits.length-1] < B.agentIntervalMs) return;
      if (typeof host.ask !== 'function') return;
      agentHits.push(now); r.review.replaceChildren();
      host.ask(q,'text');
    });
    var stage = doc.createElement('button'); stage.type = 'button'; stage.textContent = 'Edit in composer';
    stage.addEventListener('click',function (event) {
      if (!event.isTrusted || !active(r)) return;
      var field = doc.getElementById('q'); if (!field) return;
      field.value = q; field.dispatchEvent(new Event('input',{bubbles:true})); field.focus(); r.token = null;
    }); r.review.appendChild(stage);
  }
  async function data(r,a) {
    var p = prefs(r), endpoint = config.manifest.dataEndpoints[a.endpoint];
    if (!active(r) || !p || !p.data || !endpoint || endpoint.method !== 'GET') return;
    var now = Date.now(); r.dataHits = r.dataHits.filter(function (t) { return now-t < 60000; });
    if (r.dataHits.length >= B.dataPerMinute || dataActive >= B.dataConcurrent) return;
    var query = Object.create(null), env = core.evaluate(r.result.spec,r.values);
    Object.keys(a.query).forEach(function (k) { query[k] = core.resolve(a.query[k],env); });
    try { core.schema(query,endpoint.query,{}); } catch (_) { return; }
    var url = new URL(endpoint.path,host.location.origin);
    if (url.origin !== host.location.origin || !endpoint.path.startsWith('/') || endpoint.path.startsWith('//') || url.username || url.password || url.hash) return;
    Object.keys(query).forEach(function (k) { url.searchParams.set(k,String(query[k])); });
    var controller = new AbortController(), rev = r.revision, timer = setTimeout(function () { controller.abort(); },B.dataTimeoutMs);
    r.controllers.add(controller); r.dataHits.push(now); dataActive++;
    try {
      var response = await host.fetch(url.href,{method:'GET',credentials:'omit',mode:'same-origin',redirect:'error',cache:'no-store',signal:controller.signal,headers:{Accept:'application/json'}});
      if (!response.ok || !/^application\/json(?:;|$)/i.test(response.headers.get('content-type') || '')) throw new Error('DATA response');
      var reader = response.body.getReader(), chunks = [], total = 0;
      for (;;) { var part = await reader.read(); if (part.done) break; total += part.value.byteLength; if (total > B.dataResponseBytes) { await reader.cancel(); throw new Error('DATA bytes'); } chunks.push(part.value); }
      var joined = new Uint8Array(total), at = 0; chunks.forEach(function (v) { joined.set(v,at); at += v.length; });
      var value = JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(joined)); core.schema(value,endpoint.response,{});
      var input = r.result.spec.inputs.find(function (i) { return i.id === a.input; }); core.inputValue(input,value);
      if (active(r) && r.revision === rev && prefs(r).data) post(r,{type:'data',action:a.id,revision:rev,value:value});
    } catch (_) { log(r.result.spec.component,'DATA unavailable'); }
    finally { clearTimeout(timer); r.controllers.delete(controller); dataActive--; }
  }
  function message(event) {
    var r = Array.from(records).find(function (r) { return r.frame && event.source === r.frame.contentWindow; });
    if (!r || !accept(r,event)) return;
    var d = event.data;
    if (d.type === 'ready') {
      if (r.ready || r.initializing || d.manifest !== config.hash) return;
      r.initializing = true;
      post(r,{type:'init',manifest:config.hash,spec:r.raw,inputs:r.values,theme:theme(),scale:fontScale(),policy:prefs(r)});
      return;
    }
    if (d.type === 'mounted' && r.initializing && !r.ready) { r.ready = true; clearTimeout(r.readyTimer); r.fallback.hidden = true; r.frame.hidden = false; return; }
    if (d.type === 'fault' && r.initializing) { dispose(r,'runtime failure'); return; }
    if (!r.ready) return;
    if (d.type === 'resize') {
      if (!r.resize()) return;
      r.frame.style.height = Math.round(Math.max(B.minFrameHeight,Math.min(host.innerHeight*B.maxFrameViewportRatio,d.height))) + 'px'; return;
    }
    if (d.type === 'draft') { r.draft = d.editing; r.token = null; r.review.replaceChildren(); return; }
    if (d.type === 'change') {
      if (d.revision === r.revision && r.acked === r.revision && JSON.stringify(d.inputs) === JSON.stringify(r.values)) { post(r,{type:'ack',revision:r.revision}); return; }
      if (d.revision !== r.revision+1) return;
      var values; try { values = core.inputs(r.result.spec,d.inputs); core.outputValues(r.result.spec,core.evaluate(r.result.spec,values)); } catch (_) { return; }
      r.revision = d.revision; r.draft = false; r.values = values; r.token = null; r.review.replaceChildren(); r.writing++;
      var rev = d.revision, snapshot = core.clone(values);
      r.pending = r.pending.then(function () {
        if (!active(r)) return false;
        var currentPolicy = prefs(r);
        if (!currentPolicy) return false;
        return currentPolicy.remember ? journal.put(r.scope,r.identity,r.conv,{inputs:snapshot}).then(function () { return true; }) : true;
      }).then(function (written) {
        r.writing--;
        if (written && active(r)) { r.acked = rev; post(r,{type:'ack',revision:rev}); }
      }).catch(function () { r.writing--; dispose(r,'checkpoint unavailable'); }); return;
    }
    if (d.type === 'intent') {
      if (d.revision !== r.revision || r.writing || r.acked !== r.revision) return;
      var a = r.result.spec.actions.find(function (a) { return a.id === d.action; });
      if (!a) return;
      if (a.class === 'AGENT') review(r,a);
      else if (a.class === 'DATA') data(r,a);
    }
  }
  function theme() { var v = doc.documentElement.getAttribute('data-theme') || doc.body.getAttribute('data-theme'); return v === 'light' || v !== 'dark' && host.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'; }
  function fontScale() { var value = host.getComputedStyle ? parseFloat(host.getComputedStyle(doc.documentElement).getPropertyValue('--tscale')) : 1; var a = config.manifest.appearance; return Number.isFinite(value) ? Math.max(a.scaleMin,Math.min(a.scaleMax,value)) : 1; }
  async function activate(r) {
    if (r.dead || r.started || !r.node.isConnected) return;
    r.conv = conv(); var turn = r.node.closest('.turn');
    if (!turn || !turn.dataset.id || !/^[0-9a-f]{32}$/.test(r.conv)) return;
    r.started = true;
    try {
      var ctx = await context(r.conv); r.account = ctx.account; r.epoch = ctx.epoch;
      if (r.dead || !active(r) || !ctx.enabled || !ctx.prefs.interactive) { if (!r.dead && !ctx.prefs.interactive) dormant.set(r.node,{source:r.source,values:core.clone(r.values)}); dispose(r); return; }
      if (!installation) installation = journal.installation(random).catch(function (e) { installation = null; throw e; });
      var install;
      try { install = await installation; await journal.prune(); } catch (e) { if (ctx.prefs.remember) throw e; install = random(); }
      r.scope = JSON.stringify([ctx.account,ctx.epoch,install]); scope = r.scope;
      var answer = r.node.closest('.t-a') || r.node.parentNode;
      var peers = Array.from(answer.querySelectorAll('.jr-component')), index = peers.indexOf(r.node);
      r.identity = await digest(JSON.stringify([r.conv,turn.dataset.id,index,config.hash,r.raw]));
      if (ctx.prefs.remember && !r.restored) {
        var saved = await journal.get(r.scope,r.identity);
        if (saved) { try { r.values = core.inputs(r.result.spec,saved.inputs); core.outputValues(r.result.spec,core.evaluate(r.result.spec,r.values)); } catch (_) { await journal.remove(r.scope,r.identity); } }
      }
      if (!active(r)) { dispose(r); return; }
      r.fallback.textContent = summary(r);
      var frame = doc.createElement('iframe'); frame.className = 'jr-response-frame'; frame.title = r.result.spec.props.title || r.result.spec.component;
      frame.setAttribute('sandbox','allow-scripts'); frame.setAttribute('referrerpolicy','no-referrer');
      frame.setAttribute('allow',"camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'");
      frame.hidden = true; r.frame = frame; r.nonce = random();
      frame.src = ctx.widgetOrigin + '/w/runtime/' + config.runtime + '#nonce=' + r.nonce;
      r.node.insertBefore(frame,r.review); r.readyTimer = setTimeout(function () { dispose(r,'runtime timeout'); },B.frameReadyMs);
      frame.addEventListener('load',function () { if (r.loaded) dispose(r,'runtime navigation'); else r.loaded = true; });
    } catch (_) { dispose(r,'component unavailable'); }
  }
  function fence(raw,fromPainter) {
    var spec;
    try { spec = JSON.parse(raw); } catch (_) {}
    if (legacy(spec)) return {handled:false};
    var result = core.validate(raw);
    if (!result.ok || !declares(spec)) {
      log(result.type,result.reason || 'undeclared component');
      return {handled:true,node:plain(readable(spec))};
    }
    if (fromPainter && !painting) return {handled:true,node:plain(readable(spec))};
    var key, old;
    if (painting) {
      key = JSON.stringify([painting.index++,raw]);
      if (!painting.admit(key,result)) { log(spec.component,'response budget'); return {handled:true,node:plain(readable(spec))}; }
      old = painting.previous.get(key);
      if (old && old.node.parentNode === painting.el) {
        var placeholder = doc.createElement('section');
        painting.retained.set(placeholder,old.node); painting.next.set(key,old);
        return {handled:true,node:placeholder};
      }
    }
    var node = doc.createElement('section'); node.className = 'jr-component';
    var fallback = plain(result.spec.fallback), reviewNode = doc.createElement('div'); reviewNode.className = 'jr-response-review';
    node.appendChild(fallback); node.appendChild(reviewNode);
    var r = {node:node,result:result,source:raw,raw:spec,created:Date.now(),values:result.initial,fallback:fallback,review:reviewNode,controllers:new Set(),
      dead:false,started:false,ready:false,revision:0,acked:0,writing:0,pending:Promise.resolve(),dataHits:[],generation:++generation,
      limit:core.bucket(B.messagesPerSecond,B.messageBurst,Date.now),resize:core.bucket(B.resizePerSecond,B.resizePerSecond,Date.now)};
    records.add(r);
    if (painting) { painting.next.set(key,r); painting.created.push(r); }
    queueMicrotask(function () { activate(r); }); return {handled:true,node:node};
  }
  function reconcile(el,render) {
    var stage = doc.createElement('div'), previous = el.__responsePaint || new Map();
    var state = {el:el,previous:previous,next:new Map(),retained:new Map(),created:[],index:0,admit:core.ledger()};
    var outer = painting; painting = state;
    try { render(stage); }
    catch (e) { state.created.forEach(function (r) { dispose(r); }); throw e; }
    finally { painting = outer; }
    previous.forEach(function (r,key) { if (state.next.get(key) !== r) dispose(r); });
    // Retained frames stay connected in place. Only ordinary siblings and changed components move.
    var cursor = el.firstChild;
    Array.from(stage.childNodes).forEach(function (candidate) {
      var wanted = state.retained.get(candidate) || candidate;
      if (wanted.parentNode === el) {
        while (cursor && cursor !== wanted) { var next = cursor.nextSibling; el.removeChild(cursor); cursor = next; }
        cursor = wanted.nextSibling;
      } else el.insertBefore(wanted,cursor);
    });
    while (cursor) { var next = cursor.nextSibling; el.removeChild(cursor); cursor = next; }
    el.__responsePaint = state.next.size ? state.next : null;
    el.__keys = null; el.__tail = null; el.__tailTxt = null;
  }
  function settingsUI() {
    var target = doc.getElementById('attachrows');
    if (!target || settings) return;
    settings = doc.createElement('fieldset'); settings.className = 'jr-response-preferences'; settings.hidden = true;
    var legend = doc.createElement('legend'); legend.textContent = 'Responses in this chat'; settings.appendChild(legend);
    [['interactive','Interactive responses'],['agent','Allow reviewed questions'],['data','Allow declared data requests'],['remember','Remember input values']].forEach(function (entry) {
      var label = doc.createElement('label'), input = doc.createElement('input'); input.type = 'checkbox'; input.dataset.preference = entry[0];
      label.appendChild(input); label.appendChild(doc.createTextNode(entry[1])); settings.appendChild(label);
      input.addEventListener('change',async function (event) {
        if (!event.isTrusted || !activeContext || !activeContext.canConfigure) return;
        var id = conv(), old = activeContext.prefs[entry[0]], patch = {}; patch[entry[0]] = input.checked; input.disabled = true;
        try {
          var response = await host.fetch('/api/response/preferences/' + encodeURIComponent(id),{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify(patch)});
          if (!response.ok) throw new Error('settings refused');
          var d = await response.json(); if (!d.ok) throw new Error('settings failed');
          var ctx = await context(id,true);
          if (conv() === id) activeContext = ctx;
          if (entry[0] === 'remember' && !ctx.prefs.remember && scope) await journal.clear(scope,id);
          records.forEach(function (r) { if (r.conv === id) { r.token = null; r.review.replaceChildren(); if (!ctx.prefs.interactive) { dormant.set(r.node,{source:r.source,values:core.clone(r.values)}); dispose(r); } else post(r,{type:'policy',policy:ctx.prefs}); } });
          if (ctx.prefs.interactive && conv() === id) doc.documentElement.querySelectorAll('.jr-component').forEach(function (node) {
            var saved = dormant.get(node); if (!saved) return; dormant.delete(node);
            var decision = fence(saved.source), record = Array.from(records).find(function (r) { return r.node === decision.node; });
            if (record) { record.values = core.inputs(record.result.spec,saved.values); record.restored = true; node.replaceChildren.apply(node,Array.from(decision.node.childNodes)); record.node = node; }
            else node.replaceChildren(decision.node);
          });
        } catch (_) { input.checked = old; log('settings','preference unavailable'); }
        input.disabled = false;
      });
    }); target.appendChild(settings);
  }
  function sweep() {
    var id = conv(), isText = textMode();
    if (id !== current) { current = id; activeContext = null; records.forEach(function (r) { r.token = null; r.review.replaceChildren(); });
      if (isText && /^[0-9a-f]{32}$/.test(id)) context(id,true).then(function (d) { if (conv() === id) activeContext = d; }).catch(function () {});
    }
    if (isText && !activeContext && /^[0-9a-f]{32}$/.test(id)) {
      context(id).then(function (d) { if (conv() === id) activeContext = d; }).catch(function () {});
    }
    settingsUI();
    if (settings) {
      settings.hidden = !isText || !activeContext;
      if (activeContext) settings.querySelectorAll('input').forEach(function (i) { i.checked = activeContext.prefs[i.dataset.preference]; i.disabled = !activeContext.canConfigure || i.dataset.preference === 'data' && !Object.keys(config.manifest.dataEndpoints).length; });
    }
    records.forEach(function (r) {
      if (!r.started && Date.now()-r.created > B.frameReadyMs) { dispose(r,'missing conversation identity'); }
      else if (r.started && (!r.node.isConnected || gone(r.conv))) { if (gone(r.conv) && r.scope) journal.clear(r.scope,r.conv).catch(function () {}); dispose(r); }
      else if (!r.started && r.node.isConnected) activate(r);
      else if (!active(r)) { r.token = null; r.review.replaceChildren(); r.controllers.forEach(function (c) { c.abort(); }); }
      else if (r.ready && r.appearance !== theme() + ':' + fontScale()) { r.appearance = theme() + ':' + fontScale(); post(r,{type:'theme',theme:theme(),scale:fontScale()}); }
    });
    try {
      var stamp = host.localStorage.getItem('jarvis.v1.purged') || '';
      if (purgeStamp && stamp !== purgeStamp && scope) { journal.clear(scope).catch(function () {}); records.forEach(function (r) { dispose(r); }); }
      purgeStamp = stamp;
    } catch (_) {}
  }
  if (doc) {
    host.addEventListener('message',message);
    host.addEventListener('blur',function () { records.forEach(function (r) { r.token = null; }); });
    host.addEventListener('pagehide',function () { records.forEach(function (r) { dispose(r); }); });
    var observer = new host.MutationObserver(function () { records.forEach(function (r) { if (!r.started && r.node.isConnected) activate(r); }); });
    observer.observe(doc.documentElement,{childList:true,subtree:true});
    host.setInterval(sweep,B.lifecyclePollMs);
  }
  function signOut() {
    signingOut = true;
    var scopes = new Set(); if (scope) scopes.add(scope);
    records.forEach(function (r) { if (r.scope) scopes.add(r.scope); dispose(r); });
    return Promise.allSettled(Array.from(scopes,function (s) { return journal.clear(s); }));
  }
  return {signOut:signOut,fence:fence,plain:plain,readable:readable,legacy:legacy,declares:declares,handles:handles,reconcile:reconcile,validate:core.validate,accept:accept,question:question,message:message,
    review:review,data:data,activate:activate,sweep:sweep,records:records,core:core};
});
