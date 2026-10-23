/* Shared, data-only response validation. No DOM or transport access. */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory;
  else root.JarvisResponseCore = factory;
})(typeof globalThis === 'object' ? globalThis : this, function (manifest) {
  'use strict';
  var B = manifest.budgets, own = function (o, k) { return Object.prototype.hasOwnProperty.call(o, k); };
  function fail(reason) { throw new Error(reason); }
  function bytes(s) { return new TextEncoder().encode(String(s)).length; }
  function clone(v) { return JSON.parse(JSON.stringify(v)); }
  function object(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
  function finite(v) { return typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= B.numberMagnitude; }
  function scalar(v) { return typeof v === 'string' || typeof v === 'boolean' || finite(v); }
  function walk(v, depth, count) {
    if (depth > B.depth || ++count.n > B.nodes) fail('structure budget');
    if (typeof v === 'number' && !finite(v)) fail('non-finite number');
    if (v && typeof v === 'object') Object.keys(v).forEach(function (k) {
      if (k === '__proto__' || k === 'constructor' || k === 'prototype') fail('reserved key');
      walk(v[k], depth + 1, count);
    });
  }
  function schema(v, s, defs) {
    if (s.$ref) { schema(v, defs[s.$ref.slice(8)], defs); return; }
    if (s.oneOf) {
      var matches = 0;
      s.oneOf.forEach(function (a) { try { schema(v, a, defs); matches++; } catch (_) {} });
      if (matches !== 1) fail('schema alternative');
      return;
    }
    if (s.enum && !s.enum.some(function (x) { return x === v; })) fail('unknown enum');
    if (s.type) {
      var types = Array.isArray(s.type) ? s.type : [s.type];
      if (!types.some(function (t) {
        return t === 'object' ? object(v) : t === 'array' ? Array.isArray(v) :
          t === 'integer' ? finite(v) && Number.isInteger(v) : t === 'number' ? finite(v) : typeof v === t;
      })) fail('schema type');
    }
    if (typeof v === 'string') {
      if (s.maxLength !== undefined && v.length > s.maxLength || s.minLength !== undefined && v.length < s.minLength ||
          s.pattern && !(new RegExp(s.pattern)).test(v)) fail('schema string');
    }
    if (typeof v === 'number' && (s.minimum !== undefined && v < s.minimum || s.maximum !== undefined && v > s.maximum ||
        s.exclusiveMinimum !== undefined && v <= s.exclusiveMinimum)) fail('schema range');
    if (Array.isArray(v)) {
      if (s.maxItems !== undefined && v.length > s.maxItems || s.minItems !== undefined && v.length < s.minItems) fail('schema array');
      if (s.items) v.forEach(function (x) { schema(x, s.items, defs); });
    }
    if (object(v)) {
      (s.required || []).forEach(function (k) { if (!own(v, k)) fail('missing ' + k); });
      Object.keys(v).forEach(function (k) {
        if (s.properties && own(s.properties, k)) schema(v[k], s.properties[k], defs);
        else if (s.additionalProperties === false) fail('unknown property');
        else if (object(s.additionalProperties)) schema(v[k], s.additionalProperties, defs);
      });
    }
  }
  function date(v) {
    if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
    var t = Date.parse(v + 'T00:00:00Z');
    return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === v;
  }
  function inputValue(i, v) {
    if (i.kind === 'range' || i.kind === 'number' || i.kind === 'stepper') {
      if (!finite(i.min) || !finite(i.max) || !finite(i.step) || i.step <= 0 || i.min > i.max ||
          !finite(v) || v < i.min || v > i.max || Math.abs((v - i.min) / i.step - Math.round((v - i.min) / i.step)) > B.stepEpsilon) fail('input range');
    } else if (i.kind === 'toggle') { if (typeof v !== 'boolean') fail('input boolean'); }
    else if (typeof v !== 'string' || bytes(v) > Math.min(i.maxLength || B.inputTextBytes, B.inputTextBytes)) fail('input text');
    else if (i.kind === 'date' && !date(v)) fail('input date');
    else if (i.kind === 'select' && !(i.options || []).some(function (o) { return o.value === v; })) fail('input choice');
    return v;
  }
  function inputs(spec, values) {
    if (!object(values)) fail('input snapshot');
    var out = Object.create(null);
    if (Object.keys(values).length !== spec.inputs.length) fail('input snapshot keys');
    spec.inputs.forEach(function (i) { if (!own(values, i.id)) fail('missing input'); out[i.id] = inputValue(i, values[i.id]); });
    return out;
  }
  function initial(spec, overrides) {
    var out = Object.create(null);
    spec.inputs.forEach(function (i) { out[i.id] = i.default; });
    Object.keys(overrides || {}).forEach(function (k) { if (!own(out, k)) fail('unknown initial input'); out[k] = overrides[k]; });
    return inputs(spec, out);
  }
  function resolve(v, env) {
    if (object(v)) { if (!own(env, v.ref)) fail('unknown reference'); return env[v.ref]; }
    if (!scalar(v)) fail('invalid literal');
    return v;
  }
  function operation(op, a) {
    if (op === 'eq') { if (typeof a[0] !== typeof a[1]) fail('comparison types'); return a[0] === a[1]; }
    if (op === 'select') { if (typeof a[0] !== 'boolean' || typeof a[1] !== typeof a[2]) fail('selection types'); return a[0] ? a[1] : a[2]; }
    if (op === 'dateDiff') { if (!date(a[0]) || !date(a[1])) fail('date arithmetic'); return (Date.parse(a[0] + 'T00:00:00Z') - Date.parse(a[1] + 'T00:00:00Z')) / 86400000; }
    if (!a.every(finite)) fail('numeric operation types');
    var v;
    switch (op) {
      case 'add': v = a.reduce(function (s, x) { var n = s + x; if (!finite(n)) fail('numeric overflow'); return n; }, 0); break;
      case 'sub': v = a[0] - a[1]; break;
      case 'mul': v = a[0] * a[1]; break;
      case 'div': if (!a[1]) fail('division by zero'); v = a[0] / a[1]; break;
      case 'min': v = Math.min.apply(null, a); break;
      case 'max': v = Math.max.apply(null, a); break;
      case 'round': v = Math.round(a[0]); break;
      case 'ceil': v = Math.ceil(a[0]); break;
      case 'floor': v = Math.floor(a[0]); break;
      case 'clamp': if (a[1] > a[2]) fail('clamp bounds'); v = Math.min(a[2], Math.max(a[1], a[0])); break;
      case 'lt': return a[0] < a[1];
      case 'gt': return a[0] > a[1];
      default: fail('unknown operation');
    }
    if (!finite(v)) fail('numeric overflow');
    return v;
  }
  function evaluate(spec, state) {
    var env = inputs(spec, state), used = 0;
    spec.graph.forEach(function (g) {
      used += g.args.length + 1;
      if (used > B.operations) fail('operation budget');
      env[g.id] = operation(g.op, g.args.map(function (v) { return resolve(v, env); }));
    });
    return env;
  }
  function semantic(spec) {
    var names = Object.create(null), actions = Object.create(null), defaults = initial(spec, spec.initial);
    if (spec.inputs.length > B.inputsPerComponent || spec.graph.length > B.derived || spec.actions.length > B.actions) fail('declaration budget');
    spec.inputs.forEach(function (i) {
      if (own(names, i.id)) fail('duplicate input');
      if (i.display === 'money' && (!['number','range','stepper'].includes(i.kind) || ![i.min,i.max,i.step].every(Number.isInteger))) fail('money input units');
      names[i.id] = true;
      if (i.kind === 'select') {
        var seen = Object.create(null);
        (i.options || []).forEach(function (o) { if (own(seen, o.value)) fail('duplicate option'); seen[o.value] = true; });
      }
    });
    var used = 0;
    function value(v) { if (object(v) && !own(names, v.ref)) fail('forward or unknown reference'); }
    spec.graph.forEach(function (g) {
      var op = manifest.operations[g.op];
      if (!op || g.args.length < op.min || g.args.length > op.max || own(names, g.id)) fail('calculation declaration');
      g.args.forEach(value); names[g.id] = true;
      used += g.args.length + 1;
    });
    if (used > B.operations) fail('operation budget');
    spec.actions.forEach(function (a) {
      if (own(actions, a.id) || manifest.classes.indexOf(a.class) < 0) fail('action declaration');
      actions[a.id] = a;
      if (a.class === 'LOCAL') {
        var i = spec.inputs.filter(function (v) { return v.id === a.set.input; })[0];
        if (!i) fail('action input'); inputValue(i, a.set.value);
      }
      if (a.class === 'DATA') {
        var endpoint = manifest.dataEndpoints[a.endpoint];
        if (!endpoint || endpoint.method !== 'GET') fail('DATA endpoint denied');
        Object.values(a.query).forEach(value);
        if (!spec.inputs.some(function (i) { return i.id === a.input; })) fail('DATA target');
      }
    });
    var cost = { charts: spec.outputs.filter(function (o) { return o.kind === 'chart'; }).length, components: 1, nodes: 0, inputsPerResponse: spec.inputs.length, responseBytes: bytes(JSON.stringify(spec)), tableCells: 0, chartPoints: 0, svgPrimitives: 0, hotspots: 0, domNodes: 20 + spec.inputs.length * 8 + spec.actions.length * 6 };
    var count = { n: 0 }; walk(spec, 0, count); cost.nodes = count.n;
    function action(id) { if (id) { if (!own(actions, id)) fail('hotspot action'); cost.hotspots++; cost.domNodes += 3; } }
    spec.outputs.forEach(function (o) {
      cost.domNodes += 8;
      if (o.kind === 'text') value(o.value);
      if (o.kind === 'metrics') { o.items.forEach(function (m) { value(m.value); }); cost.domNodes += o.items.length * 4; }
      if (o.kind === 'table') {
        o.rows.forEach(function (row) { if (row.length !== o.columns.length) fail('table width'); row.forEach(value); cost.tableCells += row.length; });
        cost.domNodes += cost.tableCells * 2 + o.rows.length + o.columns.length * 2;
      }
      if (o.kind === 'chart') { o.points.forEach(function (p) { value(p.value); }); cost.chartPoints += o.points.length; cost.domNodes += o.points.length * 6; }
      if (o.kind === 'map') { o.points.forEach(function (p) { value(p.lat); value(p.lon); action(p.action); }); cost.svgPrimitives += o.points.length; cost.domNodes += o.points.length * 7; }
      if (o.kind === 'diagram') {
        var ids = Object.create(null);
        o.shapes.forEach(function (s) {
          if (own(ids, s.id)) fail('duplicate shape'); ids[s.id] = true;
          var required = { rect: ['x','y','width','height'], circle: ['x','y','r'], line: ['x','y','x2','y2'], polyline: ['points'], text: ['x','y','text'] }[s.kind];
          required.forEach(function (k) { if (!own(s, k)) fail('missing geometry'); });
          var allowed = required.concat(['id','kind','color','action','label']);
          Object.keys(s).forEach(function (k) { if (allowed.indexOf(k) < 0) fail('unused geometry'); });
          ['x','y','x2','y2','width','height','r'].forEach(function (k) { if (own(s,k)) value(s[k]); });
          action(s.action); cost.svgPrimitives += 1 + (s.points || []).length; cost.domNodes += 3;
        });
      }
      if (o.kind === 'quiz') {
        var i = spec.inputs.filter(function (x) { return x.id === o.input; })[0];
        if (!i || i.kind !== 'select' || !i.options.some(function (x) { return x.value === o.answer; })) fail('quiz input');
        cost.domNodes += i.options.length * 4;
      }
    });
    var defaultEnv = outputValues(spec, evaluate(spec, defaults));
    spec.actions.filter(function (a) { return a.class === 'DATA'; }).forEach(function (a) {
      var query = Object.create(null); Object.keys(a.query).forEach(function (k) { query[k] = resolve(a.query[k],defaultEnv); });
      schema(query,manifest.dataEndpoints[a.endpoint].query,{});
    });
    Object.keys(cost).forEach(function (k) { if (cost[k] > B[k]) fail(k + ' budget'); });
    return { initial: defaults, cost: cost };
  }
  function outputValues(spec, env) {
    function number(v) { var n = resolve(v, env); if (!finite(n)) fail('output number'); return n; }
    spec.outputs.forEach(function (o) {
      if (o.kind === 'text') resolve(o.value, env);
      if (o.kind === 'metrics') o.items.forEach(function (m) { var v = resolve(m.value, env); if (m.format && m.format !== 'text' && !finite(v)) fail('metric number'); });
      if (o.kind === 'table') o.rows.forEach(function (row) { row.forEach(function (v, i) { var x = resolve(v, env); if (o.columns[i].format && o.columns[i].format !== 'text' && !finite(x)) fail('cell number'); }); });
      if (o.kind === 'chart') o.points.forEach(function (p) { number(p.value); });
      if (o.kind === 'map') o.points.forEach(function (p) { if (Math.abs(number(p.lat)) > 90 || Math.abs(number(p.lon)) > 180) fail('map coordinate'); });
      if (o.kind === 'diagram') o.shapes.forEach(function (s) {
        ['x','y','x2','y2','width','height','r'].forEach(function (k) { if (own(s,k)) { var v = number(s[k]); if (v < 0 || v > B.coordinateMax) fail('SVG coordinate'); } });
        if (s.points && s.points.some(function (p) { return p.length !== 2; })) fail('SVG point');
      });
    });
    return env;
  }
  function legacy(spec) {
    function label(v) { return typeof v === 'string' && v.trim().length > 0; }
    function url(v) { var u; try { u = new URL(v); } catch (_) { fail('legacy URL'); } if (u.protocol !== 'https:' || !u.hostname || u.username || u.password) fail('legacy URL'); }
    function image(i,required) {
      ['url','src'].forEach(function (k) { if (i[k] !== undefined) url(i[k]); });
      if (required && !['url','src','img','image','query','alt'].some(function (k) { return label(i[k]); })) fail('legacy image source');
    }
    if (spec.type === 'metrics' && spec.items.some(function (i) { return !label(i.label) || i.value === ''; })) fail('legacy metric');
    if (spec.type === 'chart' && spec.data.some(function (p) { return Array.isArray(p) ? !label(p[0]) || !finite(p[1]) : !finite(p); })) fail('legacy chart point');
    if (spec.type === 'compare') spec.columns.forEach(function (c) { if (!label(c.name) || !c.points.every(label)) fail('legacy column'); image(c,false); });
    if (spec.type === 'steps' && spec.steps.some(function (s) { return !label(s.label); })) fail('legacy step');
    if (spec.type === 'choices' && spec.options.some(function (o) { return !label(o.label) || !label(o.value); })) fail('legacy choice');
    if (spec.type === 'image') image(spec,true);
    if (spec.type === 'gallery') spec.images.forEach(function (i) { image(i,true); });
    if (spec.type === 'sources') spec.items.forEach(function (i) { if (!label(i.url || i.href)) fail('legacy source'); if (i.url !== undefined) url(i.url); if (i.href !== undefined) url(i.href); });
  }
  function sourceLine(source) {
    if (source.kind === 'illustration') return 'Illustration: synthetic, unmeasured values.';
    var prefix;
    if (source.tool === 'yahoo_chart') {
      var query = JSON.parse(source.query);
      prefix = 'Source: Yahoo Finance; ' + query.symbol + '; requested: ' + query.start + ' to ' + query.end;
    } else prefix = source.kind === 'calculation' ? 'Calculated from editable supplied inputs' : 'Source: your supplied figures';
    var line = prefix + (source.kind === 'provided' || source.kind === 'calculation' ? '; recorded this turn: ' : '; retrieved: ') + source.timestamp;
    if (source.observed_through) line += '; observations through: ' + source.observed_through;
    line += '; ' + source.aggregation;
    if (source.missing.length) line += '; missing: ' + source.missing.join(', ');
    return line;
  }
  function provenance(spec) {
    var charts = spec.outputs.filter(function (o) { return o.kind === 'chart'; });
    if (!charts.length) return;
    if (charts.length > B.charts || !spec.source) fail('chart source/count required');
    var source = spec.source, seen = new Set();
    if (source.kind !== 'illustration' && !Number.isFinite(Date.parse(source.timestamp))) fail('source timestamp');
    charts.forEach(function (o) {
      o.points.forEach(function (p) {
        if (source.kind !== 'calculation' && source.kind !== 'illustration') {
          if (!finite(p.value) || (source.kind !== 'provided' && seen.has(p.value))) fail('repeated or nonliteral series value');
          seen.add(p.value);
        }
      });
    });
    // Fixed text output is interpreted by the existing renderer. Model text never supplies
    // this credit or the illustration warning; parent and opaque frame derive the same line.
    var credit = {kind:'text',value:sourceLine(source)};
    if (source.kind === 'illustration') spec.outputs.unshift(credit); else spec.outputs.push(credit);
  }
  function validate(raw) {
    var text = typeof raw === 'string' ? raw : '', type = 'unparseable';
    try {
      if (typeof raw !== 'string') text = JSON.stringify(raw);
      if (bytes(text) > B.componentBytes) fail('payload budget');
      var spec; try { spec = JSON.parse(text); } catch (_) { fail('malformed JSON'); }
      var count = { n: 0 }; walk(spec, 0, count);
      if (!object(spec)) fail('component object');
      type = typeof spec.type === 'string' ? spec.type.slice(0, 40) : 'missing';
      if (type === 'widget' && typeof spec.component === 'string') type = spec.component.slice(0,40);
      if (own(manifest.legacySchemas, spec.type)) {
        schema(spec, manifest.legacySchemas[spec.type], {});
        legacy(spec);
        var legacyCost = {components:1,nodes:count.n,responseBytes:bytes(text),domNodes:count.n*8};
        Object.keys(legacyCost).forEach(function (k) { if (legacyCost[k] > B[k]) fail(k+' budget'); });
        return { ok: true, legacy: true, spec: spec, cost:legacyCost };
      }
      schema(spec, manifest.schema, manifest.schema.$defs);
      if (!own(manifest.components, spec.component)) fail('unknown component');
      var component = manifest.components[spec.component];
      if (component.template) {
        if (spec.inputs || spec.graph || spec.outputs) fail('template override');
        Object.assign(spec, clone(component.template));
      } else {
        if (!spec.inputs || !spec.graph || !spec.outputs) fail('application declarations');
        if (component.requiredOutput && !spec.outputs.some(function (o) { return o.kind === component.requiredOutput; })) fail('required output');
        if (spec.outputs.some(function (o) { return component.outputKinds.indexOf(o.kind) < 0; })) fail('component output kind');
      }
      spec.actions = spec.actions || []; spec.props = spec.props || {};
      schema(spec, manifest.schema, manifest.schema.$defs);
      provenance(spec);
      schema(spec, manifest.schema, manifest.schema.$defs);
      var result = semantic(spec);
      return { ok: true, spec: spec, initial: result.initial, cost: result.cost };
    } catch (e) { return { ok: false, type: type, reason: String(e.message || e), text: text || String(raw == null ? 'Invalid response' : raw) }; }
  }
  function ledger() {
    var seen = Object.create(null), totals = Object.create(null), ids = Object.create(null);
    return function (id, result) {
      if (!result.ok) return false;
      if (own(seen, id)) return seen[id];
      if (result.spec.id && own(ids, result.spec.id)) { seen[id] = false; return false; }
      var cost = result.cost;
      var allowed = Object.keys(cost).every(function (k) { return (totals[k] || 0) + cost[k] <= B[k]; });
      seen[id] = allowed;
      if (allowed) { if (result.spec.id) ids[result.spec.id] = true; Object.keys(cost).forEach(function (k) { totals[k] = (totals[k] || 0) + cost[k]; }); }
      return allowed;
    };
  }
  function message(v) {
    try {
      var count = { n: 0 }; walk(v, 0, count);
      if (bytes(JSON.stringify(v)) > B.messageBytes) fail('message bytes');
      schema(v, manifest.messageSchema, {});
      var fields = { ready: ['type','nonce','manifest'], mounted: ['type','nonce'], draft: ['type','nonce','editing'], change: ['type','nonce','revision','inputs'], intent: ['type','nonce','revision','action'], resize: ['type','nonce','height'], fault: ['type','nonce','reason'] }[v.type];
      if (Object.keys(v).length !== fields.length || fields.some(function (k) { return !own(v,k); })) fail('message shape');
      return true;
    } catch (_) { return false; }
  }
  function bucket(rate, burst, clock) {
    var tokens = burst, last = clock();
    return function () { var now = clock(); tokens = Math.min(burst, tokens + Math.max(0, now - last) * rate / 1000); last = now; if (tokens < 1) return false; tokens--; return true; };
  }
  return { manifest: manifest, budgets: B, validate: validate, inputs: inputs, initial: initial, inputValue: inputValue,
    evaluate: evaluate, outputValues: outputValues, resolve: resolve, ledger: ledger, message: message, schema: schema,
    bytes: bytes, clone: clone, bucket: bucket, sourceLine: sourceLine };
});
