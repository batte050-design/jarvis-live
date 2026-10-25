/* The device-matrix probe (Phase 0 harness).
 *
 * Runs inside the page over CDP and returns a plain object, so the runner can print it and the
 * evidence is a list of violations rather than a picture. Nothing here is part of the page: it is
 * loaded only by the harness, and it measures what the brief asks to be measured — overlap,
 * clipping, reachability, contrast, tap targets and the dissolve mask.
 */
(function () {
  "use strict";

  function rect(el) { var r = el.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height, b: r.bottom, r: r.right }; }
  function vis(el) {
    if (!el) return false;
    var cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden" || parseFloat(cs.opacity) === 0) return false;
    var r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }
  var _probe = null;
  function toRGB(v) {
    if (!v) return null;
    if (!_probe) { _probe = document.createElement("span"); _probe.style.display = "none"; document.body.appendChild(_probe); }
    _probe.style.color = "";
    _probe.style.color = v;
    if (!_probe.style.color) return null;
    var m = getComputedStyle(_probe).color.match(/[\d.]+/g);
    return m ? [+m[0], +m[1], +m[2]] : null;
  }
  function lum(c) {
    var a = toRGB(c);
    if (!a) return null;
    a = a.map(function (v) {
      v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * a[0] + 0.7152 * a[1] + 0.0722 * a[2];
  }
  function ratio(fg, bg) {
    var l1 = lum(fg), l2 = lum(bg);
    if (l1 == null || l2 == null) return null;
    if (l1 < l2) { var t = l1; l1 = l2; l2 = t; }
    return Math.round(((l1 + 0.05) / (l2 + 0.05)) * 100) / 100;
  }

  var IDS = ["#mic", "#typing", "#reset", "#stop", "#meta", "#send", "#q", "#sheetx", "#scrim"];
  var FIXED_OK = { c: 1, sheet: 1, scrim: 1, sheetpanel: 1 };

  window.__mtx = {};

  window.__mtx.load = function (kind) {
    var s = window.__jarvisTurnStart, e = window.__jarvisTurnEnd, a = window.__jarvisArt;
    // Every scenario starts from the same place, or one scenario's state becomes the next one's
    // finding and the matrix reports its own leftovers as bugs.
    document.body.classList.remove("typing");
    var fb = document.getElementById("fallback");
    if (fb) fb.classList.remove("show");
    if (window.setState) window.setState("idle");
    if (kind === "typing") {
      // the keyboard is up: the bar is the typing row and nothing else, with a way out of it
      var tb = document.getElementById("typing");
      if (tb) tb.click();
    } else if (kind === "speaking") {
      // an answer being spoken with Stop up: the widest the status bar ever gets
      s && s("Say something long");
      document.body.setAttribute("data-state", "speaking");
      var stb = document.getElementById("stop");
      if (stb) stb.hidden = false;
      var sw = []; for (var k2 = 0; k2 < 30; k2++) sw.push("sentence number " + k2 + " being spoken now");
      e && e(sw.join(". ") + ".");
    } else if (kind === "long") {
      var words = [];
      for (var i = 0; i < 700; i++) words.push("line " + i + " of a deliberately long answer");
      var big = words.join(". ") + ".";
      s && s("Show me a very long answer");
      e && e(big);
    } else if (kind === "table") {
      var cols = ["Bike", "Rider", "Days", "Distance", "Fuel", "Cost", "Per km", "Notes"];
      var rows = [];
      for (var r = 0; r < 12; r++) rows.push(["Boda-" + r, "Rider name " + r, 12 + r, 143 + r,
        "8.4 L", "UGX 42,000", "UGX 293", "a longer note that must wrap inside its cell"]);
      a && a({ kind: "table", label: "Eight columns", columns: cols, rows: rows, seq: 9001 });
    } else if (kind === "panel400k") {
      a && a({ kind: "text", label: "400 KB panel", text: "x".repeat(400000), seq: 9002 });
    } else if (kind === "reset") {
      s && s("");
      e && e("");
      a && a({ kind: "clear", seq: 9003 });
    } else if (kind === "speak") {
      s && s("Say something long");
      var w = []; for (var k = 0; k < 40; k++) w.push("sentence number " + k + " being spoken now");
      e && e(w.join(". ") + ".");
    }
    return true;
  };

  window.__mtx.probe = function () {
    var out = { vw: innerWidth, vh: innerHeight, violations: [], notes: {} };

    // 1. the page itself must never scroll sideways
    var de = document.documentElement;
    out.notes.pageOverflowX = de.scrollWidth - de.clientWidth;
    if (de.scrollWidth > de.clientWidth + 1) {
      out.violations.push("page scrolls sideways by " + (de.scrollWidth - de.clientWidth) + "px");
    }

    // 2. nothing floats except the sheets
    var fixed = [];
    Array.prototype.forEach.call(document.querySelectorAll("body *"), function (el) {
      if (!vis(el)) return;
      if (getComputedStyle(el).position === "fixed" && !FIXED_OK[el.id]) {
        fixed.push(el.id || el.className || el.tagName);
      }
    });
    out.notes.fixedElements = fixed;
    if (fixed.length) out.violations.push("fixed elements outside the sheets: " + fixed.join(", "));

    // 3. the chrome never overlaps itself, and the bar is fully on screen
    // (in short landscape the bar is a rail on the right, so a top/bottom comparison is wrong:
    // two boxes only collide when they overlap on BOTH axes)
    function overlaps(a, b) {
      return !(a.r <= b.x + 0.6 || b.r <= a.x + 0.6 || a.b <= b.y + 0.6 || b.b <= a.y + 0.6);
    }
    var bar = document.getElementById("bar"), content = document.getElementById("content"),
        top = document.getElementById("top");
    if (bar && content) {
      var rb = rect(bar), rc = rect(content);
      out.notes.bar = { x: Math.round(rb.x), y: Math.round(rb.y), w: Math.round(rb.w), h: Math.round(rb.h) };
      out.notes.content = { x: Math.round(rc.x), y: Math.round(rc.y), w: Math.round(rc.w), h: Math.round(rc.h) };
      if (overlaps(rb, rc)) out.violations.push("the bar and the content overlap");
      if (top && overlaps(rb, rect(top))) out.violations.push("the bar and the top line overlap");
      if (top && overlaps(rect(top), rc)) out.violations.push("the top line and the content overlap");
      if (rb.b > out.vh + 0.6) {
        out.violations.push("the bar is cut off at the bottom: bar ends " + Math.round(rb.b) + " > " + out.vh);
      }
      if (rb.r > out.vw + 0.6) {
        out.violations.push("the bar is cut off at the side: bar ends " + Math.round(rb.r) + " > " + out.vw);
      }
      if (rc.w < 180) out.violations.push("the content has been squeezed to " + Math.round(rc.w) + "px");
    }

    // 4. tap targets
    var small = [];
    IDS.forEach(function (sel) {
      var el = document.querySelector(sel);
      if (!vis(el)) return;
      var r = el.getBoundingClientRect();
      if (r.width < 44 - 0.5 || r.height < 44 - 0.5) {
        small.push(sel + " " + Math.round(r.width) + "x" + Math.round(r.height));
      }
    });
    out.notes.smallTargets = small;
    if (small.length) out.violations.push("tap target under 44px: " + small.join(", "));

    // 5. contrast, on the ground the tokens use
    var rs = getComputedStyle(document.documentElement);
    var ground = rs.getPropertyValue("--ground").trim();
    out.notes.contrast = {};
    ["--dim", "--soft", "--faint", "--ink"].forEach(function (t) {
      var v = rs.getPropertyValue(t).trim();
      if (!v) return;
      var c = ratio(v, ground);
      out.notes.contrast[t] = c;
      if (t !== "--faint" && c < 4.5) out.violations.push(t + " is " + c + ":1 on the ground, under 4.5:1");
    });

    // 6. content reachability: the last line of the answer must be readable
    if (content) {
      var s = document.getElementById("answer"), cb = rect(content);
      if (vis(s)) {
        content.scrollTop = content.scrollHeight;
        var sb = rect(s);
        out.notes.answerBottomAfterScroll = Math.round(sb.b);
        out.notes.contentBottomAfterScroll = Math.round(cb.b);
        if (sb.b > cb.b + 1) {
          out.violations.push("the last of the answer is cut: " + Math.round(sb.b) + " > " + Math.round(cb.b));
        }
      }
    }

    // 7. a wide table scrolls sideways and its last column is reachable
    var tw = document.querySelector("#artifact .tw");
    if (tw) {
      out.notes.tableScroll = { scrollWidth: tw.scrollWidth, clientWidth: tw.clientWidth };
      if (tw.scrollWidth > tw.clientWidth + 1) {
        tw.scrollLeft = tw.scrollWidth;
        out.notes.tableScrolledTo = tw.scrollLeft;
        if (tw.scrollLeft < tw.scrollWidth - tw.clientWidth - 2) {
          out.violations.push("the wide table will not scroll to its last column");
        }
      }
    }

    // 8. L6: the dissolve is on only while there is more below
    var art = document.getElementById("artifact");
    if (art && art.classList.contains("overflowing")) {
      art.scrollTop = 0;
      art.dispatchEvent(new Event("scroll"));
      var atTop = art.classList.contains("more-below");
      art.scrollTop = art.scrollHeight;
      art.dispatchEvent(new Event("scroll"));
      var atEnd = art.classList.contains("more-below");
      out.notes.mask = { atTop: atTop, atEnd: atEnd };
      if (!atTop) out.violations.push("the dissolve is off at the top of a long panel");
      if (atEnd) out.violations.push("the dissolve is still on at the end of a long panel (L6)");
    }

    // 9. the state label is real text and live
    var st = document.getElementById("state");
    if (st) {
      var word = st.querySelector(".word");
      out.notes.stateWord = word ? word.textContent : "";
      out.notes.stateLive = st.getAttribute("aria-live");
      if (!word || !word.textContent) out.violations.push("the state label has no text");
      if (st.getAttribute("aria-live") !== "polite") out.violations.push("the state label is not a polite live region");
    }

    // 10. the checks that would have caught the finishing-pass bugs, so they cannot come back.
    // A row wider than the screen makes mobile Chrome widen the layout viewport, and then every
    // line on the page is laid out wider than the screen and cut off at the right. scrollWidth
    // cannot see this, because the page hides its own overflow.
    var vvw = (window.visualViewport && window.visualViewport.width) || innerWidth;
    out.notes.innerWidth = innerWidth;
    out.notes.visualWidth = Math.round(vvw);
    if (innerWidth > vvw + 1) {
      out.violations.push("the layout viewport is inflated: innerWidth " + innerWidth +
                          " against a visual viewport of " + Math.round(vvw));
    }

    // Nothing visible may end past the visual viewport.
    var past = [];
    Array.prototype.forEach.call(document.querySelectorAll("body *"), function (el) {
      if (el.id === "bar" || el.tagName === "BODY" || el.tagName === "HTML") return;
      if (el.offsetParent === null) return;
      var r = el.getBoundingClientRect();
      if (r.width > 2 && r.height > 2 && r.right > vvw + 1) {
        past.push((el.id || el.className || el.tagName) + " ends " + Math.round(r.right));
      }
    });
    if (past.length) out.violations.push("past the right edge: " + past.slice(0, 3).join(", "));

    // Portrait is never a rail: the status word stays horizontal. The rail is for a phone held
    // sideways, and a keyboard shrinking the viewport is not the same thing.
    var stEl = document.getElementById("state");
    if (innerHeight >= innerWidth && stEl && getComputedStyle(stEl).writingMode !== "horizontal-tb") {
      out.violations.push("portrait is using the landscape rail: the status word is vertical");
    }

    // At idle, nothing in the top row or the bar may be wider than the viewport.
    ["top", "bar"].forEach(function (id) {
      var box = document.getElementById(id);
      if (!box) return;
      var r = box.getBoundingClientRect();
      if (r.width > vvw + 1) out.violations.push("#" + id + " is wider than the viewport");
      if (box.scrollWidth > vvw + 1) {
        out.violations.push("#" + id + " overflows its own box by " +
                            (box.scrollWidth - Math.round(vvw)) + "px");
      }
    });

    // Copy and Share belong to a finished answer: while one is still being made or spoken they
    // must not be up, offering to copy the previous one.
    var stNow = document.body.getAttribute("data-state") || "";
    if (stNow === "speaking" || stNow === "thinking" || stNow === "transcribing") {
      var aEl = document.getElementById("acts");
      if (aEl && getComputedStyle(aEl).display !== "none") {
        out.violations.push("Copy and Share are up while the answer is still being spoken");
      }
    }

    // Typing mode is a bar of its own, and it has a way back out.
    if (document.body.classList.contains("typing")) {
      var cx = document.getElementById("typingx");
      if (!cx || getComputedStyle(cx).display === "none") {
        out.violations.push("typing mode has no way to close");
      }
      var b3 = document.getElementById("bar3");
      if (b3 && getComputedStyle(b3).display !== "none") {
        out.violations.push("the microphone row is still up while typing");
      }
    }

    return out;
  };

  // the state label for each engine state, so the vocabulary can be checked without a voice
  window.__mtx.states = function () {
    var seen = {};
    ["idle", "listening", "capturing", "transcribing", "thinking", "speaking", "error"]
      .forEach(function (s) {
        window.setState(s);
        var w = document.querySelector("#state .word");
        seen[s] = w ? w.textContent : "";
      });
    window.setState("idle");
    return seen;
  };

  // ---------------------------------------------------------------- behaviour
  // Each of these drives the real page: a real click, a real key, the real handlers.
  window.__mtx.behaviour = function () {
    var out = {};
    function ok(name, pass, detail) { out[name] = { pass: !!pass, detail: detail || "" }; }
    var reset = document.getElementById("reset");
    var mic = document.getElementById("mic");
    var fb = document.getElementById("fallback");
    var micRect = mic.getBoundingClientRect();
    var typeRect = document.getElementById("typing").getBoundingClientRect();

    // B1 — reset is a real two-step
    window.__jarvisTurnStart("a question to clear");
    window.__jarvisTurnEnd("an answer that must survive the first tap");
    reset.click();
    var afterOne = document.getElementById("answer").textContent;
    var armed = reset.getAttribute("data-label");
    ok("B1 first tap arms instead of clearing",
       afterOne.indexOf("survive") >= 0 && armed === "Tap again to clear",
       "answer kept=" + (afterOne.indexOf("survive") >= 0) + " label=" + armed);
    reset.click();
    ok("B1 second tap clears", document.getElementById("answer").textContent === "",
       "answer now=" + JSON.stringify(document.getElementById("answer").textContent));

    // B10 — the keyboard
    var before = window.__jarvisState().earArmed;
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true }));
    var after = window.__jarvisState().earArmed;
    ok("B10 space toggles the microphone", before !== after, "armed " + before + " -> " + after);
    if (after) document.body.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true }));
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "/", bubbles: true, cancelable: true }));
    ok("B10 slash opens the typing box", fb.classList.contains("show") && getComputedStyle(fb).display === "flex",
       "display=" + getComputedStyle(fb).display);
    if (fb.classList.contains("show")) { fb.classList.remove("show"); }
    var turn = window.__jarvisState().clientTurn;
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    ok("B10 escape stops the turn", window.__jarvisState().clientTurn > turn,
       "clientTurn " + turn + " -> " + window.__jarvisState().clientTurn);

    // B2 — a cleared panel can be shown again
    var panel = { kind: "text", label: "repeat me", text: "panel body", seq: 5001 };
    window.__jarvisArt(panel);
    var first = document.getElementById("artifact").textContent.indexOf("panel body") >= 0;
    window.__jarvisArt({ kind: "clear", seq: 5002 });
    window.__jarvisArt({ kind: "text", label: "repeat me", text: "panel body", seq: 5001 });
    var again = document.getElementById("artifact").textContent.indexOf("panel body") >= 0;
    ok("B2 a repeated panel shows again after a clear", first && again,
       "first=" + first + " again=" + again);

    // B4 — the error is persistent and carries a way out
    window.__jarvisTurnStart("a question worth retrying");
    window.__jarvisTurnEnd("an answer that will not arrive");
    window.fail("a test failure that must not vanish");
    var err = document.getElementById("err");
    var shown = err.classList.contains("show") && getComputedStyle(err).display === "flex";
    var btn = err.querySelector("button");
    ok("B4 the error stays and offers a retry", shown && !!btn && /retry/i.test(btn.textContent),
       "shown=" + shown + " button=" + (btn ? btn.textContent : "none"));
    err.classList.remove("show");
    err.textContent = "";

    // B6 — the live regions exist
    ok("B6 the answer and the caption are polite live regions",
       document.getElementById("answer").getAttribute("aria-live") === "polite" &&
       document.getElementById("caption").getAttribute("aria-live") === "polite",
       "answer=" + document.getElementById("answer").getAttribute("aria-live") +
       " caption=" + document.getElementById("caption").getAttribute("aria-live"));

    // B7 — a Stop control while speaking
    window.setState("speaking");
    var stop = document.getElementById("stop");
    var visible = !stop.hidden && getComputedStyle(stop).display !== "none";
    window.setState("idle");
    ok("B7 stop is shown while speaking", visible, "hidden=" + stop.hidden);

    // L10 — the microphone is the largest control and nothing is dimmed to nothing
    ok("L10 the microphone is the big control", micRect.width >= 64 && micRect.width > typeRect.width,
       "mic=" + Math.round(micRect.width) + "px type=" + Math.round(typeRect.width) + "px");

    window.__jarvisArt({ kind: "clear", seq: 5003 });
    window.__jarvisTurnStart("");
    window.__jarvisTurnEnd("");
    return out;
  };

  return true;
})();
