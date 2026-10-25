/* The JARVIS widget kit. One job: let a widget speak to the page it is framed in, and nothing
 * else. It never reaches the network, never touches a cookie and never leaves the frame. */
(function () {
  "use strict";
  var last = 0, pending = null;

  // What the page is showing. A widget opened as a link has no query string and falls back to the
  // device's preference, which is the right answer when it is the only thing on screen.
  (function () {
    try {
      var p = new URLSearchParams(location.search);
      var th = p.get("theme");
      if (th === "light" || th === "dark") document.documentElement.setAttribute("data-theme", th);
      var t = parseFloat(p.get("t"));
      if (t > 0.5 && t < 3) {
        var r = document.documentElement.style;
        r.setProperty("--t1", (0.84 * t).toFixed(3) + "rem");
        r.setProperty("--t2", (1.07 * t).toFixed(3) + "rem");
      }
    } catch (e) { /* no URLSearchParams, or no query string: keep the device's answer */ }
  })();

  function post(msg) {
    try { parent.postMessage(msg, "*"); } catch (e) { /* no parent: opened as a link */ }
  }

  function sendResize() {
    var h = Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0);
    if (Math.abs(h - last) < 2) return;
    last = h;
    post({ type: "jarvis:resize", height: h });
  }

  function observe() {
    sendResize();
    if (window.ResizeObserver) {
      try { new ResizeObserver(sendResize).observe(document.documentElement); } catch (e) {}
    }
    window.addEventListener("load", sendResize);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(sendResize);
    if (pending) { clearTimeout(pending); pending = null; }
    setTimeout(sendResize, 60);
  }

  window.JARVIS = {
    /* Ask the page to put a follow-up question to JARVIS, as if it had been typed. */
    ask: function (text) {
      text = String(text == null ? "" : text).slice(0, 200);
      if (!text) return false;
      post({ type: "jarvis:ask", text: text });
      return true;
    },
    resize: sendResize,
    num: function (v, digits) {
      var n = Number(v);
      if (!isFinite(n)) return String(v == null ? "" : v);
      var d = digits == null ? 0 : digits;
      return n.toLocaleString("en-UG", { minimumFractionDigits: d, maximumFractionDigits: d });
    },
    ugx: function (v) { return "UGX " + JARVIS.num(Math.round(Number(v) || 0)); },
    pct: function (v, digits) { return JARVIS.num(v, digits == null ? 1 : digits) + "%"; },
    /* A bar row, the workhorse of an amounts comparison. No colour carries meaning on its own: the
     * value is written beside every bar. */
    bars: function (host, rows, opts) {
      opts = opts || {};
      var max = 0;
      rows.forEach(function (r) { max = Math.max(max, Number(r.value) || 0); });
      if (!max) max = 1;
      var unit = opts.unit || "";
      var out = [];
      rows.forEach(function (r, i) {
        var w = Math.round(((Number(r.value) || 0) / max) * 100);
        out.push('<div class="jw-row"><span style="flex:1">' + esc(r.label) + '</span>' +
                 '<span style="width:45%;height:10px;background:var(--border);border-radius:2px">' +
                 '<span style="display:block;height:10px;width:' + w + '%;background:var(--c' +
                 ((i % 5) + 1) + ');border-radius:2px"></span></span>' +
                 '<span class="jw-muted" style="min-width:5.5em;text-align:right">' +
                 JARVIS.num(r.value, opts.digits) + unit + '</span></div>');
      });
      if (host) host.innerHTML = out.join("");
      return out.join("");
    },
    legend: function (host, items) {
      var html = '<div class="jw-legend">' + items.map(function (it, i) {
        var cls = "jw-swatch" + (it.variant === "dashed" ? " dashed" :
                                 it.variant === "dotted" ? " dotted" : "");
        var style = it.variant === "dash" ? "" : "background:var(--c" + ((i % 5) + 1) + ")";
        return '<span><i class="' + cls + '" style="' + style + '"></i>' + esc(it.label) + "</span>";
      }).join("") + "</div>";
      if (host) host.innerHTML = html;
      return html;
    }
  };

  function esc(s) {
    return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  observe();
})();
