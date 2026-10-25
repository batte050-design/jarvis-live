/* DevTools Snippet, run before submitting the live acceptance prompt. Not loaded by the app.
 * Observes a real conversation only. Does not create DOM, mint identities, submit turns,
 * intercept transport, mutate broker records, read cookies, or inspect private frame DOM.
 */
(function () {
  'use strict';
  var broker = window.JarvisResponses, config = window.JarvisResponseConfig;
  if (!broker || !config) throw new Error('Response layer is not installed on this page.');
  var selected = null, revision = null, afterChange = '', serverTurn = '', originSeen = false;
  var timer, deadline, complete = false;
  function live(r) {
    var value = window.__jarvisLiveTurn && window.__jarvisLiveTurn();
    return value && value.alive && String(value.conv) === r.conv && value.turn != null ? value : null;
  }
  function visible(frame) {
    var box = frame.getBoundingClientRect(), style = getComputedStyle(frame);
    return frame.isConnected && !frame.hidden && style.display !== 'none' && style.visibility !== 'hidden' && box.width > 0 && box.height > 0 &&
      box.bottom > 0 && box.right > 0 && box.top < innerHeight && box.left < innerWidth;
  }
  function ordinary(answer) {
    return Array.from(answer.childNodes).filter(function (n) { return !(n.nodeType === 1 && n.classList.contains('jr-component')); })
      .map(function (n) { return n.textContent; }).join('');
  }
  window.jarvisResponseLiveProof = new Promise(function (resolve,reject) {
    function finish(error,report) {
      if (complete) return; complete = true; clearInterval(timer); clearTimeout(deadline); window.removeEventListener('message',observe);
      if (error) { console.warn('Live response proof INCOMPLETE:',error.message); reject(error); }
      else { console.info('Live response proof PASS',report); resolve(report); }
    }
    function observe(event) {
      if (!selected || event.source !== selected.frame.contentWindow || event.origin !== 'null' || !broker.core.message(event.data) || event.data.nonce !== selected.nonce) return;
      if (event.data.type === 'change' && selected.ready && live(selected)) { originSeen = true; revision = event.data.revision; afterChange = null; }
    }
    function tick() {
      if (!selected) {
        selected = Array.from(broker.records).find(function (r) {
          var turn = r.node.closest('.turn'), answer = r.node.closest('.t-a'), thread = document.getElementById('thread');
          return !r.dead && r.ready && turn && turn.dataset.id && answer && thread && thread.contains(turn) && live(r) && visible(r.frame);
        });
        if (selected) { serverTurn = String(live(selected).turn); console.info('Live response mounted. Move an input while the answer continues streaming.'); }
        return;
      }
      var running = live(selected);
      if (selected.dead || !selected.ready || !selected.frame.isConnected) return finish(new Error('Selected component was disposed.'));
      if (!running || String(running.turn) !== serverTurn) return finish(new Error('Turn ended or changed before interactivity and later streamed text were proven.'));
      if (!originSeen || revision === null || selected.acked < revision) return;
      var text = ordinary(selected.node.closest('.t-a'));
      if (afterChange === null) { afterChange = text; return; }
      if (text.length <= afterChange.length || !text.startsWith(afterChange) || !visible(selected.frame)) return;
      var opaque = false;
      try { void selected.frame.contentWindow.document; } catch (e) { opaque = e.name === 'SecurityError'; }
      if (!opaque || selected.frame.getAttribute('sandbox') !== 'allow-scripts') return finish(new Error('Native sandbox boundary was not observed.'));
      finish(null,{nativeVisibleMount:true,opaqueFrame:true,opaqueMessageOrigin:true,acknowledgedInputChange:true,
        laterTextInSameRunningTurn:true,sameFrame:true,manifest:config.hash,runtime:config.runtime});
    }
    window.addEventListener('message',observe);timer=setInterval(tick,50);
    deadline=setTimeout(function () { finish(new Error('No complete live proof within 60 seconds.')); },60000);tick();
  });
  // Keep a console-only failure report without an unhandled rejection notification.
  window.jarvisResponseLiveProof.catch(function () {});
})();
