/* The widget verification probe (brief 5.6).
 *
 * Run inside a rendered widget. It answers one question per rule the brief lays down: horizontal
 * overflow, a blank canvas, a tap target under 44px, text clipped by its container. Console errors
 * and CSP violations are collected by the runner's own hook, which has to be installed before the
 * widget's scripts run.
 *
 * Defines window.__wp.probe(). Nothing here writes to the page.
 */
window.__wp = (function () {

  function shown(el) {
    var cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden" || Number(cs.opacity) === 0) return false;
    var r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  function ownText(el) {
    var s = "";
    for (var i = 0; i < el.childNodes.length; i++) {
      if (el.childNodes[i].nodeType === 3) s += el.childNodes[i].nodeValue;
    }
    return s.replace(/\s+/g, " ").trim();
  }

  // --- the rules -------------------------------------------------------------------------------

  function docOverflow() {
    var de = document.documentElement;
    return Math.max(de.scrollWidth - de.clientWidth, document.body ? document.body.scrollWidth - de.clientWidth : 0);
  }

  function blankCanvases() {
    var out = [];
    Array.prototype.forEach.call(document.querySelectorAll("canvas"), function (cv) {
      if (!cv.width || !cv.height) { out.push({ why: "zero size" }); return; }
      var tmp = document.createElement("canvas");
      tmp.width = cv.width; tmp.height = cv.height;
      var c = tmp.getContext("2d");
      try { c.drawImage(cv, 0, 0); } catch (e) { return; }          // a foreign canvas: not ours to judge
      var d;
      try { d = c.getImageData(0, 0, cv.width, cv.height).data; } catch (e) { return; }
      var inked = 0;
      for (var i = 3; i < d.length; i += 4) { if (d[i] !== 0) { inked++; if (inked > 32) break; } }
      if (inked <= 32) out.push({ why: "nothing drawn", w: cv.width, h: cv.height });
    });
    return out;
  }

  function smallTargets() {
    var sel = 'button, a[href], input:not([type=hidden]), select, textarea, summary, [role="button"], [role="link"], [onclick]';
    var out = [];
    Array.prototype.forEach.call(document.querySelectorAll(sel), function (el) {
      if (!shown(el)) return;
      var r = el.getBoundingClientRect();
      if (r.width < 43.5 || r.height < 43.5) {
        out.push({ tag: el.tagName.toLowerCase(), w: Math.round(r.width), h: Math.round(r.height),
                   text: (el.textContent || el.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim().slice(0, 30) });
      }
    });
    return out;
  }

  function clippedText() {
    var out = [];
    var nodes = document.querySelectorAll("h1,h2,h3,h4,p,li,td,th,span,div,pre,label,a,button,figcaption");
    Array.prototype.forEach.call(nodes, function (el) {
      if (!shown(el)) return;
      var txt = ownText(el);
      if (!txt) return;
      var cs = getComputedStyle(el);
      // Only a container that cuts its own content counts. A scroller is doing its job, not failing.
      var cutsY = /hidden|clip/.test(cs.overflowY) && el.scrollHeight > el.clientHeight + 1;
      var cutsX = /hidden|clip/.test(cs.overflowX) && el.scrollWidth > el.clientWidth + 1;
      if (cutsY || cutsX) {
        out.push({ tag: el.tagName.toLowerCase(), text: txt.slice(0, 40),
                   overY: el.scrollHeight - el.clientHeight, overX: el.scrollWidth - el.clientWidth });
      }
    });
    return out;
  }

  function escapes() {
    // Anything reaching past the viewport's right edge, which on a phone means it is simply gone.
    var de = document.documentElement, limit = de.clientWidth + 1, out = [];
    Array.prototype.forEach.call(document.querySelectorAll("body *"), function (el) {
      if (!shown(el)) return;
      var r = el.getBoundingClientRect();
      if (r.right > limit && r.width > 0) {
        var cs = getComputedStyle(el);
        if (cs.position === "fixed" || cs.position === "absolute") return;
        out.push({ tag: el.tagName.toLowerCase(), right: Math.round(r.right), w: Math.round(r.width) });
      }
    });
    return out.slice(0, 8);
  }

  function probe() {
    var de = document.documentElement;
    return {
      viewport: { w: de.clientWidth, h: de.clientHeight },
      docOverflow: docOverflow(),
      blankCanvases: blankCanvases(),
      smallTargets: smallTargets(),
      clippedText: clippedText(),
      escapes: escapes(),
      canvases: document.querySelectorAll("canvas").length,
      targets: document.querySelectorAll('button, a[href], input:not([type=hidden])').length,
      text: (document.body.innerText || "").replace(/\s+/g, " ").trim().slice(0, 120),
      violations: []
    };
  }

  return { probe: probe };
})();
