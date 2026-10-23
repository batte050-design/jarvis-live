/* UI checkpoints only. The application session/history stores are not accessed. */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory;
  else root.JarvisResponseStore = factory;
})(typeof globalThis === 'object' ? globalThis : this, function (indexedDB, budgets, clock) {
  'use strict';
  var pending, B = budgets; clock = clock || Date.now;
  function db() {
    if (!pending) pending = new Promise(function (resolve,reject) {
      if (!indexedDB) { reject(new Error('checkpoint storage unavailable')); return; }
      var request = indexedDB.open('jarvis.response.checkpoints',1);
      request.onupgradeneeded = function () {
        var d = request.result;
        var store = d.createObjectStore('rows',{keyPath:'key'}); store.createIndex('scope','scope');
        d.createObjectStore('meta',{keyPath:'key'});
      };
      request.onsuccess = function () { request.result.onversionchange = function () { request.result.close(); pending = null; }; resolve(request.result); };
      request.onerror = function () { reject(request.error); };
      request.onblocked = function () { reject(new Error('checkpoint storage blocked')); };
    });
    return pending;
  }
  function transaction(names, mode, run) {
    return db().then(function (d) { return new Promise(function (resolve,reject) {
      var tx = d.transaction(names,mode), answer;
      tx.oncomplete = function () { resolve(answer); };
      tx.onerror = tx.onabort = function () { reject(tx.error || new Error('checkpoint transaction')); };
      run(tx,function (v) { answer = v; });
    }); });
  }
  function key(scope, identity) { return JSON.stringify([scope,identity]); }
  function size(v) { return new TextEncoder().encode(JSON.stringify(v)).length; }
  function plan(rows, row) {
    var now = clock(), live = rows.filter(function (r) { return r.key !== row.key && r.expires > now; });
    live.push(row); live.sort(function (a,b) { return b.updated - a.updated; });
    var total = 0, keep = [], remove = rows.filter(function (r) { return r.expires <= now; }).map(function (r) { return r.key; });
    live.forEach(function (r) { if (keep.length < B.checkpointCount && total + r.bytes <= B.checkpointTotalBytes) { total += r.bytes; keep.push(r.key); } else remove.push(r.key); });
    if (!keep.includes(row.key)) throw new Error('checkpoint capacity');
    return {remove:remove,total:total};
  }
  return {
    installation:function (random) { return transaction(['meta'],'readwrite',function (tx,done) {
      var store = tx.objectStore('meta'), request = store.get('installation');
      request.onsuccess = function () { var id = request.result ? request.result.value : random(); store.put({key:'installation',value:id}); done(id); };
    }); },
    get:function (scope,identity) { return transaction(['rows'],'readwrite',function (tx,done) {
      var store = tx.objectStore('rows'), request = store.get(key(scope,identity));
      request.onsuccess = function () { var r = request.result; if (r && r.expires <= clock()) { store.delete(r.key); r = null; } if (r) { r.expires = clock()+B.checkpointDays*86400000; r.updated = clock(); store.put(r); } done(r ? r.value : null); };
    }); },
    put:function (scope,identity,conv,value) {
      if (size(value) > B.checkpointBytes) return Promise.reject(new Error('checkpoint payload'));
      return transaction(['rows'],'readwrite',function (tx,done) {
        var store = tx.objectStore('rows'), request = store.getAll();
        request.onsuccess = function () {
          try {
            var row = {key:key(scope,identity),scope:scope,conv:conv,value:value,updated:clock(),expires:clock()+B.checkpointDays*86400000,bytes:size(value)};
            var admission = plan(request.result,row); admission.remove.forEach(function (k) { store.delete(k); }); store.put(row); done(true);
          } catch (_) { tx.abort(); }
        };
      });
    },
    clear:function (scope,conv) { return transaction(['rows'],'readwrite',function (tx,done) {
      var store = tx.objectStore('rows'), request = store.index('scope').getAll(scope);
      request.onsuccess = function () { request.result.forEach(function (r) { if (conv === undefined || conv === r.conv || r.expires <= clock()) store.delete(r.key); }); done(true); };
    }); },
    remove:function (scope,identity) { return transaction(['rows'],'readwrite',function (tx,done) { tx.objectStore('rows').delete(key(scope,identity)); done(true); }); },
    prune:function () { return transaction(['rows'],'readwrite',function (tx,done) {
      var store = tx.objectStore('rows'), request = store.openCursor();
      request.onsuccess = function () { var c = request.result; if (c) { if (c.value.expires <= clock()) c.delete(); c.continue(); } else done(true); };
    }); },
    plan:plan
  };
});
