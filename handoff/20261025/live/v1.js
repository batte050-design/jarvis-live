/* JARVIS Live — version 1: the surface.
 *
 * The engine below this file is untouched and owns everything that makes sound: capture at
 * 16 kHz, the transcriber, the stream, and playback. This file owns what is on the screen.
 *
 * Public surface, all optional to the engine:
 *   window.__jarvisTurnStart(q) · __jarvisReply(chunk) · __jarvisTurnEnd(full) · __jarvisTerm(d)
 *   window.__jarvisLevel(buf, dir)      the voice, for the state ring and the level line
 *   window.__jarvisArt(payload)         the same entry the agent's channel uses
 */
(function () {
  "use strict";

  var $ = function (id) { return document.getElementById(id); };
  var body = document.body;
  var heard = $("heard"), qEl = $("question"), ans = $("answer"), cap = $("caption"),
      artEl = $("artifact"), errEl = $("err"), lv = $("level") ? $("level").firstElementChild : null,
      content = $("content"), workEl = $("work"), metaBtn = $("meta"), stopIn = $("stopin"),
      toBottomBtn = $("tobottom"),
      threadEl = $("thread"), speakEl = $("speak"),
      sheetEl = $("sheet"), sheetPanel = $("sheetpanel"), sheetX = $("sheetx"), scrim = $("scrim"),
      stepsEl = $("steps"), stateEl = $("state"),
      acts = $("acts"), copyBtn = $("copy"), shareBtn = $("share"),
      againBtn = $("again"), qacts = $("qacts"), qCopyBtn = $("qcopy"), qEditBtn = $("qedit"),
      clockBtn = $("clock"), sizeBtn = $("size"), toastEl = $("toast"), sheetTitle = $("sheettitle"),
      offlineEl = $("offline"),
      // The drawer's own pages: the menu is the first, a destination the second, and the track
      // between them is what slides.
      navPageTrack = $("navtrack"), navPageDetail = $("navdetail"), navPageBody = $("navdetailbody"),
      navPageTitle = $("navdetailtitle"), navBackBtn = $("navback"),
      // The full-screen pages: Settings, Persona & Memory and User Profile take the whole
      // viewport rather than the drawer's width, each with its own sticky header and action.
      pageEl = $("page"), pageBody = $("pagebody"), pageTitle = $("pagetitle"),
      pageBackBtn = $("pageback"), pageActBtn = $("pageact");

  var lastQ = "", answerText = "", captionText = "", capShown = false, turnEnded = false, settledAt = 0;
  // The answer is complete and cannot grow any further: only then can it be drawn as
  // structure. Mid-flight it is paced against the audio, a piece at a time.
  var answerSettled = false;
  var textMode = false;                         // he is reading, not listening (see __jarvisMode)
  var turnText = "";                           // the reply in order, straight off the stream
  var t0 = 0, workMs = 0, tick = null, steps = [], regenerating = false, regenerateHistoryIndex = -1;
  // A line the agent wrote that no step has claimed yet. It is the agent's statement of what it is
  // about to do, so the step that follows owns it and renders it nested underneath. Anything left
  // over at the end is shown as a plain line rather than filed against the wrong step.
  var pendingNote = null;
  var lastStepObject = "";                    // safe noun carried only within the current turn
  var KEY = "jarvis.v1.last";
  var HKEY = "jarvis.v1.history", HMAX = 30;   // the last 30 turns, each with its visual's token
  var RKEY = "jarvis.v1.reset";                // when the conversation was last started over
  var SKEY = "jarvis.v1.textscale";
  var TKEY = "jarvis.v1.theme";                // device | light | dark
  var lastWidget = null;                       // the visual shown for the current turn, if any

  // Appearance is applied before the first paint. Density moves real layout numbers, autoplay is a flag
  // the engine reads, and both come from the last value the node recorded.
  try {
    applyDensity(density());
    window.__jarvisAutoPlay = (JSON.parse(localStorage.getItem("jarvis.v1.ui.autoplay")) === true);
  } catch (e) {}

  // ---------------------------------------------------------------- the held answer
  function paintAnswer() {
    // The live turn owns the answer element. A session refresh, a rehydrate or a switch can
    // re-point it at the old hidden surface, and the answer then streams where nobody can see it:
    // the question and its controls stay, the answer never appears. Reclaim it here.
    if (liveBlock && liveBlockAns && ans !== liveBlockAns) ans = liveBlockAns;
    if (!qEl || !qEl.isConnected) return;
    qEl.textContent = lastQ || "";
    qEl.style.display = lastQ ? "" : "none";
    // The question's own two controls travel with it: copy the words, or put them back in the
    // composer to amend. They follow the prompt rather than any answer, so they are up as soon as
    // there is a question on screen.
    if (qacts) qacts.hidden = !(lastQ || "").trim();
    paintAnswerBody();
    if (acts) acts.hidden = !answerText;
  }

  // The answer is drawn block by block as it arrives, and redrawn in one pass when the turn ends so
  // the finished screen is exactly what the completed text says. Nothing structural waits for the
  // end any more: a table, a heading or a component appears as soon as its own block is closed.
  function paintAnswerBody() {
    // The live turn owns the answer element. A session refresh, a rehydrate or a switch can
    // re-point it at the old hidden surface, and the answer then streams where nobody can see it:
    // the question and its controls stay, the answer never appears. Reclaim it here.
    if (liveBlock && liveBlockAns && ans !== liveBlockAns) ans = liveBlockAns;
    if (!ans) return;
    if (textMode && liveBlock && liveBlock.dataset.agentFailed) return;
    if (answerSettled && !answerText) { streamReset(ans); ans.textContent = ""; return; }
    if (!answerSettled) {
      // The answer draws as it arrives, in its final shape. Holding the body empty until the turn
      // ended meant the only thing on screen was the plain spoken line, which was then replaced by a
      // formatted answer in one flash: he saw a rough paragraph vanish and asked why it was there at
      // all. Complete blocks are drawn formatted, the unfinished tail stays plain, and the end only
      // redraws when the block list actually changed.
      var live = String(textMode ? captionText : (turnText && turnText.length ? turnText : captionText));
      if (!live) { if (!ans.__held) { ans.textContent = ""; ans.__held = 1; } return; }
      ans.__held = 0;
      settleBody(ans, live, turnShape);
      return;
    }
    ans.__held = 0;
    settleBody(ans, answerText, turnShape);
  }
  // One place decides how a body of text is drawn, so the answer being written and the answer already
  // in the thread above are drawn by the same rules.
  // ---------------------------------------------------------------- drawing an answer as it arrives
  // A turn used to be drawn as plain text until it settled, and only then as structure, so a
  // comparison appeared in one flash at the end and a table could not be read while half-arrived.
  // A block is now drawn the moment it is complete and can no longer change. The block still being
  // written waits in the tail, and is shown there as words only when those words cannot be the
  // start of a component or a fence: half a spec must never reach the screen as braces, and half a
  // table must not reach it as pipes.
  function braceDepth(s) {
    var n = 0, q = 0, i, ch;
    for (i = 0; i < s.length; i++) {
      ch = s.charAt(i);
      if (q) { if (ch === "\\") i++; else if (ch === q) q = 0; continue; }
      if (ch === "\"" || ch === "'") { q = ch; continue; }
      if (ch === "{") n++;
      else if (ch === "}") n--;
    }
    return n;
  }
  function splitBlocks(text) {
    var lines = String(text == null ? "" : text).split("\n");
    var out = [], cur = [], fence = false, spec = 0, mode = "", raw = false;
    function flush(ok) {
      var body = cur.join("\n");
      if (body.trim()) out.push({ b: body, ok: ok });
      cur = []; mode = ""; spec = 0; raw = false;
    }
    for (var i = 0; i < lines.length; i++) {
      var t = lines[i], trim = t.replace(/^\s+/, "");
      if (fence) { cur.push(t); if (/^```/.test(trim)) { fence = false; flush(true); } continue; }
      if (/^```/.test(trim)) { if (cur.length) flush(true); cur.push(t); fence = true; raw = true; continue; }
      if (!trim) { if (cur.length) flush(true); continue; }
      if (raw) { cur.push(t); spec += braceDepth(t); if (spec <= 0) { flush(true); raw = false; } continue; }
      if (spec > 0 || trim.charAt(0) === "{") {
        cur.push(t); spec += braceDepth(t); mode = "spec";
        if (spec <= 0) flush(true);
        continue;
      }
      if (/^\|/.test(trim)) { if (mode && mode !== "table") flush(true); cur.push(t); mode = "table"; continue; }
      if (/^([-*+]|\d+[.)])\s+/.test(trim)) { if (mode && mode !== "list") flush(true); cur.push(t); mode = "list"; continue; }
      if (/^#{1,6}\s/.test(trim)) { if (cur.length) flush(true); cur.push(t); flush(true); continue; }
      if (mode && mode !== "para") flush(true);
      cur.push(t); mode = "para";
    }
    // Whatever is left was never terminated, so it is still being written. It is never drawn as a
    // finished block, however complete it looks: the next token could still change it.
    if (cur.length) out.push({ b: cur.join("\n"), ok: false });
    return out;
  }
  // The answer stops being written. Until now the whole body was thrown away and drawn again from the
  // final text, which is the flash he sees on every question: words already on screen disappear for a
  // frame and come back. Everything the streamer already folded is correct — it uses this same block
  // renderer — so the settle folds whatever became complete and rebuilds only if the structure really
  // differs. Nothing that is already right is drawn twice.
  function settleBody(el, text, shape) {
    if (textMode && window.JarvisOpenUI && window.JarvisOpenUI.handles(text, el)) {
      window.JarvisOpenUI.paint(el, text, function (target, prose) { paintBodyInto(target, prose, true, shape, true); }, answerSettled);
      return;
    }
    if (textMode && window.JarvisResponses && window.JarvisResponses.handles(text, el)) {
      window.JarvisResponses.reconcile(el, function (target) { paintBodyInto(target, text, true, shape, true); });
      outboxLinks(el);
      return;
    }
    var body = String(text == null ? "" : text);
    var blocks = splitBlocks(body), i, ok = true;
    // No folding pass here. While a turn runs the body is held empty, so folding first drew the answer
    // once and the comparison then threw it away and drew it again — two drawings inside one frame, which
    // is the flash that could not be photographed.
    if (el.__tail) { el.removeChild(el.__tail); el.__tail = null; el.__tailTxt = null; }
    if (!el.__keys || !el.__keys.length || el.__keys.length !== blocks.length) ok = false;
    else for (i = 0; i < blocks.length; i++) if (el.__keys[i] !== blocks[i].b) { ok = false; break; }
    if (ok) return;
    el.textContent = "";
    streamReset(el);
    paintBodyInto(el, body, true, shape);
  }
  function streamFold(el, body, shape) {
    var tmp = document.createElement("div");
    renderRich(tmp, body, shape || "prose");
    var frag = document.createDocumentFragment();
    while (tmp.firstChild) frag.appendChild(tmp.firstChild);
    return frag;
  }
  function streamReset(el) {
    if (!el) return;
    el.__keys = null;
    el.__tail = null;
    el.__tailTxt = null;
  }
  function streamRender(el, text, shape) {
    var blocks = splitBlocks(text), head = [], tail = "", i;
    for (i = 0; i < blocks.length; i++) if (blocks[i].ok) head.push(blocks[i].b);
    if (blocks.length && !blocks[blocks.length - 1].ok) tail = blocks[blocks.length - 1].b;
    var keys = el.__keys;
    var same = keys && keys.length <= head.length;
    if (same) {
      for (i = 0; i < keys.length; i++) if (keys[i] !== head[i]) { same = false; break; }
    }
    if (!same) {
      el.textContent = "";
      el.__keys = [];
      el.__tail = null;
      el.__tailTxt = null;
      for (i = 0; i < head.length; i++) {
        el.appendChild(streamFold(el, head[i], shape));
        el.__keys.push(head[i]);
      }
    } else {
      for (i = keys.length; i < head.length; i++) {
        if (!el.__tail) el.appendChild(streamFold(el, head[i], shape));
        else el.insertBefore(streamFold(el, head[i], shape), el.__tail);
        el.__keys.push(head[i]);
      }
    }
    // The tail: words only when they cannot be the beginning of a component, a fence or a table.
    var show = tail && tail.indexOf("{") === -1 && tail.indexOf("```") === -1 && !/^\s*\|/.test(tail);
    if (tail && /^#{1,6}\s/.test(tail) && tail.indexOf("\n") === -1) show = true;
    if (!show) {
      if (el.__tail) { el.removeChild(el.__tail); el.__tail = null; el.__tailTxt = null; }
      return;
    }
    var shown = /^#{1,6}\s/.test(tail) && tail.indexOf("\n") === -1
      ? tail.replace(/^#{1,6}\s+/, "") : tail;
    if (!el.__tail) {
      el.__tail = document.createElement("p");
      el.__tail.className = "rc-p rc-open";
      el.appendChild(el.__tail);
      el.__tailTxt = null;
    }
    if (el.__tailTxt !== shown) {
      el.__tail.textContent = "";
      inline(el.__tail, shown.replace(/\n/g, " "));
      el.__tailTxt = shown;
    }
  }
  // Read-only, for the probes.
  window.__jarvisStream = function (text, shape) {
    var el = document.createElement("div");
    streamRender(el, String(text == null ? "" : text), shape || "prose");
    return el;
  };
  // A file the answer produced arrives as a card, not a sentence about a path. The agent writes it
  // into the app's outbox and names it in the answer as [[file:name]]; that marker is the whole
  // protocol, so one answer can carry several and each becomes its own card.
  //
  // Both doors go through this page with the session attached. A bare link to /file/... looked
  // right and did nothing when tapped: the phone handed the URL away and with it went the cookie
  // the file needs. So the bytes are fetched here first, and only then shown or saved.
  var OUTBOX_RE = /\[\[file:([^\]\n]+)\]\]/g;

  // What the phone can show, by extension. Anything not named here still downloads; nothing is
  // offered as "Open" that this page cannot put on the screen.
  var FILE_KINDS = {
    pdf: "pdf", png: "image", jpg: "image", jpeg: "image", webp: "image", gif: "image", svg: "image",
    heic: "image", mp3: "audio", m4a: "audio", wav: "audio", ogg: "audio", opus: "audio",
    mp4: "video", mov: "video", webm: "video",
    txt: "text", md: "text", csv: "text", json: "text", log: "text", html: "text", xml: "text"
  };
  function fileKind(name) {
    var ext = String(name).split(".").pop().toLowerCase();
    return FILE_KINDS[ext] || "other";
  }
  function fileGlyph(kind) {
    var open = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">';
    if (kind === "image") return open + '<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><circle cx="9" cy="10" r="1.5"/><path d="m4.5 17 5-5 4 4 2.5-2.5 3.5 3.5"/></svg>';
    if (kind === "audio") return open + '<path d="M9 17V7l9-2v10"/><circle cx="6.5" cy="17.5" r="2.5"/><circle cx="15.5" cy="15.5" r="2.5"/></svg>';
    if (kind === "video") return open + '<rect x="3" y="5.5" width="18" height="13" rx="2.5"/><path d="m10 9.5 5 2.5-5 2.5z"/></svg>';
    if (kind === "text") return open + '<path d="M6.5 3.5h8L19 8v12.5H6.5z"/><path d="M14 3.5V8h5"/><path d="M9.5 12.5h7M9.5 16h5"/></svg>';
    if (kind === "pdf") return open + '<path d="M6.5 3.5h8L19 8v12.5H6.5z"/><path d="M14 3.5V8h5"/><path d="M9 16.5c2-2.5 3-5 3-7.5"/><path d="M9.5 14.5h5"/></svg>';
    return open + '<path d="M6.5 3.5h8L19 8v12.5H6.5z"/><path d="M14 3.5V8h5"/></svg>';
  }

  function outboxBytes(name) {
    return fetch("/file/" + encodeURIComponent(name), { credentials: "same-origin" })
      .then(function (r) { if (!r.ok) throw new Error("http " + r.status); return r.blob(); });
  }

  // Save through a blob, so the phone's download manager gets bytes it already holds and never has
  // to ask for the file again from outside the session.
  function outboxSave(name, blob) {
    var u = URL.createObjectURL(blob), a = document.createElement("a");
    a.href = u; a.download = name; a.style.display = "none";
    document.body.appendChild(a); a.click();
    setTimeout(function () {
      URL.revokeObjectURL(u);
      if (a.parentNode) a.parentNode.removeChild(a);
    }, 8000);
  }

  function outboxReader(name, blob, kind) {
    var host = document.getElementById("ofview");
    if (!host) {
      host = document.createElement("div");
      host.id = "ofview";
      host.className = "ofv";
      host.innerHTML = '<div class="ofv-bar"><span class="ofv-name"></span>' +
                       '<button class="ofv-x" type="button" aria-label="Close">Close</button></div>' +
                       '<div class="ofv-body"></div>';
      document.body.appendChild(host);
      host.querySelector(".ofv-x").addEventListener("click", function () {
        host.classList.remove("on");
        host.querySelector(".ofv-body").innerHTML = "";
      });
      host.addEventListener("click", function (e) {
        if (e.target === host) {
          host.classList.remove("on");
          host.querySelector(".ofv-body").innerHTML = "";
        }
      });
    }
    var body = host.querySelector(".ofv-body");
    host.querySelector(".ofv-name").textContent = name;
    body.innerHTML = "";
    var u = URL.createObjectURL(blob), el;
    if (kind === "image") {
      el = document.createElement("img"); el.src = u; el.alt = name;
    } else if (kind === "video") {
      el = document.createElement("video"); el.src = u; el.controls = true; el.setAttribute("playsinline", "");
    } else if (kind === "audio") {
      el = document.createElement("audio"); el.src = u; el.controls = true;
    } else {
      el = document.createElement("pre"); el.className = "ofv-text";
      var fr = new FileReader();
      fr.onload = function () { el.textContent = String(fr.result || "").slice(0, 200000); };
      fr.readAsText(blob);
    }
    body.appendChild(el);
    host.classList.add("on");
  }

  function outboxOpen(name, blob) {
    var kind = fileKind(name);
    if (kind === "pdf" || kind === "other") {
      // The phone's own document viewer, handed a blob so it never asks for the cookie again.
      var u = URL.createObjectURL(blob), w = window.open(u, "_blank");
      if (!w) outboxSave(name, blob);
      setTimeout(function () { URL.revokeObjectURL(u); }, 120000);
      return;
    }
    outboxReader(name, blob, kind);
  }


  // A link the phone can act on. The file card used to fetch the bytes and hand them to a blob URL,
  // which Android cannot download and an external viewer cannot open without the session cookie. A
  // ticket is a short-lived name for one file, and the native side takes it from there.
  function fileTicket(name, mode) {
    return fetch("/file/ticket", {
      method: "POST", credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: name, mode: mode })
    }).then(function (r) { if (!r.ok) throw new Error("ticket " + r.status); return r.json(); })
      .then(function (j) {
        if (!j || !j.ok || !j.url) throw new Error("no link");
        return { url: new URL(j.url, location.origin).href, mode: j.mode };
      });
  }

  function fileHandOff(name, mode) {
    return fileTicket(name, mode).then(function (t) {
      if (window.JarvisFile && typeof window.JarvisFile[mode === "download" ? "download" : "open"] === "function") {
        // The native side answers. Silence was how a dead button looked like a working one.
        var r = mode === "download" ? window.JarvisFile.download(t.url, name) : window.JarvisFile.open(t.url, name);
        if (String(r || "").indexOf("fail") === 0) throw new Error(String(r));
        return true;
      }
      // Outside the app: a real address, so the browser's own viewer or download manager takes it.
      if (mode === "download") { var a = document.createElement("a"); a.href = t.url; a.download = name; document.body.appendChild(a); a.click(); setTimeout(function(){ a.remove(); }, 4000); return true; }
      var w = window.open(t.url, "_blank");
      if (!w) location.href = t.url;
      return true;
    });
  }

  function outboxCard(name) {
    var kind = fileKind(name);
    var card = document.createElement("div");
    card.className = "ofile";
    card.innerHTML = '<span class="of-ic">' + fileGlyph(kind) + '</span>' +
      '<span class="of-tx"><span class="of-n"></span><span class="of-m"></span></span>' +
      '<button class="of-b of-open" type="button">Open</button>' +
      '<button class="of-b of-dl" type="button" aria-label="Download">' +
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M12 3.5v11"/><path d="M7.6 10.2 12 14.6l4.4-4.4"/><path d="M4.5 19.5h15"/></svg></button>';
    card.querySelector(".of-n").textContent = name;
    card.querySelector(".of-m").textContent = kind === "other" ? "File" : kind.toUpperCase();

    function wire(btn, act) {
      btn.addEventListener("click", function (e) {
        e.preventDefault();
        e.stopPropagation();
        if (btn.disabled) return;
        btn.disabled = true;
        outboxBytes(name).then(function (blob) {
          btn.disabled = false;
          act(blob);
        }).catch(function () {
          btn.disabled = false;
          card.classList.add("of-fail");
          card.querySelector(".of-m").textContent = "Can't reach this file";
        });
      });
    }
    wire(card.querySelector(".of-open"), function (blob) {
      fileHandOff(name, "inline").catch(function () { outboxOpen(name, blob); });
    });
    wire(card.querySelector(".of-dl"), function (blob) {
      fileHandOff(name, "download").catch(function () { outboxSave(name, blob); });
    });
    return card;
  }

  function outboxLinks(root) {
    if (!root || !root.ownerDocument) return;
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    var hits = [], node;
    while ((node = walker.nextNode())) {
      if (textMode && node.parentElement &&
          (node.parentElement.closest(".jr-response-text") || node.parentElement.closest(".jr-component"))) continue;
      OUTBOX_RE.lastIndex = 0;
      if (OUTBOX_RE.test(node.nodeValue || "")) hits.push(node);
    }
    hits.forEach(function (n) {
      var text = n.nodeValue || "", m, names = [], rest = "", last = 0;
      OUTBOX_RE.lastIndex = 0;
      while ((m = OUTBOX_RE.exec(text))) {
        if (m.index > last) rest += text.slice(last, m.index);
        names.push(m[1].trim());
        last = m.index + m[0].length;
      }
      rest += text.slice(last);
      // A marker alone in its paragraph becomes the card itself; anything else keeps its words and
      // takes the card after them.
      var alone = !rest.trim() && names.length === 1 && n.parentNode &&
                  /^(P|DIV|LI)$/.test(n.parentNode.tagName || "");
      var frag = document.createDocumentFragment();
      if (rest.trim()) frag.appendChild(document.createTextNode(rest.trim()));
      names.forEach(function (name) { frag.appendChild(outboxCard(name)); });
      if (alone) n.parentNode.replaceChild(frag, n);
      else if (n.parentNode) n.parentNode.replaceChild(frag, n);
    });
  }

  function paintBodyInto(el, text, structured, shape, responsePass) {
    if (!responsePass && textMode && window.JarvisOpenUI && window.JarvisOpenUI.handles(text, el)) {
      window.JarvisOpenUI.paint(el, text, function (target, prose) { paintBodyInto(target, prose, structured, shape, true); }, true);
      return;
    }
    if (!responsePass && textMode && structured && window.JarvisResponses && window.JarvisResponses.handles(text, el)) {
      window.JarvisResponses.reconcile(el, function (target) { paintBodyInto(target, text, structured, shape, true); });
      outboxLinks(el);
      return;
    }
    // The router's own decision outranks the client's guess: when it says the answer is cards, one
    // '- ' line is a card list, because he asked for options. Guessing from punctuation alone sent a
    // real answer that opened with a single option back to raw text with its markers showing.
    var routed = (shape === "cards" || shape === "table" || shape === "code");
    if (structured && (routed || hasStructure(text))) renderRich(el, text, shape);
    else {
      // Prose is still paragraphs. Setting the whole answer as one text node collapsed its blank lines
      // into single spaces, so a plain answer of three paragraphs arrived as the one unbroken block
      // this page exists to avoid. Each block becomes its own paragraph.
      el.textContent = "";
      String(text == null ? "" : text).split(/\n{2,}/).forEach(function (block) {
        var t = block.trim();
        if (!t) return;
        var p = document.createElement("p");
        p.className = "rc-p";
        inline(p, t.replace(/\n/g, " "));
        el.appendChild(p);
      });
    }
    // Every answer, whatever shape it took, may hand over files.
    outboxLinks(el);
  }
  // Read-only, for the probes: draw a body of text by the same rules the answer is drawn by, into a
  // detached node, so a shape can be checked against real text without spending a turn on it.
  // Read-only, for the probes: what the live answer looks like once it settles, after the same body was
  // drawn while it was still arriving. Must equal __jarvisDraw of the final text.
  window.__jarvisStreamed = function (partial, text, shape) {
    var el = document.createElement("div");
    streamRender(el, String(partial || ""), shape || "prose");
    settleBody(el, String(text || ""), shape || "prose");
    return el;
  };
  window.__jarvisDraw = function (text, shape) {
    var el = document.createElement("div");
    paintBodyInto(el, String(text == null ? "" : text), true, shape || "prose");
    return el;
  };
  // The turn that just finished stops being the live one: it moves into the thread above, dimmed, so
  // the answer being written is the only thing at full strength. The newest turn is always the live
  // one, which is also the one Copy, Share and Ask-again act on.
  // Work being done for a conversation on this screen, that this screen is not the one that asked for.
  // Two things say it: the words, under his prompt, and — when it finishes — the same badge a turn of his
  // own ends on, so the record reads the same either way. The badge is a control, not a decoration: tapping
  // it opens the execution steps through the page's own summary control, the same one the status bar uses.
  var bgPill = null, bgTimer = 0, bgSince = 0, lastBgSteps = [], lastBgMs = 0, bgQuiet = 0;
  // Work kept for a turn that ran while he was elsewhere, filed under the conversation it
  // belongs to. It used to be one slot for the whole page, so the summary under one
  // conversation could show the steps of a turn that ran in another.
  var bgStepsBy = {}, bgMsBy = {};

  function workingPillEl() {
    if (bgPill) return bgPill;
    if (!qEl || !qEl.parentNode) return null;
    bgPill = document.createElement("div");
    bgPill.className = "bgwork"; bgPill.setAttribute("role", "status");
    bgPill.innerHTML = '<span class="dotline" aria-hidden="true"><s></s><s></s><s></s></span>' +
                       '<span class="bgw"></span>';
    qEl.parentNode.insertBefore(bgPill, qEl.nextSibling);      // directly below the prompt
      // The indicator belongs under the question whose work it is reporting, and nowhere else. It used
      // to be inserted under whatever question the canvas happened to hold, which is how "working in the
      // background" sat under an already-answered question while a different one was running. The canvas
      // is corrected to the running question first; with no running question, no indicator is shown.
      // The pill sits under the question of the turn that is running, and that question is the one on
      // the block carrying the turn — not whatever was asked last anywhere on the page.
      var _wconv = String((liveBlock && liveBlock.dataset.conv) || turnConv || "");
      var _wblockQ = "";
      try { _wblockQ = String(((liveBlock.querySelector(".t-q") || {}).textContent) || ""); } catch (e) {}
      var wantQ = String(_wblockQ || (typeof turnQ !== "undefined" && turnQ[_wconv]) || lastQ || "").trim();
      if (!wantQ) return null;
      if (String(qEl.textContent || "").trim() !== wantQ) {
        try { qEl.textContent = wantQ; qEl.style.display = ""; } catch (e) {}
      }
    return bgPill;
  }
  function paintWorkingPill() {
    if (!bgPill || bgPill.hidden) return;
    var w = bgPill.querySelector(".bgw");
    // No counter here. A number climbing in the corner of the screen is a thing to watch, and watching it
    // is not what this line is for: it says that work is still going on, and that is all it says.
    if (w) w.textContent = "JARVIS is working in the background\u2026";
  }
  function showWorkingPill(since) {
    if (!workingPillEl()) return false;
    // Counted from when the turn actually began. With no stamp from the machine the turn's own recorded
    // moment is used, and only then the clock on this device: falling straight back to "now" is what made
    // one chat keep honest seconds while another started again from zero every time he opened it.
    var _mine = null;
    try { _mine = turnByIdentity(history(), lastQ); } catch (e) {}
    var _borne = _mine ? ((_mine.startedAt ? Number(_mine.startedAt) * 1000 : 0) ||
                          (_mine.t ? Number(_mine.t) * 1000 : 0)) : 0;
    bgSince = since || _borne || Date.now();
    bgPill.hidden = false;
    bgPill.className = "bgwork";
    body.setAttribute("data-bgwork", "1");
    paintWorkingPill();                     // once: with no counter there is nothing to refresh
    return true;
  }
  function finishWorkingPill(stepList, ms) {
    if (!bgPill || bgPill.hidden) return false;
    if (bgTimer) { clearInterval(bgTimer); bgTimer = 0; }
    var n = (stepList || []).length;
    var secs = Math.max(1, Math.round((ms || 0) / 1000));
    bgPill.className = "bgwork done";
    bgPill.setAttribute("role", "button");
    bgPill.setAttribute("tabindex", "0");
    bgPill.setAttribute("aria-label", "JARVIS worked in the background. Open the execution steps");
    bgPill.innerHTML = '<span class="bgw">\u2713 WORKED \u00b7 ' + secs + 's</span>' +
                       (n ? '<span class="bgsteps">' + n + (n === 1 ? ' step' : ' steps') + '</span>' : '');
    var open = function () { try { if (stateEl && stateEl.click) stateEl.click(); } catch (e) {} };
    bgPill.onclick = open;
    // While the pill carries the verdict the status badge stays out of it — including a beat later, when the
    // engine's own settling would otherwise print the same sentence a second time on the same screen.
    if (!bgQuiet) {
      bgQuiet = setInterval(function () {
        if (!(bgPill && bgPill.parentNode && !bgPill.hidden)) { clearInterval(bgQuiet); bgQuiet = 0; return; }
        var e = document.getElementById("state");
        var w2 = e && e.querySelector(".word"), s2 = e && e.querySelector(".secs");
        if (w2 && w2.textContent) { w2.textContent = ""; if (s2) s2.textContent = ""; }
      }, 250);
    }
    bgPill.onkeydown = function (ev) {
      if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); open(); }
    };
    body.setAttribute("data-bgwork", "2");   // done, and still the one status on this screen
    return true;
  }
  function hideWorkingPill() {
    if (bgQuiet) { clearInterval(bgQuiet); bgQuiet = 0; }
    if (bgTimer) { clearInterval(bgTimer); bgTimer = 0; }
    body.removeAttribute("data-bgwork");
    if (bgPill) {
      if (bgPill.parentNode) bgPill.parentNode.removeChild(bgPill);
      bgPill = null;
    }
  }

  // The dock belongs to the conversation on the screen. Work being done in another one is not a reason to
  // take his Send button away — a chat he is not looking at is exactly the one he leaves running — so the
  // working posture is cleared whenever the view changes, and set again only for the conversation that is
  // actually being answered.
  function unlockDock() {
    stopClock();
    setPhase("");
    setStop(false);
    // The state is part of the lock: it was left reading "thinking" by a turn in another conversation, and
    // the dock keys its stop control off it. This conversation is not the one being answered, so it is idle
    // here — its own turn, if it has one, says so through its own pill.
    try { if (window.setState) window.setState("idle"); } catch (e) {}
  }
  window.__jarvisUnlockDock = unlockDock;
  // The greeting's job ends when he starts composing, whether that is typing or a suggestion that staged
  // its opening words in the box. Left up, it sits over the thing he is about to send to.
  try { window.__jarvisHideHero = function () { try { hideEmpty(); } catch (e) {} }; } catch (e) {}
  // Whose turn this event belongs to. The dock is the status of the conversation on the screen: an event
  // for a turn running in another conversation keeps its own record and its own row, but it must not put
  // THINKING, WORKING or the stop control on this one. That is what made a new chat look as if it were
  // still answering the previous question, with a stop button for work it never started.
  function mineHere(d) {
    try {
      var c = d && d.conv ? String(d.conv) : "";
      if (!c) return true;                       // the machine names every event; an old one without a name
      var here = String(window.__jarvisConvId ? window.__jarvisConvId() : "");
      if (!here || here === "current") return true;
      return c === here;
    } catch (e) { return true; }
  }

  function showRunningQuestion(cid, q, at) {
    // The question of a turn that is still being written, standing on the canvas with its work. There are
    // two ways a working turn comes back in front of him — re-binding to it (a reload, a lost signal) and
    // returning to a conversation the engine never stopped reading — and both need this. Without it the
    // screen is a working light and a step list with his question nowhere on it, which is a page that
    // cannot say what it is working on.
    var text = (q && String(q).trim()) || "";
    if (!threadEl) return false;
    if (text) {
      // His question may already be standing there: the page draws it when he sends, and a rehydrated
      // conversation paints it from its own turns. Drawing the working placeholder on top of it is how
      // a loading chat carried the same question twice.
      // The running turn already owns this question. Checking only the last painted .t-q missed it when
      // the live block was appended after that question, and the placeholder then stood beside the turn
      // it was standing in for: the same question twice, one of them a ghost.
      try {
        if (liveBlock && String(((liveBlock.querySelector(".t-q") || {}).textContent) || "").trim() === text) return true;
      } catch (e) {}
      var qs = threadEl.querySelectorAll(".t-q");
      // Any painted question with this text means the turn is already on the canvas, whichever block
      // drew it. Comparing only the last one missed the case where the live block was appended after
      // the previous question and before this placeholder.
      for (var qi = 0; qi < qs.length; qi++) {
        if (String(qs[qi].textContent || "").trim() === text) return true;
      }
    }
    if (!text) {
      // Nothing on the page knows what this conversation was asked: a reload has no memory of the ask, and
      // the screen it was asked on is gone. The machine knows, because the question travels with the turn
      // it is answering — so the machine is asked, and the question goes up as soon as it answers. A canvas
      // left blank because the page could not remember is exactly the fault this exists to prevent.
      fetch("/api/sessions/" + encodeURIComponent(cid), { credentials: "same-origin" })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (d) {
          var asked = d && (d.turn_q || "");
          if (!asked && d && d.turns && d.turns.length) {
            asked = (d.turns[d.turns.length - 1] || {}).q || "";
          }
          if (asked) showRunningQuestion(cid, asked);
        })
        .catch(function () {});
      return false;
    }
    if (threadEl.querySelector('[data-running="1"]')) return true;       // already standing there
    var rb = document.createElement("div");
    rb.className = "turn"; rb.setAttribute("data-running", "1"); rb.setAttribute("data-conv", String(cid || ""));
    rb.dataset.t = String(Math.round(Number(at) || (Date.now() / 1000)));
    var rq = document.createElement("p"); rq.className = "t-q"; rq.textContent = text;
    rb.appendChild(rq); threadEl.appendChild(rb);
    // A question standing on the canvas is a message: its time, its copy and its edit are on it now,
    // whether it was sent from this screen a moment ago or re-attached to a turn already running.
    try { attachTurnActions(rb, text, ""); } catch (e) {}
    try { toBottom(); } catch (e) {}
    return true;
  }
  window.__jarvisShowRunningQuestion = showRunningQuestion;
  // The drawer's blank-canvas path takes the status pill down through this: a landing page with a working
  // line on it is a page saying something is running that he cannot see.
  window.__jarvisWorkingDone = hideWorkingPill;

  // ---------------------------------------------------------------- the running turn is a turn
  // Real chat apps keep one list of messages per conversation and draw the screen from that list. This
  // page had the list and also a second, separate live surface: the question being answered and the
  // answer being written lived outside the list, in elements of their own. Two surfaces for one turn is
  // why a turn could appear twice, lose its pill, wear another turn's steps, or stay dim after a switch.
  // The running turn is now a block in the thread like every other turn, and the painters write into
  // that block. If the block cannot be made, the old surface is still there underneath.
  var liveBlock = null, liveBlockQ = null, liveBlockAns = null;
  var blockByConv = {};     // which block belongs to which conversation's running turn
  var origQ = qEl, origAns = ans;

  function startLiveBlock(q) {
    if (!threadEl || !q || !String(q).trim()) return null;
    var b = document.createElement("div");
    b.className = "turn live";
    var qq = document.createElement("p");
    qq.className = "t-q"; qq.textContent = String(q).trim();
    b.appendChild(qq);
    var aa = document.createElement("div");
    aa.className = "t-a";
    b.appendChild(aa);
    // The message carries its own id, and the answer, the pill and the steps hang from it. The id is
    // derived the same way the saved turn derives its own, so the block on screen and the record on
    // the server are the same turn under the same name.
    try {
      var cid = (typeof window.__jarvisConvId === "function") ? window.__jarvisConvId() : "";
      b.dataset.id = liveTid || turnTid(cid, String(q).trim(), Math.round((t0 || Date.now()) / 1000));
      b.dataset.t = String(Math.round(Date.now() / 1000));
    } catch (e) {}
    // A placeholder drawn for this same question before the block existed is the block's shadow:
    // drop it here so the canvas never carries one question twice.
    try {
      [].slice.call(threadEl.querySelectorAll('[data-running="1"]')).forEach(function (el) {
        var pq = el.querySelector(".t-q");
        if (pq && String(pq.textContent || "").trim() === String(q || "").trim()) threadEl.removeChild(el);
      });
    } catch (e) {}
    threadEl.appendChild(b);
    // The question is a message the moment it is sent: its time, its copy and its edit are on it now,
    // not when the answer arrives. What waits for the answer is the answer's own row.
    try { attachTurnActions(b, String(q).trim(), ""); } catch (e) {}
    // A chat the machine has not named yet still gets a name here, from the question he just asked, so
    // the drawer never shows a blank row beside a properly named one while the work is still running.
    try {
      var _cid = String(window.__jarvisConvId ? window.__jarvisConvId() : "");
      if (_cid && provAll()[_cid]) {
        var _t = concTitle(String(q).trim());
        if (_t) { provPut(_cid, _t); if (window.__jarvisSessionsChanged) window.__jarvisSessionsChanged(); }
      }
    } catch (e) {}
    liveBlock = b; liveBlockQ = qq; liveBlockAns = aa;
    try { blockByConv[String(cid)] = { b: b, q: qq, a: aa }; } catch (e) {}
    qEl = qq; ans = aa;                       // every existing painter now writes into this turn
    return b;
  }

  // The work badge belongs to the block that carries the turn's id, and its numbers come from that
  // turn's own step list. Drawing it here rather than inside the finish path means a turn that ends
  // after its live surface was cleared still gets its own badge, on its own answer.
  function updateTurnVerdict(block) {
    var meta = block && block.querySelector(".t-meta");
    if (!meta) return;
    var state = block.dataset.responsePartial === "true" ? "partial" : block.dataset.openuiStatus || "worked";
    meta.textContent = meta.textContent.replace(/^(WORKED|PARTIAL|FINISHING)/, WORK_WORD[state] || "WORKED");
  }
  function paintPill(block, list, ms) {
    if (textMode && block && block.dataset.agentFailed) return;
    if (!block || block.querySelector(".t-meta")) return;
    var mine = Array.isArray(list) ? list : [];
    var n = mine.length, shown = Number(ms || 0) || 0;
    // No tools, no pill. A turn that simply answered has nothing to account for, and a badge saying
    // "answered" over a plain reply is a label that means nothing.
    if (n <= 0) return;
    var meta = document.createElement("p");
    meta.className = "t-meta";
    var bits = ["WORKED"];
    if (shown >= 1000) bits.push(Math.round(shown / 1000) + "s");
    bits.push(n + (n === 1 ? " step" : " steps"));
    meta.textContent = bits.join(" \u00b7 ");
    meta.dataset.id = block.dataset.id || "";
    meta.setAttribute("role", "button");
    meta.tabIndex = 0;
    meta.title = "Show this turn's steps";
    var openOwn = function (ev) {
      if (ev) ev.stopPropagation();
      try {
        steps = mine.slice();
        paintSteps(); paintMeta();
        if (typeof openSheetMode === "function") openSheetMode("steps");
      } catch (e) {}
    };
    meta.addEventListener("click", openOwn);
    meta.addEventListener("keydown", function (ev) {
      if (ev && (ev.key === "Enter" || ev.key === " ")) openOwn(ev);
    });
    // On top of the answer it belongs to, under the question and its controls.
    block.insertBefore(meta, block.querySelector(".t-a") || block.children[1] || null);
    updateTurnVerdict(block);
  }

  // A turn's own duration. The page-wide timer belongs to whichever turn was last on screen, so it is
  // the last resort, never the source: a turn that ran in another chat was stamped with no seconds or
  // with someone else's.
  var turnMs = {};
  function msForTurn(tid, conv) {
    var t = Number(turnMs[String(tid || "")] || 0);
    if (t) return t;
    var b = Number(bgMsBy[String(conv || "")] || 0);
    if (b) return b;
    return Number(workMs || 0) || (t0 ? Math.max(0, Date.now() - t0) : 0);
  }
  function finishLiveBlock() {
    if (!liveBlock) return;
    // The badge belongs to this block's own turn and is built from that turn's own step list, so a
    // page-wide list that has already moved on cannot decorate it with somebody else's work.
    var _ltid = String(liveBlock.dataset.id || "");
    var own = turnSteps[_ltid] || steps;
    try { paintPill(liveBlock, own, msForTurn(_ltid, liveBlock.dataset.conv || turnConv)); } catch (e) {}
    try {
      var _ownQ = String(((liveBlock.querySelector(".t-q") || {}).textContent) || lastQ || "");
      attachTurnActions(liveBlock, _ownQ, answerText);
    } catch (e) {}
    liveBlock.classList.remove("live");
    liveBlock = null; liveBlockQ = null; liveBlockAns = null;
    qEl = origQ; ans = origAns;
  }
  try { window.__jarvisStartTurnBlock = startLiveBlock; } catch (e) {}

  var retiringTid = "";
  function retireTurn() {
    if (!threadEl) return;
    // The turn that is ending, by name. Everything below is about THAT turn: its block, its steps,
    // its badge. Reading the page-wide question here was how a finished turn could decorate the one
    // before it.
    var wantId = String(retiringTid || ""); retiringTid = "";
    if (wantId) {
      var _all = threadEl.querySelectorAll(".turn"), _own = null;
      for (var _k = 0; _k < _all.length; _k++) {
        if (String(_all[_k].dataset.id || "") === wantId) { _own = _all[_k]; break; }
      }
      if (_own && liveBlock === _own) { finishLiveBlock(); return; }
      if (_own) {
        var _ta = _own.querySelector(".t-a");
        if (_ta && !String(_ta.textContent || "").trim() && answerText) {
          try { paintBodyInto(_ta, answerText, true, turnShape); } catch (e) {}
        }
        try { paintPill(_own, turnSteps[wantId] || [], msForTurn(wantId, _own.dataset.conv || "")); } catch (e) {}
        try { attachTurnActions(_own, ((_own.querySelector(".t-q") || {}).textContent) || "", answerText); } catch (e) {}
        return;
      }
    }
    // A named turn with no block on this canvas belongs to a conversation he is not looking at. There
    // is nothing here to retire, and finishing the live block would decorate this chat's answer with
    // another chat's question, badge and controls.
    if (wantId) return;
    if (liveBlock) { finishLiveBlock(); return; }   // already in the thread
    if (!lastQ && !answerText) return;
    // The placeholder that stood in for the question while a re-bound turn was running is replaced by the
    // turn itself, which carries its own question: one question, once.
    var staleRun = threadEl.querySelector('[data-running="1"]');
    if (staleRun) threadEl.removeChild(staleRun);
    // This question may already stand on the canvas under its own id: whichever path painted it, the
    // turn is the same turn. Drawing it again is how one question appeared twice, once nameless.
    try {
      var _have = threadEl.querySelectorAll(".turn");
      for (var _i = 0; _i < _have.length; _i++) {
        var _q0 = _have[_i].querySelector(".t-q");
        if (_q0 && _have[_i].dataset.id &&
            String(_q0.textContent || "").trim() === String(lastQ || "").trim()) {
          // The turn is already on the canvas; its badge may still be missing, because the live surface
          // was finished once before its steps arrived. The badge comes from the turn's own list.
          try { paintPill(_have[_i], turnSteps[String(_have[_i].dataset.id || "")] || steps, workMs); } catch (e) {}
          return;
        }
      }
    } catch (e) {}
    var block = document.createElement("div");
    block.className = "turn";
    try {
      var _c2 = (typeof window.__jarvisConvId === "function") ? window.__jarvisConvId() : "";
      block.dataset.id = liveTid || tidByConv[_c2] || turnTid(_c2, lastQ || "", Math.round((t0 || Date.now()) / 1000));
      block.dataset.t = String(Math.round((t0 || Date.now()) / 1000));
    } catch (e) {}
    if (lastQ) {
      var q = document.createElement("p");
      q.className = "t-q"; q.textContent = lastQ;
      block.appendChild(q);
      // The schema is per turn, not only for the live one: an old question is still copyable, and
      // editing it puts THAT turn's words in the composer rather than whatever was asked last. The
      // text is captured here because the closure outlives the variable it came from.
      var mine = lastQ;
      var row = document.createElement("div");
      row.className = "qacts";
      var qc = document.createElement("button");
      qc.type = "button"; qc.className = "qact";
      qc.title = "Copy"; qc.setAttribute("aria-label", "Copy this question");
      qc.innerHTML = RICON.copy;
      qc.addEventListener("click", function () { copyText(mine, "Question"); });
      var qe = document.createElement("button");
      qe.type = "button"; qe.className = "qact";
      qe.title = "Edit"; qe.setAttribute("aria-label", "Edit this question");
      qe.innerHTML = RICON.edit;
      qe.addEventListener("click", function () { editAsk(mine); });
      row.appendChild(qc); row.appendChild(qe);
      block.appendChild(row);
    }
    if (answerText) {
      var a = document.createElement("div");
      a.className = "t-a";
      paintBodyInto(a, answerText, true, turnShape);
      block.appendChild(a);
    }
    threadEl.appendChild(block);
    try {
      var _tid = String(block.dataset.id || "");
      paintPill(block, turnSteps[_tid] || steps, msForTurn(_tid, block.dataset.conv || ""));
    } catch (e) {}
    // A committed turn means the landing hero must go. syncEmpty() lives in a later IIFE and cannot be
    // reached from here, so the document is told directly at the point of the append; every later
    // syncEmpty() agrees with it because it reads this same thread. Without this the hero rendered on
    // top of a loaded conversation, and the new-chat guard then refused to reset one that was open.
    var _hero = document.getElementById("empty");
    if (_hero && !_hero.hidden) { _hero.hidden = true; document.body.classList.remove("empty-screen"); }
    // The thread is bounded on the page; the record behind it is on disk and in the history list, and
    // a live DOM that grows without limit is a page that gets slower every day it is used.
    while (threadEl.children.length > 40) threadEl.removeChild(threadEl.firstChild);
    // Whatever painted the turn, a turn on screen carries its own controls.
    try {
      [].slice.call(threadEl.querySelectorAll('.turn')).forEach(function (b) {
        var _q = b.querySelector('.t-q'), _a = b.querySelector('.t-a');
        attachTurnActions(b, _q ? _q.textContent : '', _a ? _a.textContent : '');
      });
    } catch (e) {}

    lastQ = ""; answerText = "";
    if (ans) ans.textContent = "";
    if (qEl) { qEl.textContent = ""; qEl.style.display = "none"; }
  }

  // ---------------------------------------------------------------- history
  // The last 30 turns, newest first, each with the token of the visual that went with it. Kept in
  // localStorage: this is the conversation on the device, not a record on the server, and clearing
  // it is a button rather than a support request.
  // Which conversation this list belongs to. One list for every conversation was the reason a reload
  // painted the previous chat's turns as the current thread, and the reason a question asked a second
  // time stood beside the first: the device's history was the machine's window, not a conversation.
  function convNow() {
    var cid = "";
    try { cid = String(window.__jarvisConvId ? window.__jarvisConvId() : ""); } catch (e) {}
    return (cid && cid !== "current") ? cid : "";
  }
  function hkey() {
    var cid = convNow();
    return cid ? (HKEY + "." + cid) : HKEY;
  }
  function history() {
    // With no conversation adopted yet the canvas is nobody's thread, so it paints nothing: at load the
    // conversations wait in Recents and a running turn draws itself. Anything else put another chat's
    // turns at the top of this one, and made the next question join them.
    if (!convNow()) return [];
    try {
      var v = JSON.parse(localStorage.getItem(hkey()) || "[]");
      return Array.isArray(v) ? canonList(v) : [];
    } catch (e) { return []; }
  }
  // How much of the transcript this screen keeps is the one "context depth" control that is honestly
  // this page's to give: it governs the record this screen holds, not the agent's own window, which
  // belongs to the process that owns it. 0 means keep everything already stored. The list is newest
  // first, so the cap takes the head.
  function transcriptCap(){
    try {
      var v = JSON.parse(localStorage.getItem("jarvis.v1.ui.transcript_turns"));
      if (v === 0) return 1e9;
      if (typeof v === "number" && v > 0) return v;
    } catch (e) {}
    return HMAX;
  }
  function trimTranscript(){
    try {
      var list = JSON.parse(localStorage.getItem(hkey()) || "[]");
      if (list && list.length) saveHistory(list);
    } catch (e) {}
  }

  // One turn, one entry. The record on the device used to accept whatever it was handed, so the same
  // question could sit there twice: once as the bubble being answered and once as the answer. A saved
  // turn and a pending one are the same turn, and the answer is the copy worth keeping. Order is the
  // record's own contract — newest first — and is enforced here rather than trusted from callers.
  function canonList(list) {
    var seen = {}, out = [];
    (Array.isArray(list) ? list : []).forEach(function (h) {
      if (!h || typeof h !== "object") return;
      // A turn is identified by its number; when copies disagree about having one, the question plus
      // the turn's own start time still identifies it, so the numbered and unnumbered copies of one
      // turn collapse instead of standing beside each other.
      var hStart = Math.round(h.startedAt || 0);
      var k = hStart ? (String(h.q || "") + "|" + hStart)
                     : (String(h.tid || "") || (String(h.q || "") + "|" + String(h.t || 0)));
      var prev = seen[k];
      if (!prev) { seen[k] = h; out.push(h); return; }
      // Which copy of the same turn is the real one: the numbered copy, because that is the one the
      // machine can join to; then the copy that carries the answer; then the later of two answered
      // copies, which is the one written last.
      var winner;
      if (!!String(h.tid || "") !== !!String(prev.tid || "")) winner = String(h.tid || "") ? h : prev;
      else if (h.a && !prev.a) winner = h;
      else if (prev.a && !h.a) winner = prev;
      else winner = (Number(h.t || 0) || 0) > (Number(prev.t || 0) || 0) ? h : prev;
      var loser = winner === h ? prev : h;
      var wt = Number(winner.t || 0) || 0, lt = Number(loser.t || 0) || 0;
      if (wt && lt) winner.t = Math.min(wt, lt);
      var at = out.indexOf(loser);
      if (at >= 0) out[at] = winner;
      seen[k] = winner;
    });
    // Newest first by the turn's own start time, never by the order it happened to be written.
    out.sort(function (a, b) { return (Number(b.t || 0) || 0) - (Number(a.t || 0) || 0); });
    return out;
  }
  // A turn is found by its own number first, and by its question only when no number exists. Two
  // intentional identical questions are two turns; only the newest of them is the one just asked.
  // Work belonging to a turn is only ever shown to the conversation that turn was asked in. A turn with
  // no known conversation gets nothing rather than a guess; a turn from another conversation gets nothing
  // at all, because borrowing across conversations is what put one chat's steps under another's answer.
  function bgStepsFor(conv) {
    var c = String(conv || ""), here = "";
    try { here = String(window.__jarvisConvId ? window.__jarvisConvId() : ""); } catch (e) {}
    if (!c) return [];
    if (here && here !== "current" && c !== here) return [];
    return (bgStepsBy[c] || []).slice();
  }
  try { window.__jarvisBgStepsFor = bgStepsFor; } catch (e) {}
  function turnByIdentity(list, q) {
    var tid = "";
    try { tid = String(turnServerId || ""); } catch (e) {}
    var arr = Array.isArray(list) ? list : [];
    var i;
    if (tid) { for (i = 0; i < arr.length; i++) { if (String(arr[i].tid || "") === tid) return arr[i]; } }
    for (i = 0; i < arr.length; i++) { if (q && arr[i].q === q) return arr[i]; }   // legacy records
    return null;
  }
  try { window.__jarvisTurnByIdentity = turnByIdentity; } catch (e) {}
  try { window.__jarvisCanonList = canonList; } catch (e) {}
  function saveHistory(list) {
    try { localStorage.setItem(hkey(), window.__jarvisRedact(JSON.stringify(canonList(list).slice(0, transcriptCap())))); }
    catch (e) {}
  }
  function resetAt() {
    try { return Number(localStorage.getItem(RKEY) || 0) || 0; } catch (e) { return 0; }
  }
  function markReset() {
    try { localStorage.setItem(RKEY, String(Date.now())); } catch (e) {}
  }
  // ---------------------------------------------------------------- the session store, on the device
  // The machine keeps the record; this is the copy that survives a cleared browser, a lost network
  // and a reload, and it is the one that carries the work trace: what the page showed him while the
  // answer was being written belongs to the turn, not to the moment it was rendered. One object per
  // conversation, keyed by the same id the machine uses, so the two can never disagree about which
  // conversation is which. Written before the request is made, because it is the copy that answers
  // "is this thread safe" with no network in the way.
  window.__jarvisRedact = function (text) {
    if (!text) return text || "";
    var mask = function (v) {
      if (!v) return v;
      return v.length < 24 ? (v.length >= 8 ? v.slice(0, 2) + "…" : "***") : v.slice(0, 4) + "…" + v.slice(-4);
    };
    var out = String(text);
    out = out.replace(/\b(sk-[A-Za-z0-9_\-]{12,})\b/g, function (m) { return mask(m); });
    out = out.replace(/\b(AIza[0-9A-Za-z_\-]{20,})\b/g, function (m) { return mask(m); });
    out = out.replace(/\b(gh[pousr]_[A-Za-z0-9]{20,})\b/g, function (m) { return mask(m); });
    out = out.replace(/\b([0-9]{8,10}:AA[0-9A-Za-z_\-]{20,})\b/g, function (m) { return mask(m); });
    return out;
  };

  var SKEY2 = "jarvis.v1.sessionstore";
  var SESS_MAX = 12;                      // conversations kept on the device, newest first

  function devStore() {
    try {
      var v = JSON.parse(localStorage.getItem(SKEY2) || "{}");
      return (v && typeof v === "object") ? v : {};
    } catch (e) { return {}; }
  }
  function devAll() {
    var v = devStore();
    return Object.keys(v).map(function (k) { return v[k]; })
      .filter(function (s) { return s && s.id && (s.turns || []).length; })   // see devPut: nothing empty
      .sort(function (a, b) { return (b.updated || 0) - (a.updated || 0); });
  }
  function devGet(id) {
    var v = devStore();
    return v[String(id)] || null;
  }
  function devStoreSave(all) {
    // Only ever called with a map that is at least as full as what is already held.
    try {
      var cur = devStore();
      if (Object.keys(cur).length && !Object.keys(all || {}).length) return false;
      localStorage.setItem(SKEY2, JSON.stringify(all || {}));
      return true;
    } catch (e) { return false; }
  }
  function devPut(sess) {
    if (!sess || !sess.id) return false;
    // A conversation with nothing in it is not a conversation, and kept it becomes a second heading for a
    // chat that already has one: the twin he could neither open (nothing to read) nor name. What this
    // store holds is turns; a record that holds none is noise however it got here.
    if (!(sess.turns || []).length) return false;
    try {
      var v = devStore();
      // The guard: this store is only ever added to. A sync that fails, a read that comes back empty, a
      // reconnect that has not finished — none of them may take his conversations off the device. Writing an
      // empty record over a loaded store is how a chat history gets wiped by the network, and it is the one
      // mistake here that cannot be undone from the machine.
      if (!(sess.turns || []).length && Object.keys(v).length) return false;
      try {
        (sess.turns || []).forEach(function (x) {
          if (x && typeof x.a === "string") x.a = window.__jarvisRedact(x.a);
          if (x && typeof x.q === "string") x.q = window.__jarvisRedact(x.q);
        });
      } catch (e) {}
      v[String(sess.id)] = sess;
      Object.keys(v).sort(function (a, b) { return (v[b].updated || 0) - (v[a].updated || 0); })
            .slice(SESS_MAX).forEach(function (k) { delete v[k]; });
      localStorage.setItem(SKEY2, JSON.stringify(v));
      return true;
    } catch (e) { return false; }        // a full disk is a real answer, and it is reported upward
  }
  function devDrop(id) {
    try {
      var v = devStore();
      if (v[String(id)]) { delete v[String(id)]; localStorage.setItem(SKEY2, JSON.stringify(v)); }
    } catch (e) {}
  }
  // Published for the same reason as the loading-state helpers: the part of the page that learns a
  // chat was deleted lives in another closure, and a cross-closure call is a ReferenceError.
  window.__jarvisDevDrop = devDrop;
  function devWipe() { try { localStorage.removeItem(SKEY2); } catch (e) {} }

  // The device keeps its own copy of the conversations, so a phone that was not open when the history
  // was emptied would go on listing what the machine no longer has. Only an explicit purge stamp clears
  // that copy: an empty list, a failed read or a lost socket never does, because a conversation the
  // machine has not got may be the only copy of it left.
  var PURGEKEY = "jarvis.v1.purged";
  function deviceCopyKeys() {
    var kill = [];
    try {
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i) || "";
        if (k === SKEY2 || k === "jarvis.v1.panelcache" || k === HKEY || k.indexOf(HKEY + ".") === 0) kill.push(k);
      }
    } catch (e) {}
    return kill;
  }
  function clearDeviceCopies() {
    deviceCopyKeys().forEach(function (k) { try { localStorage.removeItem(k); } catch (e) {} });
    return deviceCopyKeys().length === 0;
  }
  function applyPurge(j) {
    var stamp = Number((j && j.purged) || 0) || 0;
    if (!stamp) return false;
    var mine = 0;
    try { mine = Number(localStorage.getItem(PURGEKEY) || 0) || 0; } catch (e) {}
    if (stamp <= mine) return false;
    // The copy goes first and the stamp second: a stamp written over a copy that survived a failure would
    // leave the stale list on screen for good.
    if (!clearDeviceCopies()) return false;
    try { localStorage.setItem(PURGEKEY, String(stamp)); } catch (e) {}
    try { window.__jarvisSessionsChanged && window.__jarvisSessionsChanged(); } catch (e) {}
    return true;
  }
  window.__jarvisApplyPurge = applyPurge;

  // The work trace as it is worth keeping: the words on the rows, not the raw call and its output,
  // which nothing on this surface can open any more. Eighty rows, two hundred characters each, so a
  // conversation that read forty files is still a conversation object and not a file.
  function leanSteps(list) {
    if (!Array.isArray(list)) return [];
    return list.slice(-80).map(function (d) {
      if (!d || typeof d !== "object") return null;
      var o = { kind: String(d.kind || "tool").slice(0, 24) };
      if (d.kind === "note") {
        o.text = String(d.text || "").slice(0, 200);
        if (!o.text) return null;
      } else {
        o.title = String(d.title || "").slice(0, 200);
        o.tool = String(d.tool || "").slice(0, 40);
        if (!o.title && !o.tool) return null;
        o.ok = d.ok !== false;
        if (typeof d.ms === "number") o.ms = Math.round(d.ms);
        if (Array.isArray(d.kids) && d.kids.length) {
          o.kids = d.kids.slice(0, 3).map(function (k) { return String(k || "").slice(0, 200); });
        }
      }
      return o;
    }).filter(function (d) { return !!d; });
  }

  // This window's turns, oldest first, exactly as they are stored: the question, the answer, when it
  // finished, the trace that was on screen while it was being written, and the visual it carried.
  function turnRecords() {
    var cut = resetAt();
    return history().filter(function (h) { return !cut || (h.t || 0) > cut; })
      .slice().reverse().map(function (h) {                            // oldest first, the way it reads
        var rec = { q: String(h.q || ""), a: String(h.a || ""), t: Math.round((h.t || 0) / 1000) };
        var s = leanSteps(h.s);
        if (s.length) rec.s = s;
        if (h.w) rec.w = String(h.w).slice(0, 400);
        return rec;
      });
  }

  // The conversation as an object: an id, a name, when it started, when it last moved, and its turns.
  // Returns null for a canvas with nothing on it, which is what makes a blank chat not a session.
  // `id` here is whatever the caller knows: the live window's id lives in the drawer's own closure
  // (`sessionId`) and this file's outer half cannot see it, so callers that know it pass it in.
  function sessionObject(id, title) {
    var turns = turnRecords();
    if (!turns.length && !title) return null;
    var first = turns[0] || {};
    var now = Math.round(Date.now() / 1000);
    return {
      id: String(id || activeId || "current"),
      title: String(title || concTitle(first.q) || "New conversation").slice(0, 80),
      started: first.t || now,
      updated: (turns.length ? turns[turns.length - 1].t : now),
      turns: turns
    };
  }

  function keepTurn() {
    if (!answerText) return;
    var list = history(), head = list[0];
    var savedSteps = steps.concat(pendingNote ? [{ kind: "note", text: pendingNote }] : []);
    // The same turn seen twice (a repaint, a reload) is not a second turn.
    if (regenerateHistoryIndex < 0 && head && head.q === lastQ && head.a === answerText) {
      head.t = Date.now(); head.s = savedSteps; saveHistory(list); return;
    }
    var saved = { q: lastQ, a: answerText, t: Date.now(), w: lastWidget || null, s: savedSteps };
    if (regenerateHistoryIndex >= 0) list.splice(regenerateHistoryIndex, 0, saved);
    else list.unshift(saved);
    regenerateHistoryIndex = -1;
    saveHistory(list);
    // No whole-thread save here: this list spans conversations, and posting it as one conversation is what
    // put turns in the wrong place and gave one chat two headings. The conversation copy is written by the
    // turn's own save, by name.
    indexCode(lastQ, answerText);
  }

  // The code an answer carried, indexed on the machine. The drawer's Saved Artifacts reads that index,
  // so a snippet he was handed an hour ago is still one tap away after the conversation has scrolled
  // past it and after this device has forgotten the turn. Fire and forget: the answer is already on
  // his screen, and a lost index entry is not a lost answer. The cheap test first, because most
  // answers carry no code at all and there is no reason to post them.
  function indexCode(question, answer) {
    var text = String(answer || "");
    if (text.indexOf("```") < 0 && text.indexOf("{") < 0 && text.indexOf("[") < 0) return;
    try {
      fetch("/api/artifacts/code", {
        method: "POST", credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: text, title: String(question || "").slice(0, 80) })
      }).catch(function () {});
    } catch (e) {}
  }

  // The page's own copy of the conversation, pushed to the machine. One request per finished turn:
  // cheap, and it is what makes a conversation survive a cleared browser, a reload, or a lost phone.
  // It sends only this window's turns, so a conversation that was reset is not silently re-merged
  // into the new one.
  function saveConversation(sess) {
    var s = sess || sessionObject(activeId, null);
    var stored = !!(s && s.turns.length) && devPut(s);
    try {
      var turns = (s && s.turns) || [];
      if (!turns.length) return stored;
      fetch("/api/sessions", {
        method: "POST", credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ turns: turns })
      }).then(function (r) {
        return r.ok ? r.json() : null;
      }).then(function () {
        // The drawer hears about it the moment the machine has it, so a conversation that was just
        // written is in Recents without a reload and without reopening the drawer. The id the machine
        // answers with is not written back here: the live window's id belongs to the drawer's own
        // closure, and it learns it from POST /reset and from the list.
        if (typeof window.__jarvisSessionsChanged === "function") window.__jarvisSessionsChanged();
      }).catch(function () {});                                       // a lost copy is not a lost turn
    } catch (e) {}
    return stored;
  }
  function remember() { keepTurn(); }

  // One finished turn, handed over by whichever half of the page finished it. The drawer keeps its own
  // record of the turn it just drew, and the half that owns the store had none of it: it read its own
  // copies of the question and the answer, which the drawer never wrote, so every ordinary turn was
  // dropped on the way to the device copy and to the machine. The turn is passed across instead.
  window.__jarvisKeepTurn = function (q, a, stepsArr) {
    if (q) lastQ = String(q);
    answerText = String(a || "");
    steps = Array.isArray(stepsArr) ? stepsArr : [];
    keepTurn();
  };

  function recall() {
    // Reset starts a new conversation, so a turn from before it is not part of this one. Without
    // the stamp, reset and then a reload brought the old answer straight back: the turn was still
    // in history, and history is what the page paints on the way up.
    var cut = resetAt();
    var list = canonList(history()).filter(function (h) { return !cut || (h.t || 0) > cut; });
    if (list.length) {
      // The conversation, not just its newest turn. Painting only list[0] left the earlier turns off
      // the canvas until a full history load put them back, which is what made a finished answer
      // appear to vanish and then return. Older turns go through the same painter the machine's own
      // history uses; the newest still takes the live surface below it.
      var painted = false;
      try {
        var asTurns = list.slice().reverse().map(function (h) {
          return { q: h.q, a: h.a, t: (h.t || 0) / 1000, id: h.tid || null, s: h.s, ms: h.ms };
        });
        if (typeof rehydrate === "function") { rehydrate(asTurns, ""); painted = true; }
      } catch (e) { /* the single turn below still paints */ }
      lastQ = list[0].q || ""; answerText = list[0].a || "";
      steps = Array.isArray(list[0].s) ? list[0].s : [];
      t0 = list[0].t || Date.now(); setPhase("worked");
      answerSettled = true;
      if (!painted) paintAnswer();
    }
    else {
      try {
        var d = JSON.parse(localStorage.getItem(KEY) || "null");        // a turn kept by an older build
        if (d && d.a) { lastQ = d.q || ""; answerText = d.a; answerSettled = true; paintAnswer(); }
      } catch (e) { /* nothing kept, or nothing readable */ }
    }
  }

  // ---------------------------------------------------------------- the content scroller
  // Auto-scroll only when the reader is already at the bottom, so a manual scroll is never fought.
  var atBottom = true;
  var pinTop = false;                   // a new turn is pinned to the top until it outgrows the view
  // Nothing moves this canvas until a turn does. A restored answer is left where it is painted:
  // opening the page is not a reason to move his reading position, and a live turn is the one
  // thing that is. Before this, every path that wrote an answer could scroll the canvas under him.
  var following = false;
  // A tap on the way back down is one motion, not a scroll he is making: while it travels, the
  // button stays gone instead of flickering back at the halfway point and inviting a second tap.
  var jumping = false;
  function checkBottom() {
    atBottom = content.scrollTop + content.clientHeight >= content.scrollHeight - 28;
    if (atBottom) jumping = false;
    syncToBottom();
  }
  // A live turn is the only thing that follows the words. When it ends the page stops moving of its
  // own accord: leaving this set was what welded the canvas to the turn's own head after an answer,
  // so a drag was undone by the next paint and only a reload put the scroll back.
  function endFollow() {
    following = false;
    pinTop = false;
  }
  // The canvas scrolls unless a modal is genuinely up. A lock that outlived its modal — closed while
  // its exit was still animating, or closed by a path that never released — left the canvas frozen
  // until a reload, so every turn boundary asks whether anything modal is really open and hands the
  // scroll back when nothing is.
  function canvasReleased() {
    var open = false;
    ["sheet", "confirm", "attach"].forEach(function (id) {
      var el = document.getElementById(id);
      if (el && !el.hidden) open = true;
    });
    if (open) return false;
    scrollLocks = 0;                          // the count only ever guarded the canvas it just freed
    var c = document.getElementById("content");
    if (c) c.style.overflow = "";
    document.body.classList.remove("modal-open");
    return true;
  }
  // A hand on the canvas ends the follow for that turn: while the words arrive the page keeps the
  // foot in view, but the moment he scrolls, his position wins and stays won. Only a real gesture
  // counts, so a resize or a font that reflows the canvas is never mistaken for a decision.
  content.addEventListener("touchstart", endFollow, { passive: true });
  content.addEventListener("wheel", endFollow, { passive: true });
  content.addEventListener("keydown", endFollow);
  // The way back to the foot of the answer, offered only when there is somewhere to go back to.
  // 64px rather than the 28px that counts as "at the bottom": a nudge of scroll is not a scroll.
  function syncToBottom() {
    if (!toBottomBtn) return;
    var more = content.scrollHeight - content.scrollTop - content.clientHeight;
    toBottomBtn.hidden = atBottom || jumping || more < 64;
  }
  function toBottom() {
    if (!following) return;
    // While a turn is pinned to the top of the canvas the view stays where it was put, and it only
    // starts following once the words have run past the bottom edge: a short answer never scrolls
    // and a long one never leaves the reader behind.
    if (pinTop) {
      if (liveBottom() <= content.scrollTop + content.clientHeight - 8) {
        // The answer still fits below the turn's own heading, so the heading is what stays put and
        // the words fill the room under it. This is the whole point of pinning: his question holds
        // its place on the screen while the answer is written into it.
        var want = turnTop();
        if (want != null) content.scrollTop = Math.max(0, Math.min(want - 10, content.scrollHeight - content.clientHeight));
        return;
      }
      pinTop = false;
      atBottom = true;
    }
    if (atBottom) content.scrollTop = content.scrollHeight;
  }

  // Where an element sits inside the scrolling canvas, and how far down the live block reaches.
  function contentTopOf(el) {
    if (!el || !content) return null;
    var r = el.getBoundingClientRect(), c = content.getBoundingClientRect();
    return content.scrollTop + (r.top - c.top);
  }
  function turnTop() {
    return contentTopOf((qEl && qEl.style.display !== "none" && qEl.textContent) ? qEl : (threadEl && threadEl.lastChild) || qEl);
  }
  function liveBottom() {
    var el = speakEl || ans || content;
    var r = el.getBoundingClientRect(), c = content.getBoundingClientRect();
    return content.scrollTop + (r.bottom - c.top);
  }
  // A new turn opens at the top of the canvas rather than at the bottom of the last one: what he
  // just asked and what is being written about it are the same block of screen, and it starts where
  // his eye already is. Smooth, because it is a move he did not ask for and should not be a jump.
  function alignTurnToTop(smooth) {
    var anchor = (qEl && qEl.textContent && qEl.style.display !== "none") ? qEl : (threadEl && threadEl.lastChild) || qEl;
    var top = contentTopOf(anchor);
    if (top == null) return;
    pinTop = true;
    top = Math.max(0, top - 10);           // a breath above the turn, so it is not flush to the edge
    try { content.scrollTo({ top: top, behavior: smooth === false ? "auto" : "smooth" }); }
    catch (e) { content.scrollTop = top; }
  }
  content.addEventListener("scroll", checkBottom, { passive: true });
  window.addEventListener("resize", function () { setTimeout(checkBottom, 0); });
  // Scrolling is not the only thing that changes how far the foot is: an answer that arrives while
  // he is looking elsewhere, an artifact that lands, a font that finishes loading and reflows the
  // canvas all move it without a scroll event. The canvas itself is the signal, so watch it and
  // re-ask, rather than waiting for a gesture that may never come.
  if (window.ResizeObserver) {
    try { new ResizeObserver(function () { checkBottom(); }).observe($("view") || content); } catch (e) {}
  }
  // Back to the latest. One smooth travel rather than a jump, because it is a move across a screen
  // he is already reading, and the flag keeps the button from reappearing mid-flight.
  if (toBottomBtn) toBottomBtn.addEventListener("click", function () {
    pinTop = false;
    jumping = true;
    syncToBottom();
    try { content.scrollTo({ top: content.scrollHeight, behavior: "smooth" }); }
    catch (e) { content.scrollTop = content.scrollHeight; }
    // The travel itself clears the flag, in checkBottom, once the canvas is back at the foot. The
    // timer is the backstop for a canvas that grew while it was travelling and never quite arrived.
    setTimeout(function () { jumping = false; checkBottom(); }, 700);
  });

  // The keyboard inset (L2). Chrome resizes the content viewport for the keyboard, but iOS leaves
  // the layout viewport alone and shrinks only the visual viewport, so the bar has to be lifted by
  // hand. When the browser has already resized, the difference is zero and this does nothing.
  function kbInset() {
    var vv = window.visualViewport;
    if (!vv) return;
    var inset = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
    document.documentElement.style.setProperty("--kb", Math.round(inset) + "px");
  }
  if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", kbInset);
    window.visualViewport.addEventListener("scroll", kbInset);
  }
  kbInset();

  // ---------------------------------------------------------------- the work, one line
  function secs() { return Math.max(0, (Date.now() - t0) / 1000); }
  // The seconds of a turn that has finished, in milliseconds, frozen where the turn ended. A live count
  // recomputed on every repaint is what let a chat that took 42.5s read 63s a minute later.
  function workSeconds() { return workMs ? Math.round(workMs / 1000) : Math.round(secs()); }

  // The pill at the foot of the page is the one place that says what is happening, and the way into
  // the Summary in every state. It follows the turn's own telemetry rather than a stopwatch: waiting
  // on the model is THINKING, anything the agent actually runs is WORKING, and the two alternate as
  // many times as the job needs, because that is what a multi-step turn is. Only a turn that has
  // finished says WORKED, with its total. A clock that only counts up cannot tell those apart, and
  // that is what it looked like from his side.
  var workPhase = "";                       // "" | thinking | working | worked
  var WORK_WORD = { thinking: "THINKING", working: "WORKING", worked: "WORKED", partial: "PARTIAL", pending: "FINISHING" };
  // A turn that delivered a calculation but not the control it asked for is neither a clean
  // success nor a failure. The server says so before the words arrive, and the badge says it too,
  // because a WORKED pill over an answer with no input in it claims an interaction that never
  // happened.
  window.addEventListener("jarvis:openui-status", function (event) {
    var block = Array.from(document.querySelectorAll(".turn")).find(function (b) {
      return String(b.dataset.id) === String(event.detail && event.detail.turn);
    });
    updateTurnVerdict(block);
    if (liveBlock && String(liveBlock.dataset.id) === String(event.detail && event.detail.turn)) {
      turnUIStatus = event.detail.status || "";
      if (answerSettled) setPhase(turnPartial ? "partial" : turnUIStatus || "worked");
    }
  });
  var turnPartial = false;
  var turnUIStatus = "";

  function setPhase(p) {
    if (!p) workMs = 0;                       // a cleared phase is the end of that turn's number
    workPhase = p || "";
    paintState(body.getAttribute("data-state") || "idle");
  }

  function startClock() {
    stopClock();
    workMs = 0;
    turnPartial = false;                      // an old settlement never paints a new turn
    turnUIStatus = "";
    setPhase("thinking");                    // the turn is open and nothing has run yet
    // No clock: the pill is repainted when the phase changes, not four times a second to move a number
    // that is no longer there. The turn's duration is written once, when it ends.
  }
  function stopClock() { if (tick) { clearInterval(tick); tick = null; } }

  function paintMeta() {
    var n = toolCount();
    if (!n) { metaBtn.hidden = true; metaBtn.textContent = ""; return; }
    // The count stays as context and nothing more. It is not a control: the way into the Summary is
    // the pill, in every state, so that one thing on the page means one thing.
    metaBtn.hidden = false;
    metaBtn.textContent = n + (n === 1 ? " step" : " steps");
  }

  function settle() {
    stopClock();
    paintMeta();
    // Frozen once, here, at the moment the turn ends.
    if (!workMs) workMs = Math.max(1000, Date.now() - t0);
    // The turn is over, so the badge says so — whether it ran tools or answered straight out. Clearing
    // the phase when no tool had run is why a code answer, a JSON answer and a plain reply carried no
    // status at all: the turn had happened and the page said nothing about it. The step count beside
    // the badge is what says whether anything ran.
    var word = turnPartial ? "partial" : turnUIStatus || "worked";
    setPhase(word);
  }

  // ---------------------------------------------------------------- the Summary timeline
  // One step per real tool call, in the order they ran, with what the agent was working out
  // between them. Consecutive steps carrying the same title are one step that ran n times: eight
  // chips reading the same thing is not a record, it is noise, and it was the complaint that
  // started this. The fold lives here, once, so the header count and the list cannot disagree.
  // The name a step is folded and read by. Stored steps carry {label}, live ones {title}, and the fold
  // below once compared only title||tool - so a reopened trace never folded and the summary filled with
  // the same line repeated ("Opened the page in a browser" four times, "Ran echo" eleven).
  function stepNameOf(d) {
    var o = d || {};
    return String(o.title || o.label || o.tool_name || o.name || o.slug || o.tool || "").trim();
  }
  // What a row will actually say, and whether its first detail line has been lifted into the label.
  // A step whose name reads like a command is masked to a generic phrase, which is why a turn of shell
  // work printed the same words five times while the detail underneath each one said something specific
  // and different — "the page at www.cloudflare.com", "the scratch folder". The detail is the intelligent
  // half, so it becomes the label and stops being repeated beneath it. Nothing is invented: the phrase is
  // the one the step already carries.
  // One verb per kind of thing, so a row reads as somebody describing the work. It fires only on
  // shapes it actually knows - a folder, a page, a file, a query, a service - because a rewrite rule
  // broad enough to touch any label is a rule that will eventually say something untrue.
  function sayWithVerb(text) {
    var t = String(text || "").trim();
    if (!t) return t;
    if (/\bquery\s*$/i.test(t)) {
      var q = t.replace(/\s+query\s*$/i, "").replace(/\bfor the\b/i, "for").replace(/^(?:searched for|searched)\s+the\s+/i, "Searched for ")
               .replace(/^the\s+/i, "Searched for ").trim();
      return /^searched/i.test(q) ? q : "Searched for " + q;
    }
    // Only a bare noun phrase gets a verb. "the scratch folder" is one; "Applied to the running page"
    // is a sentence that happens to contain the word page, and prefixing it would say something false.
    if (!/^the\s+/i.test(t)) return t;
    if (/\bfolder\b/i.test(t)) return "Went through " + t;
    if (/\bpage\b/i.test(t)) return "Read " + t;
    if (/\bfile\b/i.test(t)) return "Read " + t;
    if (/\bservice\b/i.test(t)) return "Checked " + t;
    return t;
  }

  function rowWords(d) {
    var raw = String((d && (d.title || d.label)) || "").trim();
    var label = stepLabel(d);
    var kids = (d && d.kids) || [];
    var masked = !raw || label !== raw;
    if (masked && kids.length) {
      var lifted = safeStepText(String(kids[0] || ""), d.tool);
      // A bare noun is not a sentence. The detail says "the scratch folder"; the row should say
      // "Went through the scratch folder". The verb follows the noun, so it is right for a folder,
      // a page, a file and a query alike, and a detail that is already a sentence is left alone.
      if (lifted) return { label: sayWithVerb(lifted), children: kids.slice(1) };
    }
    // When the label already carries the detail, printing that detail again underneath says the same
    // thing twice: "Wrote the phone_compare.json file" over "the phone_compare.json file". The row keeps
    // only the children that add something, and a child the label already contains is dropped.
    var shown = sayWithVerb(label);
    var norm = function (s) {
      return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
    };
    var rest = kids.filter(function (k, i) {
      var t = norm(k);
      return !(i === 0 && t && norm(shown).indexOf(t) >= 0);
    });
    return { label: shown, children: rest };
  }

  // Every step gets its own line, always. This folded runs of steps that read the same, which hid
  // real work behind a count: four different visits to one folder became a single row. The lines were
  // never the problem - the generic labels were, and those now say what the step actually did. The
  // panel scrolls and sticks to the bottom, so a long turn reads as a list of what happened.
  function shownSteps() {
    return (steps || []).map(function (d) {
      var copy = {};
      for (var k in d) if (Object.prototype.hasOwnProperty.call(d, k)) copy[k] = d[k];
      return copy;
    });
  }

  function toolCount() {
    return shownSteps().filter(function (d) { return d.kind !== "note"; }).length;
  }

  var STEP_ICONS = {
    term:   '<svg viewBox="0 0 24 24"><path d="M5 8l4 4-4 4"/><path d="M12 17h7"/></svg>',
    web:    '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8"/><path d="M4 12h16M12 4c2.6 2.4 2.6 13.6 0 16M12 4c-2.6 2.4-2.6 13.6 0 16"/></svg>',
    file:   '<svg viewBox="0 0 24 24"><path d="M7 4h7l4 4v12H7z"/><path d="M14 4v4h4"/></svg>',
    screen: '<svg viewBox="0 0 24 24"><rect x="4" y="5" width="16" height="11" rx="2"/><path d="M9 20h6M12 16v4"/></svg>'
  };
  function iconFor(tool) {
    tool = String(tool || "").toLowerCase();
    if (/web|search|fetch|browse|http/.test(tool)) return STEP_ICONS.web;
    if (/screen|show|panel|widget|artifact/.test(tool)) return STEP_ICONS.screen;
    if (/read|write|edit|file|view|open|patch/.test(tool)) return STEP_ICONS.file;
    return STEP_ICONS.term;
  }

  // A step's own label. The note he read out loud gives it the sentence; failing that the tool
  // names what it did, and a tool name is machine spelling, so it is never printed raw.
  function plainTool(tool) {
    var t = String(tool || "").toLowerCase().trim();
    if (!t) return "";
    if (/^(bash|shell|terminal|exec|run|command|process)$/.test(t)) return "Used Terminal";
    if (/web|search|fetch|browse|http|url|page/.test(t)) return "Searched the web";
    if (/mail|email|inbox|imap|smtp|himalaya/.test(t)) return "Used email";
    if (/deliver|send|whatsapp|telegram|message|sms/.test(t)) return "Sent a message";
    if (/screen|camera|vision|computer|desktop/.test(t)) return "Looked at the screen";
    if (/memory|remember|persona|user/.test(t)) return "Checked its memory";
    if (/cron|schedul|timer|remind|alarm/.test(t)) return "Set a schedule";
    if (/delegate|subagent|agent|spawn/.test(t)) return "Ran a helper";
    if (/read|cat|open|inspect|list|glob|grep|search_file/.test(t)) return "Read a file";
    if (/write|edit|patch|create|save|append|move|copy/.test(t)) return "Changed a file";
    if (/\bimage|photo|video|audio|voice|tts|speech/.test(t)) return "Made a file";
    // Nothing matches: the name in words rather than the machine's spelling of it. A tool name is
    // not a command, and safeStepText still replaces this if it ever reads like one.
    return "Used the " + t.replace(/[_-]+/g, " ") + " tool";
  }
  function commandLikeStep(text) {
    var s = String(text || "").trim();
    return /(^|\s)terminal\s*:/i.test(s) || /(^|\s)(?:sudo|echo|cd|ls|cat|grep|rg|find|curl|wget|python3?|node|npm|git|bash|sh)(?:\s|$)/i.test(s) ||
           /(?:^|\s)\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*/.test(s) || /(?:\$|&&|\||;|`|=>|[{}])/.test(s) ||
           /["'][^"']{2,}["']/.test(s) || /(?:^|\s)(?:var|let|const|def|function|import)\s+[A-Za-z_$]/.test(s) ||
           /\b[A-Za-z_$][\w$]*\s*=\s*[^=]/.test(s);
  }
  function safeStepText(text, tool) {
    var s = String(text || "").trim();
    return !s || commandLikeStep(s) ? (plainTool(tool) || "Ran a step") : s;
  }
  function stepObject(d) {
    var line = String(d && d.line || "").trim();
    var m = line.match(/https?:\/\/([^\/:?#\s]+)/i);
    if (m) return "the page at " + m[1].toLowerCase();
    if (/\b(query|search|pattern)\b/i.test(String(d && d.tool || "")) && line) {
      var q = line.replace(/[^A-Za-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim().split(" ").slice(0, 5).join(" ");
      if (q) return "the " + q + " query";
    }
    var paths = line.match(/(?:^|\s)(?:\.?\.?\/|\/)[A-Za-z0-9._\/-]+/g);
    if (paths && paths.length) {
      var bits = paths[paths.length - 1].trim().replace(/\/+$/, "").split("/");
      var leaf = bits[bits.length - 1].replace(/[_-]+/g, " ").replace(/^\.+|\.+$/g, "");
      if (leaf) return "the " + leaf + (/\.[A-Za-z0-9]+$/.test(leaf) ? " file" : " folder");
    }
    // A title is not an object: reading one back out of it only repeats the line above as its own
    // detail. The detail comes from the call's line, a URL, a path or a query, or not at all.
    return "";
  }
  function stepLabel(d) {
    // A step's name, from whatever the record actually calls it. The stored steps are written as
    // {label}, the live ones as {title}, and a tool may be recorded under its own name or its slug —
    // reading only one of those is what made a reopened summary say "Used the unnamed tool" when the
    // step had a name all along. A slug is machinery, not a label, so it is spelled out for him; a
    // step that is genuinely nameless reads as work, never as a hole in the record.
    var obj = d || {};
    var named = String(obj.title || obj.label || obj.tool_name || obj.name || obj.slug || "").trim();
    var tool = String(obj.tool || obj.tool_name || obj.slug || obj.name || "").trim();
    if (!named) return plainTool(tool) || "Ran a step";
    return safeStepText(named, tool);
  }

  function paintSteps() {
    // A view switch can take this list out of the document while a turn is still arriving. Painting into
    // an element the page has let go is what threw the null errors during navigation: the guard is the
    // element still being in the document, not merely being remembered.
    if (!stepsEl || !stepsEl.isConnected) return;
    // History and Appearance own this list when they are open: a live step must not repaint
    // over the panel he is reading.
    if (stepsEl.dataset.mode && stepsEl.dataset.mode !== "summary") return;
    var stick = stepsEl.scrollHeight - stepsEl.scrollTop - stepsEl.clientHeight < 60;
    stepsEl.textContent = "";
    stepsEl.dataset.mode = "summary";
    if (!steps.length && !pendingNote) {
      // The page's own copy is empty. The machine keeps a record of every turn, so ask it rather
      // than telling him nothing happened: a turn this page never held the steps for is not a
      // turn that did nothing.
      var e = document.createElement("div");
      var convNow = String((typeof turnConv !== "undefined" && turnConv) || "");
      var tidNow = String(turnServerId || "");
      var claimable = /^[0-9a-f]{32}$/.test(convNow) && /^[0-9a-zA-Z]+$/.test(tidNow);
      if (claimable && !stepsEl.dataset.fetching) {
        e.className = "empty"; e.textContent = "Loading the recorded steps\u2026";
        stepsEl.appendChild(e);
        stepsEl.dataset.fetching = "1";
        fetch("/api/turns/events?conv=" + encodeURIComponent(convNow) +
              "&tid=" + encodeURIComponent(tidNow), { credentials: "same-origin" })
          .then(function (r) { return r.ok ? r.json() : null; })
          .then(function (d) {
            delete stepsEl.dataset.fetching;
            var rec = d && (d.records || [])[0];
            var got = (rec && rec.steps) || [];
            if (got.length) {
              steps = got.map(function (x) { return { kind: "tool", title: String(x) }; });
              paintSteps();
              return;
            }
            stepsEl.textContent = "";
            var msg = document.createElement("div");
            msg.className = "empty";
            msg.textContent = rec ? "This turn used no tools."
                                  : "The steps for this turn were not recorded.";
            stepsEl.appendChild(msg);
          })
          .catch(function () {
            delete stepsEl.dataset.fetching;
            stepsEl.textContent = "";
            var msg = document.createElement("div");
            msg.className = "empty";
            msg.textContent = "The recorded steps could not be fetched.";
            stepsEl.appendChild(msg);
          });
        return;
      }
      e.className = "empty"; e.textContent = "No steps were recorded for this turn.";
      stepsEl.appendChild(e);
      return;
    }
    var ol = document.createElement("ol");
    ol.className = "tl";
    var shown = shownSteps();
    shown.forEach(function (d) {
      var li = document.createElement("li");
      if (d.kind === "note") {
        var dot = document.createElement("span");
        dot.className = "dot"; dot.setAttribute("aria-hidden", "true");
        var nt = document.createElement("p");
        nt.className = "nt"; nt.textContent = safeStepText(d.text, d.tool);
        li.appendChild(dot); li.appendChild(nt);
      } else {
        li.className = (d.running ? "run " : "") + (d.ok === false ? "bad" : "");
        var chip = document.createElement("span");
        chip.className = "chip"; chip.setAttribute("aria-hidden", "true");
        chip.innerHTML = iconFor(d.tool);
        // A step is a line of text, not a control. It used to open a drawer holding the raw call,
        // its output and its milliseconds: that is machinery on a surface meant to read as work, and
        // it was one tap from a screen he shows people. Nothing here expands any more, so the icons
        // and the words are the whole record and there is nothing to open.
        var b = document.createElement("div");
        b.className = "tt";
        var words = rowWords(d);
        b.textContent = words.label;
        li.appendChild(chip); li.appendChild(b);
        // The reasoning the step owns, nested under it: an explanation sits under its heading, and
        // a flat list made the agent's thinking look like one more action it had taken.
        if (words.children && words.children.length) {
          var kl = document.createElement("ul");
          kl.className = "kids";
          words.children.forEach(function (t) {
            var kli = document.createElement("li");
            var kp = document.createElement("p");
            kp.className = "kt"; kp.textContent = safeStepText(t, d.tool);
            kli.appendChild(kp); kl.appendChild(kli);
          });
          li.appendChild(kl);
        }
      }
      ol.appendChild(li);
    });
    // A line nothing claimed, kept as itself rather than filed against a step it may not describe.
    if (pendingNote) {
      var pli = document.createElement("li");
      var pdot = document.createElement("span");
      pdot.className = "dot"; pdot.setAttribute("aria-hidden", "true");
      var pnt = document.createElement("p");
      pnt.className = "nt"; pnt.textContent = safeStepText(pendingNote, "");
      pli.appendChild(pdot); pli.appendChild(pnt);
      ol.appendChild(pli);
    }
    stepsEl.appendChild(ol);
    if (stick) stepsEl.scrollTop = stepsEl.scrollHeight;
  }

  // ---------------------------------------------------------------- springs (the motion engine)
  // The apple-design skill's two parameters, and nothing else: damping (how much it overshoots)
  // and response (how fast it gets there, in seconds — not a duration; the settle time falls out
  // of it). Apple's own numbers are used below: 0.8 / 0.3 for a drawer or sheet, 1.0 / 0.4 for a
  // reposition. A spring is used instead of a transition or a keyframe because only a spring can
  // start from the value that is on the screen right now and carry the finger's velocity, which is
  // what makes a surface interruptible (skill sections 3, 4, 5).
  var RM = window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;
  var RT = window.matchMedia ? window.matchMedia("(prefers-reduced-transparency: reduce)") : null;
  var TAU = Math.PI * 2;
  function reduced(){ return !!(RM && RM.matches); }
  function reducedTransparency(){ return !!(RT && RT.matches); }
  function haptic(ms){ try { if (navigator.vibrate && !reduced()) navigator.vibrate(ms); } catch (e) {} }

  function spring(o) {
    var damping = o.damping == null ? 1 : o.damping;
    var response = o.response == null ? 0.4 : o.response;
    var w0 = TAU / Math.max(0.02, response);
    var x = o.from - o.to, v = o.velocity || 0, t = 0, last = performance.now();
    var alive = true, sub = 1 / 240;
    if (reduced()) {                         // no autonomous motion: arrive, do not travel
      if (o.onFrame) o.onFrame(o.to, 0);
      if (o.onDone) o.onDone();
      return { cancel: function(){}, value: function(){ return o.to } };
    }
    function frame(now){
      if (!alive) return;
      var dt = Math.min(0.064, Math.max(0, (now - last) / 1000)); last = now;
      for (var s = 0; s < dt; s += sub) {     // sub-stepped: a slow frame must not change the feel
        var a = -w0 * w0 * x - 2 * damping * w0 * v;
        v += a * sub; x += v * sub;
      }
      t += dt;
      if (o.onFrame) o.onFrame(o.to + x, v);
      if ((Math.abs(x) < 0.12 && Math.abs(v) < 6) || t > 6) {
        if (o.onFrame) o.onFrame(o.to, 0);
        if (o.onDone) o.onDone();
        return;
      }
      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
    return { cancel: function(){ alive = false }, value: function(){ return o.to + x } };
  }

  // Where the gesture is going, not where it is (section 6). Apple's exponential-decay form.
  function project(v, d){ d = d == null ? 0.998 : d; return (v / 1000) * d / (1 - d) }
  // A boundary that resists instead of stopping (section 9). Real things slow before they stop.
  function rubberband(over, dim, c){ c = c == null ? 0.55 : c;
    return (over * dim * c) / (dim + c * Math.abs(over)) }

  // ---------------------------------------------------------------- the steps sheet
  var lastFocus = null, shSpring = null, shY = 0, shH = 1, shGrab = null;
  function setSheetY(y, scale){
    shY = y;
    var r = document.documentElement.style;
    r.setProperty("--sh-y", y.toFixed(2) + "px");
    r.setProperty("--sh-s", (scale == null ? 1 : scale).toFixed(4));
    r.setProperty("--scrim-a", String(Math.max(0, Math.min(.55, .55 * (1 - y / Math.max(1, shH))))));
  }
  // A modal owns its chrome while it is up, but `#content` remains the page's scroller. The count
  // tracks overlapping surfaces without changing overflow or taking touch scroll from the canvas.
  var scrollLocks = 0, scrollTopWas = 0;
  function lockScroll(){
    scrollLocks++;
    if (scrollLocks > 1) return;
    var c = document.getElementById("content");
    if (c) scrollTopWas = c.scrollTop;
    document.body.classList.add("modal-open");
  }
  function unlockScroll(){
    if (scrollLocks > 0) scrollLocks--;
    if (scrollLocks > 0) return;
    document.body.classList.remove("modal-open");
  }

  function openSheet(){
    lastFocus = document.activeElement;
    sheetEl.hidden = false;
    lockScroll();
    shH = (sheetPanel && sheetPanel.offsetHeight) || Math.round(window.innerHeight * 0.6);
    if (shSpring) { shSpring.cancel(); shSpring = null; }
    if (reduced()) { setSheetY(0, 1); if (sheetX) { try { sheetX.focus(); } catch (e) {} } return; }
    var r = document.documentElement.style;
    shSpring = spring({
      from: shH, to: 0, velocity: 0, damping: 0.8, response: 0.3,
      onFrame: function (val, vel){
        var p = Math.max(0, Math.min(1, 1 - val / Math.max(1, shH)));
        setSheetY(val, 0.97 + 0.03 * p);
        // A material arrives by thickening, not by fading in (section 12: materialise).
        if (!reducedTransparency()) r.setProperty("--sh-blur", (8 + 22 * p).toFixed(1) + "px");
      },
      onDone: function (){ shSpring = null; setSheetY(0, 1); r.removeProperty("--sh-blur") }
    });
    if (sheetX) { try { sheetX.focus(); } catch (e) {} }
  }
  function closeSheet(){
    stopTelemetry();
    if (shSpring) { shSpring.cancel(); shSpring = null; }
    if (sheetEl.hidden) return;
    unlockScroll();
    if (reduced()) { setSheetY(0, 1); sheetEl.hidden = true; canvasReleased(); return; }
    shSpring = spring({
      from: shY, to: shH, velocity: 0, damping: 0.8, response: 0.26,
      onFrame: function (val){ var p = Math.min(1, val / Math.max(1, shH));
                               setSheetY(val, 1 - 0.02 * p) },
      // The lock is released once, on the way out above; releasing it again here made a single
      // modal subtract two, so the count stopped meaning how many are open.
      onDone: function (){ shSpring = null; sheetEl.hidden = true; shGrab = null; canvasReleased() }
    });
    if (lastFocus && lastFocus.focus) { try { lastFocus.focus(); } catch (e) {} }
  }
  // The pill is the way into the Summary, in every state: it is the one thing on the page that
  // always says what is happening, so it is the one thing that opens the record of it. The top bar
  // keeps its count as context and is not a control at all any more.
  if (stateEl) {
    stateEl.setAttribute("role", "button");
    stateEl.setAttribute("tabindex", "0");
    // In every state, including while the live-voice strip is up: the pill is the one control
    // that always says what is happening, so it is the one that always opens the record of it.
    stateEl.addEventListener("click", function () { openSheetMode("steps"); });
    stateEl.addEventListener("keydown", function (e) {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault(); openSheetMode("steps");
      }
    });
  }
  if (sheetX) sheetX.addEventListener("click", closeSheet);
  if (scrim) scrim.addEventListener("click", closeSheet);
  document.addEventListener("keydown", function (e) { if (e.key === "Escape" && !sheetEl.hidden) closeSheet(); });

  // --- the one question the page asks before it destroys something -------------------------------
  // Keeping is the default: it takes focus, Escape closes it, the scrim closes it, and only the
  // second button goes through. A destructive action reached from a list should never be one tap
  // away from a row he misread.
  var confirmEl = $("confirm"), confirmScrim = $("confirmscrim"),
      confirmTitle = $("confirmtitle"), confirmBody = $("confirmbody"),
      confirmKeep = $("confirmkeep"), confirmGo = $("confirmgo");
  var confirmYes = null, confirmWas = null;
  function askConfirm(opts) {
    opts = opts || {};
    if (!confirmEl) { if (window.confirm(opts.title || "Are you sure?")) opts.onYes && opts.onYes(); return; }
    confirmYes = opts.onYes || null;
    if (confirmTitle) confirmTitle.textContent = opts.title || "Are you sure?";
    if (confirmBody) { confirmBody.textContent = opts.body || ""; confirmBody.hidden = !opts.body; }
    if (confirmGo) confirmGo.textContent = opts.yes || "Clear";
    confirmWas = document.activeElement;
    confirmEl.hidden = false;
    lockScroll();
    if (confirmKeep) { try { confirmKeep.focus(); } catch (e) {} }
  }
  function closeConfirm() {
    if (!confirmEl || confirmEl.hidden) return;
    confirmEl.hidden = true;
    confirmYes = null;
    unlockScroll();
    canvasReleased();
    if (confirmWas && confirmWas.focus) { try { confirmWas.focus(); } catch (e) {} }
  }
  if (confirmKeep) confirmKeep.addEventListener("click", closeConfirm);
  if (confirmScrim) confirmScrim.addEventListener("click", closeConfirm);
  if (confirmGo) confirmGo.addEventListener("click", function () {
    var fn = confirmYes;
    closeConfirm();                          // closed first: the action may repaint anything it likes
    if (typeof fn === "function") fn();
  });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && confirmEl && !confirmEl.hidden) closeConfirm();
  });

  // Dragging the sheet: 1:1 with the finger, respectful of where it was grabbed, resisting past
  // its rest position, and finishing at the velocity the finger left with (sections 2, 3, 5, 9,
  // 10). The old version was a 60px touch swipe that only reported a final state and could not be
  // reversed — exactly what section 3 calls the most important thing to get right.
  if (sheetPanel) {
    sheetPanel.addEventListener("pointerdown", function (e){
      if (sheetEl.hidden || e.button) return;
      // A control keeps its own tap: presses commit on release (sections 1, 10).
      var t = e.target, inHead = !!(t && t.closest && t.closest("header"));
      if (t && t.closest && t.closest("button, a, input, textarea") && !inHead) return;
      // The sheet is dragged only by its header/grab area. A gesture begun in its scrollable body
      // always remains native scrolling, including when the list is already at its top.
      if (!inHead) return;
      shH = sheetPanel.offsetHeight || shH;
      if (shSpring) { shSpring.cancel(); shSpring = null }   // grab it mid-flight: interruptible
      shGrab = { y0: e.clientY, y: shY, moved: false, hist: [[e.clientY, performance.now()]] };
      try { sheetPanel.setPointerCapture(e.pointerId); } catch (err) {}
    });
    sheetPanel.addEventListener("pointermove", function (e){
      if (!shGrab) return;
      var dy = e.clientY - shGrab.y0;
      if (!shGrab.moved) {
        if (Math.abs(dy) < 8) return;                        // ~10px of hysteresis before intent
        shGrab.moved = true;                                 // ownership is settled once: the sheet
      }                                                      // took the gesture at pointerdown
      var y = shGrab.y + dy;
      if (y < 0) y = -rubberband(-y, shH, 0.55);             // past the rest position, it resists
      shGrab.hist.push([e.clientY, performance.now()]);
      if (shGrab.hist.length > 6) shGrab.hist.shift();
      setSheetY(y);
      e.preventDefault();
    });
    function sheetRelease(){
      if (!shGrab) return;
      var h = shGrab.hist, v = 0;
      if (h.length >= 2) {
        var a = h[0], b = h[h.length - 1], dt = (b[1] - a[1]) / 1000;
        if (dt > 0.001) v = (b[0] - a[0]) / dt;              // px/s: the finger's own velocity
      }
      var y = shY;
      // The projection is what decides a flick, so its decay is tuned for a dismissal, not for
      // scrolling to rest: at 0.998 a leisurely 120px drag projects another 200px and slams the
      // sheet shut, which is the wrong read of a slow hand. 0.99 keeps the position threshold in
      // charge for slow drags and lets a real flick commit from anywhere (sections 6, 10).
      var land = y + project(v, 0.99);
      // Commit from the projection, and decide the direction from the velocity's SIGN (section 10).
      var close = land > shH * 0.45 || v > 620;
      if (v < -160 && y < shH * 0.34) close = false;         // a flick back up keeps it
      var target = close ? shH : 0;
      shGrab = null;
      if (reduced()) { setSheetY(target, 1); if (close) sheetEl.hidden = true; haptic(4); return }
      shSpring = spring({
        from: y, to: target, velocity: v,                    // hand the velocity over: no seam (§5)
        damping: 0.8, response: 0.3,
        onFrame: function (val){ setSheetY(val, target === 0 ? 1 : 1 - 0.02 * (val / Math.max(1, shH))) },
        onDone: function (){ shSpring = null; if (close) { sheetEl.hidden = true; shY = shH } else setSheetY(0, 1);
                             haptic(close ? 6 : 3) }
      });
    }
    sheetPanel.addEventListener("pointerup", sheetRelease);
    sheetPanel.addEventListener("pointercancel", sheetRelease);
    sheetPanel.addEventListener("lostpointercapture", sheetRelease);
  }

  // ---------------------------------------------------------------- the artifact
  function clearArtifact() {
    artEl.textContent = "";
    artEl.classList.remove("overflowing", "leaving", "more-below");
    body.classList.remove("has-art");
    lastWidget = null;
    appliedArt = "";                        // B2: a panel cleared must be showable again
    // The frames it held went with the markup, so their records go too. Nothing pruned them, and
    // every panel ever shown left behind a record for a frame that no longer exists.
    frames.length = 0;
  }

  // What is up there steps back before it goes, and the next thing arrives from below, so new work
  // never lands on top of the old. The token stops a slow fade from wiping something that has
  // already arrived behind it.
  var artFade = 0;
  function fadeArtifactOut(then) {
    if (!artEl.firstChild) { then(); return; }
    var mine = ++artFade;
    artEl.classList.add("leaving");
    setTimeout(function () {
      if (mine !== artFade) return;
      artEl.classList.remove("leaving");
      then();
    }, 180);
  }

  function box(kind) {
    var d = document.createElement("div");
    d.className = "art art-" + kind;
    return d;
  }

  function label(parent, a) {
    if (!a.label) return;
    var l = document.createElement("div");
    l.className = "lbl"; l.textContent = String(a.label);
    parent.appendChild(l);
  }

  function rows(v) { return Array.isArray(v) ? v : []; }

  function renderArtifact(a) {
    var el;
    if (a.kind === "text") {
      el = box("text"); label(el, a);
      var p = document.createElement("div");
      p.className = "big"; p.textContent = String(a.text == null ? "" : a.text);
      el.appendChild(p);

    } else if (a.kind === "table") {
      el = box("table"); label(el, a);
      var cols = rows(a.columns), rowsBody = rows(a.rows);
      // Right-align a column only when every value in it is a number, optionally with a unit.
      // A path or a name reads wrong against the right edge, and a column of figures reads wrong
      // against the left. (Do not name this variable `body`: it would shadow the page's own.)
      var numeric = cols.map(function (_, i) {
        var vals = rowsBody.map(function (r) { return rows(r)[i]; });
        return vals.length > 0 && vals.every(function (v) {
          return v != null && /^[-+]?\d[\d.,\s]*(%|[A-Za-z]{1,3})?$/.test(String(v).trim());
        });
      });
      var table = document.createElement("table");
      var thead = document.createElement("thead"), htr = document.createElement("tr");
      cols.forEach(function (c, i) {
        var th = document.createElement("th");
        th.textContent = String(c);
        if (numeric[i]) th.className = "num";
        htr.appendChild(th);
      });
      if (htr.childNodes.length) { thead.appendChild(htr); table.appendChild(thead); }
      var tb = document.createElement("tbody");
      rowsBody.forEach(function (r, ri) {
        var tr = document.createElement("tr");
        tr.style.setProperty("--i", ri);
        rows(r).forEach(function (c, i) {
          var td = document.createElement("td");
          td.textContent = String(c);
          if (numeric[i]) td.className = "num";
          tr.appendChild(td);
        });
        tb.appendChild(tr);
      });
      table.appendChild(tb);
      var scroll = document.createElement("div");      // L7: wide tables scroll sideways
      scroll.className = "tw";
      scroll.appendChild(table);
      el.appendChild(scroll);

    } else if (a.kind === "list") {
      el = box("list"); label(el, a);
      var ul = document.createElement("ul"); ul.className = "list";
      rows(a.items).forEach(function (it, i) {
        var li = document.createElement("li");
        li.textContent = String(it);
        li.style.setProperty("--i", i);        // each line lands just behind the one above it
        ul.appendChild(li);
      });
      el.appendChild(ul);

    } else if (a.kind === "code") {
      el = box("code"); label(el, a);
      var pre = document.createElement("div");
      pre.className = "code"; pre.textContent = String(a.text == null ? "" : a.text);
      el.appendChild(pre);
      var cbtn = document.createElement("button");
      cbtn.type = "button"; cbtn.className = "copy"; cbtn.textContent = "Copy";
      cbtn.addEventListener("click", function () {
        copyText(String(a.text == null ? "" : a.text), "Code");
      });
      el.appendChild(cbtn);

    } else if (a.kind === "metrics") {
      el = box("metrics"); label(el, a);
      var wrap = document.createElement("div"); wrap.className = "metrics";
      rows(a.items).forEach(function (m) {
        var one = document.createElement("div"); one.className = "m";
        var v = document.createElement("div"); v.className = "v";
        v.textContent = String(m && m.v != null ? m.v : "");
        var k = document.createElement("div"); k.className = "k";
        k.textContent = String(m && m.k != null ? m.k : "");
        one.appendChild(v); one.appendChild(k); wrap.appendChild(one);
      });
      el.appendChild(wrap);

    } else if (a.kind === "chart") {
      // A graph the agent asked for, drawn by the same hand that draws one inside an answer. The
      // artifact's own `kind` names the artifact, so the shape of the chart travels in `chart`
      // (bar or line) and never collides with it.
      var chartSpec = {
        type: "chart",
        kind: (String(a.chart || a.style || "bar").toLowerCase() === "line") ? "line" : "bar",
        title: a.title || a.label || "",
        unit: a.unit || "",
        source: a.source || "",
        data: a.data || a.rows || a.values || []
      };
      var drawn = null;
      try { drawn = uiChart(chartSpec); } catch (e) { drawn = null; }
      if (!drawn) return;
      el = box("chart"); label(el, a);
      el.appendChild(drawn);

    } else if (a.kind === "image") {
      var src = String(a.src || "");
      if (!/^https?:\/\//i.test(src)) return;
      el = box("image"); label(el, a);
      var img = document.createElement("img");
      img.src = src; img.alt = String(a.label || "");
      img.loading = "lazy";
      el.appendChild(img);

    } else if (a.kind === "link") {
      var href = String(a.href || "");
      if (!/^https?:\/\//i.test(href)) return;
      el = box("link");
      var link = document.createElement("a");
      link.href = href; link.textContent = String(a.label || href);
      link.target = "_blank"; link.rel = "noopener noreferrer";
      el.appendChild(link);

    } else if (a.kind === "widget") {
      // Only the widget origin is ever framed, whatever the payload claims.
      var wurl = String(a.url || a.src || "");
      var okUrl = /^https:\/\/widgets\.battemohammad\.com\/w\/[A-Za-z0-9_-]{20,32}$/.test(wurl);
      if (!okUrl) return;
      el = box("widget"); label(el, a);
      mountWidgetFrame(el, wurl, String(a.label || "Visual"));
      var open = document.createElement("a");
      open.className = "wopen";
      open.href = wurl; open.target = "_blank"; open.rel = "noopener noreferrer";
      open.textContent = "Open full size";
      el.appendChild(open);
      // Kept with the turn so history can bring it back while the token is still alive.
      lastWidget = { url: wurl, t: Date.now(), exp: a.expires || null };

    } else if (a.kind === "video") {
      // Only an embed address the server built from a video id is ever framed here, so a panel
      // cannot point the frame at a page of someone else's choosing.
      var vsrc = String(a.src || "");
      var okVid = /^https:\/\/www\.youtube-nocookie\.com\/embed\/[A-Za-z0-9_-]{11}$/.test(vsrc);
      if (!okVid) return;
      el = box("video"); label(el, a);
      var vwrap = document.createElement("div"); vwrap.className = "vwrap";
      var vframe = document.createElement("iframe");
      vframe.className = "vframe";
      vframe.src = vsrc;
      vframe.setAttribute("title", String(a.label || "Video"));
      vframe.setAttribute("referrerpolicy", "no-referrer");
      vframe.setAttribute("loading", "lazy");
      vframe.setAttribute("allow", "accelerometer; encrypted-media; gyroscope; picture-in-picture");
      vframe.setAttribute("allowfullscreen", "true");
      vwrap.appendChild(vframe);
      el.appendChild(vwrap);
      var vopen = document.createElement("a");
      vopen.className = "wopen";
      vopen.href = String(a.watch || vsrc);
      vopen.target = "_blank"; vopen.rel = "noopener noreferrer";
      vopen.textContent = "Open on YouTube";
      el.appendChild(vopen);

    } else {
      return;                                  // an unknown kind shows nothing at all
    }
    artEl.textContent = "";
    artEl.classList.remove("overflowing", "leaving", "more-below");
    artFade++;                                 // cancel any fade still in flight
    artEl.appendChild(el);
    body.classList.add("has-art");
    fitArtifact();
    toBottom();
  }

  // The dissolve is applied only while there is more content below (L6), so the last rows of a
  // scrolled panel are never left dim once the reader has reached the end of it.
  function artScroll() {
    var more = artEl.scrollTop + artEl.clientHeight < artEl.scrollHeight - 6;
    artEl.classList.toggle("more-below", more);
  }
  artEl.addEventListener("scroll", artScroll, { passive: true });

  function fitArtifact() {
    artEl.classList.remove("more-below");
    var over = artEl.scrollHeight > artEl.clientHeight + 2;
    artEl.classList.toggle("overflowing", over);
    if (over) artScroll();
  }
  window.addEventListener("resize", function () { setTimeout(fitArtifact, 0); });

  // -------------------------------- the widget frame (5.1, 5.3)
  // A widget runs in an opaque origin, in a frame that may run scripts and do nothing else: no
  // same-origin, no popups, no top navigation, no forms. It can speak to the page on exactly two
  // subjects — how tall it is, and one short question — and both are clamped and rate-limited
  // here, so a hostile widget's attempts have no effect rather than being trusted.
  var WIDGET_HOST = "widgets.battemohammad.com";
  var frames = [];

  function frameDvh() { return Math.round(window.innerHeight * 0.7); }

  function widgetMessage(e) {
    // The frame's window is read live at message time. Reading it once at mount is wrong: an
    // iframe that is not yet in the document has no window, and a widget's own script runs before
    // its load event — exactly the messages this has to judge.
    var f = null, i;
    for (i = 0; i < frames.length; i++) {
      var w = frames[i].el.contentWindow;
      if (w && w === e.source) { f = frames[i]; break; }
    }
    if (!f) return;                                  // only a frame this page put up may speak
    f.seen += 1;
    var d = e.data;
    if (!d || typeof d !== "object") return;
    var now = Date.now();

    if (d.type === "jarvis:resize") {
      // at most five a second, and the number is clamped between a floor and 70dvh: a widget
      // cannot grow the page without limit however much it asks for.
      f.resizeHits = f.resizeHits.filter(function (t) { return now - t < 1000; });
      if (f.resizeHits.length >= 5) { f.droppedResize += 1; return; }
      f.resizeHits.push(now);
      var h = Math.round(Number(d.height) || 0);
      if (!isFinite(h) || h <= 0) return;
      f.requested = h;
      h = Math.max(160, Math.min(frameDvh(), h));
      f.el.style.height = h + "px";
      return;
    }

    if (d.type === "jarvis:ask") {
      if (now - (f.lastAsk || 0) < 2000) { f.droppedAsk += 1; return; }   // one every two seconds
      var text = String(d.text == null ? "" : d.text).slice(0, 200).trim();
      if (!text) return;
      f.lastAsk = now;
      askFromWidget(text);
      return;
    }
    // anything else a widget sends is not acted on at all
  }
  window.addEventListener("message", widgetMessage);

  function askFromWidget(text) {
    try { useAsAsk(text); } catch (e) {}
  }

  function frameUrl(url) {
    // A widget follows the page, not the device. Choosing Light on a dark phone used to give a
    // dark widget on a light page, because the frame only ever saw the device's preference. The
    // page's own choice and the reader's text size travel to it by query string.
    try {
      var v = theme();
      var light = v === "light" ||
        (v === "device" && window.matchMedia &&
         window.matchMedia("(prefers-color-scheme: light)").matches);
      return url + (url.indexOf("?") >= 0 ? "&" : "?") +
             "theme=" + (light ? "light" : "dark") + "&t=" + textScale();
    } catch (e) { return url; }
  }

  function remountWidgets() {
    for (var i = 0; i < frames.length; i++) {
      var rec = frames[i];
      if (rec.url && rec.el) rec.el.src = frameUrl(rec.url);
    }
  }

  function mountWidgetFrame(el, url, title) {
    var frame = document.createElement("iframe");
    frame.className = "wframe";
    frame.setAttribute("sandbox", "allow-scripts");        // and nothing else, ever
    frame.setAttribute("referrerpolicy", "no-referrer");
    frame.setAttribute("loading", "lazy");
    frame.setAttribute("title", title || "Visual");
    // No scrolling="no": a widget taller than the frame became unreachable, because the frame
    // could not scroll and the frame is clamped to a share of the viewport.
    frame.src = frameUrl(url);
    el.appendChild(frame);
    var rec = { el: frame, url: url, resizeHits: [], droppedResize: 0, droppedAsk: 0, lastAsk: 0,
                requested: 0, seen: 0 };
    frames.push(rec);
    return rec;
  }
  window.__jarvisWidgets = function () {
    return frames.map(function (f) {
      return { height: f.el.style.height, requested: f.requested, seen: f.seen,
               droppedResize: f.droppedResize, droppedAsk: f.droppedAsk };
    });
  };

  function showArtifact(a) {
    try {
      if (!a || typeof a !== "object") return;
      if (a.kind === "clear") {
        fadeArtifactOut(clearArtifact);
        // The machine emptied its side: this device's copies go with it, stamp and all.
        try { if (a.purged) { applyPurge({ purged: a.purged }); } else { clearDeviceCopies(); } } catch (e) {}
        return;
      }
      if (artEl.firstChild) { fadeArtifactOut(function () { renderArtifact(a); }); return; }
      renderArtifact(a);
    } catch (e) { /* a bad artifact must never take the page down */ }
  }
  // The typing box. The page's own handler reveals it and focuses the field 60 ms later; some
  // mobile browsers refuse a focus that arrives on a later tick, so the field is opened and
  // focused inside the tap itself, which is what actually raises the phone's keyboard.
  (function () {
    var t = $("typing"), box = $("fallback"), field = $("q");
    if (!t || !box || !field) return;
    var closeBtn = $("typingx");
    // Typing mode hides the microphone row, which gives the keyboard a bar of its own. It had no
    // way back out: once opened, the row stayed open for good. This closes it and hands the
    // keyboard back.
    function openTyping() { box.classList.add("show"); body.classList.add("typing"); }
    function closeTyping() {
      box.classList.remove("show");
      body.classList.remove("typing");
      try { field.blur(); } catch (e) {}
      fitArtifact();
    }
    if (closeBtn) closeBtn.addEventListener("click", closeTyping);
    // The microphone is on screen while typing now, and touching it means he wants to talk, so the
    // box puts itself away. The switch and the control that does the switching are the same tap.
    var micBtn = $("mic");
    if (micBtn) micBtn.addEventListener("click", function () {
      if (box.classList.contains("show")) closeTyping();
    });
    t.addEventListener("click", function () {
      openTyping();
      try { field.focus(); } catch (e) {}
      setTimeout(function () { try { field.focus(); } catch (e) {} }, 60);
      fitArtifact();
    });
  })();

  window.__jarvisArt = showArtifact;

  // The channel's own state. A page that has lost it has to say so, otherwise it sits there
  // looking healthy while panels go nowhere, which is how he came to be told "all six landed"
  // with nothing on his screen.
  var screenState = { open: false, events: 0, last: 0, error: "" };
  var appliedArt = "";
  window.__jarvisScreenState = function () {
    return { open: screenState.open, events: screenState.events, last: screenState.last,
             error: screenState.error, up: appliedArt ? appliedArt.slice(0, 60) : "" };
  };

  var dot = null;
  function markScreen(up, why) {
    screenState.open = !!up;
    screenState.error = up ? "" : (why || "");
    if (up) body.classList.remove("noscreen");
    else body.classList.add("noscreen");
  }

  function applyArtifact(d) {
    var sig = "";
    try { sig = JSON.stringify(d); } catch (e) { sig = ""; }
    if (sig && sig === appliedArt) return;   // already up: do not replay the animation at him
    appliedArt = sig;
    showArtifact(d);
  }

  // What is up there already. A panel sent while the phone was locked has to still be found when
  // he looks, or a missed panel and a panel never sent look exactly the same from his chair.
  function catchUp() {
    try {
      fetch("/screen/last", { cache: "no-store" }).then(function (r) {
        return r.ok ? r.json() : null;
      }).then(function (j) {
        if (j && j.art) applyArtifact(j.art);
      }).catch(function () {});
    } catch (e) {}
  }

  var screenES = null;
  var screenRetry = 0;          // 1 while a reconnect is already queued, so only one ever runs
  var screenRetryTimer = 0;
  var screenOpens = 0;          // how many times the channel has opened in this page's life
  var screenFails = 0;          // failures in a row since it last opened
  function openScreenChannel() {
    if (screenState.open) return;
    if (!window.EventSource) { markScreen(false, "this browser cannot hold the screen link"); return; }
    // One channel, always. Leaving the app and coming back reopened it without closing the last,
    // so every return left another stream running behind the page.
    if (screenES) { try { screenES.close(); } catch (e) {} screenES = null; }
    try {
      var es = new EventSource("/screen");
      screenES = es;
      es.onopen = function () { screenRetry = 0; screenOpens += 1; screenFails = 0; markScreen(true); catchUp(); };
      es.onerror = function () {
        // A cold start reports an error while the channel is still connecting, so the first failure
        // is not news: it only means the link has not opened yet. Staying quiet about that is what
        // stops "screen link down" flashing in the header every time the app opens. A link that is
        // genuinely down is still reported, one failed retry later.
        screenFails += 1;
        // The link's state is shown as the dot's colour and nothing else. A raw connection string in the
        // top row is machinery on a surface he reads: the retry below is the whole of what he needs, and
        // it happens whether or not anything is written here.
        if (screenOpens || screenFails >= 2) markScreen(false);
        // A drop while he is looking at the page had nothing to bring it back: the link stayed down
        // until he reloaded, which is what the page shutting itself down looks like from his side.
        // Coming back to the foreground used to be the only repair, and it is not one he can rely on.
        try { es.close(); } catch (_) {}
        screenES = null;
        screenState.open = false;
        if (!screenRetry) {
          screenRetry = 1;
          screenRetryTimer = setTimeout(function () {
            screenRetry = 0;
            openScreenChannel();
          }, 1500);
        }
      };
      es.addEventListener("art", function (e) {
        var d; try { d = JSON.parse(e.data); } catch (_) { return; }
        screenState.events += 1;
        screenState.last = Date.now();
        markScreen(true);
        applyArtifact(d);
      });
      if (!dot) {
        dot = document.createElement("span");
        dot.className = "screen-dot";
        // A quiet mark, not a sentence: the words live in the accessible name, where a screen reader can
        // read them and a glance cannot trip over them.
        dot.setAttribute("aria-label", "screen link");
        dot.setAttribute("title", "screen link");
        // Into the top row, not the status bar: there it takes its own line instead of widening a
        // row that is already the widest thing on the page.
        var top1 = $("top");
        if (top1) top1.appendChild(dot);
      }
    } catch (e) { /* the page still works, it just cannot be shown things */ }
  }

  // ------------------------------------------------------------------ the error, with a way out (B4)
  // The engine's own error line showed for seven seconds and then left him at a dead end. This
  // one stays until it is dealt with, and carries the question back to JARVIS.
  function clearError() {
    if (!errEl) return;
    errEl.classList.remove("show");
    errEl.textContent = "";
  }
  // Whether the phone itself is offline, and how recently. The engine blames the connection for
  // every failed stream — including the ones where the connection is perfectly good and the other
  // end went away — so the page has to know the difference before it repeats the claim.
  var lastOffline = 0;
  window.addEventListener("offline", function () { lastOffline = Date.now(); });
  window.addEventListener("online", function () { lastOffline = 0; });
  function reallyOffline() {
    if (typeof navigator.onLine === "boolean" && !navigator.onLine) return true;
    return !!lastOffline && (Date.now() - lastOffline) < 15000;
  }

  function failureLine(text) {
    if (reallyOffline()) return "You are offline. JARVIS needs a connection.";
    if (!text) return "Something went wrong.";
    // Online, and the stream died anyway: the turn ended at the other end, not in his hand. Saying
    // "lost the connection" to someone who is looking at four bars of signal is how a page teaches
    // him to distrust what it says.
    if (/connection|network|fetch|load failed|failed to fetch/i.test(text)) {
      return "The link to JARVIS dropped mid-answer. Your connection is fine; the turn ended " +
             "before it finished.";
    }
    return text;
  }

  // Carrying on, rather than asking again. The partial answer is on his screen and the only thing
  // a plain re-ask does with it is throw it away: the same question, the same first minute, and the
  // work he already read gone. The question goes back with what was already produced attached.
  function resumePrompt(partial) {
    var head = "You were cut off partway through answering. Carry on from where you stopped, and " +
               "do not start over. Keep whatever you already produced that is still right.\n\n" +
               "The question was: ";
    var tail = "\n\nWhat you had already produced:\n";
    var room = 1900 - head.length - tail.length - lastQ.length;   // the server refuses past 2000
    var keep = partial.length > room ? partial.slice(0, Math.max(0, room)) : partial;
    return head + lastQ + tail + keep;
  }

  // The reply being written RIGHT NOW — which is not answerText. answerText is only assigned when
  // a turn ENDS, so during a turn it still holds the previous answer, and carrying that would
  // attach the wrong words to the new question. That is the whole reason this reads the live copy:
  // turnText is the engine's ordered reply for this turn, captionText the slices as they are
  // spoken, and either may be the only one that survived.
  function partialAnswer() {
    var cand = [turnText, captionText, (cap && cap.textContent) || ""];
    for (var i = 0; i < cand.length; i++) {
      var t = String(cand[i] || "").trim();
      if (t) return t;
    }
    return "";
  }

  function showError(text) {
    if (!errEl) return;
    errEl.textContent = "";
    var span = document.createElement("span");
    span.textContent = text;
    errEl.appendChild(span);
    // Nothing to carry once the turn has ended: the answer is complete and already on the screen.
    var partial = turnEnded ? "" : partialAnswer();
    if (lastQ) {
      var b = document.createElement("button");
      b.type = "button";
      // Named for what it will actually do. "Retry" implied it was resuming; it was starting over.
      // "Ask again" is an instruction to redo work that may already have been done. It is only offered
      // when the record does not already hold the complete answer for this question.
      b.textContent = partial ? "Carry on" : "Ask again";
      if (!partial && turnAlreadyAnswered()) { b.hidden = true; }
      b.setAttribute("aria-label", partial
        ? "Carry on from where JARVIS stopped, keeping what it already produced"
        : "Ask the question again from the start");
      b.addEventListener("click", function () {
        clearError();
        try { window.ask(partial ? resumePrompt(partial) : lastQ); } catch (e) {}
      });
      errEl.appendChild(b);
    }
    errEl.classList.add("show");
  }
  // The engine's own fail turned the status light red and then hid its line after seven seconds,
  // leaving him at a dead end. This one keeps the page's line and its way out, and takes over the
  // state change itself so the engine's version does not need to run and undo it.
  // A turn that finished while the phone was asleep has its answer in the conversation's own record, and a
  // socket that died on wake has nothing to do with it. Warning him then is the page telling him his turn
  // failed when it did not: the words are on the screen and in the store.
  function turnAlreadyAnswered() {
    try {
      if (!lastQ) return false;
      var h = history() || [];
      for (var i = 0; i < h.length; i++) {
        if (String(h[i].q || "") === String(lastQ) && String(h[i].a || "").trim()) return true;
      }
      // The answer can be complete and stored under the conversation's own record rather than this
      // page's flat history: the machine files every finished turn. A complete payload is the test —
      // a socket closing is not evidence that anything was lost.
      try {
        var rec = (window.__jarvisConvRecord && window.__jarvisConvRecord()) || null;
        var turns = (rec && rec.turns) || [];
        for (var j = 0; j < turns.length; j++) {
          if (String(turns[j].q || "") === String(lastQ) && String(turns[j].a || "").trim().length > 40) return true;
        }
      } catch (e) {}
      // And the turn this page is reading, if it ended on its own terms rather than failing.
      try {
        var lt = window.__jarvisLiveTurn && window.__jarvisLiveTurn();
        if (lt && lt.alive === false && lt.ended === "completed") return true;
      } catch (e) {}
      // The words themselves: if the answer is on the screen there is nothing to warn him about. Work
      // having happened is not the test — a failure during a turn that already drew its steps is still a
      // failure, and staying quiet about it would be the worse lie.
      var ansEl = document.getElementById("answer");
      if (ansEl && String(ansEl.textContent || "").trim()) return true;
    } catch (e) {}
    return false;
  }
  function paintAgentFailure(text) {
    if (!textMode || !/^The agent turn failed\b/.test(String(text || "")) || !evBelongsHere() || !liveBlock) return false;
    var target = liveBlock.querySelector(".t-a");
    if (!target) return false;
    liveBlock.dataset.agentFailed = "1";
    var old = target.querySelector(".agent-failure");
    if (!old) {
      old = document.createElement("p"); old.className = "rc-p agent-failure";
      old.setAttribute("role", "alert"); target.appendChild(old);
    }
    old.textContent = String(text);
    var meta = liveBlock.querySelector(".t-meta");
    if (meta) meta.remove();
    answerText = ""; captionText = ""; turnText = "";
    endFollow(); canvasReleased(); hideWorkingPill(); setPhase("");
    return true;
  }
  window.fail = function (text) {
    if (paintAgentFailure(text)) return;
    if (turnAlreadyAnswered()) {
      // Quietly: the turn is done, so the page settles on it rather than raising a red line about a link.
      endFollow();
      canvasReleased();
      try { setPhase("worked"); } catch (e) {}
      try { if (window.setState) window.setState("idle"); } catch (e) {}
      return;
    }
    // A failure ends a turn as surely as an answer does: a follow left running turns one bad reply
    // into a canvas he cannot scroll, which is the same freeze with a worse reason.
    // A network-shaped failure is not proof that the turn ended. The machine runs the turn whether
    // or not this page is still reading it, so before the page says "the turn ended" it asks. The
    // phone showed the contradiction this produced: a turn marked finished at the same moment the
    // work was still running, then completing on its own.
    var ftxt = String(text || "");
    if (/connection|network|fetch|load failed|failed to fetch|dropped|stream|abort/i.test(ftxt)) {
      var fconv = "", ftid = "";
      try { fconv = String(window.__jarvisConvId ? window.__jarvisConvId() : ""); } catch (e) {}
      try { ftid = String(turnServerId || ""); } catch (e) {}
      if (/^[0-9a-f]{32}$/.test(fconv) && /^[0-9a-zA-Z]+$/.test(ftid)) {
        // Truthful state while the answer is unknown: still working, not failed. The pill keeps
        // saying THINKING because the turn genuinely is, and nothing contradicts it.
        try { if (window.setState) window.setState("thinking"); } catch (e) {}
        (function watch(conv, tid, n) {
          fetch("/api/turns/events?conv=" + encodeURIComponent(conv) + "&tid=" + encodeURIComponent(tid),
                { credentials: "same-origin" })
            .then(function (r) { return r.ok ? r.json() : null; })
            .then(function (d) {
              var rec = d && (d.records || [])[0];
              if (rec) {
                if (rec.status === "cancelled") {
                  try { setPhase(""); } catch (e) {}
                  try { if (window.setState) window.setState("idle"); } catch (e) {}
                  showError("That turn was stopped before it finished.");
                  return;
                }
                if (rec.status === "failed") {
                  try { setPhase(""); } catch (e) {}
                  showError("That turn failed before it finished.");
                  return;
                }
                // It finished after all. Read the turn back from the machine's own log so the
                // answer lands where it belongs instead of relying on what this page still holds.
                try { setPhase("worked"); } catch (e) {}
                try { if (window.setState) window.setState("idle"); } catch (e) {}
                try { if (window.__jarvisAttachTurn) window.__jarvisAttachTurn(tid, conv, 0); } catch (e) {}
                return;
              }
              if (n < 60) { setTimeout(function () { watch(conv, tid, n + 1); }, 2500); return; }
              showError("The screen lost its link partway through. The work may still be running; open "
                      + "this conversation again to see where it got to.");
            })
            .catch(function () { if (n < 60) setTimeout(function () { watch(conv, tid, n + 1); }, 2500); });
        })(fconv, ftid, 0);
        return;
      }
    }
    endFollow();
    canvasReleased();
    try { if (window.setState) window.setState("error"); } catch (e) {}
    showError(failureLine(ftxt));
  };

  // ------------------------------------------------------------------ the refresh button (B1)
  // Starting a new conversation was the engine's business and it did that much, but this page's
  // own surfaces are not the engine's: the answer, the ask, what was shown and the honest line all
  // stayed up, which reads as a button that does nothing. It is a two-step action in truth: the
  // first tap arms it and says so, the second does it.
  var resetArmed = false, resetTimer = null;
  function armReset() {
    resetArmed = true;
    var r = $("reset");
    if (r) {
      r.setAttribute("data-label", "Tap again to clear");
      r.setAttribute("aria-label", "Tap again to clear the conversation");
    }
    if (resetTimer) clearTimeout(resetTimer);
    resetTimer = setTimeout(function () {
      resetArmed = false;
      if (r) {
        r.removeAttribute("data-label");
        r.setAttribute("aria-label", "Start a new conversation. Press twice to confirm.");
      }
    }, 3000);
  }
  function disarmReset() {
    resetArmed = false;
    if (resetTimer) { clearTimeout(resetTimer); resetTimer = null; }
    var r = $("reset");
    if (r) {
      r.removeAttribute("data-label");
      r.setAttribute("aria-label", "Start a new conversation. Press twice to confirm.");
    }
  }
  // The guard runs in the capture phase on the document, ahead of the engine's own handler on the
  // button, so the first tap can be swallowed without touching the engine's wiring.
  document.addEventListener("click", function (e) {
    var t = e.target;
    if (!t || !t.closest || !t.closest("#reset")) return;
    if (!resetArmed) {
      armReset();
      e.preventDefault();
      e.stopPropagation();
    } else {
      disarmReset();
    }
  }, true);

  // Everything this page owns, cleared in one place. The engine's half of a reset (interrupt, post
  // /reset) is its own; this is the other half, and it is the only thing that takes the surfaces
  // down, so a new conversation cannot leave a piece of the old one standing.
  //
  // `paintAnswer()` is the load-bearing line. Copy and Share are hidden by it and by nothing else,
  // and the old handler cleared the answer's TEXT without telling the row the answer had gone: a
  // reset left an empty screen with a live Copy and Share on it, which is exactly what was
  // reported. Anything that empties the answer goes through here.
  function clearView() {
    turnEnded = true;                // anything still in flight must not redraw any of this
    markReset();                     // and nothing from before this point belongs to this conversation
    try { saveHistory([]); } catch (e) {}     // the conversation kept on the device goes too
    try { localStorage.removeItem(KEY); } catch (e) {}
    stopClock();
    // The pill holds its last word until it is told otherwise, and "WORKED 39s" left standing over a
    // brand new conversation is both a stale status counter and the thing that kept the empty screen
    // from coming back: the page reads an open phase as a turn in flight.
    setPhase("");
    clearError();
    captionText = ""; capShown = false; cap.textContent = "";
    answerText = ""; lastQ = ""; lastWidget = null;
    if (threadEl) // A refresh must not detach the turn that is still being answered: emptying the thread removed its
 // block from the page while the painters kept writing into it, so the answer went into a node nobody
 // could see - the question and its controls stayed and the answer never appeared.
 // Only a turn still being written keeps its block on the canvas; a finished one is already in the
 // record, and leaving it there put a question and its copy/share/retry icons on a brand new chat.
 var _keepLive = (liveBlock && !turnEnded && liveBlock.parentNode === threadEl) ? liveBlock : null;
 threadEl.textContent = "";
 if (_keepLive) threadEl.appendChild(_keepLive);
 else if (liveBlock) {
   try { for (var _k in blockByConv) { if (blockByConv[_k] && blockByConv[_k].b === liveBlock) delete blockByConv[_k]; } } catch (e) {}
   liveBlock = null; liveBlockQ = null; liveBlockAns = null; qEl = origQ; ans = origAns;
 }
    origAns.textContent = ""; origAns.style.display = "none";   // the old surface stays gone: showing it again put the previous answer under the new question
    origQ.textContent = ""; origQ.style.display = "none";
    if (heard) { heard.textContent = ""; heard.classList.remove("show"); }
    if (workEl) workEl.textContent = "";
    steps = []; lastStepObject = ""; paintSteps(); paintMeta();
    clearArtifact();
    body.classList.remove("has-art");
    closeSheet();
    paintAnswer();                   // the ask goes, and Copy/Share go with it
    t0 = 0;
  }

  (function () {
    var r = $("reset");
    if (!r) return;
    r.addEventListener("click", function () { clearView(); });
  })();

  // ------------------------------------------------------------------ the words in order (B9)
  // The engine paces the caption off the sound: each spoken sentence is its own unit, and the
  // clock says how much of it has been said. When nothing is playing (the phone is muted, or the
  // page was typed at instead of talked to) the engine paces every sentence at once, and the
  // words arrive sliced from several sentences at the same time. Printed in that order they read
  // as nonsense. The engine already holds the reply in order, so it hands it over: one guarded
  // call at the point it accumulates a token, and the page does no parsing of its own.
  window.__jarvisOrdered = function (text) { turnText = String(text == null ? "" : text); };

  // ------------------------------------------------------------------ the mode
  // Which way the answer comes back. The page decides it (the live button arms voice, the typing
  // box arms text) and tells this layer once, so the caption can render a read answer differently
  // from one being spoken: no pacing against a sound that does not exist, and no "already said"
  // stepping, because in text mode every word on the screen is the answer.
  window.__jarvisMode = function (m) { textMode = (m === "text"); };

  // The settled answer for a text turn, sent once before done. Last write wins, so a dropped
  // token delta can never leave a truncated answer on the screen.
  window.__jarvisSetReply = function (full) {
    if (!full) return;
    if (!evBelongsHere()) return;
    // Only this conversation's turn may write the answer being read. The stream reader already refuses
    // chunks from another conversation; this is the writer's own check.
    try {
      var _here = String(window.__jarvisConvId ? window.__jarvisConvId() : "");
      if (_here && _here !== "current" && turnConv && String(turnConv) !== _here) return;
    } catch (e) {}
    if (turnEnded) return;
    captionText = String(full == null ? "" : full);
    // The archived surface is what goes dark here. `ans` is the LIVE turn's answer once the running
    // turn is a block in the thread, so hiding it hid the answer the page had just been given.
    if (!capShown) { capShown = true; origAns.style.display = "none"; }
    if (textMode) paintAnswerBody(); else paintCaption();
    toBottom();
  };

  // ---------------------------------------------------------------- the hooks
  // ---------------------------------------------------------------- the turn nobody is watching
  // Switching conversations does not end the turn in flight: the engine keeps reading it and hands its
  // events here. This is where they go — a record of the turn, against the conversation it belongs to,
  // so it can be saved whole, words and work, even though no canvas showed it. The machine has already
  // written the words into that conversation's record; what only this page can add is the work trace,
  // and that is what this keeps.
  // One record per conversation for the turn nobody is watching. It was a single slot, so a second
  // chat finishing in the background took the first one's place and the first answer and its badge were
  // lost. A turn's work belongs to its conversation, so the record is kept per conversation.
  var backgroundBy = {};                 // conv -> { conv, turn, text, steps, notes }
  var turnQ = {};                        // conversation id -> the question asked in it
  var turnConv = "";                     // the conversation the turn in flight was asked in
  function bgFor(conv, turn) {
    var id = String(conv == null ? "current" : conv);
    var b = backgroundBy[id];
    if (!b) { b = backgroundBy[id] = { conv: id, turn: (turn == null ? null : turn), text: "", steps: [], notes: [], at: Date.now() }; }
    if (turn != null) b.turn = turn;
    b.at = Date.now();                    // a live record keeps its own clock fresh
    return b;
  }
  function bgGet(conv) {
    var id = String(conv == null ? "" : conv), b = backgroundBy[id];
    // A record is for a turn that is still running. One nobody ever ended — a closed tab, a turn that died
    // with the machine — would otherwise sit in the page for the life of the session.
    if (b && b.at && Date.now() - Number(b.at) > 15 * 60 * 1000) { delete backgroundBy[id]; return null; }
    return b || null;
  }
  function bgDrop(conv) {
    delete backgroundBy[String(conv == null ? "" : conv)];
  }
  window.__jarvisDetached = function (turn, conv) {
    // The view moved off a running turn. Nothing is thrown away: it is now a turn being finished for
    // the conversation he left, and the page records it when it ends. The steps it had already drawn
    // come with it — the work that happened while he was still watching is the same work — so the
    // stored trace is the whole turn rather than only the part that ran after he walked away.
    var b = bgFor(conv, turn);
    // The question travels with the turn: it is what the conversation is named after and what the record
    // is filed against, and it is known for certain here — this is the turn that was just detached.
    b.q = b.q || String(turnQ[String(conv == null ? "current" : conv)] || lastQ || "");
    if (!b.steps.length && steps && steps.length) {
      b.steps = steps.map(function (s) { return s; });
    }
  };
  window.__jarvisBackgroundEvent = function (ev, d, conv) {
    // The record this event belongs to is the one for the conversation the event names. Without that, a
    // second chat finishing in the background wrote into the first one's record: its words and its steps
    // went to the wrong chat.
    var b = bgGet(conv) || null;
    if (!b || !d) return;
    if (ev === "tok" && d.d) {
      // The fast layer can hand over the same text twice - once as it is produced and once
      // when the turn closes - which drew every short answer twice ("Paris.Paris."). A
      // second copy of everything already on the screen adds nothing.
      if (String(d.d) === b.text) return;
      b.text += String(d.d); return;
    }
    if (ev === "text" && d.text) { b.text = String(d.text); return; }
    if (ev === "term" || ev === "note") bgStep(ev, d, b);
  };
  // The steps of a turn nobody is watching. The live canvas builds richer rows — nested objects, the
  // agent's own sentences — and none of that survives into a stored trace anyway, which keeps the words
  // on the rows. This builds exactly those, so a turn that finished off screen is saved in the same
  // shape as one that finished on it.
  function bgStep(ev, d, b) {
    if (!b || !d) return;
    if (ev === "note" || d.kind === "note") {
      if (d.text) b.notes.push(String(d.text));
      return;
    }
    if (d.kind === "run" || (!d.kind && d.line)) {
      b.steps.push({ kind: "tool", tool: String(d.tool || ""),
                     title: safeStepText(d.title, d.tool), ok: null, running: true, ms: null });
      return;
    }
    var at = -1;
    for (var i = b.steps.length - 1; i >= 0; i--) {
      if (b.steps[i].kind === "tool" && b.steps[i].running &&
          (!d.tool || b.steps[i].tool === d.tool)) { at = i; break; }
    }
    if (at < 0) return;
    var row = b.steps[at];
    row.running = false; row.ok = d.ok !== false;
    if (d.ms != null) row.ms = d.ms;
  }
  // One finished turn, written into the conversation it was asked in — on this device by name, and on the
  // machine by the same name. Never the whole thread: the thread belongs to whatever conversations it came
  // from, and filing all of it here is how two conversations become one row and one becomes two.
  var REAL_NAME = /^[0-9a-fA-F]{8,40}$/;
  // The identity of one turn. Derived from the conversation, the question and the moment it began:
  // the same submission saved twice hashes the same and collapses; the same question asked again
  // later hashes differently and stands on its own, which is what makes a repeat legitimate.
  // THE turn's name, minted once when the question is asked and then used by everything: the block on
  // screen, the record, the request the machine is sent, and the open event it answers with. Two
  // derivations of one id is how a block and its saved turn came to disagree.
  var liveTid = "";
  var turnServerTid = "";
  var tidByConv = {};
  // Each turn's own work, kept under its id. The page-wide list is what the sheet is showing; this is
  // what the turn actually ran, and the badge is built from it. Losing the globals (a conversation
  // switch, a repaint) no longer loses the steps.
  var turnSteps = {};
  window.__jarvisTurnSteps = function () { return turnSteps; };
  function recordStep(tid, step) {
    var k = String(tid || "");
    if (!k) return;
    (turnSteps[k] = turnSteps[k] || []).push(step);
    var keys = Object.keys(turnSteps);
    if (keys.length > 40) { try { delete turnSteps[keys[0]]; } catch (e) {} }
  }

  // Point the painters at the block that owns this turn id. Returns false when no block on the canvas
  // carries it, which is the signal to leave the canvas alone rather than write into somebody else.
  function bindTurnById(tid) {
    var want = String(tid || "");
    if (!want || !threadEl) return false;
    var all = threadEl.querySelectorAll(".turn");
    for (var i = 0; i < all.length; i++) {
      if (String(all[i].dataset.id || "") === want) {
        liveBlock = all[i];
        liveBlockQ = all[i].querySelector(".t-q");
        liveBlockAns = all[i].querySelector(".t-a");
        qEl = liveBlockQ; ans = liveBlockAns;
        return true;
      }
    }
    // Coming back to a chat whose turn is still being written draws the question first, as a placeholder
    // that has no name yet — the machine's turn id is not known to the page at that moment. When the
    // first chunk arrives carrying that id, the placeholder IS this turn, so it takes the name and is
    // painted into. Without this, every chunk was refused as belonging elsewhere and the block sat
    // blank with its answer already in the record.
    var _conv = String((window.__jarvisEvCtx || {}).conv || "");
    var _run = threadEl.querySelectorAll('[data-running="1"]');
    var _pick = null;
    for (var _j = 0; _j < _run.length; _j++) {
      var _b = _run[_j];
      if (String(_b.dataset.id || "")) continue;
      var _bc = String(_b.getAttribute("data-conv") || "");
      if (_conv && _bc && _bc !== _conv) continue;
      _pick = _b; break;
    }
    if (_pick) {
      _pick.dataset.id = want;
      if (!_pick.dataset.t) _pick.dataset.t = String(Math.round(Date.now() / 1000));
      _pick.removeAttribute("data-running");
      liveBlock = _pick;
      liveBlockQ = _pick.querySelector(".t-q");
      liveBlockAns = _pick.querySelector(".t-a");
      if (!liveBlockAns) {
        liveBlockAns = document.createElement("div");
        liveBlockAns.className = "t-a";
        _pick.appendChild(liveBlockAns);
      }
      qEl = liveBlockQ; ans = liveBlockAns;
      try { blockByConv[String(_pick.getAttribute("data-conv") || "")] = _pick; } catch (e) {}
      return true;
    }
    return false;
  }

  // A painter may only write into the turn the event belongs to. The machine stamps each chunk with
  // its turn id; when that id is not the block the painters are pointing at, the block with that id
  // is taken instead, and if the canvas holds no such turn the chunk is refused. One chat's words
  // landing in another turn of the same chat stops being possible here rather than merely unlikely.
  function evBelongsHere() {
    try {
      var c = window.__jarvisEvCtx || null;
      if (!c || !c.tid) return true;
      if (liveBlock && String(liveBlock.dataset.id || "") === String(c.tid)) return true;
      if (bindTurnById(c.tid)) return true;
      window.__jarvisDropped = (window.__jarvisDropped || 0) + 1;
      window.__jarvisDroppedWhy = { ev: c.ev, tid: c.tid, block: (liveBlock && liveBlock.dataset.id) || "" };
      return false;
    } catch (e) { return true; }
  }
  function turnTid(conv, q, startedAt) {
    var seed = String(conv || "current") + "|" + String(q || "") + "|" + String(startedAt || 0);
    var h = 0x811c9dc5;
    for (var i = 0; i < seed.length; i++) {
      h ^= seed.charCodeAt(i);
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return ("0000000" + h.toString(16)).slice(-8) + ("0000000" + seed.length.toString(16)).slice(-8);
  }

  function saveTurnInto(conv, q, said, trace, quiet) {
    var id = String(conv == null ? "" : conv);
    var words = stripScreenAnnounce(String(said || "").trim());
    q = String(q || "").trim();
    // A ring of what was filed, and where: when words turn up under the wrong conversation this is the
    // record that says which call did it, instead of a theory about which one might have.
    try {
      window.__jarvisSaveLog = window.__jarvisSaveLog || [];
      window.__jarvisSaveLog.push({ at: Date.now(), conv: id.slice(0, 12), q: q.slice(0, 26), a: words.slice(0, 22) });
      if (window.__jarvisSaveLog.length > 40) window.__jarvisSaveLog.shift();
    } catch (e) {}
    if (!words || !q) return false;
    // A conversation this page cannot name is not filed at all — not on this device, not on the machine.
    // Filing it under "current" (whatever window the machine is in) is what put one chat's turns into
    // another, and it also made a second row with the same question beside the real chat.
    if (!REAL_NAME.test(id)) return false;
    var rec = devGet(id) ||
              { id: id || "current", title: concTitle(q) || "New conversation",
                started: Date.now() / 1000, turns: [] };
    var startedAt = Math.round((t0 || Date.now()) / 1000);
    // The machine's number when there is one — that is the record the server kept — and the
    // derived hash only when the page has no number to use.
    // The record only accepts a hex identity, and the machine's own number is an integer, so the
    // number was silently dropped on every save: the record never carried a turn id at all.
    // The derived id is hex and stable for the turn; the machine's number travels beside it.
    var tid = String(tidByConv[id] || (String(turnConv) === id && liveTid ? liveTid : "") || turnTid(id, q, startedAt));
    // Only this turn is replaced when it is saved again. Two genuine asks of one question are
    // two turns and both stay; a turn saved twice is one turn and stays one.
    // The same turn, in whatever form it was last stored: matched on its number, and also on its
    // question together with its own start time — because a copy written before the turn had a number
    // carries no number at all, and the old test kept exactly those copies. That is how one question
    // came to sit in the record twice, painted once from the thread and once on the live surface.
    var keep = (rec.turns || []).filter(function (t) {
      if (tid && String(t.tid || "") === tid) return false;
      if (String(t.q || "") === q) {
        var started = Math.round(t.startedAt || t.t || 0);
        if (!started || !startedAt || started === startedAt) return false;
        if (Math.abs(started - startedAt) <= 2) return false;      // the same turn, a second apart
      }
      return true;
    });
    // The turn's own absolute start travels with it: the page knows when it began, and without that stamp a
    // screen arriving later can only be told how long the turn took, never count it.
    // The turn's time is when it began, never when it was written: a second save of the same turn
    // used to stamp a later second, which made one turn look like two.
    // How long the turn took travels with it. Without this the record could say what the turn did and
    // never how long it took, so a reopened chat lost the badge the live one had shown.
    // This turn's own steps, from the store keyed by its id. The list handed in is what the caller had
    // to hand; the store is what the turn actually ran, and the badge was built from it — so the record
    // and the badge can never disagree about whether any work happened.
    try {
      var _ownS = leanSteps((turnSteps[String(tid)] || []).filter(function (x) { return x && !x.running; }));
      if (_ownS.length) trace = _ownS;
    } catch (e) {}
    var durMs = Number((bgMsBy[String(id)] || 0)) || Number(workMs || 0) ||
                (t0 ? Math.max(0, Date.now() - t0) : 0);
    keep.push({ q: q, a: words, t: Math.round((t0 || Date.now()) / 1000), s: trace || [], tid: tid,
                srv: String(turnServerId || ""),
                startedAt: Math.round((t0 || Date.now()) / 1000),
                ms: Math.round(durMs),
                // The conversation this turn was asked in. Without it the machine had only the page's
                // word for where the turn belonged, and a history saved while the page did not know its
                // own conversation's name was filed against whichever window the machine was in.
                cid: REAL_NAME.test(id) ? id : "" });
    rec.turns = keep.slice(-40);
    rec.title = rec.title || concTitle(q) || "New conversation";
    rec.updated = Math.round(Date.now() / 1000);
    devPut(rec);
    try {
      // Only this conversation's turns travel: an unnamed page sends the single turn it is saving rather
      // than a history the machine would have to guess the owner of.
      var body = { turns: REAL_NAME.test(id) ? keep : keep.filter(function (t) {
        return String(t.q || "") === q;
      }) };
      // A name this page is sure of is sent; a placeholder is the machine's to resolve, and it knows which
      // conversation its own window is.
      if (REAL_NAME.test(id)) body.id = id;
      // Only a turn that knows its own name may be filed, and only under the conversation it was asked
      // in. Anything else becomes a duplicate conversation carrying the same question under a new name.
      body.turns = (body.turns || []).filter(function (t) {
        return t && t.tid && REAL_NAME.test(String(t.tid));
      });
      if (!body.turns.length) return;
      fetch("/api/sessions", { method: "POST", credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      }).then(function (resp) {
        // The machine holds this conversation now, so the placeholder row this device made for it gives
        // way to the real one.
        if (resp && resp.ok) { try { provDrop(id); } catch (e) {} }
        if (typeof window.__jarvisSessionsChanged === "function") window.__jarvisSessionsChanged();
      }).catch(function () {});
    } catch (e) {}
    if (!quiet) {
      // A conversation answered while he was looking elsewhere says so quietly, so a row he comes back to
      // is not a row he has to open to find out that it is done.
      toast("Answered in the background: " + (concTitle(q) || "that question"), 2200);
    }
    return true;
  }
  window.__jarvisSaveTurn = saveTurnInto;

  window.__jarvisBackgroundEnd = function (conv, text) {
    try {
      var _tb = document.querySelector('.turn[data-running="1"]') || liveBlock;
      if (_tb) _tb.dataset.ta = String(Math.round(Date.now() / 1000));
    } catch (e) {}
    var id = String(conv == null ? "current" : conv);
    var b = bgGet(id);
    var said = String(text || (b && b.text) || "");
    var trace = leanSteps(((b && b.steps) || []).filter(function (s) { return !s.running; }));
    var q = (b && b.q) || turnQ[id] || "";
    if (b) bgDrop(id);                      // only this turn's record is cleared, never another's
    lastBgSteps = trace || [];              // the badge and the summary both read this turn's work
    // If that conversation is the one on screen, its answer is repainted from the final words. What was
    // painted while it ran was a partial stream — a table cut off mid-row is the shape that used to sit
    // there until he opened the chat again.
    try {
      if (String(activeId) === id && threadEl) {
        var _eb = null, _bs = threadEl.querySelectorAll(".turn");
        for (var _i = 0; _i < _bs.length; _i++) {
          var _bq = String(((_bs[_i].querySelector(".t-q") || {}).textContent) || "").trim();
          if (_bq && _bq === String(q || "").trim()) { _eb = _bs[_i]; }
        }
        if (_eb && said) {
          var _ea = _eb.querySelector(".t-a");
          if (!_ea) { _ea = document.createElement("div"); _ea.className = "t-a"; _eb.appendChild(_ea); }
          settleBody(_ea, said, turnShape);
        }
      }
    } catch (e) {}
    if (id) { bgStepsBy[id] = trace || []; bgMsBy[id] = Number((b && b.ms) || 0) || 0; }
    saveTurnInto(id, q, said, trace, false);
  };
  // Nothing to re-bind to: the turn ended between the page deciding to come back and the request
  // landing, or its log has been swept. The record is on the canvas already, so saying nothing is the
  // honest answer — an error line here would be about the page's bookkeeping, not about his question.
  window.__jarvisRebindFailed = function () {};
  // Coming back to a conversation whose turn is still being written: the words it produced while he was
  // away are in the page's own record, so they go onto the canvas before the live events continue.
  function paintBackground(conv) {
    var b0 = bgGet(conv);
    if (!b0) return false;
    var said = String(b0.text || "").trim();
    var rows = (b0.steps || []).filter(function (s) { return !s.running; });
    // The record is NOT consumed here. Coming back to look at a chat that is still working used to take
    // the record away from the ending that still needed it: the answer then landed with no question to
    // file it under and no steps to badge it with, and the turn vanished from the chat. Only the ending
    // clears a record (__jarvisBackgroundEnd), never a look at it.
    if (rows.length) { steps = rows.concat(steps || []); paintSteps(); }
    return true;
  }

  // The machine's own number for the turn it is running. The page keeps it so the record it saves
  // can be joined exactly to the record the machine keeps, not to a hash of the question.
  var turnServerId = "";
  window.__jarvisTurnId = function (turn, conv, attached, q, tid) {
    if (turn != null && String(turn) !== "") turnServerId = String(turn);
    // The id the machine published for this turn. It is the page's own when the request carried one,
    // and the machine's when it had to mint it; either way it replaces anything derived here.
    if (tid) {
      turnServerTid = String(tid);
      if (liveBlock) {
        try {
          // The work already recorded under the name the page gave this turn belongs to the same turn:
          // move it to the name the machine published, or the badge looks under a key with nothing in it.
          var _was = String(liveBlock.dataset.id || "");
          if (_was && _was !== turnServerTid) {
            if (turnSteps[_was]) { turnSteps[turnServerTid] = turnSteps[_was]; delete turnSteps[_was]; }
            if (turnMs[_was]) { turnMs[turnServerTid] = turnMs[_was]; delete turnMs[_was]; }
          }
          liveBlock.dataset.id = turnServerTid;
        } catch (e) {}
      }
      var _c = String(conv || turnConv || "");
      if (_c && _c !== "current") tidByConv[_c] = turnServerTid;
    }
    // Every turn announces itself here: its number, the conversation it was asked in, whether this is a
    // re-bind rather than a fresh start, and — when the machine hands one over mid-flight — the question
    // it was asked with. A turn re-bound after a reload has no page-side start to have recorded its
    // question, and without it the answer would be saved under a blank name.
    var name = conv ? String(conv) : "";
    // "current" is the machine's word for the window it happens to be in, not a conversation. When the
    // machine has no name for this turn but this page does, the page's name is the true one: adopting
    // "current" here meant the turn was saved with no conversation to go to and was dropped, which is
    // why a NEW chat's first answer arrived with no record, no steps and no WORKED pill.
    if (!REAL_NAME.test(name)) {
      var _mine = "";
      try { _mine = String(window.__jarvisConvId ? window.__jarvisConvId() : ""); } catch (e) {}
      if (REAL_NAME.test(_mine)) name = _mine;
    }
    if (name && turnConv && name !== turnConv) {
      // The machine has just named the conversation this turn is being written in. The turn's own record
      // follows it, so its answer is filed under the real name rather than the placeholder it started on.
      // (This read a page-wide `background` slot that no longer exists; the throw stopped everything after
      // it — including the machine's turn id — which is why a NEW chat's first answer arrived with no
      // steps and no WORKED pill.)
      var _old = String(turnConv), _b = backgroundBy[_old];
      if (_b) { delete backgroundBy[_old]; _b.conv = name; backgroundBy[name] = _b; }
      if (turnQ[_old]) { turnQ[name] = turnQ[_old]; }
      if (tidByConv[_old]) { tidByConv[name] = tidByConv[_old]; }
    }
    if (name) turnConv = name;
    var qt = (q && String(q).trim()) || "";
    if (qt && turnConv) { turnQ[turnConv] = qt; lastQ = qt; }
    // And the page takes the same name for the conversation it is showing, so what it saves and what the
    // machine saves are one conversation, not two rows with the same question in them.
    try { if (name && window.__jarvisAdoptConversation) window.__jarvisAdoptConversation(name); } catch (e) {}
    // Coming back to a turn the machine is still writing. The canvas has to be put back the way he left it
    // before the words resume: the question he asked, on the live surface, with what has already been done
    // about it following from the machine's own log. A re-bound turn never went through the page's own
    // start — a reload holds no memory of it — and without this the screen is a blank one with a working
    // light on it, which reads as a chat that swallowed his question. When the canvas already shows this
    // question the turn is being read on it still, and nothing is repainted.
    if (attached && qt && qt !== lastQ) {
      try { window.__jarvisTurnStart(qt, name || turnConv); } catch (e) {}
      try { showRunningQuestion(name || turnConv, qt); } catch (e) {}
    }
  };

  window.__jarvisTurnStart = function (q, conv) {
    // The question belongs to the conversation it was asked in, not to whatever is on the canvas when
    // the answer lands: a turn that finishes off screen still has to be filed under its own question.
    var cid = String(conv == null ? "current" : conv);
    turnConv = cid;                        // this turn is filed under this name, wherever the canvas goes
    // One name for this turn, decided here and never recomputed: the question text and the second it
    // was asked are the seed, and every later reader (block, save, request) uses this value.
    // A question that was held for want of a connection keeps the id it was first given, so the retry
    // is recognised by the machine as the same question rather than a second one.
    var _held = "";
    try { _held = String(window.__jarvisPendingTid || ""); window.__jarvisPendingTid = ""; } catch (e) {}
    liveTid = _held || turnTid(cid, (q && String(q).trim()) || "", Math.round(Date.now() / 1000));
    turnServerTid = "";
    if (cid && cid !== "current") tidByConv[cid] = liveTid;
    turnQ[cid] = (q && String(q).trim()) || turnQ[cid] || "";
    var ids = Object.keys(turnQ);
    if (ids.length > 6) delete turnQ[ids[0]];
    canvasReleased();                           // a turn cannot start on a canvas a modal froze
    endFollow();
    body.removeAttribute("data-past");          // a new turn is not a past one
    // The finished turn moves into the thread above before the new one takes the live surface, so
    // what he just asked and what is being written about it are one block, and everything before it
    // is dimmed behind.
    if (regenerating) regenerating = false;
    else retireTurn();
    var said = (heard && heard.textContent || "").trim();
    lastQ = (q && String(q).trim()) || said || "";
    // The new turn takes its place in the thread at once, so what he is waiting on is drawn in the list
    // where the answer will appear, not on a surface beside it.
    try { startLiveBlock(lastQ); } catch (e) {}
    captionText = ""; capShown = false; turnEnded = false; answerSettled = false;
    following = true;                          // a live turn is the one thing that follows the words
    cap.textContent = "";
    clearError();
    try { hideWorkingPill(); } catch (e) {}     // his own turn is not a background one
    steps = []; lastStepObject = ""; paintSteps(); stepsEl && stepsEl.scrollTo && stepsEl.scrollTo(0, 0);
    paintMeta();
    if (artEl.firstChild) { fadeArtifactOut(clearArtifact); } else { clearArtifact(); }
    // The new block starts empty. The answer of the turn before is painted above it, where it belongs;
    // carrying `answerText` into this one put the previous reply straight under the new question the
    // moment it was asked, and the reply he was waiting for then replaced it in place.
    answerText = "";
    paintAnswer();
    t0 = Date.now();
    startClock();
    checkBottom();
    alignTurnToTop(true);                      // the new turn opens at the top of the canvas
  };

  // A question refused because this chat is still answering. Its block was drawn by the turn start and
  // never received a word, so it comes down rather than standing there as a question with no answer.
  // The one action that makes the send legal is offered: stop the turn in front of it, then ask again.
  window.__jarvisTurnRefused = function (info, question) {
    try {
      if (liveBlock && liveBlock.parentNode) {
        var _a = liveBlock.querySelector(".t-a");
        if (!_a || !String(_a.textContent || "").trim()) liveBlock.parentNode.removeChild(liveBlock);
      }
    } catch (e) {}
    liveBlock = null; liveBlockQ = null; liveBlockAns = null;
    qEl = origQ; ans = origAns;
    lastQ = ""; answerText = ""; steps = []; answerSettled = true;
    try { paintSteps(); paintMeta(); } catch (e) {}
    try { setPhase(""); } catch (e) {}
    var busyQ = String((info && info.q) || "").trim();
    askConfirm({
      title: "Still answering here",
      body: busyQ ? ("Working on: " + busyQ) : "A turn in this chat is still running.",
      yes: "Stop it and send",
      onYes: function () {
        // The stop is his own act, and the turn it stopped keeps its question. Saying so on the
        // block is the difference between an answer that never came and an answer he called off.
        try {
          var _bid = String((info && info.tid) || "");
          var _blocks = threadEl ? threadEl.querySelectorAll(".turn") : [];
          for (var _i = 0; _i < _blocks.length; _i++) {
            if (String(_blocks[_i].dataset.id || "") === _bid) {
              var _ta = _blocks[_i].querySelector(".t-a");
              if (_ta && !String(_ta.textContent || "").trim()) _ta.textContent = "Stopped.";
              break;
            }
          }
        } catch (e) {}
        fetch("/cancel", { method: "POST", credentials: "same-origin",
                           headers: { "Content-Type": "application/json" },
                           body: JSON.stringify({ turn: (info && info.turn) || null,
                                                  tid: (info && info.tid) || "" }) })
          .then(function () { return new Promise(function (r) { setTimeout(r, 400); }); })
          .then(function () { try { if (window.ask) window.ask(question); } catch (e) {} });
      }
    });
  };

  // A question with nowhere to go. The text goes back into the box, the id is kept, and the question
  // is sent again when the connection returns — with the same id, so the machine answers it once even
  // if the first attempt did reach it.
  var OUTBOX = "jl_outbox";
  window.__jarvisHoldQuestion = function (q, conv, tid) {
    var text = String(q || "");
    if (!text.trim()) return false;
    // Only a page that is actually offline holds a question. Online, a send that fails is a dropped
    // link, and the page re-binds to the turn; putting his words back into the box at that moment is
    // how a question asked in one chat turned up in the composer of another.
    try { if (navigator.onLine !== false) return false; } catch (e) { return false; }
    try { localStorage.setItem(OUTBOX, JSON.stringify({ q: window.__jarvisRedact(text), conv: String(conv || ""), tid: String(tid || ""), at: Date.now() })); }
    catch (e) { return false; }
    // The question was drawn before it was sent anywhere; it comes down, because nothing is answering it.
    try {
      if (liveBlock && liveBlock.parentNode) {
        var _a = liveBlock.querySelector(".t-a");
        if (!_a || !String(_a.textContent || "").trim()) liveBlock.parentNode.removeChild(liveBlock);
      }
    } catch (e) {}
    liveBlock = null; liveBlockQ = null; liveBlockAns = null;
    qEl = origQ; ans = origAns;
    lastQ = ""; answerText = ""; steps = []; answerSettled = true;
    try { paintSteps(); paintMeta(); } catch (e) {}
    try { setPhase(""); } catch (e) {}
    // And it only comes back into the box of the conversation it was asked in, and only when the box
    // is empty: an answer already half-typed is never replaced by an old question.
    try {
      var here = (typeof activeId === "string") ? String(activeId) : "";
      var box = document.getElementById("q");
      if (box && (!conv || !here || String(conv) === here) && !String(box.value || "").trim()) {
        var set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
        set.call(box, text);
        box.dispatchEvent(new Event("input", { bubbles: true }));
      }
    } catch (e) {}
    try { toast("No connection. Your question is kept."); } catch (e) {}
    return true;
  };

  function retryHeldQuestion() {
    var raw = "";
    try { raw = localStorage.getItem(OUTBOX) || ""; } catch (e) {}
    if (!raw) return;
    var o = null;
    try { o = JSON.parse(raw); } catch (e) {}
    try { localStorage.removeItem(OUTBOX); } catch (e) {}
    if (!o || !o.q) return;
    if (Date.now() - (Number(o.at) || 0) > 86400000) return;      // a day-old question is not sent silently
    window.__jarvisPendingTid = String(o.tid || "");
    try { if (window.ask) window.ask(o.q); } catch (e) {}
  }
  window.__jarvisRetryHeld = retryHeldQuestion;
  try { window.addEventListener("online", retryHeldQuestion); } catch (e) {}
  // A held question is sent back to the conversation it was asked in. When he is standing in another
  // one, it waits there rather than arriving in the wrong chat.
  var _retryHeld = retryHeldQuestion;
  retryHeldQuestion = function () {
    try {
      var o = JSON.parse(localStorage.getItem(OUTBOX) || "null");
      var here = (typeof activeId === "string") ? String(activeId) : "";
      if (o && o.conv && here && String(o.conv) !== here) return;
    } catch (e) {}
    return _retryHeld();
  };
  window.__jarvisRetryHeld = retryHeldQuestion;
  try { if (navigator.onLine) setTimeout(retryHeldQuestion, 1500); } catch (e) {}

  window.__jarvisReply = function (chunk) {
    if (!chunk) return;
    if (!evBelongsHere()) return;
    // The words keep arriving after the turn is done, as the tail of the speech drains. They are
    // already held in the answer, and taking them here would push the answer off the screen and
    // print the leftovers as a caption that reads as nonsense.
    if (turnEnded) return;
    captionText += String(chunk);
    if (!capShown) { capShown = true; origAns.style.display = "none"; }
    // In text mode the answer itself is on screen as it arrives, so the spoken line would be the same
    // words a second time. It stays for voice, where the stepped-back reading line is the point.
    if (textMode) paintAnswerBody(); else paintCaption();
    toBottom();
  };

  // The live line, with the part already spoken stepped back so the reading eye stays at the front
  // of it. Rebuilt per chunk, which is cheap at these sizes.
  function paintCaption() {
    var said = String(captionText);
    var text = said;
    if (!textMode && turnText && turnText.length >= said.length) text = turnText.slice(0, said.length);
    var parts = text.match(/[^.!?\n]+[.!?\n]*\s*/g) || [text];
    cap.textContent = "";
    parts.forEach(function (s, i) {
      var sp = document.createElement("span");
      sp.textContent = s;
      if (!textMode && i < parts.length - 1) sp.className = "said";
      cap.appendChild(sp);
    });
  }

  // The shape this turn was routed to, sent by the server before its first word. It decides the one
  // thing the words alone cannot: a run of "- " lines is cards when he asked for options and bullets
  // when he asked for an explanation. Empty means the router said prose, or said nothing.
  var turnShape = "";
  window.__jarvisFormat = function (d) { turnShape = String((d && d.shape) || ""); };

  window.__jarvisTurnEnd = function (full) {
    // The answer's own clock: this is when it finished, not when the question was asked.
    try { if (liveBlock) liveBlock.dataset.ta = String(Math.round(Date.now() / 1000)); } catch (e) {}
    // A turn ends in the conversation it was asked in, not in whichever one happens to be on screen.
    // This painter took no conversation at all, so a turn finishing in A while B was open wrote A's
    // answer and A's WORKED pill onto B. When the two names are both known and differ, the ending is
    // filed to its own conversation instead of being drawn here.
    var hereNow = "";
    try { hereNow = String(window.__jarvisConvId ? window.__jarvisConvId() : ""); } catch (e) {}
    if (hereNow && hereNow !== "current" && turnConv && String(turnConv) !== hereNow) {
      try { window.__jarvisBackgroundEnd && window.__jarvisBackgroundEnd(turnConv, full); } catch (e) {}
      return;
    }
    // Same chat, different turn: the ending belongs to its own block or to none.
    if (!evBelongsHere()) return;
    if (textMode && liveBlock && liveBlock.dataset.agentFailed) {
      turnEnded = true; answerSettled = true;
      answerText = ""; captionText = ""; turnText = "";
      if (cap) cap.textContent = "";
      endFollow(); canvasReleased(); hideWorkingPill(); setPhase("");
      return;
    }
    var said = stripScreenAnnounce((full && String(full).trim()) || captionText || "");
    turnEnded = true;
    answerSettled = true;
    settledAt = Date.now();        // the clock the speaking ceiling counts from
    if (said) { answerText = said; }
    captionText = ""; capShown = false;
    cap.textContent = "";
    // The turn block holds the answer, so the ARCHIVED surface stays gone. `ans` is the block's own
    // answer element by now, so hiding it hid the finished answer: the question stayed, the reply
    // never appeared, and the record showed it had been written.
    origAns.style.display = "none";
paintAnswer();
    fitArtifact();
// Now the answer is in hand, so the controls cover it: copy, share and retry arrive with the answer,
// not when the next question retires the turn.
try { if (liveBlock) attachTurnActions(liveBlock, String((liveBlock.querySelector(".t-q") || {}).textContent || "").trim() || lastQ, answerText); } catch (e) {}                             // the answer now shares the room with the visual
    // The chat he is looking at is read the moment its answer lands.
    try { if (String(turnConv) === String(activeId)) markRead(turnConv, Date.now() / 1000); } catch (e) {}
    // Everything that decides which block this ending is about reads the turn's name from here.
    retiringTid = String((window.__jarvisEvCtx || {}).tid || liveTid || "");
    // The badge goes up with the answer, on this turn's own block, from this turn's own steps. It used
    // to appear only when the NEXT question retired the block, so a finished answer sat there with no
    // account of the work behind it until he asked something else.
    try {
      var _eid = retiringTid;
      if (_eid && threadEl) {
        var _bs = threadEl.querySelectorAll(".turn"), _bb = null;
        for (var _j = 0; _j < _bs.length; _j++) {
          if (String(_bs[_j].dataset.id || "") === _eid) { _bb = _bs[_j]; break; }
        }
        // The elapsed time at the moment the turn ends. The page-wide clock is written a little later
        // than this, so reading it here would badge every turn with no duration.
        var _ms = msForTurn(_eid, turnConv);
        var _own2 = (turnSteps[_eid] || []).filter(Boolean);
        if (!_own2.length) {
          // The steps were gathered under the conversation while he was away; they belong to this turn,
          // so they are adopted under its id before anything is painted or saved.
          try {
            var _bg2 = bgStepsFor(turnConv) || [];
            if (_bg2.length) { turnSteps[_eid] = _bg2.slice(); _own2 = _bg2; }
          } catch (e) {}
        }
        try { if (_eid) turnMs[_eid] = _ms; } catch (e) {}
        if (_bb) paintPill(_bb, _own2, _ms);
      }
    } catch (e) {}
    settle();
    // A turn that ended while he was looking elsewhere belongs to the conversation he asked in, and that
    // is where it has just been written. Filing it here as well would put his answer into a conversation
    // he never asked it in — the phantom row, with the question missing from it.
    // The finished turn is filed under the conversation it was asked in — by name, whether or not this
    // canvas is showing it, because a turn that finished while he looked elsewhere is still his answer to
    // the question he asked. Then the device's own recall list keeps its copy.
    // The badge and the summary both read this turn's own work: from the canvas when this canvas read the
    // turn, and from the record kept while it ran elsewhere when it did not. The steps go into the canvas's
    // own list as well, so tapping the badge opens a summary with the real trace rather than reporting that
    // nothing ran.
    try {
      var _bgOwn = bgStepsFor(turnConv);
      if ((!steps || !steps.length) && _bgOwn.length) {
        steps = _bgOwn;
        try { paintSteps(); } catch (e) {}
      }
      var _ms = Date.now() - (t0 || Date.now());
      if (!_ms || _ms < 1000) _ms = lastBgMs || _ms;
      // The pill reports the work of the turn that just ended, in that turn's conversation only. A
      // completion arriving for another conversation must not paint this one's pill with its count.
      var _herePill = "";
      try { _herePill = String(window.__jarvisConvId ? window.__jarvisConvId() : ""); } catch (e) {}
      if (!(_herePill && _herePill !== "current" && turnConv && String(turnConv) !== _herePill)) {
        finishWorkingPill(steps, _ms);
      }
      // What is still missing is asked for. The conversation's own record holds this turn's work and how long
      // it took, and neither this canvas nor the page's note may have it: a turn watched through the machine's
      // replay, or one read on a screen that has since been replaced. Without this the badge counts nothing
      // and the summary behind it says nothing ran.
      (function (conv) {
        if (!conv || (steps && steps.length)) return;
        fetch("/api/sessions/" + encodeURIComponent(conv), { credentials: "same-origin" })
          .then(function (r) { return r.ok ? r.json() : null; })
          .then(function (dd2) {
            var turn = (dd2 && dd2.turns) ? dd2.turns[dd2.turns.length - 1] : null;
            if (!turn || !(turn.s || []).length) return;
            if (steps && steps.length) return;              // the canvas filled it in meanwhile
            steps = (turn.s || []).slice();
            if (turn.ms) t0 = Date.now() - Number(turn.ms);
            try { paintSteps(); } catch (e) {}
            try { finishWorkingPill(steps, Number(turn.ms || _ms)); } catch (e) {}
          })
          .catch(function () {});
      })(turnConv);
    } catch (e) {}
    try { if (turnConv) window.__jarvisSaveTurn(turnConv, lastQ, said, steps, true); } catch (e) {}
    // A step can land a moment after the answer ends — a fast command whose finish arrives with the last
    // token. One re-save a second later, under the same name, keeps the turn's work whole; the machine
    // merges it into the turn it already has, and a trace only ever grows.
    try {
      // Captured now, not read later: by the time this fires, the next turn has taken these names over, and
      // a late read filed this turn's answer into the next conversation — one chat's words under another
      // chat's heading.
      (function (c, q, w, st) {
        setTimeout(function () {
          try { if (c) window.__jarvisSaveTurn(c, q, w, st, true); } catch (e) {}
        }, 1500);
      })(turnConv, lastQ, said, (steps || []).slice());
    } catch (e) {}
    try { window.__jarvisKeepTurn(lastQ, said, steps); } catch (e) { remember(); }
    toBottom();                                 // the one last settle, with the follow still on
    endFollow();                                // the turn is over: nothing moves the canvas again
    canvasReleased();                           // and the scroll belongs to him, modal or not
  };

  window.__jarvisTerm = function (d) {
    if (!d) return;
    // A step belongs to the turn that ran it. If this event names a turn whose block is not the one
    // on the canvas, the step is not this answer's work: it must not enter the list the pill is
    // built from, or another chat's work ends up printed under this reply.
    if (!evBelongsHere()) return;
    // A note is a note wherever it arrives from: routing it into the finish branch would close a
    // running step with a sentence and lose the line.
    if (d.kind === "note") return window.__jarvisNote(d);
    if (d.kind === "run" || (!d.kind && d.line)) {
      // Anything the agent actually runs is WORKING, whatever it was doing a moment before: a
      // command, a browser query, a script. This is the other half of the loop with THINKING. Only when
      // the step belongs to the conversation on the screen: the trace is kept either way.
      var here = mineHere(d);
      if (here) setPhase("working");
      // A step starts. `title` is the plain-language sentence the Summary shows; `line` is the
      // raw command, kept for the expanded row. An event with no kind at all is the old shape,
      // which always arrived already finished, so only a real `run` is left running.
      var isStart = d.kind === "run";
      // The agent's own description of the work wins over anything derived from the call: it is the
      // only source that says what the step was FOR, and it keeps code and command text off the
      // screen. The derived title then becomes the line nested underneath, naming the concrete
      // thing that was touched, so every step reads as a description with its detail below it
      // whether or not the agent says anything else.
      var derived = safeStepText(d.title, d.tool);
      // The runtime hands over no arguments for any call, so "no input" is not evidence of a
      // continuation and nothing may be inherited from the step before: the object is read from the
      // call's own words or there is no object at all.
      var object = stepObject(d);
      var said = pendingNote;
      pendingNote = null;
      // The agent's own note reads best when it is a sentence, and the server's plain phrasing is
      // the better line when the note was only the command it ran ("terminal: df -h /"). Keep the
      // note when it is words, fall back to the plain phrase, and only then to the tool's own verb.
      var spoken = (said && !commandLikeStep(String(said))) ? String(said) : "";
      var _st = ({ kind: "tool", tool: d.tool || "",
                   line: String(d.line || ""),
                   title: spoken || derived || safeStepText(said, d.tool),
                   running: isStart, ok: isStart ? null : (d.ok !== false),
                   ms: d.ms != null ? d.ms : null, out: "",
                   kids: object && object !== (spoken || derived) ? [object] : [] });
      steps.push(_st);
      try { recordStep((window.__jarvisEvCtx || {}).tid || liveTid, _st); } catch (e) {}
    } else {
      // The finish closes the last running step of the same tool: a result that arrives out of
      // order must not close somebody else's row.
      var at = -1;
      for (var i = steps.length - 1; i >= 0; i--) {
        if (steps[i].kind === "tool" && steps[i].running &&
            (!d.tool || steps[i].tool === d.tool)) { at = i; break; }
      }
      if (at < 0) return;
      steps[at].running = false;
      steps[at].ok = d.ok !== false;
      steps[at].ms = d.ms;
      steps[at].out = String(d.line || "");
      // The tool has finished and the agent is reasoning again: back to THINKING, which is the other
      // half of the loop. Only a turn that has actually ended is WORKED. This belongs in the finish
      // branch and nowhere else — set after the branch it overwrote WORKING in the same tick, so
      // WORKING never once reached the screen.
      if (here) setPhase(tick ? "thinking" : "worked");
    }
    paintSteps();
    paintMeta();
    // The Summary scrolls itself only while it is open; paintSteps keeps the bottom in view.
  };

  // One line of what the agent was working out, from its own intermediate text. It sits in the
  // Summary; it is never the caption and never the answer.
  window.__jarvisNote = function (d) {
    if (!evBelongsHere()) return;
    if (d && d.partial) {
      turnPartial = true;
      if (liveBlock) liveBlock.dataset.responsePartial = "true";
      updateTurnVerdict(liveBlock);
    }
    var t = d && d.text ? String(d.text).trim() : "";
    if (!t) return;
    if (answerText && t === String(answerText).trim()) return;
    var line = t;
    // The agent narrating is the agent reasoning: whatever ran a moment ago is finished and it is
    // thinking again, which is what puts the pill back to THINKING between two tools. Never for another
    // conversation's turn: this one is idle and stays idle.
    if (mineHere(d)) setPhase("thinking");
    // While a step is running, the agent is saying what it found: that belongs to that step and
    // nests under it. With nothing running it is stating what it is about to do, so it is held and
    // the next step takes it as its own title. That is where a readable chip comes from, and it is
    // why a chip no longer has to fall back to dumping the call's arguments on the screen.
    for (var i = steps.length - 1; i >= 0; i--) {
      if (steps[i].kind === "note") continue;
      if (steps[i].running) {
        var detail = stepObject(steps[i]);
        steps[i].kids = steps[i].kids || [];
        if (detail && detail !== steps[i].title && steps[i].kids.indexOf(detail) < 0) steps[i].kids.push(detail);
        paintSteps();
        return;
      }
      break;
    }
    if (pendingNote === line) return;
    pendingNote = line;
    paintSteps();
  };

  window.__jarvisLevel = function (buf, dir) {
    if (!buf || !buf.length) return;
    var n = Math.min(buf.length, 80), s = 0, i;
    for (i = 2; i < n; i++) s += buf[i];
    var v = Math.min(1, (s / Math.max(1, n - 2)) / 170);
    if (lv) {
      lv.style.transform = "scaleX(" + (0.06 + v * 0.94).toFixed(3) + ")";
      lv.style.opacity = (0.16 + v * 0.84).toFixed(2);
    }
    if (stateEl) stateEl.style.setProperty("--lvl", v.toFixed(2));
  };

  // ---------------------------------------------------------------- state, for CSS and the label
  var WORDS = { idle: "Ready", connecting: "Ready", listening: "Listening",
                capturing: "Hearing you", recording: "Hearing you",
                transcribing: "Thinking", thinking: "Thinking",
                speaking: "Speaking", interrupted: "Ready", error: "Problem" };
  // The drawer's status pill is gone (10 October 2026): the profile card names who is signed in and
  // nothing else, and the state it used to repeat already lives on the dock's own pill. `navsub` and
  // this reporter went with it rather than being left behind pointing at an element that no longer
  // exists — a status line that renders nowhere is a trap for whoever reads it next.

  function paintState(s) {
    var w = stateEl ? stateEl.querySelector(".word") : null;
    var sec = stateEl ? stateEl.querySelector(".secs") : null;
    // While a turn is doing work the pill belongs to the lifecycle: THINKING, WORKING, then WORKED
    // with the total. It stays on WORKED until the next turn, so the last thing he sees is that the
    // job finished rather than the page drifting back to Ready as if nothing had happened. A turn
    // that used no tools never sets a phase, so a spoken one-line answer still reads Speaking.
    if (bgPill && bgPill.parentNode && !bgPill.hidden) {
      // The background pill is saying it, and saying it better: the state badge stays out of it rather than
      // printing a second word for the same fact — which is the double pill he was reading.
      body.removeAttribute("data-phase");
      if (w) w.textContent = "";
      if (sec) sec.textContent = "";
      // The background pill replaces the badge, not the control: a long turn is exactly when he
      // needs to stop it, and this branch used to hide the button for the whole run — which is
      // how the stop came to be "lost" while JARVIS was working in the background.
      setStop(!!(threadEl && threadEl.querySelector('[data-running="1"]')));
      return;
    }
    // The verdict belongs to the turn, above its own answer. This pill is one element for the whole
    // page and it keeps the last turn's word, which is how WORKED came to sit under a chat with no
    // answer, below the reply, and claim work for a turn that ran no tools at all. A finished turn
    // clears it; the badge in the thread is the only place the verdict is printed.
    if (workPhase === "worked" || ((workPhase === "partial" || workPhase === "pending") && liveBlock && liveBlock.querySelector(".t-meta"))) workPhase = "";
    if (workPhase) {
      body.setAttribute("data-phase", workPhase);
      if (w) w.textContent = WORK_WORD[workPhase];
      // The seconds tick in their own element, hidden from assistive tech: a live region that changes
      // every 400ms reads the whole badge aloud four times a second. The word changes once a phase,
      // and that is the part worth announcing.
      // The seconds are printed only once the turn is done, as part of its verdict: the total on WORKED,
      // never a count climbing under THINKING and WORKING.
      if (sec) sec.textContent = workPhase === "worked" ? (" \u00b7 " + workSeconds() + "s") : "";
      setStop(workPhase === "thinking" || workPhase === "working");
      return;
    }
    body.removeAttribute("data-phase");
    if (w) w.textContent = WORDS[s] || "Ready";
    if (sec) sec.textContent = "";
    setStop(s === "speaking" || s === "thinking" || s === "transcribing");
  }
  try {
    var orig = window.setState;
    if (typeof orig === "function") {
      window.setState = function (s) {
        body.setAttribute("data-state", s || "idle");
        paintState(s || "idle");
        syncWake();
        return orig.apply(this, arguments);
      };
    }
  } catch (e) { /* the page's own state names are a nicety here, not a dependency */ }
  paintState(body.getAttribute("data-state") || "idle");

  // A state the page can be left holding for good. The controls under an answer are hidden while the
  // page says `speaking`, and the engine clears that state from the clip's own end event. Where the
  // audio never starts - a browser that will not play until it is touched, a machine with no output
  // at all - that end never comes, and Copy, Edit, Share and Regenerate stayed hidden under every
  // answer permanently. This watches for the one case that can be nothing but stuck: the turn is
  // finished, the page still says speaking, and there is nothing left in the queue. It can only fire
  // once the audio has genuinely stopped, so a turn still running is never interrupted by it.
  var spokeLen = 0;
  setInterval(function () {
    if (body.getAttribute("data-state") !== "speaking") return;
    if (!answerSettled || !settledAt) return;
    try {
      if (typeof audioBusy === "function" && !audioBusy()) {      // the queue drained: nothing is playing
        settledAt = 0;
        if (typeof audioDone === "function") audioDone(); else setState("idle");
        return;
      }
    } catch (e) {}
    // The queue can also be stuck. The engine releases this state only when the queue is empty, and a
    // browser that will not start the audio leaves the clip sitting in that queue for good, so the
    // state is never released and the controls under every answer stay hidden. Past any plausible
    // clip for an answer this long, this releases it. Where the audio really is playing the engine
    // has already released the state and this never runs.
    spokeLen = String(answerText || "").length;
    // Counted from the turn's own end rather than from the first sighting of the state: a state that
    // flickers in and out would restart the clock and never reach it.
    var ceiling = 25000 + Math.min(spokeLen, 3000) / 12 * 1000;
    if (Date.now() - settledAt > ceiling) {
      settledAt = 0;
      try { if (typeof audioDone === "function") audioDone(); else setState("idle"); }
      catch (e) { /* a state the surface could not read never takes the page down */ }
    }
  }, 3000);

  // ---------------------------------------------------------------- the screen wake lock (B5)
  var wl = null;
  function syncWake() {
    var armed = false;
    try { armed = !!(window.__jarvisState && window.__jarvisState().earArmed); } catch (e) {}
    try {
      if (armed && !wl && navigator.wakeLock) {
        navigator.wakeLock.request("screen").then(function (l) {
          wl = l;
          l.addEventListener("release", function () { wl = null; });
        }).catch(function () {});
      } else if (!armed && wl) {
        try { wl.release(); } catch (e) {}
        wl = null;
      }
    } catch (e) {}
  }

  // Returning to the foreground: the audio context is suspended and the screen link has gone
  // quiet. Resume both and re-read what is up there (B5).
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState !== "visible") return;
    try { window.audio && window.audio(); } catch (e) {}
    try { window.__jarvisSync && window.__jarvisSync(); } catch (e) {}
    screenState.open = false;
    openScreenChannel();
    catchUp();
    syncWake();
  });

  // ---------------------------------------------------------------- Stop and the keyboard (B7, B10)
  // The stop lives in the capsule now, in the slot the send and the microphone share, and it is
  // shown by the same rule the old pill was: a turn is being generated, or work is running.
  //
  // Stopping takes two halves and needs both. The front half is the page's own: abort the fetch the
  // moment he taps, so nothing more is drawn or spoken and a late event can never land on a turn
  // that is already over. The back half is the machine's: the stream being closed is not the same as
  // the agent stopping — it is a separate process, mid-tool — so the turn is named and killed by
  // /api/chat/stop. Waiting for the closed socket to be noticed costs about a second, which is fine
  // as a backstop but not for a deliberate tap.
  function setStop(on) {
    if (stopIn) stopIn.hidden = !on;
    if (on) body.setAttribute("data-stop", "1"); else body.removeAttribute("data-stop");
  }
  function stopNow() {
    try { window.interrupt && window.interrupt(); } catch (e) {}
    // A stopped turn never reports its own work-done, so the phase and its clock are cleared here.
    // Left alone, the pill went on counting a job that was already over and the stop icon stayed on
    // screen offering to stop a turn that had ended.
    stopClock();
    setPhase("");
    setStop(false);
    try {
      fetch("/api/chat/stop", {
        method: "POST", keepalive: true,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ turn: null, tid: (function () {
          // Name the turn. An unnamed stop only resolves when exactly one turn is live, and a page
          // that has lost a stream or two leaves more than one; the machine then stops nothing and
          // says nothing. The id the block was drawn with is the turn both sides already agree on.
          var t = "";
          try { t = String(turnServerId || ""); } catch (e) {}
          if (!t) { try { t = String((liveBlock && liveBlock.dataset.id) || ""); } catch (e) {} }
          return t || null;
        })() })
      }).then(function (r) { return r.ok ? r.json() : null; }).then(function (d) {
        if (d && d.stopped) toast("Stopped");
      }).catch(function () { /* the client half has already stopped it */ });
    } catch (e) {}
  }
  if (stopIn) stopIn.addEventListener("click", stopNow);
  document.addEventListener("keydown", function (e) {
    var t = e.target;
    var typing = t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
    if (e.key === "Escape") {
      if (!sheetEl.hidden) { closeSheet(); return; }
      if (typing) { try { t.blur(); } catch (err) {} return; }
      try { window.interrupt && window.interrupt(); } catch (err) {}
      return;
    }
    if (typing) return;
    if (t && t.tagName === "BUTTON") return;      // a focused button already takes Space itself
    if (e.key === " " || e.key === "Spacebar") {
      e.preventDefault();
      var m = $("mic"); if (m) m.click();
      return;
    }
    if (e.key === "/") {
      e.preventDefault();
      var ty = $("typing"); if (ty) ty.click();
    }
  });

  // ---------------------------------------------------------------- history, copy, text size
  // Section 4. Three small surfaces behind two small controls, so the page stays what it was: the
  // conversation, the visual, and the bottom bar.

  function fmtTime(ms) {
    var d = new Date(ms), h = d.getHours(), m = d.getMinutes(), ap = h < 12 ? "AM" : "PM";
    h = h % 12; if (!h) h = 12;
    return h + ":" + (m < 10 ? "0" + m : m) + " " + ap;
  }

  var toastTimer = null;
  // A minor status line, floating under the app bar. The default hold is long enough to read a
  // sentence; `ms` is for the ones that only need to be noticed, like "already in a new chat".
  function toast(msg, ms) {
    if (!toastEl) return;
    toastEl.textContent = msg;
    toastEl.hidden = false;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.hidden = true; toastEl.textContent = ""; },
                            Math.max(600, Number(ms) || 2600));
  }

  // --- copy and share -------------------------------------------------------------------------
  // The async clipboard API refuses without a real gesture or a granted permission, and it is
  // absent on older Safari. The old selection trick is the fallback, so Copy works either way
  // rather than depending on which browser he opened.
  function legacyCopy(text) {
    try {
      var ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.top = "-1000px";
      document.body.appendChild(ta);
      ta.select();
      var ok = document.execCommand && document.execCommand("copy");
      document.body.removeChild(ta);
      return !!ok;
    } catch (e) { return false; }
  }

  function copyText(text, what, tipTarget) {
    if (!text) return;
    var done = function () {
      if (tipTarget) flashTip(tipTarget, "Copied");
      else toast(what + " copied");
    };
    var fallback = function () { if (legacyCopy(text)) done(); else toast("Could not copy"); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, fallback);
    } else {
      fallback();
    }
  }

  // A widget past its expiry is gone; the answer stands on its own (section 4).
  function liveWidget() {
    if (!lastWidget || !lastWidget.url) return "";
    if (lastWidget.exp && lastWidget.exp * 1000 < Date.now()) return "";
    return lastWidget.url;
  }

  function shareAnswer() {
    var url = liveWidget();
    var data = { title: "JARVIS", text: (lastQ ? lastQ + "\n\n" : "") + (answerText || "") };
    if (url) data.url = url;
    if (navigator.share) {
      navigator.share(data).catch(function () { /* he closed the sheet: not an error */ });
    } else if (url) {
      copyText(url, "Link");
    } else {
      // This WebView has no system share sheet, so text is the only thing that can travel. What a
      // share would have carried is copied, and it is said plainly rather than passed off as sharing.
      copyText(data.text, "Answer and question");
    }
  }

  // --- text size ------------------------------------------------------------------------------
  var SCALES = [0.9, 1, 1.12, 1.25];
  function textScale() {
    var v = 1;
    try { v = parseFloat(localStorage.getItem(SKEY) || "1"); } catch (e) {}
    return (isFinite(v) && v > 0.5 && v < 2) ? v : 1;
  }
  function setTextScale(v) {
    try { localStorage.setItem(SKEY, String(v)); } catch (e) {}
    document.documentElement.style.setProperty("--tscale", String(v));
  }

  // --- the material, and the height the bar actually is -----------------------------------------
  // Two decisions that belong together, because they are the same decision twice: how heavy the
  // glass is, and how much room it takes. Ink is the default (denser, quieter); Frost is the same
  // structure read lighter, and it is one attribute away (Appearance → Material). Section 12.
  var MKEY = "jarvis.v1.material";
  var DKEY = "jarvis.v1.density";
  function material() {
    var v = null;
    try { v = localStorage.getItem(MKEY); } catch (e) {}
    return v === "frost" ? "frost" : "ink";
  }
  function setMaterial(v) {
    v = v === "frost" ? "frost" : "ink";
    try { localStorage.setItem(MKEY, v); } catch (e) {}
    document.documentElement.setAttribute("data-material", v);
  }
  setMaterial(material());

  // --- how hard it thinks, and whether this turn wants the web ----------------------------------
  // Two per-turn settings the page owns and publishes to the engine at the moment it sends.
  // `auto` is the default and it is the page's own routing: a simple question is answered at once,
  // and a question shaped like work goes to the layer that thinks and holds tools, at low effort.
  // The other levels are explicit — the turn is handed to the agent whatever he asks — because a
  // level nothing can act on is not worth a row.
  var RVKEY = "jarvis.v1.reason",           // what this menu stores
      RVOLD = "jarvis.v1.reasoning",        // what the old header pill stored: read once, to seed
      RVDEF = "auto",
      RVLV = ["auto", "none", "medium", "high", "max"];
  var RVLABEL = { auto: "Auto", none: "Off", medium: "Medium", high: "High", max: "Max" };
  // Levels the pill offered that no longer have a row of their own. Each resolves to the rung it was
  // really running at, so a choice made there is carried rather than thrown away. `none` is not here
  // because Off still exists — but it WAS this page's default, written to every phone that ever
  // loaded it, so an old Off is read as the new default rather than pinning him to Off for good.
  var RVSEED = { minimal: "auto", low: "auto", xhigh: "max", ultra: "max" };
  function reasonSeed() {
    var old = null;
    try { old = localStorage.getItem(RVOLD); } catch (e) {}
    if (!old || old === "none") return RVDEF;
    return RVSEED[old] || (RVLV.indexOf(old) > -1 ? old : RVDEF);
  }
  function reasonLevel() {
    var v = null;
    try { v = localStorage.getItem(RVKEY); } catch (e) {}
    if (v === null) {                        // first load on this menu: seed it, once
      v = reasonSeed();
      try { localStorage.setItem(RVKEY, v); } catch (e) {}
    }
    return RVLV.indexOf(v) > -1 ? v : RVDEF;
  }
  // The setter lives here and the drawing lives wherever the state is shown: the row in the sheet
  // and the badge above the field are both built far below this block, so they subscribe.
  var reasonPainters = [];
  function setReasonLevel(v) {
    if (RVLV.indexOf(v) < 0) v = RVDEF;
    try { localStorage.setItem(RVKEY, v); } catch (e) {}
    for (var i = 0; i < reasonPainters.length; i++) reasonPainters[i](v);
    return v;
  }
  function onReasonPaint(fn) { reasonPainters.push(fn); fn(reasonLevel()); }
  // Armed by Quick Tools → Web search override, and cleared with the chip it stages in the composer:
  // what he can see staged is what the turn will ask for. It is an override for the turn he is about
  // to send and goes back to off by itself, because that is what the row says it does.
  var webArmed = false;
  // Quick Tools → Memory context. Off for the session, or until he turns it back on, and shown as
  // off in the panel whenever he looks: a switch that quietly rearmed itself was the worse failure.
  var memOn = true;

  // What the engine merges into the request it is about to send. Captured when the turn starts
  // rather than read when the request is built, because the same engine call that starts a turn is
  // the one that clears the composer: the staged chip is gone by then, and a web search asked for
  // that way would never actually be sent.
  var turnOpts = { reasoning: "none" };
  function captureTurnOpts() {
    var o = { reasoning: reasonLevel() };
    // Which conversation this turn is asked in travels with the request. The page knows it for certain —
    // it is the conversation on the screen — and the machine's own idea of it can be stale (it forgets on
    // restart), which is how one conversation's answer ends up filed as another's.
    try { if (window.__jarvisConvId) o.conv = String(window.__jarvisConvId()); } catch (e) {}
    if (webArmed) o.web = true;
    // Absent means on, so a plain turn is byte for byte the turn this page sent before the row
    // existed.
    if (!memOn) o.memory = false;
    turnOpts = o;
  }
  window.__jarvisTurnOpts = function () {
    // The turn's name travels with the question. The machine adopts it, so the id the page paints, the
    // id the machine publishes and the id the record is filed under are one value, not three.
    var o = {};
    for (var k in turnOpts) o[k] = turnOpts[k];
    if (liveTid) o.turn_id = liveTid;
    return o;
  };

  // The bar is pulled up over the content by its own measured height, and the scroller is padded
  // by the same number, so the last line of an answer never ends underneath the material. Measured
  // rather than hardcoded: the bar changes height with the state row, the keyboard and the rail.
  var lastBarh = 0;
  function publishBarHeight() {
    var b = $("bar");
    if (!b) return;
    var h = Math.round(b.getBoundingClientRect().height);
    if (h > 0 && h !== lastBarh) {
      lastBarh = h;
      document.documentElement.style.setProperty("--barh", h + "px");
    }
  }
  publishBarHeight();
  if (window.ResizeObserver) { try { new ResizeObserver(publishBarHeight).observe($("bar")); } catch (e) {} }
  window.addEventListener("resize", publishBarHeight);
  window.addEventListener("orientationchange", function () { setTimeout(publishBarHeight, 250); });
  // The observer alone is not enough, and this is measured rather than assumed: a bar that grows
  // AFTER the first paint (the staged-chip band coming back from the device's own storage, a font
  // landing, the composer growing) was measured once at load and the number then stayed stale. At
  // 121px of dock against a published 75px, both the scroller's foot and the landing list's reserve
  // were short by the height of the band that appeared later, which is exactly the collision this
  // re-measure removes. Cheap: one rect read, and it writes only when the number has moved.
  window.addEventListener("load", function () { setTimeout(publishBarHeight, 0); });
  if (window.requestAnimationFrame) {
    requestAnimationFrame(function () { requestAnimationFrame(publishBarHeight); });
  }

  // iOS only paints `:active` when the page listens for touch. The press must be visible on the
  // press, not on the release (section 1), so the listener exists for that reason alone.
  document.addEventListener("touchstart", function () {}, { passive: true });

  // ---------------------------------------------------------------- what a panel is made of
  // One vocabulary for every panel, so the drawer's detail page and the Summary sheet render the
  // same way and a panel never has to know which surface it is on. Each builder writes into the
  // element it is handed; nothing looks a container up for itself, so a panel can be shown in
  // either place without a second code path.
  var PANEL_ICONS = {
    box: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3.4 20 7.6v8.8l-8 4.2-8-4.2V7.6z"/><path d="m4.2 7.6 7.8 4.1 7.8-4.1M12 11.7v8.9"/></svg>',
    clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8.4"/><path d="M12 7.6V12l3.1 1.9"/></svg>',
    image: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3.4" y="5" width="17.2" height="14" rx="2.4"/><circle cx="8.6" cy="10.1" r="1.5"/><path d="m4.6 17.4 4.5-4.3 3.2 3 3-2.6 4.1 3.9"/></svg>',
    bolt: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M13.2 2.6 5.4 13.3h5.1l-.9 8.1 8.4-11.1h-5.4z"/></svg>',
    cal: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3.6" y="5.2" width="16.8" height="15" rx="2.6"/><path d="M3.6 10h16.8M8.4 3.4v3.6M15.6 3.4v3.6"/></svg>',
    plug: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M9 2.8v4.6M15 2.8v4.6"/><path d="M6.4 7.4h11.2v3.2a5.6 5.6 0 0 1-11.2 0z"/><path d="M12 16.2v5"/></svg>',
    puzzle: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10.2 3.6h3.6v1.9a1.6 1.6 0 1 0 3.2 0V3.6h3.4v3.6h-1.9a1.6 1.6 0 1 0 0 3.2h1.9v3.6h-3.6v1.9a1.6 1.6 0 1 1-3.2 0v-1.9H6.8V10.4h1.9a1.6 1.6 0 1 1 0-3.2H6.8V3.6z"/></svg>',
    book: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4.4 4.8h5.8a2.6 2.6 0 0 1 2.6 2.6v11a2.1 2.1 0 0 0-2.1-2.1H4.4z"/><path d="M19.6 4.8h-5.8a2.6 2.6 0 0 0-2.6 2.6v11a2.1 2.1 0 0 1 2.1-2.1h6.3z"/></svg>',
    chip: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="7" y="7" width="10" height="10" rx="2.2"/><path d="M10 3.4v3.6M14 3.4v3.6M10 17v3.6M14 17v3.6M3.4 10h3.6M3.4 14h3.6M17 10h3.6M17 14h3.6"/></svg>',
    radio: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="2.3"/><path d="M7.9 7.9a5.8 5.8 0 0 0 0 8.2M16.1 7.9a5.8 5.8 0 0 1 0 8.2"/><path d="M4.9 4.9a10 10 0 0 0 0 14.2M19.1 4.9a10 10 0 0 1 0 14.2"/></svg>',
    /* The vocabulary a plugin's own row needs. Same hand, same weight, one mark per kind of thing:
       a row that carries the wrong glyph is a row that has to be read twice. */
    globe: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8.4"/><path d="M3.6 12h16.8"/><path d="M12 3.6c2.35 2.3 3.55 5.1 3.55 8.4S14.35 18.1 12 20.4c-2.35-2.3-3.55-5.1-3.55-8.4S9.65 5.9 12 3.6z"/></svg>',
    disk: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3.4" y="4.8" width="17.2" height="6.4" rx="2"/><rect x="3.4" y="12.8" width="17.2" height="6.4" rx="2"/><path d="M7.1 8h.01M7.1 16h.01"/></svg>',
    key: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="8.2" cy="15.8" r="3.6"/><path d="m10.8 13.2 7.6-7.6M15.6 8.4l2 2M18.1 5.9l2 2"/></svg>',
    shield: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3.4 5.6 5.9v5.5c0 3.8 2.5 7.2 6.4 8.9 3.9-1.7 6.4-5.1 6.4-8.9V5.9z"/><path d="m9.4 12 1.9 1.9 3.3-3.6"/></svg>',
    chat: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6.6A2.6 2.6 0 0 1 6.6 4h10.8A2.6 2.6 0 0 1 20 6.6v7.2a2.6 2.6 0 0 1-2.6 2.6H9.5l-4.3 3.2c-.5.4-1.2 0-1.2-.6z"/></svg>',
    search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="6.4"/><path d="m16 16 4 4"/></svg>',
    film: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3.4" y="5" width="17.2" height="14" rx="2.4"/><path d="M8.4 5v14M15.6 5v14M3.4 12h17.2"/></svg>',
    music: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="7.2" cy="17.2" r="2.8"/><circle cx="17" cy="15.4" r="2.8"/><path d="M10 17.2V7.6l9.8-2.2v10"/></svg>',
    home: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4.2 11.2 12 4.4l7.8 6.8V19a1.4 1.4 0 0 1-1.4 1.4H5.6A1.4 1.4 0 0 1 4.2 19z"/><path d="M9.6 20.4v-5.6h4.8v5.6"/></svg>',
    camera: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3.2" y="6.6" width="13.4" height="10.8" rx="2.6"/><path d="m16.6 12.2 4.2-3v5.6l-4.2-2.6z"/></svg>',
    activity: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3.4 12h3.9l2.5-5.8 3.4 11.7 2.5-5.9h5"/></svg>',
    device: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3.4" y="4.8" width="17.2" height="11.6" rx="2.2"/><path d="M8.8 20h6.4M12 16.4V20"/></svg>',
    /* The vocabulary the skills, connectors and schedules need. Same hand and same weight as the
       rest, because a row is read once and a mark that has to be decoded is a mark that failed. */
    agent: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="4.6" y="7.8" width="14.8" height="10.4" rx="3"/><path d="M12 4.6v3.2"/><circle cx="12" cy="3.4" r="1.1"/><path d="M9.4 12h.01M14.6 12h.01M9.8 15.4h4.4"/></svg>',
    code: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="m9.4 8.4-4 3.6 4 3.6M14.6 8.4l4 3.6-4 3.6"/></svg>',
    brush: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M14.6 3.9 20.1 9.4M16.9 6.2l-8 8"/><path d="M8.4 14.6c-1.7.5-2.6 1.7-2.9 3.4-.2 1-.9 1.6-1.9 1.9 1.3.9 3.1 1 4.6.3 1.7-.8 2.4-2.6 1.9-4.2z"/></svg>',
    briefcase: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3.4" y="7.4" width="17.2" height="12.2" rx="2.4"/><path d="M8.8 7.4V5.8a2 2 0 0 1 2-2h2.4a2 2 0 0 1 2 2v1.6M3.4 12.6h17.2"/></svg>',
    flask: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M9.6 3.6h4.8M10.6 3.6v5.2l-4.4 8.2a2.2 2.2 0 0 0 1.9 3.4h7.8a2.2 2.2 0 0 0 1.9-3.4l-4.4-8.2V3.6"/><path d="M7.9 14.4h8.2"/></svg>',
    pencil: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4.4 19.6 8 18.8 18.9 7.9a1.9 1.9 0 0 0 0-2.7l-.1-.1a1.9 1.9 0 0 0-2.7 0L5.2 16z"/><path d="m15.2 6.6 2.2 2.2"/></svg>',
    user: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8.6" r="3.8"/><path d="M4.8 20.2c0-3.5 3.2-6 7.2-6s7.2 2.5 7.2 6"/></svg>',
    clipboard: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="5.4" y="4.8" width="13.2" height="15.6" rx="2.4"/><path d="M9.2 4.8V3.6h5.6v1.2"/><path d="m9.4 12.4 1.9 1.9 3.5-4"/></svg>',
    gear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3.2"/><path d="M12 3.1v2.1M12 18.8v2.1M3.1 12h2.1M18.8 12h2.1M6.7 6.7 5.2 5.2M18.8 18.8l-1.5-1.5M17.3 6.7l1.5-1.5M5.2 18.8l1.5-1.5"/></svg>',
    chart: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4v16h16"/><path d="M8.6 16.4v-4.2M12.6 16.4V8.4M16.6 16.4v-6.2"/></svg>',
    plane: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M20.6 3.4 3.4 10.2l5.9 2.3 2.3 5.9z"/><path d="m9.3 12.5 11.3-9.1"/></svg>',
    webhook: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="6.4" r="2.6"/><circle cx="6.4" cy="16.6" r="2.6"/><circle cx="17.6" cy="16.6" r="2.6"/><path d="M10.5 8.7 7.8 14M13.5 8.7l2.7 5.3M9 16.6h6"/></svg>',
    cloud: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M7.4 18.6h9.4a4 4 0 0 0 .6-7.9 5.6 5.6 0 0 0-10.7-1.4 3.9 3.9 0 0 0 .7 9.3z"/></svg>',
    link: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M10.2 13.8a4.2 4.2 0 0 0 5.9 0l2.6-2.6a4.2 4.2 0 0 0-5.9-5.9l-1.1 1.1"/><path d="M13.8 10.2a4.2 4.2 0 0 0-5.9 0l-2.6 2.6a4.2 4.2 0 0 0 5.9 5.9l1.1-1.1"/></svg>'
  };
  function panelIcon(name){ return PANEL_ICONS[name] || PANEL_ICONS.box; }
  /* One lookup for every mark on the page: a published brand shape when there is one, this app's own
     glyph otherwise. Callers write "brand:cloudflare" or "ch:telegram" or a plain icon name. */
  function markIcon(spec) {
    var s = String(spec || ""), i;
    if (s.indexOf("brand:") === 0) { if (brandIcon(s.slice(6))) return brandIcon(s.slice(6)); i = s.slice(6); }
    else if (s.indexOf("ch:") === 0) { return chanIcon(s.slice(3)); }
    else i = s;
    return panelIcon(i || "box");
  }

  function panelHead(out, text, first){
    var h = document.createElement("div");
    h.className = "p-head"; if (first) h.style.marginTop = ".1rem";
    h.textContent = text;
    out.appendChild(h);
    return h;
  }
  function panelNote(out, text){
    var d = document.createElement("p");
    d.className = "p-note"; d.textContent = text;
    out.appendChild(d);
    return d;
  }
  // The empty state, in one place: a muted vector, a bold line and a quiet second line, centred.
  // Every list that can be legitimately empty uses it, so an empty panel never reads as a panel
  // that failed to load.
  function panelEmpty(out, title, sub, icon){
    var d = document.createElement("div");
    d.className = "p-empty";
    var i = document.createElement("span");
    i.className = "pe-icon"; i.setAttribute("aria-hidden", "true");
    i.innerHTML = panelIcon(icon);
    var t = document.createElement("b");
    t.className = "pe-title"; t.textContent = title;
    d.appendChild(i); d.appendChild(t);
    if (sub) { var s = document.createElement("p"); s.className = "pe-sub"; s.textContent = sub; d.appendChild(s); }
    out.appendChild(d);
    return d;
  }
  function panelButton(out, text, cls, onTap){
    var b = document.createElement("button");
    b.type = "button"; b.className = "p-btn" + (cls ? " " + cls : ""); b.textContent = text;
    b.addEventListener("click", onTap);
    out.appendChild(b);
    return b;
  }
  function segRow(out, options, current, onPick){
    var row = document.createElement("div");
    row.className = "p-seg";
    options.forEach(function (pair) {
      var b = document.createElement("button");
      b.type = "button";
      b.className = "p-segbtn" + (current === pair[0] ? " on" : "");
      b.setAttribute("aria-pressed", current === pair[0] ? "true" : "false");
      b.textContent = pair[1];
      b.addEventListener("click", function () { onPick(pair[0]); });
      row.appendChild(b);
    });
    out.appendChild(row);
    return row;
  }
  // The shimmer. A skeleton is a promise about layout, so it carries the same rows, icons and
  // switches the loaded panel will: nothing jumps when the data lands.
  function skeletonCards(out, n, opts){
    opts = opts || {};
    var wrap = document.createElement("div");
    wrap.className = "p-sk";
    for (var i = 0; i < n; i++) {
      var c = document.createElement("div");
      c.className = "sk-card";
      c.innerHTML = (opts.icon === false ? "" : '<i class="sk-ic sk-l"></i>') +
        '<span class="sk-lines"><i class="sk-l w1"></i><i class="sk-l w2"></i></span>' +
        (opts.switch === false ? "" : '<i class="sk-switch sk-l"></i>');
      wrap.appendChild(c);
    }
    out.appendChild(wrap);
    return wrap;
  }

  // --- Sessions: the conversations kept, newest first ------------------------------------------
  // The conversation lifecycle lives here because both the panel below and the drawer read it, and
  // two answers to "which conversation is on the canvas" is how a row gets a stale id.
  //
  //   activeId  the conversation on the canvas. "" is a chat that has not been named yet, which is
  //             what "+ New chat" leaves behind and what the first message turns into a real one.
  //   pending   the row for a conversation that has just started. The machine lists a conversation
  //             only once one of its turns has been saved, and a chat you are looking at should not
  //             be missing from the drawer for the length of an answer.
  var activeId = "", pending = null;

  // ---------------------------------------------------------------- one identity, minted here
  // A conversation is named the moment it exists, by this page, in the same 32-hex form the machine
  // stores. Everything after this — the turn, its question, its answer, its badge, its file — reads
  // that name and only that name. "current" is not a conversation: it means "whichever window the
  // machine happens to be in", which is a different thing after every switch. Every cross-chat bug in
  // this page came from something being filed under it.
  function newConvId() {
    try {
      var a = new Uint8Array(16);
      (window.crypto || window.msCrypto).getRandomValues(a);
      return Array.prototype.map.call(a, function (b) { return ("0" + b.toString(16)).slice(-2); }).join("");
    } catch (e) {
      var s = "";
      for (var i = 0; i < 32; i++) s += "0123456789abcdef"[Math.floor(Math.random() * 16)];
      return s;
    }
  }
  try { window.__jarvisNewConvId = newConvId; } catch (e) {}

  // A conversation that exists on this device before the machine has ever heard of it. It has a name
  // and a row straight away; the machine's own name replaces it a second later.
  var PROVKEY = "jarvis.v1.provisional";
  function provAll() { try { return JSON.parse(localStorage.getItem(PROVKEY) || "{}") || {}; } catch (e) { return {}; } }
  function provPut(id, title) {
    try {
      var v = provAll();
      v[String(id)] = { title: String(title || "New chat"), at: Math.floor(Date.now() / 1000) };
      localStorage.setItem(PROVKEY, JSON.stringify(v));
    } catch (e) {}
  }
  function provDrop(id) {
    try {
      var v = provAll();
      if (Object.prototype.hasOwnProperty.call(v, String(id))) { delete v[String(id)]; localStorage.setItem(PROVKEY, JSON.stringify(v)); }
    } catch (e) {}
  }

  // The same rule the machine applies when it names a saved conversation, kept to one screenful so
  // the row that appears with the first message matches the row that replaces it a moment later.
  var TITLE_PAD = ["hey jarvis", "hi jarvis", "ok jarvis", "okay jarvis", "jarvis",
                   "can you", "could you", "would you", "can u", "could u", "please",
                   "i want you to", "i need you to", "i'd like you to"];
  function concTitle(text, limit) {
    limit = limit || 25;
    var t = String(text || "").replace(/\s+/g, " ").trim();
    var low = t.toLowerCase(), pad, again = true, i;
    while (again) {
      again = false;
      for (i = 0; i < TITLE_PAD.length; i++) {
        pad = TITLE_PAD[i];
        if (low === pad || low.indexOf(pad + " ") === 0) {
          t = t.slice(pad.length).replace(/^[\s,.:;\-]+/, "");
          low = t.toLowerCase(); again = true; break;
        }
      }
    }
    t = t.replace(/[\s,.:;\-\u2013\u2014]+$/, "");
    if (!t) return "";
    if (t.length > limit) {
      var cut = t.slice(0, limit + 1);
      if (cut.indexOf(" ") > 0) cut = cut.slice(0, cut.lastIndexOf(" "));
      t = cut.replace(/[\s,.:;\-\u2013\u2014]+$/, "") || t.slice(0, limit);
    }
    return t.charAt(0).toUpperCase() + t.slice(1);
  }

  // The conversation that has just started, until the machine's own list carries it.
  function withPending(list) {
    if (!pending) return list || [];
    var has = (list || []).some(function (s) { return String(s.id) === String(pending.id); });
    return has ? list : [pending].concat(list || []);
  }

  // Newest first, always. The machine sorts its own list; the device's rows are appended to it, so a
  // conversation written a moment ago landed at the bottom of the drawer purely because it came from
  // the other store. The order is a property of the list he is reading, not of which store a row
  // arrived from, so it is applied once to the merged whole — and again on every repaint, which is
  // what makes a conversation that has just been written appear at the top.
  // A conversation's place is when it was STARTED. Ordering by the last thing that happened made a chat
  // move under his thumb whenever work finished in it — and a running chat floated to the top on every
  // poll. Creation order is static: a new chat arrives at the top and nothing else ever moves.
  function stamp(s) {
    return Number(s && (s.started || s.updated)) || 0;
  }
  function byNewest(list) {
    return (list || []).slice().sort(function (a, b) { return stamp(b) - stamp(a); });
  }

  var histGen = 0;
  function paintHistory(out) {
    out.textContent = "";
    out.dataset.mode = "history";            // a live step must not repaint over this
    // The conversations live on the machine, so the list has to be asked for, and the skeleton holds
    // the panel's shape while it is on its way. If the machine cannot be reached the turns on this
    // device are shown instead: a history that is empty because the network failed is a lie.
    skHistory(out);
    var mine = ++histGen;
    fetch("/api/sessions", { credentials: "same-origin" })
      .then(function (r) { return r.ok ? r.json() : Promise.reject(r.status); })
      .then(function (d) {
        if (mine !== histGen || out.dataset.mode !== "history" || !out.isConnected) return;
        try { applyPurge(d); } catch (e) {}                 // a purge this device has not heard about
        // The conversation that has just started is part of the list before the machine has saved it,
        // and anything this device holds that the machine does not is part of it too.
        // The machine answered, so its list is the record: rows from this device's own store are only
        // kept for a turn it may not have received yet.
        paintSessionRows(out, withPending(byNewest(mergedSessions((d && d.sessions) || [], true))));
      })
      .catch(function () {
        if (mine !== histGen || out.dataset.mode !== "history" || !out.isConnected) return;
        paintSessionRows(out, withPending(localSessions()));
      });
  }

  // The fallback: what this device kept, presented the way the drawer reads a list. The session store
  // comes first, because it holds whole conversations; the flat turn history behind it is what an
  // older build of this page left on the device, and it is still one conversation worth showing.
  function localSessions() {
    var dev = devAll();
    if (dev.length) {
      return dev.map(function (s) {
        return { id: s.id, title: s.title, started: s.started, updated: s.updated,
                 turns: (s.turns || []).length, live: false, local: true };
      });
    }
    var list = history();
    if (!list.length) return [];
    var dead = goneIds();
    // The id is the conversation's own, not a placeholder: tapping this row has to reach the window
    // the page is actually in, and "current" is only what the machine calls a window before it has
    // minted one.
    var one = { id: activeId || "current", title: concTitle(list[0].q) || "This conversation",
                updated: (list[0].t || 0) / 1000, turns: list.length, live: true };
    return dead.indexOf(String(one.id)) < 0 ? [one] : [];
  }

  // What the drawer shows: the machine's records, plus anything this device holds that the machine
  // does not — a save that never got through, a machine that cannot be reached. Those rows are marked
  // `local`. A deleted conversation leaves the device store at the same moment it leaves the machine,
  // so nothing comes back through this door.
  function goneIds() {
    try {
      if (typeof window.__jarvisGone === "function") return window.__jarvisGone();
      var v = JSON.parse(localStorage.getItem("jarvis.v1.gone") || "[]");
      return Array.isArray(v) ? v : [];
    } catch (e) { return []; }
  }

  function mergedSessions(serverList, authoritative) {
    var out = (serverList || []).slice();
    var ids = {};
    out.forEach(function (s) { ids[String(s.id)] = true; });
    var _now = Date.now() / 1000;
    devAll().forEach(function (s) {
      if (ids[String(s.id)]) return;
      if (!(s.turns || []).length) return;      // an empty record is not a row: see devPut
      // When the machine has answered, it is the record of what exists. A conversation the machine no
      // longer holds was deleted there — by him or from another device — and this device's copy must
      // not put the row back. The exception is a turn written here in the last two minutes, which the
      // machine may simply not have received yet.
      if (authoritative && String(s.id) !== String((pending || {}).id || "")) {
        var _u = Number(s.updated || 0) || 0;
        if (!_u || (_now - _u) > 120) return;
      }
      // A copy this device holds under a name that is not a conversation name — a placeholder from before
      // the conversation was given its own — belongs to the machine's conversation only when the machine's
      // name for it is known here and its first question is that conversation's first question. It is never
      // matched on a title: two conversations may be given the same opening words, and each is its own
      // chat. An id is the conversation; a title is only what it happens to be called.
      var held = String(s.id);
      var opening = ((s.turns && s.turns[0]) || {}).q || "";
      var realName = (!REAL_NAME.test(held) && opening) ? Object.keys(turnQ).filter(function (k) {
        return REAL_NAME.test(k) && String(turnQ[k] || "") === String(opening);
      })[0] : null;
      if (realName) {
        var mine = out.filter(function (m) { return String(m.id) === realName; })[0];
        if (mine) {
          try {
            var here = devGet(realName) || { id: realName, title: mine.title || s.title, turns: [] };
            var have = {};
            (here.turns || []).forEach(function (t) { have[String(t.q || "")] = true; });
            here.turns = (here.turns || []).concat((s.turns || []).filter(function (t) {
              return !have[String(t.q || "")];
            }));
            here.turns.sort(function (a, b) { return (a.t || 0) - (b.t || 0); });
            devPut(here); devDrop(s.id);
          } catch (e) {}
          return;
        }
      }
      out.push({ id: s.id, title: s.title, started: s.started, updated: s.updated,
                 turns: (s.turns || []).length, live: false, local: true });
    });
    var dead = goneIds();
    return out.filter(function (s) { return dead.indexOf(String(s.id)) < 0; });
  }

  // Today, yesterday, then everything before it: the only three divisions that are ever the same
  // answer to "when was this", whatever the date is.
  function groupOf(ts) {
    var d = new Date((ts || 0) * 1000), n = new Date();
    function same(a, b) { return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate(); }
    if (same(d, n)) return "Today";
    if (same(d, new Date(n.getTime() - 86400000))) return "Yesterday";
    return "Older";
  }

  // What this device has seen of each conversation. Kept on the device, not the machine: "unread" is
  // a fact about this reader, and another phone having read a chat does not make it read here.
  var READ_KEY = "jl_read";
  function readMap() { try { return JSON.parse(localStorage.getItem(READ_KEY) || "{}") || {}; } catch (e) { return {}; } }
  function markRead(id, updated) {
    if (!id || id === "current") return;
    var m = readMap(); m[String(id)] = Number(updated || (Date.now() / 1000));
    try { localStorage.setItem(READ_KEY, JSON.stringify(m)); } catch (e) {}
  }
  function isUnread(s) {
    if (!s || !s.id || s.id === "current") return false;
    if (String(s.id) === String(activeId)) return false;
    var seen = Number(readMap()[String(s.id)] || 0);
    return Number(s.updated || 0) > seen + 0.5;
  }

  function paintSessionRows(out, sessions) {
    // The first time this page runs, the conversations already on the machine are not news. Without
    // this every chat in the drawer wore an unread dot on the first open, which is the opposite of
    // what a dot is for.
    try {
      // One-time seed, flagged separately: the read map itself is written the moment a turn ends, so
      // its presence cannot mean "this device has already seen the archive".
      if (!localStorage.getItem(READ_KEY + "_init") && (sessions || []).length) {
        var _seed = readMap();
        (sessions || []).forEach(function (s) {
          if (!s || !s.id) return;
          var k = String(s.id);
          if (!_seed[k] || Number(_seed[k]) < Number(s.updated || 0)) _seed[k] = Number(s.updated || 0);
        });
        localStorage.setItem(READ_KEY, JSON.stringify(_seed));
        localStorage.setItem(READ_KEY + "_init", "1");
      }
    } catch (e) {}
    // A chat made a moment ago exists before the machine has heard of it: it has a row here, under the
    // name this app gave it, from the instant it was created. The machine's record takes the row over
    // when the first turn is saved, and names it a second later.
    try {
      var _prov = provAll(), _have = {};
      (sessions || []).forEach(function (s) { if (s && s.id) _have[String(s.id)] = true; });
      var _now2 = Date.now() / 1000;
      Object.keys(_prov).forEach(function (id) {
        if (_have[id]) { provDrop(id); return; }
        var at = Number((_prov[id] || {}).at || 0);
        if (at && (_now2 - at) > 86400) { provDrop(id); return; }
        sessions = (sessions || []).concat([{ id: id, title: (_prov[id] || {}).title || "New chat",
          updated: at, started: at, turns: 0, provisional: true,
          live: String(id) === String(activeId) }]);
      });
      sessions = byNewest(sessions);
    } catch (e) {}
    out.textContent = "";
    out.dataset.mode = "history";
    if (!sessions.length) {
      panelEmpty(out, "No Sessions Yet",
                 "Every conversation is kept here once a turn has finished in it. Nothing has been kept yet.", "clock");
      return;
    }
    // A conversation's own two marks: what it is called, and whether it stays at the top. Both live on
    // the machine, so the drawer he opens on the other device is the same drawer.
    function patchMeta(id, body, out2) {
      fetch("/api/sessions/" + encodeURIComponent(id) + "/meta", {
        method: "POST", credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      }).then(function (r) { return r.json(); }).then(function (d) {
        if (!d || !d.ok) { try { toast("That change did not stick."); } catch (e) {} return; }
        try { paintHistory(out2); } catch (e) {}
      }).catch(function () { try { toast("That change did not stick."); } catch (e) {} });
    }

    function closeMenu() {
      var m = document.getElementById("pmenu");
      if (m && m.parentNode) m.parentNode.removeChild(m);
    }

    function rowMenu(s, anchor, out2) {
      closeMenu();
      var m = document.createElement("div"); m.id = "pmenu"; m.className = "pmenu";
      var ren = document.createElement("button");
      ren.type = "button"; ren.className = "pm-i"; ren.textContent = "Rename";
      ren.addEventListener("click", function (ev) { ev.stopPropagation(); closeMenu(); inlineRename(s, anchor, out2); });
      var pin = document.createElement("button");
      pin.type = "button"; pin.className = "pm-i"; pin.textContent = s.pinned ? "Unpin" : "Pin to top";
      pin.addEventListener("click", function (ev) { ev.stopPropagation(); closeMenu(); patchMeta(s.id, { pinned: !s.pinned }, out2); });
      m.appendChild(ren); m.appendChild(pin);
      document.body.appendChild(m);
      var r = anchor.getBoundingClientRect(), w = m.offsetWidth, h = m.offsetHeight;
      m.style.left = Math.min(Math.max(8, r.right - w), window.innerWidth - w - 8) + "px";
      m.style.top = Math.min(r.bottom + 6, window.innerHeight - h - 8) + "px";
      setTimeout(function () {
        document.addEventListener("pointerdown", function onDoc(ev) {
          if (m.contains(ev.target)) return;
          document.removeEventListener("pointerdown", onDoc);
          closeMenu();
        });
      }, 0);
    }

    // Renaming happens in the row itself: the name is the thing being changed, so the place it is
    // written is where it gets edited. Enter keeps it, Escape leaves the old one alone.
    function inlineRename(s, anchor, out2) {
      // The anchor is the row's menu mark, a sibling of the title, not its parent.
      var rowEl = anchor && anchor.closest ? anchor.closest(".p-row") : null;
      var v = rowEl ? rowEl.querySelector(".pr-v") : null;
      if (!v) return;
      var old = String(s.title || "");
      var inp = document.createElement("input");
      inp.type = "text"; inp.className = "pr-in"; inp.value = old; inp.maxLength = 60;
      v.textContent = ""; v.appendChild(inp);
      inp.focus(); inp.select();
      var done = false;
      function save() {
        if (done) return; done = true;
        var name = String(inp.value || "").trim();
        if (!name || name === old) { paintHistory(out2); return; }
        patchMeta(s.id, { title: name }, out2);
      }
      inp.addEventListener("keydown", function (ev) {
        ev.stopPropagation();
        if (ev.key === "Enter") { ev.preventDefault(); save(); }
        else if (ev.key === "Escape") { done = true; paintHistory(out2); }
      });
      inp.addEventListener("blur", save);
      inp.addEventListener("click", function (ev) { ev.stopPropagation(); });
    }

    function paintGroup(name, mine) {
      if (!mine.length) return;
      panelHead(out, name);
      mine.forEach(function (s) {
        var row = document.createElement("button");
        row.type = "button"; row.className = "p-row";
        var t = document.createElement("span"); t.className = "pr-k"; t.textContent = fmtTime((s.updated || 0) * 1000);
        var v = document.createElement("span"); v.className = "pr-v";
        // An answer that arrived while he was elsewhere is a dot and a heavier title, not a number:
        // one unanswered thing is worth attention, twelve are worth a glance.
        if (isUnread(s)) {
          row.classList.add("unread");
          var dot = document.createElement("span"); dot.className = "pr-dot";
          row.appendChild(dot);
        }
        v.textContent = String(s.title || "Untitled").slice(0, 120);
        var g2 = document.createElement("span"); g2.className = "pr-tag";
        g2.textContent = s.turn ? "working"
          : (s.live ? "now" : (s.turns || 0) + (s.turns === 1 ? " turn" : " turns"));
        if (s.pinned) g2.textContent = "Pinned";
        var more = document.createElement("span");
        more.className = "pr-more"; more.textContent = "\u22ef";
        more.setAttribute("role", "button"); more.setAttribute("aria-label", "Conversation options");
        more.tabIndex = 0;
        more.addEventListener("click", function (ev) { ev.stopPropagation(); rowMenu(s, more, out); });
        more.addEventListener("keydown", function (ev) {
          ev.stopPropagation();
          if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); rowMenu(s, more, out); }
        });
        row.appendChild(t); row.appendChild(v); row.appendChild(g2); row.appendChild(more);
        // The row you are already in is not re-opened: re-reading it would throw away the live turn
        // on the canvas and, before the first answer is saved, report the chat as empty. This panel
        // dismisses, which is the whole of what a tap on it means.
        row.addEventListener("click", function () {
          if (s.id === activeId) { closeSheet(); closeNavView(); return; }
          openSession(s.id, s.title);
        });
        out.appendChild(row);
      });
    }

    // Pinned first, then the days. A chat he keeps to hand does not sit wherever the clock puts it.
    paintGroup("Pinned", sessions.filter(function (s) { return !!s.pinned; }));
    ["Today", "Yesterday", "Older"].forEach(function (g) {
      paintGroup(g, sessions.filter(function (s) { return !s.pinned && groupOf(s.updated) === g; }));
    });
    // Clearing is the one action on this page that cannot be taken back, so it asks first and then
    // does all of it: the conversations this device kept, and the session logs the machine kept for
    // them. It used to clear only the device's copy, with no question asked and nothing said about
    // the rest — which read as "my history is still there" the next time the drawer was opened.
    function purgeChatHistory() {
      if (typeof window.__jarvisResetSurface === "function") window.__jarvisResetSurface();
      // The device's own session store goes with the machine's. "Clear all local chat history" is a
      // promise about every conversation kept on this device, and this is where they are kept now.
      devWipe();
      fetch("/api/sessions/clear", {
        method: "POST", credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        // The word the endpoint asks for. A purge should carry the intent of the tap, not just the
        // URL, so a replayed or duplicated request cannot wipe the archive on its own.
        body: JSON.stringify({ confirm: "clear-chat-history" })
      })
        .then(function (r) { return r.ok ? r.json() : Promise.reject(r.status); })
        .then(function (j) {
          if (typeof window.__jarvisResetSurface === "function" && j && j.session) {
            window.__jarvisResetSurface(j.session);
          }
          if (out.isConnected) paintHistory(out);
          var n = (j && j.sessions) || 0, t = (j && j.turns) || 0;
          toast(n || t
                ? "Cleared " + n + " conversation" + (n === 1 ? "" : "s") + ", " +
                  t + " turn" + (t === 1 ? "" : "s")
                : "Nothing had been kept yet", 2000);
        })
        .catch(function () {
          if (out.isConnected) paintHistory(out);
          toast("This device is cleared. The machine could not be reached.", 2600);
        });
    }
    panelButton(out, "Clear chat history", "danger", function () {
      askConfirm({
        title: "Clear all local chat history?",
        body: "Every conversation kept on this device goes, and the session logs behind them. " +
              "This cannot be undone.",
        yes: "Clear",
        onYes: purgeChatHistory
      });
    });
  }

  // Opening a conversation: it goes back onto the canvas whole, its newest turn as the live one, so
  // the thread above reads as the context of the turn at the bottom — which is also the turn Copy,
  // Share and Ask-again act on.
  function openSession(id, title) {
    try { document.body.removeAttribute("data-fresh"); } catch (e) {}
    closeNavView();
    closeSheet();
    // He chose this conversation: a question asked here is a follow-up, not a new chat.
    try { window.__jarvisAutoBound = false; } catch (e) {}
    // The conversation already on the canvas is not re-opened. Fetching it again would drop the live
    // turn being read, and a chat whose first answer has not been saved yet would come back as an
    // empty one — which is how the drawer ended up telling him a chat he was in was broken.
    // Skipped only when the canvas already holds this conversation. It was skipped whenever the id
    // matched, so a chat the page considered current but whose canvas was empty — after a switch, a
    // reload, a lost reader — could not be opened at all: the row was there, the chat was not.
    if (id && id === activeId && !(typeof threadEmpty === "function" && threadEmpty())) return;
    // The view is moving. A turn the machine is still writing in the conversation being opened is not
    // read as a finished record: the engine is told where the screen is going, and if it is already
    // reading that turn the canvas simply starts drawing it again.
    var liveNow = null;
    try { liveNow = window.__jarvisLiveTurn && window.__jarvisLiveTurn(); } catch (e) {}
    var backToTurn = !!(liveNow && String(liveNow.conv) === String(id));
    try { hideWorkingPill(); } catch (e) {}
    try { unlockDock(); } catch (e) {}          // a new chat must not arrive locked
    try { window.__jarvisViewChanged && window.__jarvisViewChanged(String(id)); } catch (e) {}
    // The read is a round trip. After a moment the canvas holds the shape of what is coming, and the
    // first thing the answer does — whether it carries turns, a running turn or nothing — is take
    // that shape away, so it can never be mistaken for the conversation itself. Both calls go
    // through the page's hook: the skeleton lives in another closure, and reaching for it directly
    // from here threw before the fetch was ever made, which is what left an opened chat empty.
    try { window.__jarvisArmThreadSkeleton && window.__jarvisArmThreadSkeleton(); } catch (e) {}
    fetch("/api/sessions/" + encodeURIComponent(id), { credentials: "same-origin" })
      .then(function (r) { return r.ok ? r.json() : Promise.reject(r.status); })
      .then(function (d) {
        try { window.__jarvisClearThreadSkeleton && window.__jarvisClearThreadSkeleton(); } catch (e) {}
        // The machine says whether this conversation has a turn still being written in it (`d.turn`).
        // That is the difference between opening a record and re-binding to something live, and only
        // the machine knows it: the page may never have seen the turn at all.
        var running = (d && d.turn) ? d.turn : null;
        if (d && d.turns && d.turns.length) {
          activeId = String(id);
          // Opening a conversation is reading it: the dot clears here, not when the drawer repaints.
          try {
            var _last = d.turns[d.turns.length - 1] || {};
            markRead(String(id), Number(_last.t || 0) || (Date.now() / 1000));
          } catch (e) {}
          try {
            rehydrate(d.turns, title || d.title, running);
          } catch (e) {
            // The turns arrived and the canvas could not take them. That is a different fault from a
            // conversation that is empty, and saying which one it is is the whole difference between a
            // page that is broken and a page that lies about what is stored. The fallback below is for
            // the machine being unreachable, so the two must not share a path.
            window.__jarvisOpenError = String((e && (e.stack || e.message)) || e);
            console.error("openSession: could not paint the conversation", e);
            toast("Could not put that conversation on screen.");
          }
        } else if (running) {
          // A turn in flight and nothing committed yet. Whatever this conversation already holds goes up
          // first — the machine sent its turns with the turn, and dropping them is what left a working
          // light burning on a blank screen with no question anywhere on it — and the turn paints onto
          // that surface below.
          activeId = String(id);
          try { rehydrate((d && d.turns) || [], title || d.title); } catch (e) {}
        } else toast("That conversation has nothing in it.");
        // Whichever way this conversation came back — its record, its first answer still being written, or
        // a reader that never let go — it comes back with its question. The canvas holds the answer and the
        // work; the thing being answered is what makes it a conversation, and on a re-opened chat the page
        // has no other place to get it from. The machine's own record wins, then the page's note of what it
        // asked, and when neither has it nothing is invented.
        try {
          showRunningQuestion(String(id), (d && d.turn_q) || turnQ[String(id)] || lastQ);
        } catch (e) {}
        // The name goes on the block BEFORE the replay is asked for. The replay of a turn's log arrives
        // in milliseconds; named afterwards, every one of those chunks was refused for belonging to a
        // turn the canvas did not hold, and the block sat blank over an answer already written.
        if (d && d.turn_tid) {
          try {
            liveTid = String(d.turn_tid);
            if (id && id !== "current") tidByConv[String(id)] = liveTid;
            var _rb = threadEl ? threadEl.querySelector('[data-running="1"]') : null;
            if (_rb) {
              _rb.dataset.id = liveTid;
              if (!_rb.dataset.t && d.turn_started) _rb.dataset.t = String(Math.round(Number(d.turn_started)));
            }
          } catch (e) {}
        }
        // A conversation with work in flight says so on its pill: reading a record back settles the phase on
        // "worked", and a chat that is still being answered must not present itself as finished.
        if (running) {
          // Immediately, before anything else: a chat being answered while he was elsewhere says so the
          // moment he opens it, rather than showing him a blank canvas and a step count with no word of what
          // is happening. This pill IS the status for that conversation — the badge is left out of it, so he
          // reads one line about what is running instead of two saying the same thing.
          try { showWorkingPill(d && d.turn_started ? d.turn_started * 1000 : 0); } catch (e) {}
          try { paintState(body.getAttribute("data-state") || "idle"); } catch (e) {}   // the badge stands down now
          if (d && d.turn_started) {
            try { lastBgMs = Math.max(0, Date.now() - d.turn_started * 1000); } catch (e) {}
          }
        }
        if (running) {
          if (backToTurn && liveNow && liveNow.alive) {
            // The engine never stopped reading this turn: the words it produced while he was away are
            // in the page's own record and go up now, and the live events continue from here.
            paintBackground(String(id));
            // The words and the steps come back from the engine's own record; the question the turn is
            // answering comes from the machine, which never lost it, and from the page's own note of what
            // it asked when it has one.
            try { showRunningQuestion(String(id), (d && d.turn_q) || turnQ[String(id)] || lastQ); } catch (e) {}
          } else {
            try { window.__jarvisAttachTurn && window.__jarvisAttachTurn(running, String(id), 0); } catch (e) {}
          }
        }
      })
      .catch(function () {
        // Whatever the fallback does, the shape being held for the reader goes first: a skeleton left
        // standing is a page pretending to still be loading something it has already given up on.
        try { window.__jarvisClearThreadSkeleton && window.__jarvisClearThreadSkeleton(); } catch (e) {}
        // The machine could not be reached, or does not hold this conversation at all. The device's own
        // copy is next in line, and it is the fuller record: it carries the turn's work trace too.
        var dev = devGet(id);
        if (dev && dev.turns && dev.turns.length) {
          activeId = String(id);
          rehydrate(dev.turns, title || dev.title);
          return;
        }
        // The engine's own history is the window's, not this conversation's: painting it under a name
        // the machine does not know is how one chat's turns appeared inside another. Only a conversation
        // this page can positively identify is drawn from a local copy.
        if (id === "current" || id === activeId) {
          var _dev2 = devGet(activeId) || devGet(sessionId);
          if (_dev2 && _dev2.turns && _dev2.turns.length) { rehydrate(_dev2.turns, title); return; }
        }
        // A chat this device created but has not yet stored anywhere: the machine has no record of it,
        // and that is not an error — opening it shows the empty chat it is.
        try {
          if (provAll()[String(id)] && REAL_NAME.test(String(id))) {
            activeId = String(id);
            try { window.__jarvisViewChanged && window.__jarvisViewChanged(String(id)); } catch (e) {}
            resetSurface(null, true);
            return;
          }
        } catch (e) {}
        toast("Could not open that conversation.");
      });
  }

  // The boot asks for this: the canvas that comes up holds what this page kept, and the machine holds the
  // conversation. Published because the drawer's half is where the list is read.
  window.__jarvisHydrate = function (turns, title) { return rehydrate(turns, title); };

  // ---------------------------------------------------------------- one canvas per conversation
  // The surface that shows the turn being answered used to be one set of module-level values for the
  // whole page: the question, the answer being written, the step list and the phase. Nothing in it knew
  // which conversation it was showing, so switching chats left another chat's live turn on screen.
  // Each conversation now owns its copy: leaving parks it, returning restores it, and a conversation
  // with no live turn gets a clean surface instead of somebody else's.
  var liveBy = {}, liveConv = "";

  function livePark(conv) {
    var c = String(conv || "");
    if (!c) { try { c = String(window.__jarvisConvId ? window.__jarvisConvId() : ""); } catch (e) { c = ""; } }
    if (!c || c === "current") return;          // a page with no named conversation owns nothing to park
    liveBy[c] = { q: lastQ, a: answerText, s: (steps || []).slice(), phase: workPhase,
                  ms: workMs, t0: t0, settled: !!answerSettled,
                  text: (typeof turnText === "undefined" ? "" : turnText) };
  }

  function liveRestore(conv) {
    var c = String(conv || ""), v = c ? liveBy[c] : null;
    if (!v) return false;
    lastQ = v.q || ""; answerText = v.a || ""; steps = (v.s || []).slice();
    workMs = v.ms || 0; t0 = v.t0 || 0; answerSettled = !!v.settled;
    // The running turn keeps its own block; point the painters back at it so returning to a chat shows
    // the answer where it is being written, not a badge over nothing.
    var _m = blockByConv[c];
    if (_m && _m.b && _m.b.parentNode) {
      liveBlock = _m.b; liveBlockQ = _m.q; liveBlockAns = _m.a;
      qEl = _m.q; ans = _m.a;
      try { ans.textContent = answerText || ""; } catch (e) {}
    }
    if (typeof turnText !== "undefined") turnText = v.text || "";
    return true;
  }

  function liveClear() {
    // Leaving a conversation must not finish its turn: finishing it handed the answer target back to
    // the old surface, so a turn still running wrote its answer where it could not be seen - the badge
    // arrived from the record and the answer did not. The block stays with its own conversation.
    liveBlock = null; liveBlockQ = null; liveBlockAns = null;
    qEl = origQ; ans = origAns;
    lastQ = ""; answerText = ""; steps = []; workMs = 0; t0 = 0;
    answerSettled = true; pendingNote = null;
    if (typeof turnText !== "undefined") turnText = "";
    try { setPhase(""); } catch (e) {}
    try { if (ans) ans.textContent = ""; } catch (e) {}
    try { paintSteps(); paintMeta(); } catch (e) {}
  }

  // The visible conversation changed. The one being left keeps its live state; the one being opened
  // takes its own back, or starts clean rather than inheriting what was on screen.
  function liveSwitch(conv) {
    var c = String(conv || "");
    if (liveConv === c) return false;
    if (liveConv) livePark(liveConv);
    liveConv = c;
    if (!liveRestore(c)) liveClear();
    return true;
  }
  try { window.__jarvisLiveSwitch = liveSwitch; } catch (e) {}


  // ---------------------------------------------------------------- a turn's own controls
  // Copy, edit, share and retry were five buttons for the whole page, wired to whatever was on the live
  // surface: they acted on the moment rather than the message, and an older turn lost them as soon as a
  // new question arrived. Each turn now carries its own, cloned from the same icons so they look
  // identical, with handlers that act on that turn's question and answer and nothing else.
  // Two rows, each under the thing it acts on: copy and edit belong to the question, copy, share and
  // retry belong to the answer. One merged row under the answer offered to edit a question from
  // underneath a reply, and left the question with no controls of its own.
  // When a message was sent, in the reader's own clock. Today shows the time, yesterday says so, and
  // anything older carries its date: the same three steps every chat app uses, because a bare clock
  // time on a month-old turn is a lie about when it happened.
  function stampTime(sec) {
    var s = Number(sec || 0);
    if (!s) return "";
    var d = new Date(s * 1000), now = new Date();
    var hm = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit", hour12: true });
    var same = function (x, y) { return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate(); };
    if (same(d, now)) return hm;
    var y = new Date(now.getTime() - 86400000);
    if (same(d, y)) return "Yesterday " + hm;
    var md = d.toLocaleDateString([], { day: "numeric", month: "short" });
    return md + " " + hm;
  }

  function attachTurnActions(block, q, a) {
    try {
      if (!block) return;
      var qtext = String(q || ""), atext = String(a || "");

      function cloneBtn(id, label, fn) {
        var src = document.getElementById(id);
        var b = src ? src.cloneNode(true) : document.createElement("button");
        if (!src) b.textContent = label;
        b.setAttribute("aria-label", label);
        b.title = label;
        b.onclick = function (ev) { if (ev) ev.stopPropagation(); try { fn(); } catch (e) {} };
        return b;
      }

      if (qtext && !block.querySelector(".qacts")) {
        var qrow = document.createElement("div");
        qrow.className = "qacts";
        // The question leads with when it was asked, then its two controls: time, copy, edit.
        var qWhen = stampTime(block.dataset.t);
        if (qWhen) {
          var qts = document.createElement("span");
          qts.className = "t-time";
          qts.textContent = qWhen;
          qrow.appendChild(qts);
        }
        qrow.appendChild(cloneBtn("qcopy", "Copy this question", function () { copyText(qtext, "Question"); }));
        qrow.appendChild(cloneBtn("qedit", "Edit this question", function () {
          var qi = document.getElementById("q");
          if (qi) { qi.value = qtext; qi.focus(); qi.dispatchEvent(new Event("input", { bubbles: true })); }
        }));
        var tq = block.querySelector(".t-q");
        if (tq && tq.parentNode === block) block.insertBefore(qrow, tq.nextSibling);
        else block.insertBefore(qrow, block.firstChild);
      }

      if (atext && !block.querySelector(".tacts")) {
        var row = document.createElement("div");
        row.className = "tacts";
        row.appendChild(cloneBtn("copy", "Copy this answer", function () { copyText(atext, "Answer"); }));
        row.appendChild(cloneBtn("share", "Share or export this answer", function () {
          if (navigator.share) { navigator.share({ title: "JARVIS", text: atext }).catch(function () {}); return; }
          copyText(atext, "Answer");
        }));
        row.appendChild(cloneBtn("again", "Ask this question again", function () {
          var qi = document.getElementById("q");
          if (!qi) return;
          qi.value = qtext; qi.dispatchEvent(new Event("input", { bubbles: true }));
          var send = document.querySelector("#send") || [].slice.call(document.querySelectorAll("button")).find(function (b) {
            return /send|go/i.test(b.id || "");
          });
          if (send) send.click();
        }));
        // The time of the message belongs to the message, not to the row of controls: it hangs at the
        // far end of the same line so the eye can date a turn without reading the drawer.
        var when = stampTime(block.dataset.ta || block.dataset.t);
        if (when) {
          var ts = document.createElement("span");
          ts.className = "t-time";
          ts.textContent = when;
          row.appendChild(ts);
        }
        block.appendChild(row);
      }
    } catch (e) {}
  }

  function rehydrate(turns, title, liveId) {
    if (!threadEl) return;
    // This conversation owns the canvas from here. What the last one was showing is parked first, so an
    // answer or a step list can never be carried across a switch.
    try { liveSwitch(String(window.__jarvisConvId ? window.__jarvisConvId() : "")); } catch (e) {}
    threadEl.textContent = "";
    var last = turns[turns.length - 1] || {};
    var seen = {};
    // Only a turn that is still being written is left to the live surface. A FINISHED newest turn was
    // being skipped too, so a conversation of one turn came back empty: the record was there, the
    // canvas showed nothing, and the answer read as lost. The caller says which turn, if any, is live.
    var _liveId = String(liveId || "");
    turns.forEach(function (t, i) {
      if (_liveId && String(t.id || t.tid || "") === _liveId) return;
      // A record of a conversation can hold the same turn twice — the page's copy and the machine's, joined
      // on the question — and the canvas must not read as though he asked it twice.
      // The page and the machine both file a turn, with different ids and times, and the answer can
      // differ at the tail because one copy was taken while it was still being written. Identity is
      // the question plus the opening of its answer; two genuine asks of the same thing differ there.
      var _qn = String(t.q || "").replace(/\s+/g, " ").trim();
      var _an = String(t.a || "").replace(/\s+/g, " ").trim().slice(0, 80);
      var key = _qn ? (_qn + "\u0000" + _an) : String(t.id || t.tid || "");
      if (_qn && seen[key]) return;
      if (_qn) seen[key] = true;
      var b = document.createElement("div"); b.className = "turn";
      if (t.q) { var q = document.createElement("p"); q.className = "t-q"; q.textContent = t.q; b.appendChild(q); }
      if (t.a) {
        var a = document.createElement("div"); a.className = "t-a"; paintBodyInto(a, t.a, true); b.appendChild(a);
        // A finished turn keeps saying what it did when it stops being the newest. Only what the record
        // holds is shown: steps if there were steps, elapsed if it was timed, nothing if neither. A turn
        // that ran no tools is never given an activity badge.
        var nSteps = Array.isArray(t.s) ? t.s.length : 0;
        var ms = Number(t.ms || 0) || 0;
        // Same rule as the live pill: the record's own span, however it was written.
        if (!ms && t.startedAt && t.t) ms = Math.max(0, (Number(t.t) - Number(t.startedAt)) * 1000);
        if (nSteps > 0) {                 // the work is the claim: no steps, no badge
          var meta = document.createElement("p");
          meta.className = "t-meta";
          var bits = ["WORKED"];
          if (ms >= 1000) bits.push(Math.round(ms / 1000) + "s");
          if (nSteps) bits.push(nSteps + (nSteps === 1 ? " step" : " steps"));
          meta.textContent = bits.join(" \u00b7 ");
          // The badge belongs to this question. Tapping it shows this turn's own steps, not whatever
          // the page last painted: a turn's work is that turn's, and no other turn in this chat or any
          // other can supply it.
          if (nSteps) {
            meta.setAttribute("role", "button");
            meta.tabIndex = 0;
            meta.title = "Show this turn's steps";
            var openOwn = function (ev) {
              if (ev) ev.stopPropagation();
              try {
                steps = (Array.isArray(t.s) ? t.s.slice() : []);
                paintSteps(); paintMeta();
                if (typeof openSheetMode === "function") openSheetMode("steps");
              } catch (e) {}
            };
            meta.addEventListener("click", openOwn);
            meta.addEventListener("keydown", function (ev) {
              if (ev && (ev.key === "Enter" || ev.key === " ")) openOwn(ev);
            });
          }
          b.insertBefore(meta, b.querySelector(".t-a") || b.children[1] || null);   // directly above the answer
        }
      }
      // Every message carries its id, restored or live: the answer, the pill and the steps hang
      // from it. A restored turn keeps the id it was saved with, or derives the identical one.
      try {
        var _cid = (typeof window.__jarvisConvId === "function") ? window.__jarvisConvId() : "";
        b.dataset.id = String(t.tid || turnTid(_cid, t.q || "", t.startedAt || t.t || 0));
        b.dataset.t = String(Math.round(Number(t.t || t.startedAt || 0)));
        // When the answer landed, not when the question was asked. A turn that took five minutes used
        // to carry the question's own clock on both sides, so the reply looked instant.
        var _ms = Number(t.ms || 0);
        if (_ms > 0) b.dataset.ta = String(Math.round(Number(t.t || t.startedAt || 0) + _ms / 1000));
      } catch (e) {}
      try { attachTurnActions(b, t.q, t.a); } catch (e) {}
      threadEl.appendChild(b);
    });
    while (threadEl.children.length > 40) threadEl.removeChild(threadEl.firstChild);
    lastQ = String(last.q || ""); answerText = String(last.a || "");
    answerSettled = true; turnEnded = true; captionText = ""; capShown = false;
    try { if (liveBlock) attachTurnActions(liveBlock, String((liveBlock.querySelector(".t-q") || {}).textContent || "").trim() || lastQ, answerText); } catch (e) {}
    if (cap) cap.textContent = "";
    clearError(); clearArtifact();
    body.setAttribute("data-past", "1");
    if (workEl) workEl.textContent = "reading back";
    // Two pieces of housekeeping here belong to the module that builds the drawer, and a name from a
    // later closure is a ReferenceError out here. This function used to throw on them, and the fetch
    // that called it reported that as "could not open that conversation" — the conversation was
    // intact the whole time, and the fallback then showed the device's own turns instead of the ones
    // the machine had sent. The chips are cleared through the surface the drawer publishes for it, and
    // the hero is taken down at the point of the repaint, the way retireTurn does it above.
    if (typeof window.__jarvisClearStaged === "function") window.__jarvisClearStaged();
    var _hero = document.getElementById("empty");
    if (_hero && !_hero.hidden) { _hero.hidden = true; document.body.classList.remove("empty-screen"); }
    paintMeta(); paintAnswer();
    // If the newest turn came with a visual and this device still has it, that comes back too; an
    // expired one is not a failure, it is simply gone.
    // The trace travels with the turn now, so a conversation opened on a device that never saw it
    // still shows the work that produced the answer. The device's own copy of the turn is the
    // fallback, for turns that were stored before the trace was carried.
    var rec = turns[turns.length - 1] || {};
    var mine = turnByIdentity(history(), lastQ);
    steps = (Array.isArray(rec.s) && rec.s.length) ? rec.s
          : ((mine && Array.isArray(mine.s)) ? mine.s : []);
    pendingNote = null; t0 = (mine && mine.t) || Date.now();
    // A turn that ran while he was elsewhere has no clock on this canvas. Its own duration is kept with it,
    // so the badge and the summary report the work it actually did rather than the seconds since it landed.
    if (rec && rec.ms) { t0 = Date.now() - Number(rec.ms); workMs = Number(rec.ms); }
    setPhase("worked"); paintSteps();
    // The elapsed beside WORKED on a conversation opened from the record is the turn's own duration, written
    // once here so that a later repaint cannot replace the work it did with the seconds since the page opened.
    try {
      var _wm = (rec && rec.ms) || (mine && mine.ms) || 0;
      if (!_wm && rec && rec.startedAt && rec.t) {
        // Both stamps are on the record: the duration is their difference, which is arithmetic rather
        // than a story. Older turns have neither, and those say nothing instead of showing a number.
        _wm = Math.max(0, (Number(rec.t) - Number(rec.startedAt)) * 1000);
      }
      workMs = _wm || 0;
      var _se = stateEl && stateEl.querySelector(".secs");
      if (_se) _se.textContent = _wm ? (" \u00b7 " + Math.round(_wm / 1000) + "s") : "";
    } catch (e) {}
    lastWidget = rec.w || (mine && mine.w) || null;
    var url = liveWidget();
    if (url) showArtifact({ kind: "widget", url: url, label: "From this conversation", seq: 0 });
    alignTurnToTop(false);
    toBottom();
    toast(title ? "Opened: " + String(title).slice(0, 44) : "Conversation opened");
  }


  // --- the machine's own endpoints ---------------------------------------------------------------
  // Every panel below reads the box through the live server's /sys/* routes, which in turn run the
  // platform's own commands. Nothing is cached between panels, and a toggle re-reads, so the switch
  // you see is the state on disk rather than the state you asked for.
  function sysGet(path) {
    return fetch(path, { headers: { "Accept": "application/json" } })
      .then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; });
  }
  function sysPost(path, body) {
    return fetch(path, { method: "POST", headers: { "Content-Type": "application/json" },
                         body: JSON.stringify(body) })
      .then(function (r) { return r.json().catch(function () { return null; }); })
      .catch(function () { return null; });
  }
  function fmtBytes(n) {
    if (n == null) return "-";
    var u = ["B", "KB", "MB", "GB", "TB"], i = 0;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return (i ? n.toFixed(n < 10 ? 1 : 0) : n) + " " + u[i];
  }
  function fmtUptime(s) {
    var d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
    return d ? (d + "d " + h + "h") : (h ? (h + "h " + m + "m") : (m + "m"));
  }
  function gb(n) {
    var v = (n || 0) / 1073741824;
    return v >= 100 ? String(Math.round(v)) : v.toFixed(1);
  }

  // --- System Telemetry: the box, read live -------------------------------------------------------
  // The four numbers a machine is judged on, as cards with a bar or a gauge, because a figure alone
  // does not say whether it is a lot. The reading is live: the panel re-reads every two seconds
  // while it is the one on screen.
  var telTimer = 0, telData = null, telErr = "";
  function stopTelemetry() { if (telTimer) { clearInterval(telTimer); telTimer = 0; } }
  function barCard(label, value, unit, sub, ratio) {
    var c = document.createElement("div");
    c.className = "p-card";
    var k = document.createElement("span"); k.className = "pc-k"; k.textContent = label;
    var v = document.createElement("span"); v.className = "pc-v"; v.textContent = value;
    if (unit) { var u = document.createElement("span"); u.className = "pc-u"; u.textContent = unit; v.appendChild(u); }
    var bar = document.createElement("div"); bar.className = "p-bar";
    var fill = document.createElement("i");
    var frac = Math.max(0, Math.min(1, ratio == null ? 0 : ratio));
    // A transform rather than a width: the bar is animated on the compositor, so a 450ms fill
    // never lays the card out again on every frame (the stylesheet scales it from the left).
    fill.style.transform = "scaleX(" + frac + ")";
    // One accent for every bar makes a 15% CPU look as alarming as a 90% disk. The band is read
    // off the number itself, so the colour and the length always tell the same story.
    if (frac >= 0.9) fill.className = "hi";
    else if (frac >= 0.75) fill.className = "warn";
    bar.appendChild(fill);
    c.appendChild(k); c.appendChild(v); c.appendChild(bar);
    if (sub) { var s = document.createElement("span"); s.className = "pc-s"; s.textContent = sub; c.appendChild(s); }
    return c;
  }
  function gaugeCard(label, value, unit, sub, pills) {
    var c = document.createElement("div");
    c.className = "p-card";
    var k = document.createElement("span"); k.className = "pc-k"; k.textContent = label;
    var v = document.createElement("span"); v.className = "pc-v"; v.textContent = value;
    if (unit) { var u = document.createElement("span"); u.className = "pc-u"; u.textContent = unit; v.appendChild(u); }
    var row = document.createElement("div"); row.className = "p-pills";
    (pills || []).forEach(function (p) {
      var d = document.createElement("span"); d.className = "p-dot"; d.textContent = p; row.appendChild(d);
    });
    c.appendChild(k); c.appendChild(v); c.appendChild(row);
    if (sub) { var s = document.createElement("span"); s.className = "pc-s"; s.textContent = sub; c.appendChild(s); }
    return c;
  }
  // When the machine last came up. Short enough to stay on ONE line inside a 115px card: a wrap
  // here pushes the caption under the pills and the whole bottom row loses its shared baseline.
  function bootWhen(upSec) {
    var d = new Date(Date.now() - (upSec || 0) * 1000);
    var MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    var h = d.getHours(), ap = h < 12 ? "AM" : "PM";
    h = h % 12 || 12;
    return d.getDate() + " " + MON[d.getMonth()] + ", " +
           h + ":" + String(d.getMinutes()).padStart(2, "0") + " " + ap;
  }
  function renderOverview(host, t) {
    var grid = document.createElement("div");
    grid.className = "p-grid";
    grid.appendChild(barCard("CPU", String(t.cpu.pct), "%", (t.cpu.cores || 0) + " cores",
                             (t.cpu.pct || 0) / 100));
    grid.appendChild(barCard("Memory", gb(t.mem.used), "GB",
                             "of " + gb(t.mem.total) + " GB in use",
                             t.mem.total ? t.mem.used / t.mem.total : 0));
    grid.appendChild(barCard("Disk", gb(t.disk.used), "GB",
                             "of " + gb(t.disk.total) + " GB on /",
                             t.disk.total ? t.disk.used / t.disk.total : 0));
    var pills = ["machine up"];
    if (t.mem.swap_total) pills.push("swap " + gb(t.mem.swap_used) + "/" + gb(t.mem.swap_total) + " GB");
    grid.appendChild(gaugeCard("Uptime", fmtUptime(t.uptime), "", bootWhen(t.uptime), pills));
    host.appendChild(grid);

    var off = reallyOffline();
    var st = document.body.getAttribute("data-state") || "idle";
    var mode = "voice";
    try { mode = (window.__jarvisModes && window.__jarvisModes().mode) || "voice"; } catch (e) {}
    var row = document.createElement("div");
    row.className = "p-pills";
    row.style.marginTop = ".9rem";
    [off ? "offline" : "online",
     workPhase ? WORK_WORD[workPhase].toLowerCase() : st,
     mode === "text" ? "text mode" : "voice mode",
     "load " + (t.cpu.load || []).join(" "),
     toolCount() + " tools this turn"].forEach(function (x) {
      var d = document.createElement("span");
      d.className = "p-dot" + ((x === "offline") ? " bad" : ""); d.textContent = x;
      row.appendChild(d);
    });
    host.appendChild(row);
    panelNote(host, "Read live while this panel is open.");
  }
  function paintTelemetry(out) {
    out.textContent = "";
    out.dataset.mode = "telemetry";
    var panel = document.createElement("div");
    panel.className = "p-tabbody";
    panel.setAttribute("role", "region");
    panel.setAttribute("aria-label", "Overview");
    out.appendChild(panel);
    if (!telData) {
      if (telErr) {
        panelEmpty(panel, "Machine Unreachable", "Could not read this machine: " + telErr, "chip");
        return;
      }
      skTelGrid(panel);
      return;
    }
    renderOverview(panel, telData);
  }
  function startTelemetry() {
    stopTelemetry();
    var load = function () {
      var out = showing("telemetry");
      if (!out) { stopTelemetry(); return; }
      sysGet("/sys/telemetry").then(function (j) {
        var live = showing("telemetry");
        if (!live) return;
        if (j && j.ok && j.telemetry) { telData = j.telemetry; telErr = ""; }
        else { telErr = (j && j.error) || "unreachable"; }
        paintTelemetry(live);
      });
    };
    var first = showing("telemetry");
    if (first) paintTelemetry(first);
    load();
    telTimer = setInterval(load, 2000);
  }

  // --- a filter pinned to the top of a long sub-panel ----------------------------------------------
  // The bar is stuck inside the drawer's own scrolling viewport, so it stays put while the rows
  // pass under it. The filter is local: every row already carries the text it should match on, so
  // a keystroke never goes near the network.
  function searchBar(out, section) {
    var wrap = document.createElement("div");
    wrap.className = "p-searchwrap";
    var ic = document.createElement("span");
    ic.className = "ps-ic"; ic.setAttribute("aria-hidden", "true");
    ic.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="11" cy="11" r="6.4"/><path d="m16 16 4 4"/></svg>';
    var inp = document.createElement("input");
    inp.type = "search"; inp.className = "p-search";
    inp.autocomplete = "off"; inp.spellcheck = false;
    inp.placeholder = "Search " + section + "\u2026";
    inp.setAttribute("aria-label", "Search " + section);
    wrap.appendChild(ic); wrap.appendChild(inp);
    out.appendChild(wrap);
    return inp;
  }
  function searchNone(listEl, text) {
    var p = document.createElement("p");
    p.className = "p-searchnone"; p.hidden = true; p.textContent = text;
    listEl.appendChild(p);
    return p;
  }
  function filterList(input, listEl) {
    var none = listEl.querySelector(".p-searchnone");
    var apply = function () {
      var q = input.value.trim().toLowerCase();
      var rows = listEl.querySelectorAll("[data-search]");
      var shown = 0;
      for (var i = 0; i < rows.length; i++) {
        var hit = !q || rows[i].getAttribute("data-search").indexOf(q) >= 0;
        rows[i].hidden = !hit;
        if (hit) shown++;
      }
      if (none) none.hidden = !q || shown > 0;
    };
    input.addEventListener("input", apply);
    return apply;
  }

  // --- one card per item: an icon, a name, a line under it and the switch that owns its state ------
  // The switch never sets itself: it asks the server to run the platform's own command and the
  // panel is re-read, so an item that refuses to move shows as unmoved instead of as moved.
  var XICON = { mcp: "plug", plugin: "puzzle", skill: "book", cal: "cal", radio: "radio" };
  function extCard(list, kind, name, on, sub, toggle, opts) {
    opts = opts || {};
    var card = document.createElement("div");
    card.className = "xcard";
    card.setAttribute("data-search", (String(name) + " " + String(sub || "") + " " +
      String(opts.search || "")).toLowerCase());
    if (opts.group) card.setAttribute("data-group", opts.group);
    var ic = document.createElement("span");
    ic.className = "xc-ic"; ic.setAttribute("aria-hidden", "true");
    ic.innerHTML = opts.mark ? markIcon(opts.mark) : panelIcon(XICON[kind] || "box");
    var tx = document.createElement("div");
    tx.className = "xc-tx";
    var t = document.createElement("b"); t.className = "xc-t"; t.textContent = name; tx.appendChild(t);
    if (sub || opts.badge) {
      var d = document.createElement("span");
      // A line carrying a badge has to vary in length, so it is allowed to wrap; a plain one keeps
      // the ellipsis that stops a long value pushing the switch off the row.
      d.className = "xc-d" + (opts.badge ? " xc-flow" : "");
      if (sub) d.appendChild(document.createTextNode(sub));
      if (opts.badge) {
        if (sub) d.appendChild(document.createTextNode(" "));
        d.appendChild(opts.badge);
      }
      tx.appendChild(d);
    }
    if (opts.sub2) {
      var d2 = document.createElement("span");
      d2.className = "xc-d xc-d2" + (opts.sub2cls ? " " + opts.sub2cls : "");
      d2.textContent = opts.sub2;
      tx.appendChild(d2);
    }
    var sw = document.createElement("button");
    sw.type = "button"; sw.className = "xswitch iossw" + (on ? " on" : "");
    if (!sw.querySelector(".slider")) { var sl = document.createElement("span"); sl.className = "slider"; sw.appendChild(sl); }
    sw.setAttribute("role", "switch");
    sw.setAttribute("aria-checked", on ? "true" : "false");
    sw.setAttribute("aria-checked", on ? "true" : "false");
    sw.setAttribute("aria-label", name + " " + (on ? "on" : "off"));
    var kn = document.createElement("span"); kn.className = "xknob"; sw.appendChild(kn);
    sw.addEventListener("click", function () { sw.disabled = true; toggle(!on); });
    card.appendChild(ic); card.appendChild(tx); card.appendChild(sw);
    list.appendChild(card);
    return card;
  }

  // --- a small chip: an inline mark plus a word, used for transports and for delivery targets ----
  function chip(cls, spec, text, title) {
    var el = document.createElement("span");
    el.className = "xc-chip " + cls;
    if (spec) {
      var m = document.createElement("span");
      m.className = "xc-chip-ic"; m.setAttribute("aria-hidden", "true");
      m.innerHTML = markIcon(spec);
      el.appendChild(m);
    }
    el.appendChild(document.createTextNode(text));
    if (title) el.title = title;
    return el;
  }

  // --- Plugins: the machine lists slugs and says "bundled" about all of them ----------------------
  // A slug is a folder name, and "bundled" is where a plugin came from, not what it does. So the
  // page carries the reading a person actually needs: the product's name, the job it does, the shelf
  // it belongs on, and a mark of its own. Nothing here invents a capability — the name is a label,
  // and everything else on the card is read back off the machine.
  var PLUGIN_GROUPS = [["web", "Web & Search"], ["system", "System"],
                       ["integrations", "Integrations"], ["ai", "AI & Media"]];
  var PLUGIN_GROUP_LABEL = { ai: "AI & Media", integrations: "Integrations", system: "System", web: "Web & Search" };
  // slug: [name to show, what it does, shelf, mark]
  var PLUGIN_META = {
    "browser-browser-use":  ["Browser Use", "Web Automation", "web", "globe"],
    "browser-browserbase":  ["Browserbase", "Web Automation", "web", "globe"],
    "browser-firecrawl":    ["Firecrawl Browser", "Web Automation", "web", "globe"],
    "chronos":              ["Chronos", "Managed Scheduling", "system", "clock"],
    "basic":                ["Basic Auth", "Dashboard Access", "system", "key"],
    "drain":                ["Drain Control", "Dashboard Access", "system", "key"],
    "nous":                 ["Nous OAuth", "Dashboard Access", "system", "key"],
    "self-hosted":          ["Self-Hosted OIDC", "Dashboard Access", "system", "key"],
    "disk-cleanup":         ["Disk Cleanup", "System Maintenance", "system", "disk"],
    "google_meet":          ["Google Meet", "Meetings", "integrations", "camera"],
    "krea":                 ["Krea", "Image Generation", "ai", "image"],
    "meta-ai-image-gen":    ["Meta AI Images", "Image Generation", "ai", "image"],
    "openai":               ["OpenAI Images", "Image Generation", "ai", "image"],
    "openai-codex":         ["OpenAI Codex Images", "Image Generation", "ai", "image"],
    "langfuse":             ["Langfuse", "Observability", "system", "activity"],
    "a2a-platform":         ["A2A", "Agent Messaging", "integrations", "chat"],
    "buzz-platform":        ["Buzz", "Messaging", "integrations", "chat"],
    "dingtalk-platform":    ["DingTalk", "Messaging", "integrations", "chat"],
    "discord-platform":     ["Discord", "Messaging", "integrations", "chat"],
    "email-platform":       ["Email", "Mail", "integrations", "chat"],
    "feishu-platform":      ["Feishu", "Messaging", "integrations", "chat"],
    "google_chat-platform": ["Google Chat", "Messaging", "integrations", "chat"],
    "homeassistant-platform": ["Home Assistant", "Smart Home", "integrations", "home"],
    "irc-platform":         ["IRC", "Messaging", "integrations", "chat"],
    "line-platform":        ["LINE", "Messaging", "integrations", "chat"],
    "matrix-platform":      ["Matrix", "Messaging", "integrations", "chat"],
    "mattermost-platform":  ["Mattermost", "Messaging", "integrations", "chat"],
    "ntfy-platform":        ["ntfy", "Notifications", "integrations", "chat"],
    "photon-platform":      ["Photon", "Messaging", "integrations", "chat"],
    "raft-platform":        ["Raft", "Messaging", "integrations", "chat"],
    "simplex-platform":     ["SimpleX", "Messaging", "integrations", "chat"],
    "slack-platform":       ["Slack", "Messaging", "integrations", "chat"],
    "sms-platform":         ["SMS", "Messaging", "integrations", "chat"],
    "teams-platform":       ["Microsoft Teams", "Messaging", "integrations", "chat"],
    "telegram-platform":    ["Telegram", "Messaging", "integrations", "chat"],
    "wecom-platform":       ["WeCom", "Messaging", "integrations", "chat"],
    "whatsapp-platform":    ["WhatsApp", "Messaging", "integrations", "chat"],
    "security-guidance":    ["Security Guidance", "Content Safety", "system", "shield"],
    "spotify":              ["Spotify", "Music", "integrations", "music"],
    "teams_pipeline":       ["Teams Pipeline", "Meeting Transcripts", "integrations", "film"],
    "web-brave-free":       ["Brave", "Web Search", "web", "search"],
    "web-ddgs":             ["DuckDuckGo", "Web Search", "web", "search"],
    "web-exa":              ["Exa", "Web Search", "web", "search"],
    "web-firecrawl":        ["Firecrawl", "Web Search", "web", "search"],
    "web-keenable":         ["Keenable", "Web Search", "web", "search"],
    "web-openai-native":    ["OpenAI Web Search", "Web Search", "web", "search"],
    "web-parallel":         ["Parallel", "Web Search", "web", "search"],
    "web-perplexity":       ["Perplexity", "Web Search", "web", "search"],
    "web-searxng":          ["SearXNG", "Web Search", "web", "search"],
    "web-tavily":           ["Tavily", "Web Search", "web", "search"],
    "web-xai":              ["xAI Live Search", "Web Search", "web", "search"],
    "desk":                 ["Front Desk", "Business Line", "system", "chip"],
    "screen":               ["Live Screen", "Device Control", "system", "device"],
    // The generative backends list an image half and a video half under ONE slug. Their shelf is
    // decided here and their name and tag are finished off from the description below, because only
    // the machine's own line says which half a given row is.
    "deepinfra":            ["DeepInfra", "Media Generation", "media", "image"],
    "fal":                  ["FAL.ai", "Media Generation", "media", "image"],
    "openrouter":           ["OpenRouter", "Media Generation", "media", "image"],
    "xai":                  ["xAI Grok Imagine", "Media Generation", "media", "image"]
  };
  function pluginSlugWords(slug) {
    return slug.replace(/-platform$/, "").replace(/[-_]+/g, " ").trim()
      .replace(/\b[a-z]/g, function (c) { return c.toUpperCase(); });
  }
  function pluginGuess(slug) {
    if (/^web-/.test(slug)) return { tag: "Web Search", group: "web", icon: "search" };
    if (/^browser-/.test(slug)) return { tag: "Web Automation", group: "web", icon: "globe" };
    if (/-platform$/.test(slug)) return { tag: "Messaging", group: "integrations", icon: "chat" };
    return { tag: "Extension", group: "system", icon: "puzzle" };
  }
  // Which half of a shared slug this row is. The machine's own description says "image generation
  // backend" or "video generation backend", so the page reads that rather than guessing by position.
  function pluginMedia(it) {
    var d = String(it.description || "");
    if (/\bvideo\b/i.test(d)) return "video";
    if (/\bimage\b/i.test(d)) return "image";
    if (/\baudio\b|\bvoice\b|\bspeech\b/i.test(d)) return "audio";
    return "";
  }
  function pluginView(it) {
    var m = PLUGIN_META[String(it.name || "")];
    var v = m ? { title: m[0], tag: m[1], group: m[2], icon: m[3] }
              : (function () { var g = pluginGuess(String(it.name || "")); return { title: pluginSlugWords(String(it.name || "")), tag: g.tag, group: g.group, icon: g.icon }; })();
    if (v.group === "media") {
      var half = pluginMedia(it);
      v.group = "ai";
      if (half === "video") { v.title += " Video"; v.tag = "Video & Audio"; v.icon = "film"; }
      else if (half === "image") { v.title += " Image"; v.tag = "Image Generation"; v.icon = "image"; }
      else if (half === "audio") { v.title += " Audio"; v.tag = "Video & Audio"; v.icon = "music"; }
      else { v.tag = "Media Generation"; }
    }
    v.pill = PLUGIN_GROUP_LABEL[v.group] || "Other";
    return v;
  }

  // --- a shelf bar under the search: the count on every pill is the list's own ---------------------
  // `spec.active` is off for a list where nothing is ever off, and `spec.groups` carries whichever
  // shelves that list actually has, so one bar serves plugins and skills without a second copy.
  function filterPills(out, rows, list, apply, spec) {
    spec = spec || {};
    var bar = document.createElement("div");
    bar.className = "p-shelf";
    bar.setAttribute("role", "group");
    bar.setAttribute("aria-label", spec.label || "Filter");
    var cells = [["all", "All", rows.length]];
    if (spec.active !== false) {
      cells.push(["active", "Active", rows.filter(function (r) { return r.enabled; }).length]);
    }
    (spec.groups || PLUGIN_GROUPS).forEach(function (g) {
      var n = rows.filter(function (r) { return r.group === g[0]; }).length;
      if (n) cells.push([g[0], g[1], n]);
    });
    cells.forEach(function (c) {
      var b = document.createElement("button");
      b.type = "button";
      b.className = "p-shelfbtn" + (c[0] === "all" ? " on" : "");
      b.setAttribute("data-cat", c[0]);
      b.setAttribute("aria-pressed", c[0] === "all" ? "true" : "false");
      b.appendChild(document.createTextNode(c[1] + " "));
      var n = document.createElement("span");
      n.className = "n"; n.textContent = String(c[2]);
      b.appendChild(n);
      b.addEventListener("click", function () {
        list.setAttribute("data-cat", c[0]);
        var all = bar.querySelectorAll(".p-shelfbtn");
        for (var i = 0; i < all.length; i++) {
          var hit = all[i] === b;
          all[i].className = "p-shelfbtn" + (hit ? " on" : "");
          all[i].setAttribute("aria-pressed", hit ? "true" : "false");
        }
        apply();
      });
      bar.appendChild(b);
    });
    out.appendChild(bar);
    return bar;
  }
  // The search and the shelf are one filter, not two: a plugin is shown when it matches the text AND
  // sits on the chosen shelf.
  function tieFilters(input, list) {
    var apply = function () {
      var q = input ? input.value.trim().toLowerCase() : "";
      var cat = list.getAttribute("data-cat") || "all";
      var rows = list.querySelectorAll("[data-search]");
      var shown = 0;
      for (var i = 0; i < rows.length; i++) {
        var r = rows[i];
        var hit = (!q || r.getAttribute("data-search").indexOf(q) >= 0) &&
          (cat === "all" || (cat === "active" ? r.getAttribute("data-state") === "on"
                                              : r.getAttribute("data-group") === cat));
        r.hidden = !hit;
        if (hit) shown++;
      }
      var none = list.querySelector(".p-searchnone");
      if (none) {
        none.hidden = shown > 0;
        none.textContent = q ? "Nothing matches that search." : "Nothing on that shelf.";
      }
      return shown;
    };
    if (input) input.addEventListener("input", apply);
    return apply;
  }

  // --- one card per plugin, and the card is also the door onto its detail --------------------------
  function xcFact(body, key, value) {
    var line = document.createElement("div");
    line.className = "xc-fact";
    var k = document.createElement("span"); k.textContent = key;
    var v = document.createElement("code"); v.textContent = value;
    line.appendChild(k); line.appendChild(v);
    body.appendChild(line);
    return line;
  }
  function pluginCard(list, it, v, toggle) {
    var on = !!it.enabled;
    var item = document.createElement("div");
    item.className = "xc-item";
    item.setAttribute("data-search", [it.name, v.title, v.tag, v.pill, it.description || ""].join(" ").toLowerCase());
    item.setAttribute("data-group", v.group);
    item.setAttribute("data-state", on ? "on" : "off");

    var card = document.createElement("div");
    card.className = "xcard xc-openable";
    card.setAttribute("role", "button");
    card.setAttribute("tabindex", "0");
    card.setAttribute("aria-expanded", "false");

    var ic = document.createElement("span");
    ic.className = "xc-ic"; ic.setAttribute("aria-hidden", "true");
    ic.innerHTML = panelIcon(v.icon);
    var tx = document.createElement("div");
    tx.className = "xc-tx";
    var t = document.createElement("b"); t.className = "xc-t"; t.textContent = v.title;
    var d = document.createElement("span"); d.className = "xc-d";
    d.textContent = v.tag + (it.source === "user" || it.source === "git" ? " \u00b7 " + it.source : "");
    tx.appendChild(t); tx.appendChild(d);

    var chev = document.createElement("span");
    chev.className = "xc-chev"; chev.setAttribute("aria-hidden", "true");
    chev.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="m7.4 10.2 4.6 4.6 4.6-4.6"/></svg>';

    var sw = document.createElement("button");
    sw.type = "button"; sw.className = "xswitch iossw" + (on ? " on" : "");
    if (!sw.querySelector(".slider")) { var sl = document.createElement("span"); sl.className = "slider"; sw.appendChild(sl); }
    sw.setAttribute("role", "switch");
    sw.setAttribute("aria-checked", on ? "true" : "false");
    sw.setAttribute("aria-checked", on ? "true" : "false");
    sw.setAttribute("aria-label", v.title + " " + (on ? "on" : "off"));
    var kn = document.createElement("span"); kn.className = "xknob"; sw.appendChild(kn);
    // The switch is its own control: tapping it must not also open the card behind it.
    sw.addEventListener("click", function (ev) { ev.stopPropagation(); sw.disabled = true; toggle(!on); });

    card.appendChild(ic); card.appendChild(tx); card.appendChild(chev); card.appendChild(sw);

    // What the tap opens: the plugin's own description, the surface it declares, and the state the
    // machine reports. Every line here was read; none of it is inferred from the name.
    var body = document.createElement("div");
    body.className = "xc-body";
    body.hidden = true;
    if (it.description) {
      var p = document.createElement("p");
      p.className = "xc-desc"; p.textContent = it.description;
      body.appendChild(p);
    }
    var tools = it.tools || [], hooks = it.hooks || [];
    if (!it.declared) {
      xcFact(body, "Declares", "not resolved from a manifest on this machine");
    } else if (!tools.length && !hooks.length) {
      xcFact(body, "Declares", "no tools or hooks");
    } else {
      if (tools.length) xcFact(body, "Tools (" + tools.length + ")", tools.join(", "));
      if (hooks.length) xcFact(body, "Hooks (" + hooks.length + ")", hooks.join(", "));
    }
    xcFact(body, "Runtime", (on ? "enabled" : "not enabled") + " \u00b7 " + (it.source || "unknown source") +
                           (it.version ? " \u00b7 v" + it.version : ""));
    xcFact(body, "Identifier", String(it.name || ""));

    var isOpen = function () { return item.getAttribute("data-open") === "1"; };
    var setOpen = function (open) {
      var others = list.querySelectorAll(".xc-item");
      for (var i = 0; i < others.length; i++) {
        if (others[i] === item) continue;
        others[i].setAttribute("data-open", "0");
        var ob = others[i].querySelector(".xc-body");
        if (ob) ob.hidden = true;
        var oc = others[i].querySelector(".xcard");
        if (oc) oc.setAttribute("aria-expanded", "false");
      }
      item.setAttribute("data-open", open ? "1" : "0");
      body.hidden = !open;
      card.setAttribute("aria-expanded", open ? "true" : "false");
    };
    card.addEventListener("click", function (ev) {
      if (ev.target && ev.target.closest && ev.target.closest("button,a")) return;
      setOpen(!isOpen());
    });
    card.addEventListener("keydown", function (ev) {
      if (ev.key !== "Enter" && ev.key !== " ") return;
      ev.preventDefault(); setOpen(!isOpen());
    });

    item.appendChild(card); item.appendChild(body);
    list.appendChild(item);
    return item;
  }

  // --- Skills, MCP and Plugins: one machine read, three destinations -------------------------------
  //
  // Every row on these panels is a config key or a folder name, and the machine is under no
  // obligation to make those readable. So the page carries the reading — and only the reading. A
  // name is a label; a tag and a badge restate a field the endpoint already sent; and the two things
  // that could be invented (a transport, a schedule) are parsed out of the value itself, with the
  // machine's own display string as the fallback rather than a guess.

  // Connectors: the service's published mark where it publishes one, this app's own glyph where it
  // does not — never the same plug drawn on every row regardless of what the row actually is.
  var MCP_META = {
    "cloudflare":   ["Cloudflare",   "brand:cloudflare"],
    "context7":     ["Context7",     "book"],
    "deepwiki":     ["DeepWiki",     "book"],
    "github":       ["GitHub",       "brand:github"],
    "globalping":   ["Globalping",   "globe"],
    "hugging_face": ["Hugging Face", "brand:huggingface"],
    "kiwi":         ["Kiwi.com",     "plane"],
    "semgrep":      ["Semgrep",      "shield"],
    "serena":       ["Serena",       "code"],
    "twelve-data":  ["Twelve Data",  "chart"],
    "wolfram":      ["Wolfram",      "brand:wolfram"]
  };
  var TX_LABEL = { http: "HTTP", sse: "SSE", stdio: "stdio" };
  function mcpView(it) {
    var k = String(it.name || "");
    var m = MCP_META[k] || MCP_META[k.toLowerCase().replace(/-/g, "_")];
    var tx = TX_LABEL[String(it.transport || "")] || String(it.transport || "");
    return {
      title: m ? m[0] : pluginSlugWords(k),
      mark: m ? m[1] : "plug",
      sub: it.host ? it.host : (it.transport === "stdio" ? "local process" : ""),
      badge: tx ? chip("tx", "", tx, "Reached over " + tx) : null,
      search: [it.host, it.auth, it.transport].join(" ")
    };
  }

  // Skills: the folder is the slug and the folder above it is the shelf. Acronyms and the small
  // joining words are the two things a naive capitaliser gets wrong, and both are visible at a
  // glance in a list of two hundred.
  var SKILL_ACRO = {
    acp: "ACP", ai: "AI", api: "API", apis: "APIs", arxiv: "arXiv", ascii: "ASCII", asr: "ASR",
    cdp: "CDP", cli: "CLI", comfyui: "ComfyUI", cpu: "CPU", crm: "CRM", css: "CSS", csv: "CSV",
    devops: "DevOps", docx: "DOCX", dom: "DOM", findmy: "Find My", gif: "GIF", gguf: "GGUF",
    github: "GitHub", gpu: "GPU", html: "HTML", http: "HTTP", https: "HTTPS", hud: "HUD",
    huggingface: "Hugging Face", ide: "IDE", imap: "IMAP", imessage: "iMessage",
    inspectfirst: "InspectFirst", ios: "iOS", jarvis: "JARVIS", json: "JSON", jwt: "JWT", k8s: "K8s",
    llm: "LLM", llms: "LLMs", macos: "macOS", mcp: "MCP", mlops: "MLOps", nira: "NIRA", npm: "npm",
    oauth: "OAuth", ocr: "OCR", opencode: "OpenCode", openhue: "OpenHue", osrm: "OSRM", otp: "OTP",
    p5js: "p5.js", pdf: "PDF", powerpoint: "PowerPoint", rag: "RAG", ram: "RAM", rss: "RSS",
    sdlc: "SDLC", sdk: "SDK", seo: "SEO", smtp: "SMTP", sql: "SQL", ssh: "SSH", stt: "STT",
    telegram: "Telegram", tls: "TLS", touchdesigner: "TouchDesigner", tts: "TTS", ui: "UI", ugx: "UGX",
    uk: "UK", url: "URL", urls: "URLs", usd: "USD", ussd: "USSD", ux: "UX", vllm: "vLLM", vpn: "VPN",
    vps: "VPS", whatsapp: "WhatsApp", xlsx: "XLSX", xurl: "xurl", yaml: "YAML", youtube: "YouTube"
  };
  // A handful of names are not words that can be capitalised — a product's own casing in the middle
  // of its name, or a filename. They are spelled out rather than approximated.
  var SKILL_NAME = {
    "design-md": "DESIGN.md", "llama-cpp": "llama.cpp"
  };
  var SKILL_MINOR = { and: 1, as: 1, at: 1, by: 1, for: 1, from: 1, in: 1, into: 1, of: 1,
                      on: 1, or: 1, the: 1, to: 1, via: 1, vs: 1, with: 1 };
  function skillTitle(slug) {
    var parts = String(slug || "").split(/[-_]+/).filter(Boolean);
    if (!parts.length) return pluginSlugWords(slug);
    return parts.map(function (w, i) {
      var low = w.toLowerCase();
      if (SKILL_ACRO[low]) return SKILL_ACRO[low];
      if (i > 0 && i < parts.length - 1 && SKILL_MINOR[low]) return low;
      if (/^[0-9]/.test(w)) return w;
      return low.replace(/^[a-z]/, function (c) { return c.toUpperCase(); });
    }).join(" ");
  }
  var SKILL_CAT_ICON = {
    apple: "brand:apple", "autonomous-ai-agents": "agent", "software-development": "code",
    devops: "gear", creative: "brush", productivity: "clipboard", business: "briefcase",
    personal: "user", research: "flask", mlops: "chip", email: "ch:email", "social-media": "chat",
    media: "film", "note-taking": "pencil", "smart-home": "home", web: "globe",
    "whatsapp-front-desk": "ch:whatsapp", "contact-data-erasure": "shield"
  };
  function skillView(it) {
    var cat = String(it.category || "");
    var solo = cat === String(it.name || "");
    return { title: SKILL_NAME[String(it.name || "")] || skillTitle(it.name),
             mark: SKILL_CAT_ICON[cat] || "book",
             sub: solo ? "" : skillTitle(cat),
             group: cat,
             enabled: !!it.enabled,
             search: [it.name, cat, it.group || ""].join(" ") };
  }
  // The shelves are the folders that exist, ordered by how full they are, so the bar never offers a
  // category the tree does not have and never hides one behind a scroll it does not need.
  function skillShelves(rows) {
    var counts = {}, order = [];
    rows.forEach(function (r) {
      if (counts[r.group] === undefined) { counts[r.group] = 0; order.push(r.group); }
      counts[r.group]++;
    });
    order.sort(function (a, b) { return counts[b] - counts[a] || (a < b ? -1 : 1); });
    return order.map(function (c) { return [c, skillTitle(c)]; });
  }

  // --- Schedules: what the scheduler holds, said the way it means -----------------------------------
  var DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  var MON_NAMES = ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  function clock12(h, m) {
    var ap = h < 12 ? "AM" : "PM", hh = h % 12;
    if (hh === 0) hh = 12;
    return hh + ":" + (m < 10 ? "0" + m : String(m)) + " " + ap;
  }
  function everyN(n, unit) {
    var v = Math.round(n);
    return "Every " + v + " " + unit + (v === 1 ? "" : "s");
  }
  function schedText(j) {
    if (j.kind === "interval") {
      var mins = Number(j.minutes) || 0;
      if (mins >= 1440 && mins % 1440 === 0) return everyN(mins / 1440, "day");
      if (mins >= 60 && mins % 60 === 0) return everyN(mins / 60, "hour");
      return everyN(mins, "minute");
    }
    var f = String(j.expr || "").trim().split(/\s+/);
    if (f.length !== 5) return j.when || "On a schedule";
    var mi = f[0], hr = f[1], dom = f[2], mon = f[3], dow = f[4], when;
    if (/^\*\/[0-9]+$/.test(hr)) {
      when = everyN(parseInt(hr.slice(2), 10), "hour");
      if (/^[0-9]+$/.test(mi) && Number(mi) !== 0) when += " at :" + ("0" + Number(mi)).slice(-2);
      return when;
    } else if (hr === "*") {
      return Number(mi) === 0 ? "Hourly" : "Hourly at :" + ("0" + Number(mi)).slice(-2);
    } else if (/^[0-9]+$/.test(hr) && /^[0-9]+$/.test(mi)) {
      when = "at " + clock12(Number(hr) % 24, Number(mi));
    } else {
      return j.when || "On a schedule";
    }
    var base;
    if (/^[0-9]+$/.test(dow) && dom === "*" && mon === "*") base = DAY_NAMES[Number(dow) % 7] + "s";
    else if (/^[0-9]+$/.test(dom) && /^[0-9]+$/.test(mon)) base = Number(dom) + " " + (MON_NAMES[Number(mon)] || "?");
    else if (/^[0-9]+$/.test(dom) && mon === "*") base = "Monthly on day " + Number(dom);
    else base = "Daily";
    return base + " " + when;
  }
  // Age is read from the run's own timestamp, never from a counter this page keeps.
  function relTime(iso) {
    var t = Date.parse(String(iso || ""));
    if (!t) return "";
    var s = Math.max(0, (Date.now() - t) / 1000);
    if (s < 45) return "just now";
    if (s < 5400) return Math.round(s / 60) + "m ago";
    if (s < 172800) return Math.round(s / 3600) + "h ago";
    return Math.round(s / 86400) + "d ago";
  }
  function runLine(j) {
    var bits;
    if (j.last_run_at) {
      var st = String(j.last_status || "");
      var word = st === "ok" ? "Success" : (st === "error" ? "Failed" : (st || "Ran"));
      if (st === "error" && j.failure_streak > 1) word += " \u00b7 " + j.failure_streak + " in a row";
      bits = ["Last run " + relTime(j.last_run_at) + " \u00b7 " + word];
    } else {
      bits = ["Never run"];
    }
    if (j.state === "paused") bits.push("Paused");
    else if (j.state === "completed") bits.push("Finished");
    return bits.join(" \u00b7 ");
  }
  // Where a job's output lands. `deliver` is "platform" or "platform:chat_id"; only the platform is
  // ever shown, because an identifier is not a destination anyone reads.
  var CH_LABEL = { telegram: "Telegram", whatsapp: "WhatsApp", email: "Email", webhook: "Webhook",
                   discord: "Discord", slack: "Slack", signal: "Signal", sms: "SMS",
                   google_chat: "Google Chat", teams: "Teams", matrix: "Matrix", ntfy: "ntfy" };
  function deliverChip(d) {
    var raw = String(d || "").trim();
    if (!raw) return chip("chan", "", "No destination", "This job does not deliver anywhere");
    var key = raw.split(":")[0].trim().toLowerCase();
    if (key === "local") return chip("chan", "disk", "Saved locally", "Written to the machine only");
    if (key === "origin") return chip("chan", "chat", "This chat", "Delivers to the chat it came from");
    var label = CH_LABEL[key] || pluginSlugWords(key);
    return chip("chan", CH_BRAND[key] ? "ch:" + key : "webhook", label, "Delivers to " + label);
  }

  var EXT_META = {
    skills:  { title: "Skills",  kind: "skill",  ep: "/api/skills/toggle" },
    mcp:     { title: "MCP",     kind: "mcp",    ep: "/api/mcp/toggle" },
    plugins: { title: "Plugins", kind: "plugin", ep: "/api/plugins/toggle" }
  };
  var extData = null, extErr = "", extLoaded = false, extStale = false;
  function paintExtPanel(out, mode) {
    var meta = EXT_META[mode];
    out.textContent = "";
    out.dataset.mode = mode;
    if (!extData) {
      if (extErr) {
        panelEmpty(out, meta.title + " Unreachable",
                   "Could not read " + meta.title.toLowerCase() + ": " + extErr, "bolt");
        return;
      }
      skeletonCards(out, 5, { icon: true, switch: true });
      return;
    }
    var items = extData[mode] || [];
    if (!items.length) {
      panelEmpty(out, "No " + meta.title,
                 "Nothing of this kind is configured on the machine yet.", "bolt");
      return;
    }
    var on = items.filter(function (it) { return it.enabled; }).length;
    panelHead(out, on + " on of " + items.length, true);
    if (extStale) {
      // Said plainly, because a list from the cache that does not admit it is a list he will act on.
      panelNote(out, "Last read on this device — reconnecting to the machine.");
    }
    var input = searchBar(out, meta.title);
    if (mode === "plugins") { paintPluginsPanel(out, input, items); return; }
    paintListPanel(out, input, items, mode, meta);
  }

  // Skills and connectors share one list — a mark, a name, a line, a switch — because they are the
  // same object to a reader: something the machine has that can be turned on and off. Only the
  // shelves differ, and only the skill list has any.
  function paintListPanel(out, input, items, mode, meta) {
    var view = mode === "mcp" ? mcpView : skillView;
    var rows = items.map(function (it) {
      var v = view(it);
      return { it: it, v: v, enabled: !!it.enabled, group: v.group };
    });
    var list = document.createElement("div");
    list.className = "xlist";
    list.setAttribute("data-cat", "all");
    rows.forEach(function (r) {
      extCard(list, meta.kind, r.v.title, r.enabled, r.v.sub, function (next) {
        sysPost(meta.ep, { name: r.it.name, enabled: next }).then(function (j) {
          if (j && j.ok) toast(r.v.title + (next ? " on" : " off"));
          else toast((j && (j.result || j.error)) || "That did not take");
          extLoaded = false;
          loadExtPanel(mode);
        });
      }, { mark: r.v.mark, badge: r.v.badge || null, search: r.v.search, group: r.v.group || "" });
    });
    searchNone(list, "Nothing matches that search.");
    var apply = tieFilters(input, list);
    if (mode === "skills") {
      filterPills(out, rows, list, apply,
                  { label: "Filter skills by category", active: false, groups: skillShelves(rows) });
    }
    out.appendChild(list);
    panelNote(out, "A switch writes through the platform's own config; taking full effect may " +
                   "need the gateway restarted.");
  }

  // The plugins panel: the same machine read as skills and MCP, handed to the card that can be
  // opened. The shelf bar sits between the search and the list, and its numbers are counted off the
  // very rows below it, so a pill can never promise a shelf the list does not have.
  function paintPluginsPanel(out, input, items) {
    var rows = items.map(function (it) {
      var v = pluginView(it);
      return { it: it, v: v, enabled: !!it.enabled, group: v.group };
    });
    var list = document.createElement("div");
    list.className = "xlist plugins";
    list.setAttribute("data-cat", "all");
    rows.forEach(function (r) {
      pluginCard(list, r.it, r.v, function (next) {
        sysPost("/api/plugins/toggle", { name: r.it.name, enabled: next }).then(function (j) {
          if (j && j.ok) toast(r.v.title + (next ? " on" : " off"));
          else toast((j && (j.result || j.error)) || "That did not take");
          extLoaded = false;
          loadExtPanel("plugins");
        });
      });
    });
    searchNone(list, "Nothing matches that search.");
    var apply = tieFilters(input, list);
    filterPills(out, rows, list, apply);
    out.appendChild(list);
    apply();
    panelNote(out, "Tap a plugin for its own detail: what it does, what it declares, and how the " +
                   "machine reports it. A switch writes through the platform's own config; taking " +
                   "full effect may need the gateway restarted.");
  }
  // --- the last list this page was shown, kept on the device (cache-first on wake) ----------------
  // Waking on a train is not a reason to be shown a shimmer where his plugins were. What was read last is
  // painted at once and replaced the moment the machine answers, and a read that fails never empties a
  // list: an empty list is a claim, and a failed read is no evidence for it.
  var PANELCACHE = "jarvis.v1.panelcache";
  function cachePut(key, data) {
    try {
      var all = {};
      try { all = JSON.parse(localStorage.getItem(PANELCACHE) || "{}") || {}; } catch (e) { all = {}; }
      all[key] = { at: Date.now(), data: data };
      var keys = Object.keys(all);
      if (keys.length > 8) {
        keys.sort(function (a, b) { return (all[a].at || 0) - (all[b].at || 0); });
        delete all[keys[0]];
      }
      localStorage.setItem(PANELCACHE, JSON.stringify(all));
    } catch (e) {}
  }
  function cacheGet(key) {
    try {
      var all = JSON.parse(localStorage.getItem(PANELCACHE) || "{}") || {};
      return all[key] ? all[key].data : null;
    } catch (e) { return null; }
  }

  function loadExtPanel(mode) {
    var out = showing(mode);
    if (!out) return;
    if (!extLoaded) paintExtPanel(out, mode);
    sysGet("/sys/extensions").then(function (j) {
      var live = showing(mode);
      if (!live) return;
      if (j && j.ok && j.extensions) {
        extData = j.extensions; extErr = ""; extLoaded = true;
        cachePut("ext", j.extensions);
      } else {
        extErr = (j && j.error) || "unreachable";
        // The read failed. If this device has the last list it was shown, that is what he gets — a list
        // with a line saying when it was read, rather than an empty panel or a shimmer that never ends.
        var cached = cacheGet("ext");
        if (cached) { extData = cached; extErr = ""; extLoaded = true; extStale = true; }
      }
      paintExtPanel(live, mode);
    });
  }
  function paintSkills(out) { paintExtPanel(out, "skills"); }
  function paintMcp(out) { paintExtPanel(out, "mcp"); }
  function paintPlugins(out) { paintExtPanel(out, "plugins"); }
  function loadSkills() { loadExtPanel("skills"); }
  function loadMcp() { loadExtPanel("mcp"); }
  function loadPlugins() { loadExtPanel("plugins"); }

  // --- Channels: what is connected, and the wizard for what is not ---------------------------------
  // A connected channel carries a status badge; the rest carry their own setup steps, opened in
  // place. The badge states are read from the machine, never from what the panel last asked for.
  var chanData = null, chanErr = "", chanOpen = "", chanStale = false;
  // The rows carried emoji, which render differently on every device and are not the marks anyone
  // recognises. These are the official glyph shapes (Simple Icons, CC0), drawn in the theme's own ink
  // rather than each brand's colour so the list keeps one voice; a channel with no mark of its own
  // falls back to the channel glyph, never an emoji.
  // The connectors and the Apple skills carry the mark the brand itself publishes (Simple Icons,
  // CC0): first-party shapes rather than a shape invented here. They are drawn in the theme's own
  // ink instead of each brand's colour, so a list of ten connectors still keeps one voice, and a
  // connector with no published mark falls back to a contextual glyph rather than a blank plug.
  var SVG_BRAND = {
    apple: "M12.152 6.896c-.948 0-2.415-1.078-3.96-1.04-2.04.027-3.91 1.183-4.961 3.014-2.117 3.675-.546 9.103 1.519 12.09 1.013 1.454 2.208 3.09 3.792 3.039 1.52-.065 2.09-.987 3.935-.987 1.831 0 2.35.987 3.96.948 1.637-.026 2.676-1.48 3.676-2.948 1.156-1.688 1.636-3.325 1.662-3.415-.039-.013-3.182-1.221-3.22-4.857-.026-3.04 2.48-4.494 2.597-4.559-1.429-2.09-3.623-2.324-4.39-2.376-2-.156-3.675 1.09-4.61 1.09zM15.53 3.83c.843-1.012 1.4-2.427 1.245-3.83-1.207.052-2.662.805-3.532 1.818-.78.896-1.454 2.338-1.273 3.714 1.338.104 2.715-.688 3.559-1.701",
    cloudflare: "M16.5088 16.8447c.1475-.5068.0908-.9707-.1553-1.3154-.2246-.3164-.6045-.499-1.0615-.5205l-8.6592-.1123a.1559.1559 0 0 1-.1333-.0713c-.0283-.042-.0351-.0986-.021-.1553.0278-.084.1123-.1484.2036-.1562l8.7359-.1123c1.0351-.0489 2.1601-.8868 2.5537-1.9136l.499-1.3013c.0215-.0561.0293-.1128.0147-.168-.5625-2.5463-2.835-4.4453-5.5499-4.4453-2.5039 0-4.6284 1.6177-5.3876 3.8614-.4927-.3658-1.1187-.5625-1.794-.499-1.2026.119-2.1665 1.083-2.2861 2.2856-.0283.31-.0069.6128.0635.894C1.5683 13.171 0 14.7754 0 16.752c0 .1748.0142.3515.0352.5273.0141.083.0844.1475.1689.1475h15.9814c.0909 0 .1758-.0645.2032-.1553l.12-.4268zm2.7568-5.5634c-.0771 0-.1611 0-.2383.0112-.0566 0-.1054.0415-.127.0976l-.3378 1.1744c-.1475.5068-.0918.9707.1543 1.3164.2256.3164.6055.498 1.0625.5195l1.8437.1133c.0557 0 .1055.0263.1329.0703.0283.043.0351.1074.0214.1562-.0283.084-.1132.1485-.204.1553l-1.921.1123c-1.041.0488-2.1582.8867-2.5527 1.914l-.1406.3585c-.0283.0713.0215.1416.0986.1416h6.5977c.0771 0 .1474-.0489.169-.126.1122-.4082.1757-.837.1757-1.2803 0-2.6025-2.125-4.727-4.7344-4.727",
    github: "M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12",
    huggingface: "M1.4446 11.5059c0 1.1021.1673 2.1585.4847 3.1563-.0378-.0028-.0691-.0058-.1058-.0058-.4209 0-.8015.16-1.0704.4512-.3454.3737-.4984.8335-.4316 1.293a1.576 1.576 0 0 0 .2148.5978c-.2319.1864-.4018.4456-.4844.7578-.0646.2448-.131.7543.2149 1.2794a1.4552 1.4552 0 0 0-.0625.1055c-.208.3923-.2207.8372-.0371 1.25.2783.6258.9696 1.1175 2.3126 1.6467.8356.3292 1.5988.5411 1.6056.543 1.1046.2847 2.104.4277 2.969.4277 1.4173 0 2.4754-.3849 3.1525-1.1446 1.538.2651 2.791.1403 3.592.006.6773.7555 1.7332 1.1387 3.1467 1.1387.8649 0 1.8643-.143 2.969-.4278.0068-.0019.77-.2138 1.6056-.543 1.343-.5292 2.0343-1.0208 2.3126-1.6466.1836-.4129.171-.8577-.037-1.25a1.4685 1.4685 0 0 0-.0626-.1056c.346-.525.2795-1.0346.2149-1.2793-.0826-.3122-.2525-.5714-.4844-.7579.11-.1816.1831-.3788.2148-.5977.0669-.4595-.0862-.9193-.4316-1.293-.2688-.2913-.6495-.4513-1.0704-.4513-.0209 0-.0376.0008-.0588.0018.3162-.9966.4846-2.0518.4846-3.1523 0-5.807-4.7362-10.5144-10.5789-10.5144-5.8426 0-10.5788 4.7073-10.5788 10.5144Zm10.5788-9.4831c5.2727 0 9.5476 4.246 9.5476 9.483a9.4201 9.4201 0 0 1-.2696 2.2365c-.0039-.0047-.0079-.011-.0117-.0156-.274-.3255-.6679-.5059-1.1075-.5059-.352 0-.714.1155-1.0763.3438-.2403.1517-.5058.422-.7793.7598-.2534-.3492-.608-.5832-1.0137-.6465a1.5174 1.5174 0 0 0-.2344-.0176c-.9263 0-1.4828.7993-1.6935 1.5177-.1046.2426-.6065 1.3482-1.3614 2.0978-1.1681 1.1601-1.4458 2.3534-.8396 3.6382-.843.1029-1.5836.0927-2.365-.006.5906-1.212.3626-2.4388-.8426-3.6322-.755-.7496-1.2568-1.8552-1.3614-2.0978-.2107-.7184-.7673-1.5177-1.6935-1.5177-.078 0-.1568.0054-.2344.0176-.4057.0633-.7604.2973-1.0137.6465-.2735-.3379-.539-.6081-.7794-.7598-.3622-.2283-.7243-.3438-1.0762-.3438-.4266 0-.8094.171-1.0821.4786a9.4208 9.4208 0 0 1-.2598-2.1936c0-5.237 4.2749-9.483 9.5475-9.483zM8.6443 7.0036c-.4838.0043-.9503.2667-1.1934.7227-.3536.6633-.1006 1.4873.5645 1.84.351.1862.4883-.5261.836-.6485.3107-.1095.841.399 1.0078.086.3536-.6634.1025-1.4874-.5625-1.84a1.3659 1.3659 0 0 0-.6524-.1602Zm6.8403 0c-.2199-.002-.4426.05-.6504.1602-.665.3526-.9181 1.1766-.5645 1.84.1669.313.6971-.1955 1.0079-.086.3476.1224.4867.8347.838.6485.6649-.3527.916-1.1767.5624-1.84-.243-.456-.7096-.7184-1.1934-.7227Zm-9.7565 1.418a.8768.8768 0 0 0-.877.877c0 .4846.3925.877.877.877a.8768.8768 0 0 0 .877-.877.8768.8768 0 0 0-.877-.877zm12.6434 0c-.4845 0-.879.3925-.879.877 0 .4846.3945.877.879.877a.8768.8768 0 0 0 .877-.877.8768.8768 0 0 0-.877-.877zM8.7927 11.459c-.179-.003-.2793.1107-.2793.416 0 .8097.3874 2.125 1.4279 2.924.207-.7123 1.3453-1.2832 1.5079-1.2012.2315.1167.2191.4417.6074.7266.3884-.285.374-.6098.6056-.7266.1627-.082 1.3009.4889 1.5079 1.2012 1.0404-.799 1.4278-2.1144 1.4278-2.924 0-1.2212-1.583.6402-3.5413.6485-1.4686-.0061-2.7266-1.0558-3.2639-1.0645zM4.312 14.4768c.5792.365 1.6964 2.2751 2.1056 3.0177.1371.2488.371.3536.582.3536.4188 0 .7465-.4138.0391-.9395-1.0636-.791-.6914-2.0846-.1836-2.1642a.4302.4302 0 0 1 .0664-.004c.4616 0 .666.7892.666.7892s.5959 1.4898 1.6213 2.508c.942.9356 1.062 1.703.4961 2.6661-.0164-.004-.0159.0236-.1484.2149-.1853.2673-.4322.4688-.7188.6152-.5062.2269-1.1397.2696-1.7833.2696-1.037 0-2.1017-.1824-2.6975-.336-.0293-.0075-3.6505-.9567-3.1916-1.8224.0771-.1454.2033-.2031.3633-.2031.6463 0 1.823.9551 2.3283.9551.113 0 .196-.0865.2285-.2031.2249-.8045-3.2787-1.0522-2.9846-2.1642.0519-.1967.193-.2757.3907-.2754.854 0 2.7704 1.4923 3.172 1.4923.0307 0 .0525-.0085.0645-.0274.2012-.3227.1096-.5865-1.3087-1.4395-1.4182-.8533-2.4315-1.329-1.8653-1.9416.0651-.0707.1574-.1015.2695-.1015.8611.0002 2.8948 1.84 2.8948 1.84s.5487.5683.8809.5683c.0762 0 .1416-.0315.1855-.1054.2355-.3946-2.1858-2.2183-2.3224-2.971-.0926-.51.0641-.7676.3555-.7676-.0006.008.1701-.0285.4942.1759zm16.2257.5918c-.1366.7526-2.5579 2.5764-2.3224 2.9709.044.074.1092.1055.1855.1055.3321 0 .881-.5684.881-.5684s2.0336-1.8397 2.8947-1.84c.1121 0 .2044.0308.2695.1016.5662.6125-.447 1.0882-1.8653 1.9415-1.4183.853-1.51 1.1168-1.3087 1.4396.012.0188.0337.0273.0644.0273.4016 0 2.3181-1.4923 3.1721-1.4923.1977-.0002.3388.0787.3907.2754.294 1.112-3.2095 1.3597-2.9846 2.1642.0325.1166.1156.2032.2285.2032.5054 0 1.682-.9552 2.3283-.9552.16 0 .2862.0577.3633.2032.459.8656-3.1623 1.8149-3.1916 1.8224-.5958.1535-1.6605.336-2.6975.336-.6351 0-1.261-.0409-1.7638-.2599-.2949-.1472-.5488-.3516-.7383-.625-.0411-.0682-.1026-.1476-.1426-.205-.5726-.9679-.455-1.7371.4903-2.676 1.0254-1.0182 1.6212-2.508 1.6212-2.508s.2044-.7891.666-.7891a.4318.4318 0 0 1 .0665.0039c.5078.0796.88 1.3732-.1836 2.1642-.7074.5257-.3797.9395.039.9395.211 0 .445-.1047.5821-.3535.4092-.7426 1.5264-2.6527 2.1056-3.0178.5588-.3524.99-.1816.8497.5918z",
    wolfram: "M15.74 10.7c-.53-1.53.14-4 .14-4S13.6 8.01 11.93 8 8.13 6.7 8.13 6.7s.56 2.46.07 4.04c-.48 1.58-2.47 3.34-2.47 3.34s2.58.23 3.85 1.1S12 18.64 12 18.64s.78-2.35 2.32-3.41c1.54-1.07 3.96-1.15 3.96-1.15s-2-1.84-2.54-3.37zm-2 3.69c-1.09.81-1.75 2.19-1.75 2.19s-.76-1.43-1.8-2.22c-1.05-.79-2.57-.97-2.57-.97a5.06 5.06 0 0 0 1.53-2.37c.46-1.54.18-2.73.18-2.73s.92.7 2.62.7c1.7 0 2.79-.7 2.79-.7s-.38 1.58.07 2.7c.44 1.14 1.57 2.41 1.57 2.41s-1.56.17-2.64.99zM13.73 9.6s-.95.38-1.77.37c-.82 0-1.7-.37-1.7-.37.05.58 0 1.15-.17 1.7-.27.86-.91 1.64-.91 1.64A4.23 4.23 0 0 1 12 14.95s.45-.85 1.18-1.33c.5-.31 1.05-.55 1.63-.7 0 0-.74-.78-1.02-1.57-.28-.78-.06-1.75-.06-1.75zM20.1 12l3.31-3.7-4.85-1.07.5-4.94-4.56 2L12 0 9.5 4.29l-4.55-2 .49 4.95L.59 8.29 3.89 12 .6 15.7l4.85 1.07-.5 4.94 4.55-2L12 24l2.5-4.29 4.56 2-.5-4.94 4.85-1.06-3.3-3.71zm-5.27 3.95C14 16.56 12 20.81 12 20.81S10.5 16.95 9 15.95c-1.48-1-5.38-1.22-5.38-1.22s2.99-2.37 3.57-4.47c.59-2.1-.37-5.37-.37-5.37s2.9 2.1 5.08 2.1c2.17 0 5.26-2.1 5.26-2.1s-.82 4.5-.53 5.46c.3.96 3.73 4.38 3.73 4.38s-4.7.62-5.54 1.22z"
  };
  function brandIcon(key) {
    var d = SVG_BRAND[key];
    if (!d) return "";
    return '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="' + d + '"/></svg>';
  }
  var CH_BRAND = {
    "bluebubbles":   "M12.152 6.896c-.948 0-2.415-1.078-3.96-1.04-2.04.027-3.91 1.183-4.961 3.014-2.117 3.675-.546 9.103 1.519 12.09 1.013 1.454 2.208 3.09 3.792 3.039 1.52-.065 2.09-.987 3.935-.987 1.831 0 2.35.987 3.96.948 1.637-.026 2.676-1.48 3.676-2.948 1.156-1.688 1.636-3.325 1.662-3.415-.039-.013-3.182-1.221-3.22-4.857-.026-3.04 2.48-4.494 2.597-4.559-1.429-2.09-3.623-2.324-4.39-2.376-2-.156-3.675 1.09-4.61 1.09zM15.53 3.83c.843-1.012 1.4-2.427 1.245-3.83-1.207.052-2.662.805-3.532 1.818-.78.896-1.454 2.338-1.273 3.714 1.338.104 2.715-.688 3.559-1.701",
    "discord":       "M20.317 4.3698a19.7913 19.7913 0 00-4.8851-1.5152.0741.0741 0 00-.0785.0371c-.211.3753-.4447.8648-.6083 1.2495-1.8447-.2762-3.68-.2762-5.4868 0-.1636-.3933-.4058-.8742-.6177-1.2495a.077.077 0 00-.0785-.037 19.7363 19.7363 0 00-4.8852 1.515.0699.0699 0 00-.0321.0277C.5334 9.0458-.319 13.5799.0992 18.0578a.0824.0824 0 00.0312.0561c2.0528 1.5076 4.0413 2.4228 5.9929 3.0294a.0777.0777 0 00.0842-.0276c.4616-.6304.8731-1.2952 1.226-1.9942a.076.076 0 00-.0416-.1057c-.6528-.2476-1.2743-.5495-1.8722-.8923a.077.077 0 01-.0076-.1277c.1258-.0943.2517-.1923.3718-.2914a.0743.0743 0 01.0776-.0105c3.9278 1.7933 8.18 1.7933 12.0614 0a.0739.0739 0 01.0785.0095c.1202.099.246.1981.3728.2924a.077.077 0 01-.0066.1276 12.2986 12.2986 0 01-1.873.8914.0766.0766 0 00-.0407.1067c.3604.698.7719 1.3628 1.225 1.9932a.076.076 0 00.0842.0286c1.961-.6067 3.9495-1.5219 6.0023-3.0294a.077.077 0 00.0313-.0552c.5004-5.177-.8382-9.6739-3.5485-13.6604a.061.061 0 00-.0312-.0286zM8.02 15.3312c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9555-2.4189 2.157-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.9555 2.4189-2.1569 2.4189zm7.9748 0c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9554-2.4189 2.1569-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.946 2.4189-2.1568 2.4189Z",
    "email":         "M24 5.457v13.909c0 .904-.732 1.636-1.636 1.636h-3.819V11.73L12 16.64l-6.545-4.91v9.273H1.636A1.636 1.636 0 0 1 0 19.366V5.457c0-2.023 2.309-3.178 3.927-1.964L5.455 4.64 12 9.548l6.545-4.91 1.528-1.145C21.69 2.28 24 3.434 24 5.457z",
    "google_chat":   "M1.637 0C.733 0 0 .733 0 1.637v16.5c0 .904.733 1.636 1.637 1.636h3.955v3.323c0 .804.97 1.207 1.539.638l3.963-3.96h11.27c.903 0 1.636-.733 1.636-1.637V5.592L18.408 0Zm3.955 5.592h12.816v8.59H8.455l-2.863 2.863Z",
    "homeassistant": "M22.939 10.627 13.061.749a1.505 1.505 0 0 0-2.121 0l-9.879 9.878C.478 11.21 0 12.363 0 13.187v9c0 .826.675 1.5 1.5 1.5h9.227l-4.063-4.062a2.034 2.034 0 0 1-.664.113c-1.13 0-2.05-.92-2.05-2.05s.92-2.05 2.05-2.05 2.05.92 2.05 2.05c0 .233-.041.456-.113.665l3.163 3.163V9.928a2.05 2.05 0 0 1-1.15-1.84c0-1.13.92-2.05 2.05-2.05s2.05.92 2.05 2.05a2.05 2.05 0 0 1-1.15 1.84v8.127l3.146-3.146A2.051 2.051 0 0 1 18 12.239c1.13 0 2.05.92 2.05 2.05s-.92 2.05-2.05 2.05c-.25 0-.488-.047-.709-.13L12.9 20.602v3.088h9.6c.825 0 1.5-.675 1.5-1.5v-9c0-.825-.477-1.977-1.061-2.561z",
    "line":          "M19.365 9.863c.349 0 .63.285.63.631 0 .345-.281.63-.63.63H17.61v1.125h1.755c.349 0 .63.283.63.63 0 .344-.281.629-.63.629h-2.386c-.345 0-.627-.285-.627-.629V8.108c0-.345.282-.63.63-.63h2.386c.346 0 .627.285.627.63 0 .349-.281.63-.63.63H17.61v1.125h1.755zm-3.855 3.016c0 .27-.174.51-.432.596-.064.021-.133.031-.199.031-.211 0-.391-.09-.51-.25l-2.443-3.317v2.94c0 .344-.279.629-.631.629-.346 0-.626-.285-.626-.629V8.108c0-.27.173-.51.43-.595.06-.023.136-.033.194-.033.195 0 .375.104.495.254l2.462 3.33V8.108c0-.345.282-.63.63-.63.345 0 .63.285.63.63v4.771zm-5.741 0c0 .344-.282.629-.631.629-.345 0-.627-.285-.627-.629V8.108c0-.345.282-.63.63-.63.346 0 .628.285.628.63v4.771zm-2.466.629H4.917c-.345 0-.63-.285-.63-.629V8.108c0-.345.285-.63.63-.63.348 0 .63.285.63.63v4.141h1.756c.348 0 .629.283.629.63 0 .344-.282.629-.629.629M24 10.314C24 4.943 18.615.572 12 .572S0 4.943 0 10.314c0 4.811 4.27 8.842 10.035 9.608.391.082.923.258 1.058.59.12.301.079.766.038 1.08l-.164 1.02c-.045.301-.24 1.186 1.049.645 1.291-.539 6.916-4.078 9.436-6.975C23.176 14.393 24 12.458 24 10.314",
    "matrix":        "M.632.55v22.9H2.28V24H0V0h2.28v.55zm7.043 7.26v1.157h.033c.309-.443.683-.784 1.117-1.024.433-.245.936-.365 1.5-.365.54 0 1.033.107 1.481.314.448.208.785.582 1.02 1.108.254-.374.6-.706 1.034-.992.434-.287.95-.43 1.546-.43.453 0 .872.056 1.26.167.388.11.716.286.993.53.276.245.489.559.646.951.152.392.23.863.23 1.417v5.728h-2.349V11.52c0-.286-.01-.559-.032-.812a1.755 1.755 0 0 0-.18-.66 1.106 1.106 0 0 0-.438-.448c-.194-.11-.457-.166-.785-.166-.332 0-.6.064-.803.189a1.38 1.38 0 0 0-.48.499 1.946 1.946 0 0 0-.231.696 5.56 5.56 0 0 0-.06.785v4.768h-2.35v-4.8c0-.254-.004-.503-.018-.752a2.074 2.074 0 0 0-.143-.688 1.052 1.052 0 0 0-.415-.503c-.194-.125-.476-.19-.854-.19-.111 0-.259.024-.439.074-.18.051-.36.143-.53.282-.171.138-.319.337-.439.595-.12.259-.18.6-.18 1.02v4.966H5.46V7.81zm15.693 15.64V.55H21.72V0H24v24h-2.28v-.55z",
    "mattermost":    "M12.081 0C7.048-.034 2.339 3.125.637 8.153c-2.125 6.276 1.24 13.086 7.516 15.21 6.276 2.125 13.086-1.24 15.21-7.516 1.727-5.1-.172-10.552-4.311-13.557l.126 2.547c2.065 2.282 2.88 5.512 1.852 8.549-1.534 4.532-6.594 6.915-11.3 5.321-4.708-1.593-7.28-6.559-5.745-11.092 1.031-3.046 3.655-5.121 6.694-5.67l1.642-1.94A4.87 4.87 0 0 0 12.08 0zm3.528 1.094a.284.284 0 0 0-.123.024l-.004.001a.33.33 0 0 0-.109.071c-.145.142-.657.828-.657.828L13.6 3.4l-1.3 1.585-2.232 2.776s-1.024 1.278-.798 2.851c.226 1.574 1.396 2.34 2.304 2.648.907.307 2.302.408 3.438-.704 1.135-1.112 1.098-2.75 1.098-2.75l-.087-3.56-.07-2.05-.047-1.775s.01-.856-.02-1.057a.33.33 0 0 0-.035-.107l-.006-.012-.007-.011a.277.277 0 0 0-.229-.14z",
    "ntfy":          "M12.597 13.693v2.156h6.205v-2.156ZM5.183 6.549v2.363l3.591 1.901.023.01-.023.009-3.591 1.901v2.35l.386-.211 5.456-2.969V9.729ZM3.659 2.037C1.915 2.037.42 3.41.42 5.154v.002L.438 18.73 0 21.963l5.956-1.583h14.806c1.744 0 3.238-1.374 3.238-3.118V5.154c0-1.744-1.493-3.116-3.237-3.117h-.001zm0 2.2h17.104c.613.001 1.037.447 1.037.917v12.108c0 .47-.424.916-1.038.916H5.633l-3.026.915.031-.179-.017-13.76c0-.47.424-.917 1.038-.917z",
    "photon":        "M12.152 6.896c-.948 0-2.415-1.078-3.96-1.04-2.04.027-3.91 1.183-4.961 3.014-2.117 3.675-.546 9.103 1.519 12.09 1.013 1.454 2.208 3.09 3.792 3.039 1.52-.065 2.09-.987 3.935-.987 1.831 0 2.35.987 3.96.948 1.637-.026 2.676-1.48 3.676-2.948 1.156-1.688 1.636-3.325 1.662-3.415-.039-.013-3.182-1.221-3.22-4.857-.026-3.04 2.48-4.494 2.597-4.559-1.429-2.09-3.623-2.324-4.39-2.376-2-.156-3.675 1.09-4.61 1.09zM15.53 3.83c.843-1.012 1.4-2.427 1.245-3.83-1.207.052-2.662.805-3.532 1.818-.78.896-1.454 2.338-1.273 3.714 1.338.104 2.715-.688 3.559-1.701",
    "signal":        "M12 0q-.934 0-1.83.139l.17 1.111a11 11 0 0 1 3.32 0l.172-1.111A12 12 0 0 0 12 0M9.152.34A12 12 0 0 0 5.77 1.742l.584.961a10.8 10.8 0 0 1 3.066-1.27zm5.696 0-.268 1.094a10.8 10.8 0 0 1 3.066 1.27l.584-.962A12 12 0 0 0 14.848.34M12 2.25a9.75 9.75 0 0 0-8.539 14.459c.074.134.1.292.064.441l-1.013 4.338 4.338-1.013a.62.62 0 0 1 .441.064A9.7 9.7 0 0 0 12 21.75c5.385 0 9.75-4.365 9.75-9.75S17.385 2.25 12 2.25m-7.092.068a12 12 0 0 0-2.59 2.59l.909.664a11 11 0 0 1 2.345-2.345zm14.184 0-.664.909a11 11 0 0 1 2.345 2.345l.909-.664a12 12 0 0 0-2.59-2.59M1.742 5.77A12 12 0 0 0 .34 9.152l1.094.268a10.8 10.8 0 0 1 1.269-3.066zm20.516 0-.961.584a10.8 10.8 0 0 1 1.27 3.066l1.093-.268a12 12 0 0 0-1.402-3.383M.138 10.168A12 12 0 0 0 0 12q0 .934.139 1.83l1.111-.17A11 11 0 0 1 1.125 12q0-.848.125-1.66zm23.723.002-1.111.17q.125.812.125 1.66c0 .848-.042 1.12-.125 1.66l1.111.172a12.1 12.1 0 0 0 0-3.662M1.434 14.58l-1.094.268a12 12 0 0 0 .96 2.591l-.265 1.14 1.096.255.36-1.539-.188-.365a10.8 10.8 0 0 1-.87-2.35m21.133 0a10.8 10.8 0 0 1-1.27 3.067l.962.584a12 12 0 0 0 1.402-3.383zm-1.793 3.848a11 11 0 0 1-2.345 2.345l.664.909a12 12 0 0 0 2.59-2.59zm-19.959 1.1L.357 21.48a1.8 1.8 0 0 0 2.162 2.161l1.954-.455-.256-1.095-1.953.455a.675.675 0 0 1-.81-.81l.454-1.954zm16.832 1.769a10.8 10.8 0 0 1-3.066 1.27l.268 1.093a12 12 0 0 0 3.382-1.402zm-10.94.213-1.54.36.256 1.095 1.139-.266c.814.415 1.683.74 2.591.961l.268-1.094a10.8 10.8 0 0 1-2.35-.869zm3.634 1.24-.172 1.111a12.1 12.1 0 0 0 3.662 0l-.17-1.111q-.812.125-1.66.125a11 11 0 0 1-1.66-.125",
    "simplex":       "m16.1 0-4.026 4.025L8.125.076 6.113 2.09l3.95 3.947-3.975 3.977L2.14 6.066.109 8.096l3.948 3.947L0 16.1l1.975 1.972 4.056-4.056 3.95 3.947 2.029-2.027-3.95-3.95 3.975-3.972 3.951 3.949-4.025 4.023v.002L9.947 18l-4.023 4.025L7.896 24l4.026-4.025 3.95 3.949 2.013-2.014-3.951-3.95 4.027-4.024 3.95 3.949 2.013-2.012-3.95-3.95L24 7.899l-1.975-1.972L18 9.949 14.049 6l4.025-4.025z",
    "telegram":      "M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z",
    "wechat":        "M8.691 2.188C3.891 2.188 0 5.476 0 9.53c0 2.212 1.17 4.203 3.002 5.55a.59.59 0 0 1 .213.665l-.39 1.48c-.019.07-.048.141-.048.213 0 .163.13.295.29.295a.326.326 0 0 0 .167-.054l1.903-1.114a.864.864 0 0 1 .717-.098 10.16 10.16 0 0 0 2.837.403c.276 0 .543-.027.811-.05-.857-2.578.157-4.972 1.932-6.446 1.703-1.415 3.882-1.98 5.853-1.838-.576-3.583-4.196-6.348-8.596-6.348zM5.785 5.991c.642 0 1.162.529 1.162 1.18a1.17 1.17 0 0 1-1.162 1.178A1.17 1.17 0 0 1 4.623 7.17c0-.651.52-1.18 1.162-1.18zm5.813 0c.642 0 1.162.529 1.162 1.18a1.17 1.17 0 0 1-1.162 1.178 1.17 1.17 0 0 1-1.162-1.178c0-.651.52-1.18 1.162-1.18zm5.34 2.867c-1.797-.052-3.746.512-5.28 1.786-1.72 1.428-2.687 3.72-1.78 6.22.942 2.453 3.666 4.229 6.884 4.229.826 0 1.622-.12 2.361-.336a.722.722 0 0 1 .598.082l1.584.926a.272.272 0 0 0 .14.047c.134 0 .24-.111.24-.247 0-.06-.023-.12-.038-.177l-.327-1.233a.582.582 0 0 1-.023-.156.49.49 0 0 1 .201-.398C23.024 18.48 24 16.82 24 14.98c0-3.21-2.931-5.837-6.656-6.088V8.89c-.135-.01-.27-.027-.407-.03zm-2.53 3.274c.535 0 .969.44.969.982a.976.976 0 0 1-.969.983.976.976 0 0 1-.969-.983c0-.542.434-.982.97-.982zm4.844 0c.535 0 .969.44.969.982a.976.976 0 0 1-.969.983.976.976 0 0 1-.969-.983c0-.542.434-.982.969-.982z",
    "weixin":        "M8.691 2.188C3.891 2.188 0 5.476 0 9.53c0 2.212 1.17 4.203 3.002 5.55a.59.59 0 0 1 .213.665l-.39 1.48c-.019.07-.048.141-.048.213 0 .163.13.295.29.295a.326.326 0 0 0 .167-.054l1.903-1.114a.864.864 0 0 1 .717-.098 10.16 10.16 0 0 0 2.837.403c.276 0 .543-.027.811-.05-.857-2.578.157-4.972 1.932-6.446 1.703-1.415 3.882-1.98 5.853-1.838-.576-3.583-4.196-6.348-8.596-6.348zM5.785 5.991c.642 0 1.162.529 1.162 1.18a1.17 1.17 0 0 1-1.162 1.178A1.17 1.17 0 0 1 4.623 7.17c0-.651.52-1.18 1.162-1.18zm5.813 0c.642 0 1.162.529 1.162 1.18a1.17 1.17 0 0 1-1.162 1.178 1.17 1.17 0 0 1-1.162-1.178c0-.651.52-1.18 1.162-1.18zm5.34 2.867c-1.797-.052-3.746.512-5.28 1.786-1.72 1.428-2.687 3.72-1.78 6.22.942 2.453 3.666 4.229 6.884 4.229.826 0 1.622-.12 2.361-.336a.722.722 0 0 1 .598.082l1.584.926a.272.272 0 0 0 .14.047c.134 0 .24-.111.24-.247 0-.06-.023-.12-.038-.177l-.327-1.233a.582.582 0 0 1-.023-.156.49.49 0 0 1 .201-.398C23.024 18.48 24 16.82 24 14.98c0-3.21-2.931-5.837-6.656-6.088V8.89c-.135-.01-.27-.027-.407-.03zm-2.53 3.274c.535 0 .969.44.969.982a.976.976 0 0 1-.969.983.976.976 0 0 1-.969-.983c0-.542.434-.982.97-.982zm4.844 0c.535 0 .969.44.969.982a.976.976 0 0 1-.969.983.976.976 0 0 1-.969-.983c0-.542.434-.982.969-.982z",
    "whatsapp":      "M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413Z",
  };
  function chanIcon(key) {
    var d = CH_BRAND[key];
    if (d) return '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="' + d + '"/></svg>';
    return panelIcon("radio");
  }
  function chanBadge(card, c, toggle) {
    var pill = document.createElement("button");
    pill.type = "button";
    var on = c.state === "connected";
    pill.className = "p-pill ch-badge " + (on ? "up" : (c.state === "off" ? "off" : "warn"));
    pill.textContent = on ? "Connected \u25be" : (c.state === "setup" ? "Needs setup" : "+ Connect");
    pill.setAttribute("aria-expanded", "false");
    pill.addEventListener("click", function (ev) { ev.stopPropagation(); toggle(pill); });
    card.appendChild(pill);
    return pill;
  }
  function chanRow(list, c, connectable) {
    var card = document.createElement("div");
    card.className = "xcard ch-row" + (connectable ? " ch-openable" : "");
    card.setAttribute("data-search", (c.label + " " + c.key).toLowerCase());
    var ic = document.createElement("span");
    ic.className = "xc-ic"; ic.setAttribute("aria-hidden", "true");
    ic.innerHTML = chanIcon(c.key);
    var tx = document.createElement("div");
    tx.className = "xc-tx";
    var t = document.createElement("b"); t.className = "xc-t"; t.textContent = c.label; tx.appendChild(t);
    var d = document.createElement("span"); d.className = "xc-d";
    d.textContent = c.state === "connected"
      ? (c.contacts ? c.contacts + " contact" + (c.contacts === 1 ? "" : "s") : "no contacts yet")
      : (c.state === "setup" ? "enabled, credential missing" : "not connected");
    tx.appendChild(d);
    card.appendChild(ic); card.appendChild(tx);

    var steps = document.createElement("div");
    steps.className = "ch-steps";
    steps.hidden = chanOpen !== c.key;

    if (c.state === "connected") {
      // What is actually known about a connected channel: its state, how many contacts it has, and the
      // command that owns it. There is no contact editor behind this yet, and a fake one would be worse
      // than none, so the tap opens the facts rather than a door that does not exist.
      [["State", "connected"],
       ["Contacts", String(c.contacts || 0)],
       ["Command", c.command || "hermes gateway setup"]].forEach(function (f) {
        var line = document.createElement("div"); line.className = "ch-fact";
        var k = document.createElement("span"); k.textContent = f[0];
        var v = document.createElement("code"); v.textContent = f[1];
        line.appendChild(k); line.appendChild(v); steps.appendChild(line);
      });
    } else {
      var cmd = document.createElement("code");
      cmd.textContent = c.command;
      steps.appendChild(cmd);
      var ul = document.createElement("ul");
      var lines = (c.steps && c.steps.length)
        ? c.steps
        : ["Run " + c.command + " and choose " + c.label + "."];
      lines.forEach(function (s) {
        var li = document.createElement("li"); li.textContent = s; ul.appendChild(li);
      });
      steps.appendChild(ul);
    }

    var toggle = function (pill) {
      chanOpen = (chanOpen === c.key) ? "" : c.key;
      var open = chanOpen === c.key;
      var all = list.querySelectorAll(".ch-steps");
      for (var i = 0; i < all.length; i++) all[i].hidden = true;
      steps.hidden = !open;
      if (pill) pill.setAttribute("aria-expanded", open ? "true" : "false");
    };

    chanBadge(card, c, toggle);
    list.appendChild(card);
    list.appendChild(steps);
    card.classList.add("ch-openable");
    card.addEventListener("click", function (e) {
      if (e.target && e.target.closest && e.target.closest("a,button")) return;
      toggle(card.querySelector(".ch-badge"));
    });
    return card;
  }
  function paintChannels(out) {
    out.textContent = "";
    out.dataset.mode = "channels";
    if (!chanData) {
      var chanCached = cacheGet("channels");
      if (chanCached) {
        // Held on the device: shown at once, with the line that says where it came from, so opening this
        // while the machine is being reached does not stand him in front of a skeleton.
        chanData = chanCached; chanErr = ""; chanStale = true;
      } else if (chanErr) {
        panelEmpty(out, "Channels Unreachable", "Could not read the channels: " + chanErr, "radio");
        return;
      } else {
        skeletonCards(out, 4, { icon: true, switch: false });
        return;
      }
    }
    if (chanStale) panelNote(out, "Last read on this device — reconnecting to the machine.");
    var all = chanData.channels || [];
    var live = all.filter(function (c) { return c.state !== "off"; });
    var rest = all.filter(function (c) { return c.state === "off"; });
    if (live.length) {
      panelHead(out, live.length + " configured", true);
      var l = document.createElement("div"); l.className = "xlist";
      out.appendChild(l);
      live.forEach(function (c) { chanRow(l, c, false); });
    } else {
      panelEmpty(out, "No Channels", "No messaging channel is configured on this machine yet.", "radio");
    }
    panelHead(out, "Connect Channel", !live.length);
    var input = searchBar(out, "channels");
    var wl = document.createElement("div"); wl.className = "xlist";
    out.appendChild(wl);
    rest.forEach(function (c) { chanRow(wl, c, true); });
    searchNone(wl, "No channel matches that search.");
    filterList(input, wl);
    panelNote(out, "Tap a channel for its own setup steps. The gateway picks a channel up once it " +
                   "is configured and restarted.");
  }
  function loadChannels() {
    var out = showing("channels");
    if (!out) return;
    if (!chanData) paintChannels(out);
    sysGet("/sys/channels").then(function (j) {
      var live = showing("channels");
      if (!live) return;
      if (j && j.ok && j.channels) { chanData = j.channels; chanErr = ""; chanStale = false; cachePut("channels", j.channels); }
      else { chanErr = (j && j.error) || "unreachable"; }
      paintChannels(live);
    });
  }

  // --- Automations: the cron jobs the gateway is actually running, each with its own switch --------
  var autoData = null, autoErr = "";
  function paintAutomations(out) {
    out.textContent = "";
    out.dataset.mode = "automations";
    if (!autoData) {
      if (autoErr) {
        panelEmpty(out, "Schedule Unreachable", "Could not read the schedule: " + autoErr, "cal");
        return;
      }
      skeletonCards(out, 4, { icon: true, switch: true });
      return;
    }
    var d = autoData;
    if (!d.length) {
      panelEmpty(out, "No Automations", "Nothing is scheduled on this machine yet.", "cal");
      return;
    }
    var on = d.filter(function (j) { return j.enabled; }).length;
    var failing = d.filter(function (j) {
      return j.enabled && String(j.last_status || "") === "error";
    }).length;
    panelHead(out, on + " active of " + d.length +
                   (failing ? " \u00b7 " + failing + " failing" : ""), true);
    var list = document.createElement("div");
    list.className = "xlist";
    out.appendChild(list);
    d.forEach(function (j) {
      // A job that has been failing says so on the row, with the machine's own last error trimmed to
      // the first clause. It is the one fact on this panel somebody has to act on.
      var bad = String(j.last_status || "") === "error" && !!j.enabled;
      var err = String(j.last_error || "").replace(/\s+/g, " ").trim();
      extCard(list, "cal", j.name, j.enabled, schedText(j), function (next) {
        sysPost("/api/automations/toggle", { id: j.id, name: j.name, enabled: next })
          .then(function (r) {
            if (r && r.ok) toast(j.name + (next ? " resumed" : " paused"));
            else toast((r && (r.result || r.error)) || "That did not take");
            autoData = null;
            loadAutomations();
          });
      }, {
        badge: deliverChip(j.deliver),
        sub2: runLine(j) + (bad && err ? " \u2014 " + err.slice(0, 96) : ""),
        sub2cls: bad ? "bad" : "",
        search: [j.when, j.expr, j.deliver, j.script].join(" ")
      });
    });
    panelNote(out, "A switch pauses or resumes the job through the scheduler's own command.");
  }
  function loadAutomations() {
    sysGet("/sys/automations").then(function (j) {
      var live = showing("automations");
      if (!live) return;
      if (j && j.ok && j.jobs) { autoData = j.jobs; autoErr = ""; }
      else { autoErr = (j && j.error) || "unreachable"; }
      paintAutomations(live);
    });
  }

  // --- Profile Files: the identity and knowledge files, opened read-only ---------------------------
  // Nothing on this panel writes. It is a viewer drawn as markdown with no field and no save path,
  // so the page cannot corrupt what it opens.
  var pfData = null, pfErr = "", pfSel = "", pfText = null, pfMissing = false;
  function pfRender(host, text) {
    host.textContent = "";
    var lines = String(text || "").split("\n");
    var pre = null;
    var flush = function () { if (pre) { pre.textContent += "\n"; host.appendChild(pre); pre = null; } };
    lines.forEach(function (raw) {
      var line = raw.replace(/\s+$/, "");
      if (/^\s*```/.test(line)) { if (pre) { flush(); } else { pre = document.createElement("pre"); pre.className = "pf-code"; } return; }
      if (pre) { pre.textContent += line + "\n"; return; }
      if (!line.trim()) return;
      if (line.trim() === "\u00a7") { var hr = document.createElement("hr"); hr.className = "pf-hr"; host.appendChild(hr); return; }
      var m = /^(#{1,4})\s+(.*)$/.exec(line);
      if (m) {
        var h = document.createElement("h" + (m[1].length + 1));
        h.className = "pf-h pf-h" + m[1].length;
        h.textContent = m[2];
        host.appendChild(h);
        return;
      }
      var b = /^\s*[-*]\s+(.*)$/.exec(line);
      if (b) { var li = document.createElement("div"); li.className = "pf-li"; li.textContent = b[1]; host.appendChild(li); return; }
      var p = document.createElement("p"); p.className = "pf-p"; p.textContent = line;
      host.appendChild(p);
    });
    flush();
  }
  function paintProfileFile(host) {
    host.textContent = "";
    if (pfMissing) {
      panelEmpty(host, "Not Present",
                 "This file does not exist on the machine yet. Nothing here creates it.", "book");
      return;
    }
    if (pfText == null) { skeletonCards(host, 5, { icon: false, switch: false }); return; }
    pfRender(host, pfText);
  }
  function loadProfileFile() {
    if (!pfSel) return;
    sysGet("/sys/profile-file?id=" + encodeURIComponent(pfSel)).then(function (j) {
      var live = showing("profilefiles");
      if (!live) return;
      var into = live.querySelector(".pf-body");
      if (!into) return;
      if (j && j.ok) { pfText = j.text || ""; pfMissing = !!j.missing; }
      else { pfText = ""; pfMissing = false; }
      paintProfileFile(into);
    });
  }
  function paintProfileFiles(out) {
    out.textContent = "";
    out.dataset.mode = "profilefiles";
    if (!pfData) {
      if (pfErr) {
        panelEmpty(out, "Files Unreachable", "Could not read the profile files: " + pfErr, "book");
        return;
      }
      skeletonCards(out, 4, { icon: true, switch: false });
      return;
    }
    var files = pfData || [];
    if (!files.length) { panelEmpty(out, "No Files", "No profile files are configured.", "book"); return; }
    if (!pfSel) {
      var first = files.filter(function (f) { return f.exists; })[0] || files[0];
      pfSel = first ? first.id : "";
      pfText = null;
      pfMissing = false;
    }
    var pick = document.createElement("div");
    pick.className = "pf-pick";
    files.forEach(function (f) {
      var b = document.createElement("button");
      b.type = "button";
      b.className = "pf-tab" + (pfSel === f.id ? " on" : "") + (f.exists ? "" : " miss");
      b.textContent = f.label;
      b.addEventListener("click", function () {
        if (pfSel === f.id) return;
        pfSel = f.id; pfText = null; pfMissing = false;
        paintProfileFiles(out);
        loadProfileFile();
      });
      pick.appendChild(b);
    });
    out.appendChild(pick);
    var into = document.createElement("div");
    into.className = "pf-body";
    out.appendChild(into);
    paintProfileFile(into);
    panelNote(out, "Read-only. Nothing on this panel can write to a file.");
  }
  function loadProfileFiles() {
    var out = showing("profilefiles");
    if (!out) return;
    if (!pfData) paintProfileFiles(out);
    sysGet("/sys/profile-files").then(function (j) {
      var live = showing("profilefiles");
      if (!live) return;
      if (j && j.ok && j.files) { pfData = j.files; pfErr = ""; }
      else { pfErr = (j && j.error) || "unreachable"; }
      paintProfileFiles(live);
      if (pfSel) loadProfileFile();
    });
  }

  // --- Restart Gateway: the one control on this page that changes the machine ---------------------
  // It keeps a sheet, because it is a short action confirmation rather than a place to read: ask,
  // then run the platform's own restart, which drains a turn in flight rather than cutting it.
  function paintRestart(out) {
    out.textContent = "";
    out.dataset.mode = "restart";
    panelHead(out, "Restart the gateway", true);
    panelNote(out, "This restarts the JARVIS agent gateway. Messaging pauses for a few seconds " +
                   "and a turn in flight is drained first, never cut.");
    var armed = false;
    var b = panelButton(out, "Restart gateway", "danger", function () {
      if (!armed) {
        armed = true; b.classList.add("armed"); b.textContent = "Tap again to restart"; return;
      }
      armed = false; b.classList.remove("armed");
      b.disabled = true; b.textContent = "Restarting\u2026";
      sysPost("/sys/restart", {}).then(function (j) {
        panelNote(out, (j && j.ok)
          ? ("Gateway restarted. " + ((j.result || "").split("\n")[0] || ""))
          : ("Could not restart: " + ((j && (j.result || j.error)) || "no answer")));
        b.disabled = false; b.textContent = "Restart gateway";
        toast((j && j.ok) ? "Gateway restarted" : "Restart failed");
      });
    });
  }

  // --- the Summary sheet -------------------------------------------------------------------------
  // What is left of the sheet: the work trace the pill opens, plus the two panels the hidden header
  // buttons still name. Everything the drawer lists is a detail page of the drawer now.
  function openSheetMode(mode) {
    stopTelemetry();
    var sum = mode !== "history" && mode !== "restart";
    if (stepsEl) stepsEl.classList.add("pane");
    if (mode === "history") {
      stepsEl.dataset.mode = "history";
      if (sheetTitle) sheetTitle.textContent = "History";
      paintHistory(stepsEl);
        } else if (mode === "restart") {
      stepsEl.dataset.mode = "restart";
      if (sheetTitle) sheetTitle.textContent = "Restart Gateway";
      paintRestart(stepsEl);
    } else {
      if (sheetTitle) sheetTitle.textContent = "Summary";
      stepsEl.dataset.mode = "";
      paintSteps();
    }
    if (sheetPanel) sheetPanel.classList.toggle("sum", sum);
    if (sheetX) {
      if (sum) {
        sheetX.innerHTML = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" ' +
                           'stroke="currentColor" stroke-width="1.8" stroke-linecap="round">' +
                           '<path d="M6 6l12 12M18 6L6 18"/></svg>';
        sheetX.setAttribute("aria-label", "Close");
      } else {
        sheetX.textContent = "Close";
      }
    }
    openSheet();
  }

  // ---------------------------------------------------------------- the drawer's own pages
  // A menu row no longer throws a sheet over the canvas: it drills in. The drawer is a two-page
  // track, the detail arrives from the right edge so the motion reads as going deeper, and Back is
  // that same motion reversed. Sheets are kept for short action confirmations only — the
  // attachment picker and the gateway restart.
  var navViewMode = "", navViewGen = 0;
  var PANELS = {
    history:      { title: "Sessions",          paint: paintHistory },
    telemetry:    { title: "System Telemetry",  paint: paintTelemetry, load: startTelemetry, stop: stopTelemetry },
    skills:       { title: "Skills",            paint: paintSkills, load: loadSkills },
    mcp:          { title: "MCP",               paint: paintMcp, load: loadMcp },
    channels:     { title: "Channels",          paint: paintChannels, load: loadChannels },
    plugins:      { title: "Plugins",           paint: paintPlugins, load: loadPlugins },
    automations:  { title: "Automations",       paint: paintAutomations, load: loadAutomations },
    profilefiles: { title: "Profile Files",     paint: paintProfileFiles, load: loadProfileFiles }
  };
  // The one element currently showing `mode`, or null. One answer for both surfaces, so a panel can
  // move between them and every poller asks the same question rather than naming a container.
  function showing(mode) {
    if (navPageTrack && navPageTrack.classList.contains("detail") &&
        navPageBody && navPageBody.dataset.mode === mode) return navPageBody;
    if (sheetEl && !sheetEl.hidden && stepsEl && stepsEl.dataset.mode === mode) return stepsEl;
    return null;
  }
  function navViewOpen() { return !!(navPageTrack && navPageTrack.classList.contains("detail")); }
  function openNavView(mode) {
    var p = PANELS[mode];
    if (!p || !navPageBody || !navPageTrack) return;
    if (navViewMode && navViewMode !== mode && PANELS[navViewMode] && PANELS[navViewMode].stop) {
      PANELS[navViewMode].stop();
    }
    navViewMode = mode;
    if (navPageTitle) navPageTitle.textContent = p.title;
    if (navPageDetail) {
      navPageDetail.removeAttribute("aria-hidden");
      try { navPageDetail.inert = false; } catch (e) {}
    }
    navPageBody.dataset.mode = mode;
    navPageBody.textContent = "";
    navPageBody.scrollTop = 0;
    // Each destination starts from the machine's own answer rather than from the last look at it.
    if (mode === "telemetry") { telData = null; telErr = ""; }
    if (mode === "skills" || mode === "mcp" || mode === "plugins") { extLoaded = false; }
    if (mode === "automations") { autoData = null; }
    if (mode === "channels") { chanData = null; chanErr = ""; chanOpen = ""; }
    if (mode === "profilefiles") { pfData = null; pfErr = ""; pfSel = ""; pfText = null; pfMissing = false; }
    navPageTrack.classList.add("detail");
    p.paint(navPageBody);
    if (p.load) p.load();
  }
  function closeNavView() {
    if (!navViewOpen()) return;
    if (navViewMode && PANELS[navViewMode] && PANELS[navViewMode].stop) PANELS[navViewMode].stop();
    navViewMode = "";
    // Off screen the moment the slide starts, so nothing on it can be reached or focused while it
    // travels — this is set at once, because it changes nothing about how the page looks.
    if (navPageDetail) {
      navPageDetail.setAttribute("aria-hidden", "true");
      try { navPageDetail.inert = true; } catch (e) {}
    }
    var mine = ++navViewGen;
    // The content itself goes once the slide has finished, or the empty page would be the one seen
    // sliding out. The transition's own end is the signal; a background tab throttles timers, so
    // the timer is only the backstop.
    var drop = function () {
      if (mine !== navViewGen || navViewOpen() || !navPageBody) return;
      navPageBody.textContent = "";
      navPageBody.dataset.mode = "";
    };
    try {
      navPageTrack.addEventListener("transitionend", function (e) {
        if (e.target === navPageTrack && e.propertyName === "transform") drop();
      }, { once: true });
    } catch (e) {}
    navPageTrack.classList.remove("detail");
    setTimeout(drop, 600);
  }
  function resetNavView() {
    navViewGen++;
    if (navViewMode && PANELS[navViewMode] && PANELS[navViewMode].stop) PANELS[navViewMode].stop();
    navViewMode = "";
    if (navPageTrack) navPageTrack.classList.remove("detail");
    if (navPageBody) { navPageBody.textContent = ""; navPageBody.dataset.mode = ""; }
    if (navPageDetail) {
      navPageDetail.setAttribute("aria-hidden", "true");
      try { navPageDetail.inert = true; } catch (e) {}
    }
  }
  if (navPageDetail) {
    navPageDetail.setAttribute("aria-hidden", "true");
    try { navPageDetail.inert = true; } catch (e) {}
  }
  if (navBackBtn) navBackBtn.addEventListener("click", closeNavView);

  function clearSteps() { steps = []; lastStepObject = ""; paintSteps(); }

  // --- a past turn, read only -----------------------------------------------------------------

  if (clockBtn) clockBtn.addEventListener("click", function () { openSheetMode("history"); });
  // The text controls moved into the Settings page, so the header's own button goes there rather
  // than into a sheet that no longer paints them.
  // ---------------------------------------------------------------- the answer, as structure
  // The fast layer writes prose, and prose is left exactly as it arrives. But when what comes back
  // is not prose — figures to compare, a command, three options — the page draws the thing itself
  // instead of printing its punctuation. Four shapes are recognised and nothing else is guessed at:
  // a fenced block, a pipe table, a quoted callout, and a run of list items. Anything unrecognised
  // falls through to the plain paragraph it already reads as today, so no answer can be made worse
  // by being looked at.
  function structLine(s) {
    // A fence anywhere on the line, not only at its start: a model opens one mid-sentence.
    return s.indexOf("```") >= 0 ||
           /^[ \t]*#{1,4}[ \t]+\S/.test(s) ||
           /^[ \t]*\*\*[^*\n]{1,80}\*\*[ \t]*$/.test(s) ||
           isPipeRow(s) ||
           /^[ \t]*>[ \t]?\S/.test(s) ||
           /^[ \t]*([-*]|\d+[.)])[ \t]+\S/.test(s) ||
           /^[ \t]*[{\[]/.test(s);                 // a component written without a fence
  }
  function hasStructure(t) {
    var s = String(t || "");
    if (!s) return false;
    if (/```/.test(s)) return true;                                    // a fenced block
    // A heading is structure too. Missing this drew his own briefing shape as raw text with the
    // hashes showing, because a section under a heading may hold no list and no table at all.
    if (/(^|\n)[ \t]*#{1,4}[ \t]+\S/.test(s)) return true;             // a heading names a part
    if (/(^|\n)[ \t]*\*\*[^*\n]{1,80}\*\*[ \t]*(?=\n|$)/.test(s)) return true;
    if (/(^|\n)[ \t]*[^|\n]+(?:\|[^|\n]+)+\n[ \t]*\|?[ \t]*:?-{2,}[-: \t|]*$/m.test(s)) return true;
    if (/^[ \t]*\|/m.test(s)) return true;                              // a table row, closed or not
    // A row glued to the end of a sentence is still a table, and without this the whole answer took
    // the plain-text path and printed its pipes.
    if (/[.:;!?][ \t]+\|[^\n]*\|[ \t]*$/m.test(s)) return true;
    if (/(^|\n)[ \t]*>[ \t]?\S/.test(s)) return true;                  // a quoted callout
    // A divider is structure: without this a '---' answer went down the paragraph path and printed
    // its own rule as three dashes.
    if (/(^|\n)[ \t]*([-*_])([ \t]*\2){2,}[ \t]*(\n|$)/.test(s)) return true;
    // One dash is a sentence that starts with a dash. Two are a list.
    if (/(^|\n)[ \t]*([-*]|\d+[.)])[ \t]+\S[\s\S]*\n[ \t]*([-*]|\d+[.)])[ \t]+\S/.test(s)) return true;
    // A component spec that arrived without its fence is structure too. Without this the page draws
    // its braces as prose, which is exactly the leak this rule exists to stop.
    // A payload is structure whether or not it opens its own line. A real turn glued its chart spec
    // onto the end of a sentence, and because the brace was not at the start of a line this said no,
    // the rich renderer never ran, and the braces went up as prose.
    return /\{\s*"/.test(s) && /"\s*type\s*"\s*:/.test(s);
  }

  // A source, as a chip carrying its own name and a mark that says it opens somewhere else. The
  // arrow is drawn rather than typed: the arrow characters are emoji-presentation on Android and
  // would arrive as a box on a phone without a colour-emoji font.
  function pill(label, href) {
    var a = document.createElement("a");
    a.className = "rc-pill";
    // A link out of a page he owns is drawn only when it is a real address: the answer's text is
    // data from a model, and a javascript: or data: href in it is not something a tap should run.
    var url = /^https?:\/\//i.test(href) ? href : "";
    if (url) { a.href = url; a.target = "_blank"; a.rel = "noopener noreferrer"; }
    else { a.setAttribute("role", "text"); a.removeAttribute("href"); }
    var t = document.createElement("span");
    t.textContent = String(label == null ? "" : label);
    a.appendChild(t);
    a.insertAdjacentHTML("beforeend", '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
      'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M8.6 15.4 15.4 8.6"/><path d="M10 8.6h5.4V14"/></svg>');
    return a;
  }

  // Bold, inline code and links, and nothing else: every other character is text and stays text.
  // Inline spans, drawn as DOM nodes and never as HTML: the answer is model text, so a tag written in
  // it is text, not markup. Order matters. Strike and bold are read before italic or **x** would be
  // drawn as a pair of italic markers; code and links come next. An underscore inside a word
  // (snake_case, file_name) is not emphasis, so that form only counts at a word boundary.
  var INLINE_RE = new RegExp(
    "(~~[^~\\n]+~~" +                                  // strikethrough
    "|\\*\\*[^*\\n]+\\*\\*" +                          // bold
    "|`[^`\\n]+`" +                                    // inline code
    "|\\[[^\\]\\n]+\\]\\([^)\\s]+\\)" +                // a link
    "|\\*[^*\\s][^*\\n]*?[^*\\s]\\*" +                 // italic with asterisks
    "|(?<![\\w])_[^_\\s][^_\\n]*?[^_\\s]_(?![\\w]))",  // italic with underscores, word-bounded
    "g");

  function inline(el, text) {
    var s = String(text == null ? "" : text);
    INLINE_RE.lastIndex = 0;
    var at = 0, m;
    while ((m = INLINE_RE.exec(s))) {
      if (m.index > at) el.appendChild(document.createTextNode(s.slice(at, m.index)));
      var tok = m[0], node;
      if (tok.slice(0, 2) === "~~") {
        node = document.createElement("s"); node.textContent = tok.slice(2, -2);
      } else if (tok.slice(0, 2) === "**") {
        node = document.createElement("b"); node.textContent = tok.slice(2, -2);
      } else if (tok.charAt(0) === "`") {
        node = document.createElement("code"); node.className = "rc-in"; node.textContent = tok.slice(1, -1);
      } else if (tok.charAt(0) === "[") {
        var lm = tok.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
        // A bracket that is not a link is text. Reading `[[file:name]]` as one threw, and the whole
        // answer stopped being drawn because of a marker that is meant to hand over a file.
        node = lm ? pill(lm[1], lm[2]) : document.createTextNode(tok);
      } else {
        node = document.createElement("i");
        node.textContent = tok.slice(1, -1);
      }
      el.appendChild(node);
      at = m.index + tok.length;
    }
    if (at < s.length) el.appendChild(document.createTextNode(s.slice(at)));
    return el;
  }

  var RICON = {
    edit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>',
    copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="8.6" y="8.6" width="11.4" height="11.4" rx="2.4"/><path d="M15.4 8.6V6.4a2.4 2.4 0 0 0-2.4-2.4H6.4A2.4 2.4 0 0 0 4 6.4v6.6a2.4 2.4 0 0 0 2.4 2.4h2.2"/></svg>'
  };

  // A choice hands its own words back to the composer rather than sending them: a tap must never
  // cost him a turn he did not ask for.
  function useAsAsk(text) {
    var field = document.getElementById("q");
    if (!field) return;
    field.value = text;
    try { field.dispatchEvent(new Event("input", { bubbles: true })); } catch (e) {}
    try { field.focus(); } catch (e) {}
    toast("In the composer");
  }
  // Amend, rather than send again: the words go back in the composer with the caret at the end, so he
  // can change the part he got wrong instead of retyping the question. Used by the question's own row
  // and by the answer's, which is the same act on the same turn.
  function editAsk(text) {
    if (!text) return;
    useAsAsk(text);
    var field = document.getElementById("q");
    if (!field) return;
    var n = field.value.length;
    try { field.setSelectionRange(n, n); } catch (e) {}
  }

  function codeBlock(lang, body) {
    var wrap = document.createElement("div");
    wrap.className = "rc-code";
    var head = document.createElement("div");
    head.className = "rc-codehead";
    var tag = document.createElement("span");
    tag.className = "rc-lang"; tag.textContent = lang || "code";
    head.appendChild(tag);
    // A named action, not a bare mark: on a code block the one thing he came to do is take it away.
    var cp = document.createElement("button");
    cp.type = "button"; cp.className = "rc-copy";
    cp.innerHTML = RICON.copy + "<span>Copy code</span>";
    cp.setAttribute("aria-label", "Copy code");
    cp.addEventListener("click", function () { copyText(body, "Code", cp); });
    head.appendChild(cp);
    var pre = document.createElement("pre");
    pre.className = "rc-pre";
    var code = document.createElement("code");
    code.textContent = body;
    pre.appendChild(code);
    wrap.appendChild(head); wrap.appendChild(pre);
    return wrap;
  }

  // A header row, a rule, then rows, until the pipes stop. A column that is nothing but figures is
  // right-aligned so a column of numbers lines up the way a column of numbers should.
  function isNum(c) {
    var t = String(c == null ? "" : c).replace(/[$£€]/g, "").trim();
    return /\d/.test(t) && /^[-+]?[\d.,\s]*%?$/.test(t);
  }
  // A column of figures is right-aligned so the digits line up; a column of words is left alone
  // even when one of its cells happens to be a number. One number in a column of words used to be
  // sent to the right edge on its own, which reads as a column that was never lined up.
  function numColumns(body) {
    if (!body.length) return [];
    var out = [];
    for (var c = 0; c < body[0].length; c++) {
      var seen = 0, num = 0;
      body.forEach(function (r) {
        var v = r[c];
        if (v == null || !String(v).trim()) return;
        seen++; if (isNum(v)) num++;
      });
      out.push(seen > 0 && num / seen >= 0.8);
    }
    return out;
  }
  function isRuleRow(line) {
    return /^[ \t]*\|?[ \t]*:?-{2,}[-: \t|]*$/.test(String(line || ""));
  }
  function isTableLegend(row) {
    var first = String(row[0] == null ? "" : row[0]).trim();
    var filled = row.filter(function (c) { return String(c == null ? "" : c).trim(); });
    return /^(?:n\/m\b|sources?\s*:|notes?\b|[\u2020\u2021\u2014](?:\s|$))/i.test(first) ||
      (filled.length === 1 && first.length > 36);
  }
  function legendBlock(rows) {
    var note = document.createElement("div");
    note.className = "rc-legend";
    rows.forEach(function (row, n) {
      if (n) note.appendChild(document.createElement("br"));
      inline(note, row.filter(function (c) { return String(c == null ? "" : c).trim(); }).join(" "));
    });
    return note;
  }
  function isLegendLine(line) {
    return /^[ \t]*(?:n\/m\b|sources?\s*:|notes?\b|[\u2020\u2021\u2014](?:\s|$))/i.test(String(line || ""));
  }
  function headingParts(line) {
    var text = String(line || "").replace(/^[ \t]*#{1,4}[ \t]+/, "").replace(/[ \t]*#+[ \t]*$/, "");
    var sentence = /^(.{3,80}?[.!?])[ \t]+(\S[\s\S]*)$/.exec(text);
    if (sentence) return [sentence[1], sentence[2]];
    var prose = /^(.{3,70}?)[ \t]+((?:Here\s+(?:is|are)|This\s+(?:is|shows|means)|These\s+(?:are|show)|The\s+following\b|Below\b)[\s\S]*)$/i.exec(text);
    if (prose) return [prose[1], prose[2]];
    // A section title with its own sentence glued after it and no punctuation between the two:
    // "30-Day Fleet Operational Expense Total spend across the fleet is 4.2m shillings a month." The
    // whole line was drawn as one bold title, so a sentence read as part of the name of the part.
    // The break is found by shape rather than by guessing: a capitalised word that opens a run of
    // lowercase ones, at least two words in, with at least three words left after it. The title half
    // must itself hold no lowercase word, and that condition is what keeps real titles intact -
    // "Cost: what the fleet really takes to run" has lowercase words from the second word on, so no
    // candidate survives and nothing is split. A sentence opening on a lowercase word is deliberately
    // not matched: allowing that would cut legitimate titles such as "Cost of the fleet" in half.
    var words = text.split(/[ \t]+/);
    var STARTER = /^(the|a|an|this|that|these|those|it|we|they|he|she|there)$/i;
    var ENDER   = /^(the|a|an|of|from|in|on|for|and|or|to|with|per|each|its|his|her|their|our)$/i;
    var labelled = /:$/.test(words[0] || "");   // "Cost: what it takes" is a label, never a title
    // A short line is only read for a split when it ends like a sentence. A title does not end in a
    // full stop, so "System Health Disk fine." is separated while "Cost Per Kilometre." is left whole.
    var punctEnd = /[.!?]$/.test(words[words.length - 1] || "");
    var longEnough = words.length >= 5 || punctEnd;
    if (!labelled && longEnough) {
      // A sentence that ends like one may be as short as two words ("Disk fine."); without that
      // closing punctuation the tail must be at least three, so a title is never cut on a phrase.
      var stop = words.length - (punctEnd ? 1 : 2);
      for (var k = 1; k < stop; k++) {
        var w = words[k], nxt = words[k + 1] || "";
        // Two shapes start a sentence: a capitalised word followed by lowercase words, or a lowercase
        // word that can only be a sentence opener. A preposition cannot open one, so "from" is out and
        // a title like "Uganda Fuel Prices September 2026" is never cut at it.
        var starts = (/^[A-Z]/.test(w) && /^[a-z]/.test(nxt)) || (/^[a-z]/.test(w) && STARTER.test(w));
        if (!starts) continue;
        var head = words.slice(0, k);
        if (/[ ][a-z]+[ ]/.test(" " + head.join(" ") + " ")) continue;   // a lowercase word in the title
        if (ENDER.test(head[head.length - 1])) continue;          // a title never ends on a connector,
        return [head.join(" "), words.slice(k).join(" ")];        // which is how "Notes From The" was
      }                                                          // drawn as a heading with the rest below
    }
    return [text, ""];
  }
  // Rows the writer left outside a component's own data, as pipes under it. They are the same
  // dataset, so they are folded into it rather than drawn as a second table beside it. Nothing is
  // folded unless all three hold: the payload is a component the page has, it already carries an
  // array of rows, and the lines under it really are pipe rows. A rule row is never a row of data.
  function mergeTrailingRows(text, lines, from) {
    var spec = parseSpec(text);
    if (!isSpec(spec)) return null;
    // A citation written under a widget belongs inside the widget: the page prints the source of a
    // chart, a tile set or a comparison from its own payload, so a 'Source:' line left in the prose is
    // the same citation on the screen twice. Taken only by a widget that prints one, and only when it
    // carries none of its own, so nothing is lost and nothing repeats.
    var srcUsed = 0, scan0 = from;
    while (scan0 < lines.length && !lines[scan0].trim()) scan0++;
    var cite = /^[ \t]*(?:source|sources|figures from|ref)\b[^:\n]*[:\u2013\u2014-][ \t]*(\S.*)$/i.exec(lines[scan0] || "");
    if (cite && !spec.source && !spec.src && UI_SOURCED[uiTxt(spec.type, 20).toLowerCase()]) {
      spec.source = cite[1].replace(/[ \t]+$/, "");
      srcUsed = scan0 - from + 1;
    }
    var srcOut = srcUsed ? { text: JSON.stringify(spec), used: srcUsed } : null;
    var keys = ["rows", "data", "items", "values", "steps", "options"], arrKey = null, arr = null;
    for (var n = 0; n < keys.length; n++) {
      if (Array.isArray(spec[keys[n]])) { arrKey = keys[n]; arr = spec[keys[n]]; break; }
    }
    if (!arrKey) return srcOut;
    // The lines are scanned from the payload's own position to the last row that belongs to it. A
    // blank line between the payload and its rows is skipped rather than read as the end of the run:
    // the split that gives a glued payload its own line leaves one either side of it.
    var used = 0, rows = [], scan = from;
    while (scan < lines.length) {
      var raw = lines[scan];
      if (!raw.trim()) { scan++; continue; }
      if (!isPipeRow(raw)) break;
      if (!isRuleRow(raw)) {
        rows.push(raw.replace(/^[ \t]*\|/, "").replace(/\|[ \t]*$/, "").split("|").map(function (c) { return c.trim(); }));
      }
      used = scan - from + 1;             // consume up to and including this row, blanks included
      scan++;
    }
    // Rows beside a payload that already carries them are the same dataset written a second time, not
    // rows that belong inside it: the payload keeps its own copy and the markdown one is consumed
    // without being drawn. Only rows the payload does not already hold are folded in, which is the
    // case this was built for - a dataset the model began as a payload and finished in markdown.
    var held = [];
    uiBagValues(arr, held);
    var isHeld = function (r) {
      var cs = r.map(uiNorm).filter(function (c) { return c; });
      return cs.length > 0 && cs.every(function (c) { return held.indexOf(c) >= 0; });
    };
    var fresh = rows.filter(function (r) { return !isHeld(r); });
    if (!fresh.length) return { text: spec.source ? JSON.stringify(spec) : text, used: Math.max(used, srcUsed) };
    // A chart draws a series, not a row array: markdown written beside it is either a duplicate of the
    // same figures or a different dataset, and neither belongs in the series it draws.
    if (uiTxt(spec.type, 20).toLowerCase() === "chart" || arrKey === "data") return srcOut;
    rows = fresh;
    if (!rows.length) return srcOut;
    var shape = null;
    for (var m = 0; m < arr.length; m++) if (arr[m] != null) { shape = arr[m]; break; }
    rows.forEach(function (r) {
      if (Array.isArray(shape)) { arr.push(r); return; }
      if (shape && typeof shape === "object") {
        var o = {}, ks = Object.keys(shape);
        ks.forEach(function (k, n2) { o[k] = n2 < r.length ? r[n2] : ""; });
        arr.push(o);
        return;
      }
      arr.push(r.length > 1 ? r.join(" ") : (r[0] || ""));
    });
    return { text: JSON.stringify(spec), used: Math.max(used, srcUsed) };
  }

  function tableCells(line) {
    // Only unescaped pipes delimit cells. Remove the pipe escape here: the inline renderer
    // handles emphasis and links, not table syntax.
    var text = String(line).trim(), parts = [], cell = "", escaped = false;
    for (var i = 0; i < text.length; i++) {
      var ch = text.charAt(i);
      if (ch === "|" && escaped) cell = cell.slice(0, -1) + ch;
      else if (ch === "|") { parts.push(cell.trim()); cell = ""; }
      else cell += ch;
      if (ch === "\\") escaped = !escaped; else escaped = false;
    }
    parts.push(cell.trim());
    if (text.charAt(0) === "|") parts.shift();
    var slashes = 0, end = text.length - 2;
    while (end >= 0 && text.charAt(end--) === "\\") slashes++;
    if (text.charAt(text.length - 1) === "|" && slashes % 2 === 0) parts.pop();
    return parts;
  }

  function tableBlock(raw) {
    // The row under the header is the --- rule when the model wrote one. Assuming it is there and
    // skipping a row because of it dropped the table's own first line of data whenever it was not,
    // which is how a table came back missing its first row.
    // A --- row is structure and never a row of data. When a run began on the rule itself the rule
    // became the table's own header and the real header above it was read as prose.
    // A heading and the table's own header row can arrive on the same line, because that is how a
    // model writes them: "### Caching strategies | Strategy | Writes | Best for |". The heading is
    // the words before the first pipe; everything from the pipe on is the header row and is put
    // back, or the table loses its column labels and the first row of data is promoted into them.
    var heading = "";
    if (raw.length && /^[ \t]*#{1,3}[ \t]+\S/.test(raw[0])) {
      var headLine = raw.shift(), bar = headLine.indexOf("|");
      if (bar >= 0) { heading = headLine.slice(0, bar); raw.unshift(headLine.slice(bar)); }
      else heading = headLine;
    }
    var rows = raw.filter(function (l) { return !isRuleRow(l); });
    if (!rows.length) return null;
    var parsedRows = rows.map(tableCells), legends = [];
    parsedRows = parsedRows.filter(function (row) {
      if (!isTableLegend(row)) return true;
      legends.push(row); return false;
    });
    if (!parsedRows.length) return legends.length ? legendBlock(legends) : null;
    var head = parsedRows[0];
    var bodyRows = parsedRows.slice(1);
    // A frequent model error is an unlabeled leading rank. Repair only an unambiguous 1..N
    // sequence with exactly one extra cell on every row. Other ragged tables stay readable as
    // rows in source order, without falsely attaching a value to the next column's heading.
    if (bodyRows.length && bodyRows.every(function (row, i) {
      return row.length === head.length + 1 && row[0] === String(i + 1);
    })) head = ["#"].concat(head);
    if (bodyRows.some(function (row) { return row.length !== head.length; })) {
      var fallback = document.createElement("div");
      fallback.className = "rc-table-fallback";
      var notice = document.createElement("p");
      notice.textContent = "Column labels are incomplete; values are shown in their original order.";
      fallback.appendChild(notice);
      // Keep the original header too: labels and every supplied value remain available.
      parsedRows.forEach(function (row) {
        var line = document.createElement("div");
        row.forEach(function (cell, i) {
          if (i) line.appendChild(document.createTextNode(" · "));
          inline(line, cell);
        });
        fallback.appendChild(line);
      });
      var readable = document.createDocumentFragment();
      if (heading) {
        var title = document.createElement("div"); title.className = "rc-h";
        inline(title, heading.replace(/^[ \t]*#{1,3}[ \t]+/, "").replace(/[ \t]*#+[ \t]*$/, ""));
        readable.appendChild(title);
      }
      readable.appendChild(fallback);
      if (legends.length) readable.appendChild(legendBlock(legends));
      return readable;
    }
    var align = numColumns(bodyRows);
    var wrap = document.createElement("div");
    wrap.className = "rc-tw";
    wrap.setAttribute("role", "region");
    wrap.setAttribute("aria-label", "Data table; scroll horizontally for more columns");
    wrap.setAttribute("tabindex", "0");
    var t = document.createElement("table");
    t.className = "rc-table";
    var thead = document.createElement("thead"), tr = document.createElement("tr");
    head.forEach(function (c, i) {
      var th = document.createElement("th");
      th.setAttribute("scope", "col");
      if (align[i]) th.className = "num";
      inline(th, c); tr.appendChild(th);
    });
    thead.appendChild(tr); t.appendChild(thead);
    var tb = document.createElement("tbody");
    bodyRows.forEach(function (row) {
      var trr = document.createElement("tr");
      row.forEach(function (c, i) {
        var td = document.createElement("td");
        if (align[i]) td.className = "num";
        inline(td, c); trr.appendChild(td);
      });
      tb.appendChild(trr);
    });
    t.appendChild(tb); wrap.appendChild(t);
    // Table headings label columns. Reading or touching one never changes row order.
    var group = document.createDocumentFragment();
    if (heading) {
      var hd = document.createElement("div");
      hd.className = "rc-h";
      inline(hd, heading.replace(/^[ \t]*#{1,3}[ \t]+/, "").replace(/[ \t]*#+[ \t]*$/, ""));
      group.appendChild(hd);
    }
    group.appendChild(wrap);
    if (legends.length) group.appendChild(legendBlock(legends));
    return group;
  }

  function calloutBlock(body) {
    var d = document.createElement("div");
    d.className = "rc-call";
    var bar = document.createElement("span");
    bar.className = "rc-callbar"; bar.setAttribute("aria-hidden", "true");
    var p = document.createElement("p");
    p.className = "rc-calltext";
    inline(p, body.replace(/\s*\n\s*/g, " ").trim());
    d.appendChild(bar); d.appendChild(p);
    return d;
  }

  // A list reads as cards, not as a wall of dashes. A leading bold run or a short "name: ..." is
  // taken as the card's own header; the rest is its body, and a card holds nothing but its words.
  // A run of list lines, in the order it was written: bullets, or numbers, with one level of nesting
  // by indentation. A line indented two spaces or more under the item above it is that item's child,
  // and a numbered child becomes its own <ol>. Continuation lines belong to the item they follow.
  function listRun(lines, start) {
    var first = /^([ \t]*)([-*]|\d+[.)])[ \t]+(\S[\s\S]*)$/.exec(lines[start]);
    var ordered = /^\d/.test(first[2]);
    var root = document.createElement(ordered ? "ol" : "ul");
    root.className = ordered ? "rc-ol" : "rc-ul";
    if (ordered) {
      var n0 = parseInt(first[2], 10);
      if (n0 > 1) root.setAttribute("start", String(n0));   // a list that begins at 3 says 3
    }
    var i = start, lastLi = null, sub = null, subOwner = null, subOrdered = false;
    while (i < lines.length) {
      var m = /^([ \t]*)([-*]|\d+[.)])[ \t]+(\S[\s\S]*)$/.exec(lines[i]);
      if (!m) break;
      var indent = m[1].replace(/\t/g, "  ").length;
      var ord = /^\d/.test(m[2]);
      var text = m[3];
      i++;
      while (i < lines.length && lines[i].trim() &&
             !/^[ \t]*([-*]|\d+[.)])[ \t]+\S/.test(lines[i]) && !structLine(lines[i])) {
        text += " " + lines[i].trim(); i++;
      }
      var li = document.createElement("li");
      inline(li, text);
      if (indent >= 2 && lastLi) {
        if (!sub || subOwner !== lastLi || subOrdered !== ord) {
          sub = document.createElement(ord ? "ol" : "ul");
          sub.className = ord ? "rc-ol" : "rc-ul";
          subOwner = lastLi; subOrdered = ord;
          lastLi.appendChild(sub);
        }
        sub.appendChild(li);
      } else {
        root.appendChild(li);
        lastLi = li; sub = null; subOwner = null;
      }
    }
    return { node: root, next: i };
  }

  function listBlock(items, asBullets) {
    if (asBullets) {
      var bullets = document.createElement("ul");
      bullets.className = "rc-ul";
      items.forEach(function (it) {
        var bi = document.createElement("li");
        inline(bi, String(it));
        bullets.appendChild(bi);
      });
      return bullets;
    }
    var ul = document.createElement("ul");
    ul.className = "rc-cards";
    items.forEach(function (it) {
      var li = document.createElement("li");
      li.className = "rc-card";
      var head = "", body = String(it);
      var m = body.match(/^\*\*(.+?)\*\*[ \t]*[,:.\u2014\u2013-]?[ \t]*([\s\S]*)$/);
      if (m) { head = m[1]; body = m[2]; }
      else {
        var m2 = body.match(/^([^:.]{2,42}):[ \t]+([\s\S]+)$/);
        if (m2) { head = m2[1]; body = m2[2]; }
      }
      if (head) {
        // "**Backups:**" and "Backups:" both name the card; the punctuation is not part of it.
        head = head.replace(/[:\u2014\u2013.\-]+$/, "").trim();
        var h = document.createElement("div");
        h.className = "rc-cardhead";
        inline(h, head);
        li.appendChild(h);
      }
      var p = document.createElement("p");
      p.className = "rc-cardbody";
      inline(p, body.trim());
      li.appendChild(p);
      // A card holds its own words and nothing else.
      ul.appendChild(li);
    });
    return ul;
  }

  // The courtesies around an answer, which he asked to be rid of. Kept to whole short lines that
  // cannot be carrying anything: anything longer than a line, or that names a figure, is left alone.
  var FILL_OPEN = /^\s*(here (it|you|they) (is|are)\b|here'?s (what|the)\b|here is what you asked\b|as (you can see|requested|asked)\b)/i;
  var FILL_CLOSE = /^\s*(the (table|cards?|list|code|snippet|figures?|numbers|results?|answer|breakdown|summary|options?)( is| are| is now| are now)?( on| in)? (your|the)? ?screen\b|say the word\b|one,? two,? three\b|i can (expand|shorten|tidy|redo|trim)\b|i could (expand|shorten|tidy|redo|trim)\b|(let me know|tell me) if you (want|need)\b|want me to (expand|shorten|tidy|redo|go|add)\b|would you like me to\b|happy to (expand|shorten|tidy|redo)\b|shall i (expand|shorten|tidy|redo)\b|that'?s (it|all)[.!]?\s*$|anything else\b)/i;
  function isFiller(text, rx) {
    var t = String(text || "").trim();
    if (!t || t.split(/\s+/).length > 16) return false;
    return rx.test(t);
  }
  // A line whose only job is to say that something is now on the screen is not the answer: he is
  // looking at it. The prompt no longer asks for one, and this drops the ones written before that,
  // so an answer opens on its own substance instead of on a note about itself. A line with nothing
  // behind it is left alone, because a bare announcement is still more than an empty screen.
  var SCREEN_ANNOUNCE = /^\s*(?:a|the|here'?s|here is|i'?ve)?\s*(?:short|quick|brief|full|fuller)?\s*(?:shortlist|list|table|breakdown|summary|rundown|overview|details?|figures|numbers|cards|set|suite|results?|answer|first pass|reading)\b[^.!?\n]{0,90}?\b(?:is|are|is now|are now)\b[^.!?\n]{0,45}?\b(?:on (?:the|your|his) screen|on screen|in front of (?:you|him))\b[^.!?\n]{0,45}?(?:[.!?]|$)/i;
  function stripScreenAnnounce(t) {
    var s = String(t == null ? "" : t);
    var m = s.match(SCREEN_ANNOUNCE);
    if (!m) return s;
    var rest = s.slice(m[0].length).replace(/^[ \t]+/, "");
    return rest.trim() ? rest : s;
  }
  // Only when the answer has a component of its own: a line of prose underneath a table is a
  // summary of what he is already looking at, and the same line under a paragraph is the answer.
  function trimFiller(el) {
    if (!el.querySelector(".rc-tw, .rc-code, .rc-cards, .rc-call, .ui")) return;
    for (var pass = 0; pass < 2; pass++) {
      if (el.children.length < 2) return;
      var last = el.children[el.children.length - 1];
      if (last.classList.contains("rc-p") && isFiller(last.textContent, FILL_CLOSE)) {
        el.removeChild(last); fillerDrops.push(last.textContent.trim());
      }
      if (el.children.length < 2) return;
      var first = el.children[0];
      if (first.classList.contains("rc-p") && isFiller(first.textContent, FILL_OPEN)) {
        el.removeChild(first); fillerDrops.push(first.textContent.trim());
      }
    }
  }
  // Read-only, for the probes: what was dropped from this page load, so the rule can be checked
  // against a real answer instead of being taken on trust.
  var fillerDrops = [];
  window.__jarvisFiller = function () { return fillerDrops.slice(); };

  // --------------------------------------------------- the page's own component library
  // A written answer can carry a component the page draws itself: figures that line up, a change over
  // time, two things side by side, the order of a process, or a choice he can tap. The model writes a
  // small JSON spec in a fence tagged ui and this is the library it draws from: the page's own tokens,
  // no library, no network, and nothing it can invent.
  //
  // Everything in that spec is untrusted text from a model: no innerHTML from it, every list capped,
  // every string length-capped, and a spec that does not parse falls back to the block it arrived as
  // rather than being half-drawn.
  var UI_CAP = { items: 6, points: 12, columns: 3, cols: 5, steps: 8, options: 5, images: 4, sources: 6 };
  var SVGNS = "http://www.w3.org/2000/svg";
  var uiDrawn = [];
  window.__jarvisUI = function () { return uiDrawn.slice(); };

  // The same numbers twice. When an answer draws a widget for a dataset it must not also print the raw
  // markdown of that dataset: the widget already carries every figure, and a second copy underneath
  // reads as two sets of numbers that happen to agree. These helpers keep a note of what the widgets in
  // one answer have already put on the screen, so a table or a source line repeating it can be dropped.
  // Matching is on normalized values, so 120,000 and 120000 are the same figure.
  function uiNorm(v) { return String(v == null ? "" : v).toLowerCase().replace(/[^a-z0-9.]/g, ""); }
  // A row of a table, with or without its closing pipe. A model that writes '| Q3 26* | 23' and stops
  // has written a row, and the strict form left it outside the table as a stray line of pipes printed
  // as text. A line that opens a pipe and holds a second one is a row.
  // A table a model writes into the middle of a sentence: the bold heading and the header row arrive
  // glued to the line before it ("... (BBC, 16 Oct) **Figures that moved** | Item | Figure | Source |"),
  // and the closing paragraph glued to the last row. Left as they came, the run starts a line late, so
  // the header row is printed as prose and the first row of data is promoted into the column labels.
  // Words before the first pipe are prose; the row is from the pipe on; a sentence after the last pipe
  // goes back on its own line. Pure string work, so it can be tested on its own.
  function splitGluedTableLines(lines) {
    var out = [];
    for (var i = 0; i < lines.length; i++) {
      var ln = String(lines[i] == null ? "" : lines[i]);
      var first = ln.indexOf("|");
      if (first < 0) { out.push(ln); continue; }         // no pipes at all: nothing to split
      // A line that starts with the pipe is a row already, and still needs its closing sentence taken off
      // the end of it: that sentence belongs under the table, not in its last cell.
      var head = first === 0 ? "" : ln.slice(0, first), rest = ln.slice(first);
      var tailAt = rest.lastIndexOf("|");
      var tail = rest.slice(tailAt + 1), rowText = rest.slice(0, tailAt + 1);
      var segs = rowText.split("|"), filled = segs.filter(function (c) { return c.trim(); });
      // A row is at least three cells with words in them, each short. A sentence that happens to carry
      // two bars is not a table and must not be broken up as one.
      if (!(segs.length >= 3 && filled.length >= 3 &&
            filled.every(function (c) { return c.trim().length <= 60; }))) { out.push(ln); continue; }
      head = head.replace(/\s+$/, "");
      var heading = head.match(/(\*\*[^*]+\*\*)$/);
      if (heading) {
        head = head.slice(0, head.length - heading[1].length).replace(/\s+$/, "");
        if (head) out.push(head);
        out.push(heading[1]);
      } else if (head) out.push(head);
      out.push(rowText);
      var prose = tail.trim();
      if (prose && (prose.split(/\s+/).length > 6 || /\.\s*$/.test(prose))) {
        out.push(""); out.push(prose);                   // the paragraph after the table
      } else if (prose) {
        out.push(rowText.slice(0, rowText.length - 1) + " " + prose + " |");
      }
    }
    return out;
  }

  function isPipeRow(line) {
    var s = String(line == null ? "" : line);
    if (/^[ \t]*\|[^\n]*\|[ \t]*$/.test(s)) return true;
    if (/^[ \t]*\|[^|\n]*\|/.test(s)) return true;
    return /^[ \t]*[^|\n]+(?:\|[^|\n]+)+\|?[ \t]*$/.test(s);
  }
  // The components that print the source they were given under themselves. A citation absorbed by one
  // of these is on the screen; absorbed by any other it would vanish, so only these take it.
  var UI_SOURCED = { chart: 1, metrics: 1, compare: 1 };
  function uiBagValues(v, into) {
    if (v == null) return;
    if (Array.isArray(v)) { v.forEach(function (x) { uiBagValues(x, into); }); return; }
    if (typeof v === "object") { Object.keys(v).forEach(function (k) { uiBagValues(v[k], into); }); return; }
    into.push(uiNorm(v));
  }
  function uiBagNote(bag, spec) {
    if (!bag || !spec) return;
    ["items", "rows", "data", "values", "steps", "options", "cols", "series", "bars", "labels"].forEach(function (k) {
      if (Array.isArray(spec[k])) uiBagValues(spec[k], bag.cells);
    });
    if (spec.source || spec.src) bag.sources.push(uiNorm(spec.source || spec.src));
  }
  function uiBagRow(bag, line) {
    var cells = String(line).replace(/^[ \t]*\|/, "").replace(/\|[ \t]*$/, "").split("|")
      .map(function (s) { return uiNorm(s.replace(/\*\*|`/g, "")); })
      .filter(function (c) { return c; });
    if (!cells.length || !bag.cells.length) return false;
    return cells.every(function (c) { return bag.cells.indexOf(c) >= 0; });
  }
  function uiTxt(v, max) {
    if (v == null) return "";
    var t = String(v).replace(/\s+/g, " ").trim();
    if (max && t.length > max) t = t.slice(0, max - 1).replace(/[\s,.;:]+$/, "") + "\u2026";
    return t;
  }
  function uiFigure(v) {
    var n = typeof v === "number" ? v : parseFloat(String(v).replace(/[^0-9.eE+-]/g, ""));
    return isFinite(n) ? n : null;
  }
  function uiRound(n) {
    var a = Math.abs(n);
    var d = a >= 1000 ? 0 : a >= 100 ? 0 : a >= 10 ? 1 : 2;
    return String(Number(n.toFixed(d)));
  }
  function svgEl(name, attrs) {
    var e = document.createElementNS(SVGNS, name);
    for (var k in attrs) if (attrs[k] != null) e.setAttribute(k, attrs[k]);
    return e;
  }
  // A title, a unit, or both. Returns nothing at all when the spec names neither.
  function uiHead(spec) {
    var t = uiTxt(spec && spec.title, 60), u = uiTxt(spec && spec.unit, 18);
    if (!t && !u) return null;
    var h = document.createElement("div");
    h.className = "ui-head";
    if (t) { var s = document.createElement("span"); s.className = "ui-title"; s.textContent = t; h.appendChild(s); }
    if (u) { var us = document.createElement("span"); us.className = "ui-unit"; us.textContent = u; h.appendChild(us); }
    return h;
  }
  function uiHeadInto(root, spec) { var h = uiHead(spec); if (h) root.appendChild(h); return root; }
  // A figure is only as good as where it came from. A component holding numbers carries its source
  // under it, and one with no source says so out loud rather than looking like the other charts: a
  // chart of invented figures is the one failure this page must never make quietly.
  function uiSourceInto(root, spec) {
    var src = uiTxt(spec && spec.source, 90);
    var row = document.createElement("div");
    row.className = "ui-source" + (src ? "" : " ui-source-none");
    row.textContent = src ? "Source: " + src : "No source given for these figures";
    root.appendChild(row);
    return root;
  }

  // A figure and its label, for the handful of numbers that are the whole answer.
  function uiMetrics(spec) {
    var items = Array.isArray(spec.items) ? spec.items.slice(0, UI_CAP.items) : [];
    items = items.filter(function (it) { return it && (it.label || it.value); });
    if (!items.length) return null;
    var root = document.createElement("div");
    root.className = "ui ui-tiles";
    items.forEach(function (it) {
      var t = document.createElement("div");
      t.className = "ui-tile";
      var lab = document.createElement("div");
      lab.className = "ui-tilelab"; lab.textContent = uiTxt(it.label, 30);
      var val = document.createElement("div");
      val.className = "ui-tileval"; val.textContent = uiTxt(it.value, 18);
      var unit = uiTxt(it.unit, 12);
      if (unit) {
        var u = document.createElement("span");
        u.className = "ui-tileunit"; u.textContent = " " + unit; val.appendChild(u);
      }
      var delta = uiTxt(it.delta, 20);
      var d = document.createElement("div");
      d.className = "ui-tiledelta"; d.textContent = delta;
      t.appendChild(lab); t.appendChild(val);
      if (delta) t.appendChild(d);
      root.appendChild(t);
    });
    return uiSourceInto(root, spec);
  }

  // A bar or a line, drawn by hand: the page carries no charting library and eight bars do not need
  // one. A bar chart starts at zero, because a bar on a cut axis lies about the size of a difference.
  function uiChart(spec) {
    var rows = Array.isArray(spec.data) ? spec.data.slice(0, UI_CAP.points) : [];
    var pts = [];
    rows.forEach(function (r) {
      var raw = Array.isArray(r) ? r[0] : "";
      var label = Array.isArray(r) ? uiTxt(raw, 24) : "";
      var v = uiFigure(Array.isArray(r) ? r[1] : r);
      if (v !== null) pts.push({ label: label, raw: raw, value: v });
    });
    if (pts.length < 2) return null;
    var kind = spec.kind === "line" ? "line" : "bar";
    var unit = uiTxt(spec.unit, 16);
    // The left gutter is the axis: a value with no scale beside it is a shape, not a measurement.
    var W = 320, H = 172, padL = unit || kind === "line" ? 44 : 40, padR = 10, padT = 22, padB = 30;
    var vals = pts.map(function (p) { return p.value; });
    var maxV = Math.max.apply(null, vals);
    var minV = Math.min.apply(null, vals);
    if (kind === "bar") {
      // A bar is a length from zero. Cutting its axis lies about the size of the difference, so bars
      // keep the baseline no matter how close the values are.
      minV = Math.min(0, minV);
      if (maxV <= 0) maxV = 1;
    } else {
      // A line is a shape over time, and a range that starts at zero flattens every real movement
      // into a straight edge. Give the data its own range with a margin, and label it so the cut is
      // visible rather than hidden.
      var pad = (maxV - minV) * 0.15;
      if (!(pad > 0)) pad = Math.max(Math.abs(maxV) * 0.08, 1);
      minV = minV - pad;
      maxV = maxV + pad;
      if (minV > 0 && minV < (maxV - minV) * 0.05) minV = 0;
    }
    var ticks = uiTicks(minV, maxV, 3);
    minV = Math.min(minV, ticks[0]); maxV = Math.max(maxV, ticks[ticks.length - 1]);
    var span = (maxV - minV) || 1, innerW = W - padL - padR;
    var yOf = function (v) { return H - padB - ((v - minV) / span) * (H - padT - padB); };
    var root = document.createElement("div");
    root.className = "ui ui-chart";
    var svg = svgEl("svg", { viewBox: "0 0 " + W + " " + H, role: "img" });
    // Everything the eye reads is also readable by a screen reader: the series in words, not only
    // in pixels.
    var spoken = pts.map(function (p) { return (p.label || "") + " " + uiRound(p.value) + (unit ? " " + unit : ""); }).join(", ");
    svg.setAttribute("aria-label", (uiTxt(spec.title, 60) || "chart") + ". " + spoken);
    // Unit caption: what the numbers are, once, at the top of the axis.
    if (unit) {
      var ut = svgEl("text", { x: 4, y: 12, "class": "ui-unit" });
      ut.textContent = unit;
      svg.appendChild(ut);
    }
    svg.appendChild(svgEl("line", { x1: padL, y1: H - padB, x2: W - padR, y2: H - padB, "class": "ui-axis" }));
    svg.appendChild(svgEl("line", { x1: padL, y1: padT, x2: padL, y2: H - padB, "class": "ui-axis" }));
    ticks.forEach(function (t) {
      var y = yOf(t);
      svg.appendChild(svgEl("line", { x1: padL, y1: y, x2: W - padR, y2: y, "class": "ui-grid" }));
      var tl = svgEl("text", { x: padL - 5, y: y + 3, "class": "ui-tick", "text-anchor": "end" });
      tl.textContent = uiTickText(t, unit);
      svg.appendChild(tl);
    });
    if (kind === "bar") {
      var step = innerW / pts.length, bw = Math.max(6, step * 0.56);
      pts.forEach(function (p, i) {
        var x = padL + i * step + (step - bw) / 2;
        var top = yOf(Math.max(p.value, Math.max(minV, 0)));
        var h = Math.max(2, (H - padB) - top);
        svg.appendChild(svgEl("rect", { x: x, y: H - padB - h, width: bw, height: h, rx: 3, "class": "ui-bar" }));
        var vl = svgEl("text", { x: x + bw / 2, y: H - padB - h - 5, "class": "ui-val", "text-anchor": "middle" });
        vl.textContent = uiRound(p.value);
        svg.appendChild(vl);
        if (pts.length <= 7) {
          var ll = svgEl("text", { x: x + bw / 2, y: H - 10, "class": "ui-lab", "text-anchor": "middle" });
          ll.textContent = uiShortLabel(p);
          svg.appendChild(ll);
        }
      });
      if (pts.length > 7) uiEdgeLabels(svg, pts, function (i) { return padL + i * step + step / 2; }, H);
    } else {
      var xOf = function (i) { return padL + (pts.length < 2 ? innerW / 2 : (i / (pts.length - 1)) * innerW); };
      var d = pts.map(function (p, i) { return (i ? "L" : "M") + xOf(i).toFixed(1) + " " + yOf(p.value).toFixed(1); }).join(" ");
      svg.appendChild(svgEl("path", { d: d, "class": "ui-line" }));
      pts.forEach(function (p, i) {
        var cx = xOf(i), cy = yOf(p.value);
        svg.appendChild(svgEl("circle", { cx: cx, cy: cy, r: 3, "class": "ui-dot" }));
        // A point on a phone cannot be hovered, so every point carries its own value: drawn when
        // there is room, and always reachable by a tap that has a generous target around the dot.
        if (pts.length <= 9) {
          var vt = svgEl("text", { x: cx, y: Math.max(11, cy - 7), "class": "ui-val",
                                   "text-anchor": i === 0 ? "start" : (i === pts.length - 1 ? "end" : "middle") });
          vt.textContent = uiRound(p.value);
          svg.appendChild(vt);
        }
        var hit = svgEl("rect", { x: cx - 22, y: cy - 22, width: 46, height: 46, "class": "ui-hit",
                                  role: "button", tabindex: "0" });
        hit.setAttribute("aria-label", (p.label || "point") + ": " + uiRound(p.value) + (unit ? " " + unit : ""));
        var tip = svgEl("title", {});
        tip.textContent = (p.label || "") + ": " + uiRound(p.value) + (unit ? " " + unit : "");
        hit.appendChild(tip);
        svg.appendChild(hit);
      });
      uiEdgeLabels(svg, pts, xOf, H);
      if (pts.length > 9) {
        var mid = Math.floor((pts.length - 1) / 2), mx = xOf(mid);
        var mv = svgEl("text", { x: mx, y: Math.max(11, yOf(pts[mid].value) - 7), "class": "ui-val", "text-anchor": "middle" });
        mv.textContent = uiRound(pts[mid].value);
        svg.appendChild(mv);
      }
    }
    uiHeadInto(root, spec);
    root.appendChild(svg);
    return uiSourceInto(root, spec);
  }

  // A short, readable axis label: a date loses its year before it loses its day.
  function uiShortLabel(p) {
    var s = String(p.label || "");
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
    if (m) {
      var months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
      return months[Math.max(0, Math.min(11, parseInt(m[2], 10) - 1))] + " " + parseInt(m[3], 10);
    }
    return s.length > 9 ? s.slice(0, 8) + "\u2026" : s;
  }

  function uiEdgeLabels(svg, pts, xOf, H) {
    var first = xOf(0), last = xOf(pts.length - 1);
    [0, pts.length - 1].forEach(function (i, n) {
      var x = i === 0 ? first : last;
      var ll = svgEl("text", { x: x, y: H - 10, "class": "ui-lab",
                              "text-anchor": n === 0 ? "start" : "end" });
      ll.textContent = uiShortLabel(pts[i]);
      svg.appendChild(ll);
    });
  }

  // Three or four round numbers across the range, so the axis reads 0 / 50,000 / 100,000 instead of
  // 0 / 37,412 / 74,824.
  function uiTicks(lo, hi, want) {
    var span = hi - lo;
    if (!(span > 0)) return [lo, lo + 1];
    var raw = span / Math.max(1, want);
    var mag = Math.pow(10, Math.floor(Math.log(raw) / Math.LN10));
    var norm = raw / mag, step = (norm <= 1.5 ? 1 : norm <= 3 ? 2 : norm <= 7 ? 5 : 10) * mag;
    var out = [], t = Math.ceil(lo / step) * step;
    for (; t <= hi + step * 0.001 && out.length < 8; t += step) out.push(Math.abs(t) < step * 1e-9 ? 0 : t);
    if (out.length < 2) out = [lo, hi];
    return out;
  }

  function uiTickText(v, unit) {
    var a = Math.abs(v);
    if (a >= 1e9) return (v / 1e9).toFixed(a % 1e9 ? 1 : 0) + "b";
    if (a >= 1e6) return (v / 1e6).toFixed(a % 1e6 ? 1 : 0) + "m";
    if (a >= 1e4) return (v / 1e3).toFixed(a % 1e3 ? 1 : 0) + "k";
    return uiRound(v);
  }

  // Two or three things, the same kind of fact down each: the side-by-side reading of a comparison.
  function uiCompare(spec) {
    var cols = (Array.isArray(spec.columns) ? spec.columns.slice(0, UI_CAP.columns) : [])
      .filter(function (c) { return c && (c.name || (Array.isArray(c.points) && c.points.length)); });
    if (cols.length < 2) return null;
    var root = document.createElement("div");
    root.className = "ui ui-cmp";
    uiHeadInto(root, spec);
    var row = document.createElement("div");
    row.className = "ui-cmprow";
    cols.forEach(function (c) {
      var box = document.createElement("div");
      box.className = "ui-cmpcol";
      var nm = document.createElement("div");
      nm.className = "ui-cmpname"; nm.textContent = uiTxt(c.name, 26);
      var badge = uiTxt(c.badge, 14);
      if (badge) { var b = document.createElement("span"); b.className = "ui-cmpbadge"; b.textContent = badge; nm.appendChild(b); }
      box.appendChild(nm);
      // A comparison of two things you can look at should show them. The picture is optional and
      // never blocks the column: without one the column reads exactly as it always did.
      var picUrl = imgSrc(c.url || c.src);
      var picPhrase = uiTxt(c.img || c.image || c.query, 80);
      if (picUrl || picPhrase) {
        // The credit lives outside the picture frame: the frame clips to its aspect ratio, and a
        // credit drawn inside it was invisible on the phone. It also says what the picture is,
        // because a licensed stock photograph of "an iPhone" is not a photograph of this model.
        var thumb = document.createElement("div");
        thumb.className = "ui-cmpthumb";
        var fwrap = document.createElement("div");
        fwrap.className = "ui-figframe ui-cmpfig";
        thumb.appendChild(fwrap);
        box.appendChild(thumb);
        if (picUrl) {
          var cim = imgNode(picUrl, uiTxt(c.name, 26) || picPhrase);
          cim.addEventListener("error", function () { imgFail(fwrap, uiTxt(c.name, 26) || "Picture unavailable"); });
          fwrap.appendChild(cim);
        } else {
          fwrap.classList.add("ui-figwait");
          (function (frame, phrase, label) {
            imgLookup(phrase).then(function (list) {
              var hit = list && list[0];
              if (!hit || !hit.thumb) { imgFail(frame, label || "No licensed picture found"); return; }
              frame.classList.remove("ui-figwait");
              frame.textContent = "";
              var im = imgNode(hit.thumb, label || imgTitle(hit.title) || phrase);
              im.addEventListener("error", function () { imgFail(frame, label || "Picture unavailable"); });
              frame.appendChild(im);
              imgCreditInto(thumb, hit);
              if (hit.title) {
                var what = document.createElement("div");
                what.className = "ui-figwhat";
                what.textContent = imgTitle(hit.title);
                thumb.appendChild(what);
              }
              });
          })(fwrap, picPhrase, uiTxt(c.name, 26));
        }
      }
      var ul = document.createElement("ul");
      ul.className = "ui-cmppoints";
      (Array.isArray(c.points) ? c.points.slice(0, UI_CAP.cols) : []).forEach(function (p) {
        var li = document.createElement("li");
        inline(li, uiTxt(p, 95));          // bold and a link still work inside a point
        if (li.textContent.trim()) ul.appendChild(li);
      });
      box.appendChild(ul);
      row.appendChild(box);
    });
    root.appendChild(row);
    // The reading, not just the facts. A comparison that ends without saying which one wins has
    // made him do the work; this is one line, and it stays out of the way when there is nothing
    // to say.
    var vd = spec.verdict;
    if (vd && typeof vd === "object" && (vd.winner || vd.line)) {
      var vb = document.createElement("div");
      vb.className = "ui-verdict";
      var who = uiTxt(vd.winner, 40);
      if (who) {
        var w = document.createElement("span");
        w.className = "ui-verdictwho";
        w.textContent = who;
        vb.appendChild(w);
      }
      var ln = uiTxt(vd.line, 220);
      if (ln) {
        var l = document.createElement("span");
        l.className = "ui-verdictline";
        inline(l, ln);
        vb.appendChild(l);
      }
      root.appendChild(vb);
    }
    return uiSourceInto(root, spec);
  }

  // A process, in order, as a flow rather than a numbered paragraph.
  function uiSteps(spec) {
    var list = (Array.isArray(spec.steps) ? spec.steps.slice(0, UI_CAP.steps) : [])
      .filter(function (x) { return x && (x.label || x.detail); });
    if (list.length < 2) return null;
    var root = document.createElement("div");
    root.className = "ui ui-steps";
    uiHeadInto(root, spec);
    var ol = document.createElement("ol");
    ol.className = "ui-steplist";
    list.forEach(function (x, i) {
      var li = document.createElement("li");
      li.className = "ui-step";
      var dot = document.createElement("span");
      dot.className = "ui-stepdot"; dot.setAttribute("aria-hidden", "true"); dot.textContent = String(i + 1);
      var body = document.createElement("div");
      body.className = "ui-stepbody";
      var lab = document.createElement("div");
      lab.className = "ui-steplabel"; inline(lab, uiTxt(x.label, 80));
      body.appendChild(lab);
      var det = uiTxt(x.detail, 150);
      if (det) { var dd = document.createElement("div"); dd.className = "ui-stepdetail"; dd.textContent = det; body.appendChild(dd); }
      li.appendChild(dot); li.appendChild(body);
      ol.appendChild(li);
    });
    root.appendChild(ol);
    return root;
  }

  // A choice puts itself in the composer, it does not send it: nothing on this page spends a turn he
  // did not ask for, and nothing here pretends a choice was submitted.
  // A decision to make: one full-width card per option, a tick on the right of the one that is
  // picked, and one button under the stack that sends it. The cards mark the choice and nothing
  // else, so a tap on a card can never both pick and fire; the button is the only thing in this
  // widget that spends a turn, and it says so on its face.
  function uiChoices(spec) {
    var opts = (Array.isArray(spec.options) ? spec.options.slice(0, UI_CAP.options) : [])
      .filter(function (o) { return o && (o.label || o.value); });
    if (!opts.length) return null;
    var root = document.createElement("div");
    root.className = "ui ui-choices";
    root.setAttribute("role", "radiogroup");
    uiHeadInto(root, spec);
    var picked = "", cards = [];
    var go = document.createElement("button");
    go.type = "button"; go.className = "ui-choices-go"; go.disabled = true;
    go.textContent = "Execute Action";
    go.title = "Send the choice you picked";   // what the tap does, before it is armed
    opts.forEach(function (o) {
      var label = uiTxt(o.label || o.value, 48);
      if (!label) return;
      var value = uiTxt(o.value || o.label, 400);
      var b = document.createElement("button");
      b.type = "button"; b.className = "ui-choice";
      b.setAttribute("role", "radio"); b.setAttribute("aria-checked", "false");
      var t = document.createElement("span");
      t.className = "ui-choice-t"; t.textContent = label;
      var ind = document.createElement("span");
      ind.className = "ui-choice-ind"; ind.setAttribute("aria-hidden", "true");
      b.appendChild(t); b.appendChild(ind);
      b.addEventListener("click", function () {
        cards.forEach(function (c) {
          c.setAttribute("aria-checked", "false"); c.classList.remove("picked");
        });
        b.setAttribute("aria-checked", "true"); b.classList.add("picked");
        picked = value;
        go.disabled = false;
      });
      cards.push(b);
      root.appendChild(b);
    });
    if (!cards.length) return null;
    go.addEventListener("click", function () {
      if (!picked) return;
      // The page's one way to spend a turn: the words go in the field and the engine's own send is
      // pressed, so a choice is answered exactly as if he had typed it.
      var field = document.getElementById("q");
      if (!field) return;
      field.value = picked;
      try { field.dispatchEvent(new Event("input", { bubbles: true })); } catch (e) {}
      var s = document.getElementById("send");
      if (s) s.click();
    });
    root.appendChild(go);
    return root;
  }

  // ---------------------------------------------------------------- pictures (Phase 2)
  // Finding a picture and drawing one are two different jobs, and they are kept apart. The server
  // finds (a phrase in, licensed candidates out); this file only ever draws. A picture reaches the
  // screen by one route and one route only: through this machine's own /img proxy, so the phone
  // never talks to a stranger's server, never sends a referrer, and a host that goes away leaves a
  // readable line rather than a broken box.
  var imgPending = 0, imgLookupCache = {};
  window.__jarvisImgPending = function () { return imgPending; };
  function imgLookup(phrase) {
    var p = uiTxt(phrase, 120);
    if (!p) return Promise.resolve([]);
    if (imgLookupCache[p]) return imgLookupCache[p];
    imgPending++;
    var done = function (v) { imgPending--; return v; };
    var pr = fetch("/img/search?q=" + encodeURIComponent(p) + "&n=4",
                   { headers: { "Accept": "application/json" } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) { return (d && Array.isArray(d.images)) ? d.images : []; })
      .catch(function () { return []; })
      .then(done, function () { return done([]); });
    imgLookupCache[p] = pr;
    return pr;
  }
  // A picture's own title is a title, not a filename: a search hands back slugs, and a slug read
  // under a photograph reads as a defect. Filenames elsewhere on this page keep their spelling.
  function imgTitle(t) {
    var s = uiTxt(t, 70);
    if (!s) return "";
    if (/\s/.test(s) === false && /[-_]/.test(s)) {
      s = s.replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
      s = s.replace(/\s+\d+$/, "");
    }
    return s;
  }
  // Only https, and never the URL itself in the attribute: the picture is addressed through the
  // proxy, so an image host cannot watch his phone ask for it.
  function imgSrc(v) {
    var s = String(v == null ? "" : v).trim();
    if (!/^https:\/\//i.test(s) || s.length > 2000) return "";
    return "/img?u=" + encodeURIComponent(s);
  }
  function imgNode(src, alt) {
    var im = document.createElement("img");
    im.className = "ui-figimg";
    im.alt = String(alt == null ? "" : alt);
    im.loading = "lazy";
    im.decoding = "async";
    im.referrerPolicy = "no-referrer";
    im.src = src;
    return im;
  }
  // A frame that takes the picture's own proportions, kept within a range that stays readable
  // beside prose. A tall portrait and a wide panorama both look deliberate rather than clipped.
  function imgFit(im, frame) {
    im.addEventListener("load", function () {
      var w = im.naturalWidth || 0, h = im.naturalHeight || 0;
      if (w && h) frame.style.aspectRatio = String(Math.min(1.9, Math.max(0.66, w / h)));
    });
  }
  // The credit is part of the picture, not decoration: a licensed photograph names its maker.
  function imgCreditInto(fig, it) {
    var bits = [];
    if (it && it.creator) bits.push(it.creator);
    if (it && it.license) bits.push(it.license);
    else if (it && it.page) bits.push("Wikimedia Commons");
    if (!bits.length) return;
    var row = document.createElement("div");
    row.className = "ui-figcredit";
    row.textContent = bits.join(" \u00b7 ");
    if (it && it.license_url && /^https:\/\//i.test(it.license_url)) {
      var a = document.createElement("a");
      a.href = it.license_url; a.target = "_blank"; a.rel = "noopener noreferrer";
      a.textContent = it.license ? "licence" : "source";
      row.appendChild(document.createTextNode(" "));
      row.appendChild(a);
    } else if (it && it.page && /^https:\/\//i.test(it.page)) {
      var b = document.createElement("a");
      b.href = it.page; b.target = "_blank"; b.rel = "noopener noreferrer";
      b.textContent = "source";
      row.appendChild(document.createTextNode(" "));
      row.appendChild(b);
    }
    fig.appendChild(row);
  }
  // A picture that cannot be shown says so in words, with whatever names it. The answer carries on.
  function imgFail(frame, said) {
    var box = document.createElement("div");
    box.className = "ui-figfail";
    var ic = document.createElement("span");
    ic.className = "ui-figfailico"; ic.setAttribute("aria-hidden", "true"); ic.textContent = "\u25a1";
    var t = document.createElement("span");
    t.textContent = said || "The picture could not be loaded";
    box.appendChild(ic); box.appendChild(t);
    if (frame.parentNode) frame.parentNode.replaceChild(box, frame);
    return box;
  }
  function uiImage(spec) {
    var caption = uiTxt(spec.caption || spec.label, 170);
    var direct = imgSrc(spec.url || spec.src);
    var phrase = uiTxt(spec.img || spec.query || spec.image || spec.alt, 120);
    if (!direct && !phrase) {
      // Something was asked for and cannot be drawn. Saying which, in a line, is better than
      // printing the spec as raw JSON beside the prose or leaving a hole in the answer.
      var said = (spec.url || spec.src)
        ? "That picture was not shown: only a secure https link can be drawn here."
        : "That picture was not shown: no picture or search phrase was given.";
      if (caption) said += " " + caption;
      var box = document.createElement("div");
      box.className = "ui ui-figfail";
      box.textContent = said;
      return box;
    }
    var fig = document.createElement("figure");
    fig.className = "ui ui-fig";
    var frame = document.createElement("div");
    frame.className = "ui-figframe";
    fig.appendChild(frame);
    var paint = function (src, alt, credit) {
      var im = imgNode(src, alt || caption || phrase);
      imgFit(im, frame);
      im.addEventListener("error", function () { imgFail(frame, caption ? "The picture could not be loaded just now" : "The picture could not be loaded"); });
      frame.appendChild(im);
      if (credit) imgCreditInto(fig, credit);
    };
    if (direct) {
      paint(direct, caption || phrase, null);
    } else {
      // The caption is drawn once and updated in place when the search lands, so a picture never
      // carries two lines saying the same thing.
      var capEl = null;
      if (caption) {
        capEl = document.createElement("figcaption");
        capEl.className = "ui-figcap";
        inline(capEl, caption);
        fig.appendChild(capEl);
      }
      var im0 = imgNode("", caption || phrase);
      frame.appendChild(im0);                 // the frame holds its place while the search runs
      frame.classList.add("ui-figwait");
      imgLookup(phrase).then(function (list) {
        var hit = list && list[0];
        if (!hit || !hit.thumb) { imgFail(frame, caption ? "No licensed picture was found for that" : "No licensed picture found for \u201c" + phrase + "\u201d"); return; }
        frame.classList.remove("ui-figwait");
        frame.textContent = "";
        var im = imgNode(hit.thumb, caption || hit.title || phrase);
        imgFit(im, frame);
        im.addEventListener("error", function () { imgFail(frame, caption ? "The picture could not be loaded just now" : "The picture could not be loaded"); });
        frame.appendChild(im);
        imgCreditInto(fig, hit);
        if (!caption && hit.title) {
          caption = imgTitle(hit.title);
          if (!capEl) {
            capEl = document.createElement("figcaption");
            capEl.className = "ui-figcap";
            fig.appendChild(capEl);
          }
          inline(capEl, caption);
        }
      });
      return fig;
    }
    if (caption) {
      var cap2 = document.createElement("figcaption");
      cap2.className = "ui-figcap";
      inline(cap2, caption);
      fig.appendChild(cap2);
    }
    return fig;
  }
  // Two to four pictures side by side, each with its own line. Tapping is not needed: the grid is
  // sized for the phone and shows every picture whole.
  function uiGallery(spec) {
    var items = (Array.isArray(spec.images) ? spec.images.slice(0, UI_CAP.images) : [])
      .filter(function (x) { return x && (x.url || x.src || x.img || x.query || x.image); });
    if (!items.length) return null;
    var root = document.createElement("div");
    root.className = "ui ui-gal";
    uiHeadInto(root, spec);
    var grid = document.createElement("div");
    grid.className = "ui-galgrid" + (items.length === 2 ? " ui-gal2" : (items.length === 3 ? " ui-gal3" : ""));
    items.forEach(function (it) {
      var cell = document.createElement("figure");
      cell.className = "ui-galcell";
      var frame = document.createElement("div");
      frame.className = "ui-figframe";
      cell.appendChild(frame);
      var cap = uiTxt(it.caption || it.label || it.title, 80);
      if (cap) {
        var c = document.createElement("figcaption");
        c.className = "ui-figcap";
        inline(c, cap);
        cell.appendChild(c);
      }
      grid.appendChild(cell);
      var direct = imgSrc(it.url || it.src);
      var phrase = uiTxt(it.img || it.query || it.image, 120);
      if (direct) {
        var im1 = imgNode(direct, cap || phrase);
        im1.addEventListener("error", function () { imgFail(frame, cap ? "This picture is unavailable" : "Picture unavailable"); });
        frame.appendChild(im1);
      } else if (phrase) {
        frame.classList.add("ui-figwait");
        imgLookup(phrase).then(function (list) {
          var hit = list && list[0];
          if (!hit || !hit.thumb) { imgFail(frame, cap ? "No licensed picture was found" : "No licensed picture found"); return; }
          frame.classList.remove("ui-figwait");
          frame.textContent = "";
          var im2 = imgNode(hit.thumb, cap || imgTitle(hit.title) || phrase);
          im2.addEventListener("error", function () { imgFail(frame, cap ? "This picture is unavailable" : "Picture unavailable"); });
          frame.appendChild(im2);
          imgCreditInto(cell, hit);
        });
      }
    });
    root.appendChild(grid);
    return root;
  }
  // Where the claims came from, in the order they were made. Only addresses that are really https
  // links survive: an item with nothing openable is dropped rather than drawn as a dead row.
  function uiSources(spec) {
    var items = (Array.isArray(spec.items) ? spec.items.slice(0, UI_CAP.sources) : [])
      .map(function (x) {
        var u = String((x && (x.url || x.href)) || "").trim();
        if (!/^https:\/\//i.test(u) || u.length > 2000) return null;
        var host = "";
        try { host = String(new URL(u).hostname || "").replace(/^www\./, ""); } catch (e) { host = ""; }
        return { url: u, host: host, title: uiTxt(x.title || x.label || host, 90), note: uiTxt(x.note, 90) };
      })
      .filter(Boolean);
    if (!items.length) return null;
    var root = document.createElement("div");
    root.className = "ui ui-sources";
    uiHeadInto(root, spec);
    var ol = document.createElement("ol");
    ol.className = "ui-srclist";
    items.forEach(function (it) {
      var li = document.createElement("li");
      li.className = "ui-srcrow";
      var a = document.createElement("a");
      a.href = it.url; a.target = "_blank"; a.rel = "noopener noreferrer";
      a.className = "ui-srclink";
      a.textContent = it.title;
      li.appendChild(a);
      if (it.note) {
        var n = document.createElement("span");
        n.className = "ui-srcnote"; n.textContent = " \u2014 " + it.note;
        li.appendChild(n);
      }
      var h = document.createElement("span");
      h.className = "ui-srchost"; h.textContent = it.host;
      li.appendChild(h);
      ol.appendChild(li);
    });
    root.appendChild(ol);
    return root;
  }

  var UI_TYPES = { metrics: uiMetrics, chart: uiChart, compare: uiCompare, steps: uiSteps, choices: uiChoices,
                   image: uiImage, gallery: uiGallery, sources: uiSources };

  // One JSON object, or nothing. A spec is only ever an object: an array or a bare number is not a
  // component, and treating it as one is how a fragment of an answer gets drawn as a card.
  function parseSpec(text) {
    var s = String(text == null ? "" : text).trim();
    if (s.charAt(0) !== "{") return null;
    var o = null;
    try { o = JSON.parse(s); } catch (e) { return null; }
    return (o && typeof o === "object" && !Array.isArray(o)) ? o : null;
  }
  function isSpec(o) { return !!(o && UI_TYPES[uiTxt(o.type, 20).toLowerCase()]); }

  // Anything a spec carries, as one readable line. Nested objects and lists are flattened rather
  // than dropped: a table cell that says `[object Object]` is worse than no table at all.
  function uiFlat(v) {
    if (v == null || v === "") return "";
    if (typeof v === "object") {
      if (Array.isArray(v)) return v.map(uiFlat).filter(Boolean).join(", ");
      var parts = [];
      for (var k in v) if (Object.prototype.hasOwnProperty.call(v, k)) {
        var t = uiFlat(v[k]);
        if (t) parts.push(k + ": " + t);
      }
      return parts.join(" \u00b7 ");
    }
    return uiTxt(v, 120);
  }
  function uiTable(rows, cols) {
    var md = ["| " + cols.join(" | ") + " |",
              "|" + cols.map(function () { return " --- "; }).join("|") + "|"];
    rows.forEach(function (r) {
      md.push("| " + cols.map(function (c) {
        return (uiFlat(r[c]).replace(/\|/g, "\\|") || " ");
      }).join(" | ") + " |");
    });
    return tableBlock(md);
  }

  // A component the library cannot draw still has to be readable, and its braces are not the answer.
  // The rows the spec carried become a table and its named values become a list; a block that never
  // parsed as a spec at all becomes a list of its own lines. Nothing here is drawn as code: showing
  // him the markup of a component he asked to see is the failure this whole fallback exists for.
  function specFallback(spec) {
    if (!spec) return null;
    var lists = ["items", "rows", "data", "steps", "options", "columns", "values"];
    for (var n = 0; n < lists.length; n++) {
      var v = spec[lists[n]];
      if (!Array.isArray(v) || !v.length) continue;
      var first = v[0];
      if (first && typeof first === "object" && !Array.isArray(first)) {
        var cols = [];
        v.slice(0, 15).forEach(function (r) {
          for (var k in r) if (Object.prototype.hasOwnProperty.call(r, k) && cols.indexOf(k) < 0) cols.push(k);
        });
        if (cols.length) return uiTable(v.slice(0, 15), cols.slice(0, 6));
      }
      if (Array.isArray(first)) {
        var cols2 = ["label", "value"];
        var rows2 = v.slice(0, 15).map(function (r) {
          return { label: uiFlat(r[0]), value: uiFlat(r[1]) };
        });
        return uiTable(rows2, cols2);
      }
    }
    var items = [];
    for (var k2 in spec) if (Object.prototype.hasOwnProperty.call(spec, k2) &&
        k2 !== "type" && k2 !== "title" && k2 !== "unit" && k2 !== "source") {
      var t2 = uiFlat(spec[k2]);
      if (t2) items.push("**" + k2 + ":** " + t2);
    }
    return items.length ? listBlock(items, false) : null;
  }
  function specLines(text) {
    var raw = String(text == null ? "" : text).trim();
    // Where a spec never parsed, its name/value pairs can often still be read off it. Doing that
    // first turns the one case that had no structure at all into the same list as the others.
    var pairs = raw.match(/"[^"\n]{1,40}"[ \t]*:[ \t]*(?:"[^"\n]*"|[-+0-9.]+|true|false|null)/g);
    if (pairs && pairs.length > 1) {
      pairs = pairs.filter(function (p) { return !/^[ \t]*"?(type|kind)"?[ \t]*:/.test(p); });
      if (pairs.length < 2) return null;
      return listBlock(pairs.slice(0, 15).map(function (p) {
        return "**" + p.slice(0, p.indexOf('"', 1)).replace(/"/g, "") + "** " + p.slice(p.indexOf(":") + 1).trim().replace(/^"|"$/g, "");
      }), true);
    }
    var lines = raw.split("\n").map(function (s) { return s.trim(); }).filter(function (s) {
      return s && s !== "{" && s !== "}" && s !== "[" && s !== "]" && s !== "}," && s !== "],";
    }).map(function (s) {
      var m = /^"([^"\n]{1,40})"[ \t]*:[ \t]*(.*?)[,]?$/.exec(s);
      return m ? "**" + m[1] + "** " + m[2].replace(/^"|"$/g, "").trim() : s.replace(/,$/, "");
    });
    return lines.length ? listBlock(lines.slice(0, 15), true) : null;
  }

  // One rule for a fence, in one place. A ui fence is the page's own component library and every
  // other fence is code. The tag a spec arrives under is not reliably `ui` — a model writes `json`,
  // writes `ui spec`, or leaves it empty — so a body that parses as an object naming a component the
  // page actually has is drawn whatever the tag says. A genuine code block is never turned into a
  // table, because only a recognised component earns that.
  function fenceBlock(lang, text) {
    var tag = uiTxt(lang, 24).toLowerCase();
    var spec = parseSpec(text);
    if (textMode && spec && Object.prototype.hasOwnProperty.call(spec, "component") && Object.prototype.hasOwnProperty.call(spec, "version") &&
        (/^ui\b/.test(tag) || tag === "uispec" || tag === "ui-spec")) {
      var decision = window.JarvisResponses ? window.JarvisResponses.fence(text, true) : null;
      return decision && decision.handled ? decision.node : responsePlain(spec.fallback);
    }
    if (textMode && (/^ui\b/.test(tag) || tag === "uispec" || tag === "ui-spec") &&
        !(window.JarvisResponses ? window.JarvisResponses.legacy(spec) : spec && spec.type && !Object.prototype.hasOwnProperty.call(spec, "component"))) {
      // A body that never parsed is not a rejected declaration: it is a broken fence, and the answer
      // can still be read off it as a table or a list. Only a spec that parsed and was refused gets
      // the sentence, because there the payload was understood and then turned down.
      if (String(text == null ? "" : text).trim() === "") return null;
      if (!spec) return uiBlock(text) || specFallback(spec) || specLines(text) || null;
      return responsePlain(spec.fallback);
    }
    if (/^ui\b/.test(tag) || tag === "ui" || tag === "uispec" || tag === "ui-spec") {
      // A component payload is never shown as code. This used to fall through to a code block when
      // the spec would not draw, which put the raw JSON on his screen: the one thing he asked never
      // to see. It is drawn, or read back as a table or a list, and if neither is possible the block
      // is dropped rather than printed at him.
      return uiBlock(text) || specFallback(spec) || specLines(text) || null;
    }
    if (isSpec(spec)) {
      var drawn = uiBlock(text);
      if (drawn) return drawn;
    }
    return codeBlock(lang, text);
  }

  function responsePlain(text) {
    var pre = document.createElement("pre");
    pre.className = "jr-response-text";
    pre.textContent = typeof text === "string" && text.trim() ? text : "This interactive response could not be displayed.";
    return pre;
  }

  function uiBlock(text) {
    var spec = parseSpec(text);
    if (!spec) return null;
    var type = uiTxt(spec.type, 20).toLowerCase();
    var draw = UI_TYPES[type];
    if (!draw) return null;
    var el = null;
    try { el = draw(spec); } catch (e) { el = null; }   // a malformed spec must never take the page down
    if (el) uiDrawn.push(type);
    return el;
  }

  function renderRich(el, text, shape) {
    el.textContent = "";
    // What this answer's widgets have already drawn, so that nothing goes on the screen twice.
    var bag = { cells: [], sources: [] };
    // Whatever route the words arrived by - a live answer, a restored one, a probe - the opening
    // note about what is on the screen goes before they are drawn, so every surface shows the same
    // answer and not just the one that was streamed.
    text = stripScreenAnnounce(text);
    // A heading written after a sentence instead of on a fresh line sent its hashes into the middle
    // of the paragraph, which is how a real answer printed '### Tyre pressure' as prose. A run of
    // two or more hashes is always a heading and never code, so it gets its own line before the
    // parse; a single '#' is left alone, because that is a comment in every language shown here.
    // Only a heading that shares its line with other words moves. A heading already at the start of a
    // line is where it belongs, and the old pattern matched its own first hash: "### Title" at the top
    // of an answer was split into a stray "#" and a "## Title", which silently cost the first heading
    // in every answer a level.
    text = String(text == null ? "" : text).replace(/(?<=[^\n#|])[ \t]*(#{2,4}[ \t]+)/g, "\n$1");
    // A model that glues a table row to the sentence beside it - the header onto the end of an intro
    // line, the closing sentence onto the tail of the last row - puts pipe syntax inside a paragraph,
    // and a paragraph of pipes is the one thing a table must never become. The pieces are separated
    // here, before the parse, so the row is drawn as a row and the sentence reads as a sentence.
    // Anchored to a line with no pipe of its own before the punctuation, and to prose ending in
    // . : ; ! ? with a space before the pipes: '(up to 5 hrs)' inside a cell ended in a bracket and
    // split a row down the middle on the first attempt at this.
    text = String(text).replace(/^([^|\n]*[.:;!?])([ \t]+)(\|(?:[^\n|]*\|)+[ \t]*)$/gm, "$1\n$3");
    // The same glue on a component: a real turn wrote its chart spec onto the end of the sentence,
    // and a payload that does not open its own line is never read as a component, so the braces went
    // on the screen and the chart stayed invisible. The sentence keeps its line and the spec gets its
    // own, which is what the page reads.
    text = String(text).replace(/^([^\n{]*?)[ \t]*(\{"[^\n]*\})[ \t]*([^\n{]*?)[ \t]*$/gm, "$1\n$2\n$3");
    text = String(text).replace(/^([ \t]*\|(?:[^\n|]*\|)+)[ \t]*([A-Z][^\n|]{7,}[.:!?])[ \t]*$/gm, "$1\n$2");
    // A model sometimes runs a heading into the sentence before it: "…, 15 Oct 2026; no pressure on any
    // volume. ### Routing Choices - **V4 Flash** …". A heading names the part under it, so it always
    // starts its own line: split it out here, rather than letting it merge into the paragraph above it
    // or swallow the bullet under it. Fenced blocks are left exactly as written — a '#' in a command or
    // a C# version is not a title — so the split skips every odd chunk, which is a fence.
    // A model puts the fence opener on the heading's own line ("### Payload Inspection ```json").
    // The heading must stand alone before the split or it arrives as prose with its hashes showing.
    // Done on the text alone, so a fence no heading precedes is untouched, and a fence that holds a
    // hash line keeps it - only the opener is moved.
    var _prepped = String(text).replace(/\r\n?/g, "\n")
      .replace(/(^|\n)([ \t]*#{1,4}[ \t]+[^\n`~]*?)[ \t]*(```|~~~)/g, "$1$2\n$3");
    var _unfenced = _prepped.split(/(```[\s\S]*?```|~~~[\s\S]*?~~~)/);
    for (var _fi = 0; _fi < _unfenced.length; _fi++) {
      if (_fi % 2 === 1) continue;
      var seg = _unfenced[_fi];
      // First: a hash heading that a model ran into the middle of a sentence has to reach a line start,
      // or the rules below cannot see it as a heading at all.
      seg = seg.replace(/([^\n])[ \t]+(#{1,4})[ \t]+(?=\S)/g, "$1\n$2 ");
      // Then: a heading with the bullet it names on the same line: "### Routing Choices - **V4 Flash** …"
      seg = seg.replace(/^([ \t]*#{1,4}[ \t]+[^\n]{0,58}?)[ \t]+-[ \t]+(?=\S)/gm, "$1\n- ");
      // A short bold title that opens a section mid-line, after punctuation or a code span:
      // "… not `/data` **Memory** - 23Gi total" — the title and the bullet each get their line.
      // Bounded to a short phrase and anchored on punctuation, so bold inside a sentence is untouched.
      seg = seg.replace(/([.,)!?`"”“|])[ \t]+(\*\*[^*\n]{2,40}\*\*)(?=[ \t]+-)/g, "$1\n$2");
      // A short bold title with its bullet on the same line, at the start of a line: "**Disk** - Root …"
      // Anchored to the line, so a bold figure inside a sentence ("the cost is **$5** - a lot") never moves.
      seg = seg.replace(/^([ \t]*\*\*[^*\n]{2,40}\*\*)[ \t]+-[ \t]+(?=\S)/gm, "$1\n- ");
      _unfenced[_fi] = seg;
    }
    var lines = _unfenced.join("").split("\n");
    // Before any block rule looks at them: a heading, a header row or a closing sentence stuck to the
    // line around it is split back apart, or the table run starts a line late and the pipes print.
    lines = splitGluedTableLines(lines);
    var i = 0;
    while (i < lines.length) {
      var line = lines[i];
      var fenceAt = line.indexOf("```");
      if (fenceAt >= 0) {
        // The words before an opening fence are their own paragraph, and the language is the rest of
        // that line. Reading only fences that start a line sent a real answer's JSON to the screen as
        // prose and drew the sentence AFTER its closing fence as a code block.
        var lead = line.slice(0, fenceAt).trim();
        if (lead) {
          var leadP = document.createElement("p");
          leadP.className = "rc-p";
          inline(leadP, lead);
          el.appendChild(leadP);
        }
        // The tag is the first word after the ticks; the rest of that line is still body. Reading
        // the whole tail as the language meant a model that put its spec on the opening line had
        // `ui {…}` read as a language name, so the spec was not recognised and the rest of the
        // answer was swallowed as its body.
        var tail = line.slice(fenceAt + 3);
        var lang, opened;
        if (/[{\[]/.test(tail)) {              // a body on the opening line, so the tag is one word
          var tm = /^[ \t]*([A-Za-z0-9_+.-]*)/.exec(tail);
          lang = tm ? tm[1] : "";
          opened = tail.slice(tm ? tm[0].length : 0);
        } else {                               // the whole tail is the tag, however many words it runs
          lang = tail.trim();
          opened = "";
        }
        var body = [], j = i + 1, closed = false;
        var sameLine = opened.indexOf("```");
        if (sameLine >= 0) {                   // opened and closed on the opening line
          body.push(opened.slice(0, sameLine));
          var rest = opened.slice(sameLine + 3).trim();
          lines[i] = rest;
          i = rest ? i : i + 1;
          closed = true;
        } else {
          if (opened.trim()) body.push(opened);
          while (j < lines.length) {
            var closeAt = lines[j].indexOf("```");
            if (closeAt >= 0) {
              if (closeAt > 0) body.push(lines[j].slice(0, closeAt));
              var after = lines[j].slice(closeAt + 3).trim();
              lines[j] = after;               // the rest of the closing line is read as its own line
              i = after ? j : j + 1;
              closed = true;
              break;
            }
            body.push(lines[j]); j++;
          }
          if (!closed) i = j;
        }
        // A ui fence that cannot be drawn now returns nothing on purpose, so the block is appended
        // only when there is one. Appending the nothing threw and the rest of the answer was lost.
        var fbTxt = body.join("\n");
        var fbFold = /^[ \t]*[{\[]/.test(fbTxt) ? mergeTrailingRows(fbTxt, lines, i) : null;
        var fb = fenceBlock(lang, fbFold ? fbFold.text : fbTxt);
        if (fb) { el.appendChild(fb); uiBagNote(bag, parseSpec(fbFold ? fbFold.text : fbTxt)); if (fbFold) i += fbFold.used; }
        else if (fbTxt.trim()) {
          // A block that could not be drawn still has to be readable. It is shown as the code it
          // arrived as, so nothing the model wrote is swallowed without a trace.
          el.appendChild(fenceBlock("text", fbFold ? fbFold.text : fbTxt));
          if (fbFold) i += fbFold.used;
        }
        continue;
      }
      // A run of pipe lines is a table whether or not the --- rule survived the model that wrote it.
      // Requiring the rule sent a table without one down the paragraph path, where its pipes printed
      // as text, and a blank line inside the run used to end it early and orphan the rows under it.
      if (isPipeRow(line) && (isPipeRow(lines[i + 1] || "") || isRuleRow(lines[i + 1]))) {
        var rows = [];
        while (i < lines.length) {
          if (isPipeRow(lines[i])) { rows.push(lines[i]); i++; continue; }
          if (!lines[i].trim() && isPipeRow(lines[i + 1] || "")) { i++; continue; }
          break;
        }
        // A widget above already carries this dataset, so its markdown goes no further: the same
        // figures twice reads as two sources that happen to agree. Compared as normalized values,
        // and only a table whose every body row is already on the screen is dropped.
        var bodyRows = rows.slice(1).filter(function (r) { return !isRuleRow(r); });
        if (bodyRows.length > 1 && bodyRows.every(function (r) { return uiBagRow(bag, r); })) continue;
        el.appendChild(tableBlock(rows));
        var noteAt = i;
        while (noteAt < lines.length && !lines[noteAt].trim()) noteAt++;
        if (isLegendLine(lines[noteAt])) {
          var notes = [];
          while (noteAt < lines.length && isLegendLine(lines[noteAt])) {
            notes.push([lines[noteAt].trim()]); noteAt++;
          }
          el.appendChild(legendBlock(notes));
          i = noteAt;
        }
        continue;
      }
      // A divider is a divider. Three or more of the same mark on a line of its own, with nothing
      // else on it, is the markdown rule; a table's own --- row was already taken by the branch above.
      if (/^[ \t]*([-*_])([ \t]*\1){2,}[ \t]*$/.test(line)) {
        var hr = document.createElement("hr");
        hr.className = "rc-hr";
        el.appendChild(hr);
        i++;
        continue;
      }
      if (/^[ \t]*>[ \t]?/.test(line)) {
        var quoted = [];
        while (i < lines.length && /^[ \t]*>[ \t]?/.test(lines[i])) {
          quoted.push(lines[i].replace(/^[ \t]*>[ \t]?/, "")); i++;
        }
        el.appendChild(calloutBlock(quoted.join("\n")));
        continue;
      }
      if (/^[ \t]*([-*]|\d+[.)])[ \t]+\S/.test(line)) {
        // Bullets stay bullets and numbers stay numbers. Cards were drawn for a '- ' list whenever the
        // router had called the answer cards, which turned a run of tips, a news round and a set of
        // short steps into a wall of containers. A list he reads down is a list; the entity components
        // (compare, metrics, steps, choices) are written as specs of their own, so nothing here guesses.
        var run = listRun(lines, i);
        el.appendChild(run.node);
        i = run.next;
        continue;
      }
      if (/^[ \t]*#{1,4}[ \t]+\S/.test(line)) {
        // A heading in a written answer is a name for the part under it. Drawn, not spoken: the
        // hashes of a markdown heading are not words. Its level is kept, so a written document has
        // ranks on the screen instead of one repeated weight.
        var hp = headingParts(line);
        var lvl = Math.min(4, (/^[ \t]*(#+)/.exec(line) || ["", "#"])[1].length);
        var hd = document.createElement("div");
        hd.className = "rc-h rc-h" + lvl;
        inline(hd, hp[0]);
        el.appendChild(hd);
        if (hp[1]) {
          var headingRest = document.createElement("p");
          headingRest.className = "rc-p";
          inline(headingRest, hp[1]);
          el.appendChild(headingRest);
        }
        i++;
        continue;
      }
      if (/^[ \t]*\*\*[^*\n]{1,80}\*\*[ \t]*$/.test(line)) {
        var boldHd = document.createElement("div");
        boldHd.className = "rc-h";
        inline(boldHd, line.trim().slice(2, -2));
        el.appendChild(boldHd); i++;
        continue;
      }
      // A spec written without a fence, on a line of its own. It used to be collected with whatever
      // sentence followed it and handed to the JSON reader as one string, which failed on the pair of
      // them: that is how a spec and the sentence under it both came out as loose key/value rows.
      if (/^[ \t]*[{\[]/.test(line)) {
        // Rows the payload left outside itself are folded back in before it is drawn: a dataset goes
        // wholly inside the component. If it draws with them they are consumed, and if it will not
        // draw at all they are left to the table path, so nothing is lost either way.
        var folded = mergeTrailingRows(line, lines, i + 1);
        var bareEl = folded ? uiBlock(folded.text) : uiBlock(line);
        if (bareEl) {
          el.appendChild(bareEl);
          uiBagNote(bag, parseSpec(folded ? folded.text : line));
          i += 1 + (folded ? folded.used : 0);
          continue;
        }
        var backEl = specFallback(parseSpec(line)) || specLines(line);
        if (backEl) el.appendChild(backEl);
        i++;
        continue;
      }
      if (!line.trim()) { i++; continue; }
      var para = [line]; i++;
      while (i < lines.length && lines[i].trim() && !structLine(lines[i])) { para.push(lines[i]); i++; }
      var joined = para.join("\n");
      // A spec that lost its fence is drawn, not printed: this is the path that put its braces into
      // the middle of an answer. Only a paragraph that is nothing but one JSON object naming a
      // component the page has is treated this way, so prose and a deliberate JSON answer are both
      // left exactly as they arrived.
      if (joined.trim().charAt(0) === "{" || joined.trim().charAt(0) === "[") {
        var orphan = parseSpec(joined);
        var orphanEl = isSpec(orphan) ? uiBlock(joined) : null;
        if (orphanEl) { el.appendChild(orphanEl); uiBagNote(bag, orphan); continue; }
        // Nothing the page can draw, and a paragraph of braces is not an answer. Read what it holds
        // back as a table or a list; if even that fails, print nothing.
        var regained = specFallback(orphan) || specLines(joined);
        if (regained) { el.appendChild(regained); continue; }
        if (/^[\s\S]*[}\]]\s*$/.test(joined.trim())) continue;
      }
      // The citation of a widget belongs inside the widget. A line that is nothing but a source a
      // widget has already named is the same citation twice, so it goes; every other sentence stands.
      if (bag.sources.length && /^\s*sources?\b/i.test(joined) && joined.length < 220 &&
          bag.sources.some(function (s) { return s && uiNorm(joined).indexOf(s) >= 0; })) continue;
      // A block of nothing but punctuation or markup is not an answer. A lone "#" is what is left
      // behind when a heading is split from its own line, and it renders as a stray mark on screen.
      if (!/[A-Za-z0-9]/.test(joined)) continue;
      var p = document.createElement("p");
      p.className = "rc-p";
      inline(p, joined);
      el.appendChild(p);
    }
    trimFiller(el);
  }

  // The confirmation he taps for, on the button he tapped, rather than a toast in a corner. It
  // carries role=status so the confirmation is announced as well as drawn.
  function flashTip(btn, text) {
    var tip = btn.querySelector(".tip");
    if (!tip) {
      tip = document.createElement("span");
      tip.className = "tip";
      tip.setAttribute("role", "status");
      btn.appendChild(tip);
    }
    tip.textContent = "\u2713 " + text;
    btn.classList.add("showing");
    if (btn._tipT) clearTimeout(btn._tipT);
    btn._tipT = setTimeout(function () { btn.classList.remove("showing"); }, 1500);
  }

  // The row under a finished answer: the same three things a person wants from a reply, as marks
  // rather than as three words competing with the answer they sit under.
  if (copyBtn) copyBtn.addEventListener("click", function () { copyText(answerText, "Answer", copyBtn); });
  if (qCopyBtn) qCopyBtn.addEventListener("click", function () { copyText(lastQ, "Question", qCopyBtn); });
  if (qEditBtn) qEditBtn.addEventListener("click", function () { editAsk(lastQ); });
  if (shareBtn) shareBtn.addEventListener("click", shareAnswer);
  if (againBtn) againBtn.addEventListener("click", function () {
    if (!lastQ || !answerSettled) return;          // nothing to ask again, or a turn still running
    var prompt = lastQ, oldAnswer = answerText;
    answerSettled = false; turnEnded = false; regenerating = true;
    answerText = ""; captionText = ""; capShown = false; pendingNote = null; steps = []; lastStepObject = "";
    if (ans) { ans.textContent = ""; ans.style.display = ""; }
    if (cap) cap.textContent = "";
    if (acts) acts.hidden = true;
    setPhase(""); paintMeta(); paintSteps();
    var list = history();
    for (var i = 0; i < list.length; i++) {
      if (list[i].q === prompt && list[i].a === oldAnswer) {
        regenerateHistoryIndex = i; list.splice(i, 1); saveHistory(list); break;
      }
    }
    clearError();
    try {
      if (window.__jarvisRegenerateAsk) window.__jarvisRegenerateAsk(prompt);
      else window.ask(prompt);
    } catch (e) { regenerating = false; }
  });

  if (sizeBtn) sizeBtn.addEventListener("click", function () { openPage("settings"); });

  setTextScale(textScale());

  // ---------------------------------------------------------------- theme and the offline shell
  // Light or dark: the device decides unless he has said otherwise, and his choice is kept. The
  // ordering matters — an attribute on :root has to be able to beat the media query, so the
  // override is a data-theme attribute and the meta tag is added last, where later wins.

  // Density is three numbers, not one: the page's spacing, the gap between cards, and the type scale.
  // Named as the brief names them so nothing downstream has to guess which is which.
  var DENSITY = {
    compact: { pad: "clamp(.85rem, 4vw, 2.6rem)",   gap: ".42rem", tscale: 0.92 },
    normal:  { pad: "clamp(1rem, 5vw, 3.25rem)",    gap: ".55rem", tscale: 1 },
    roomy:   { pad: "clamp(1.2rem, 6.5vw, 4rem)",   gap: ".75rem", tscale: 1.1 }
  };
  function density(){ try { return localStorage.getItem(DKEY) || "normal"; } catch (e) { return "normal"; } }
  function applyDensity(v){
    var d = DENSITY[v] || DENSITY.normal, r = document.documentElement.style;
    r.setProperty("--padding-base", d.pad);
    r.setProperty("--card-gutter", d.gap);
    r.setProperty("--font-scale", String(d.tscale));
    r.setProperty("--pad", d.pad);          // the layout's own names, so the change is real everywhere
    r.setProperty("--gap", d.gap);
    r.setProperty("--tscale", String(d.tscale));
  }
  function setDensity(v){
    var d = DENSITY[v] ? v : "normal";
    try { localStorage.setItem(DKEY, d); } catch (e) {}
    applyDensity(d);
    return d;
  }
  // One control, one write: the node records it, the client keeps its own copy for an instant first paint.
  function nodeUi(key, val){
    try { localStorage.setItem("jarvis.v1.ui." + key, JSON.stringify(val)); } catch (e) {}
    if (key === "autoplay") { try { window.__jarvisAutoPlay = !!val; } catch (e) {} }
    return sysPost("/api/v1/node/ui", (function (o) { o[key] = val; return o; })({}))
      .then(function (res) {
        if (!res || !res.ok) toast((res && res.error) || "That setting did not take");
        return res;
      });
  }

  function theme() {
    var v = "device";
    try { v = localStorage.getItem(TKEY) || "device"; } catch (e) {}
    return (v === "light" || v === "dark") ? v : "device";
  }
  function setTheme(v) {
    try { localStorage.setItem(TKEY, v); } catch (e) {}
    applyTheme();
    remountWidgets();          // an open widget follows the choice made just now
  }
  function applyTheme() {
    var v = theme(), root = document.documentElement;
    if (v === "device") root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", v);
    var m = document.getElementById("thememeta");
    if (v === "device") {
      if (m && m.parentNode) m.parentNode.removeChild(m);
      return;
    }
    if (!m) {
      m = document.createElement("meta");
      m.id = "thememeta";
      m.name = "theme-color";
      document.head.appendChild(m);
    }
    m.setAttribute("content", v === "light" ? "#FBFAF7" : "#0A0A0B");
  }
  applyTheme();
  if (window.matchMedia) {
    try {
      window.matchMedia("(prefers-color-scheme: light)").addEventListener("change", function () {
        if (theme() === "device") applyTheme();
      });
    } catch (e) { /* an older Safari: the device theme still paints, only the meta would lag */ }
  }

  // Offline says so, rather than letting a turn fail and leaving him to work it out.
  function paintOffline() {
    if (!offlineEl) return;
    var off = (typeof navigator.onLine === "boolean") && !navigator.onLine;
    offlineEl.hidden = !off;
    body.classList.toggle("is-offline", off);
  }
  window.addEventListener("online", paintOffline);
  window.addEventListener("offline", paintOffline);
  paintOffline();

  // The shell is registered where a service worker is allowed to be, which rules out anything
  // that is not a secure origin.
  if ("serviceWorker" in navigator && location.protocol === "https:") {
    window.addEventListener("load", function () {
      // Nothing here should ever be served by a cache: the page is the app. Any worker left over
      // from an earlier build is removed rather than reused, and its caches with it.
      // Versioned by the build stamp: a new build is a new worker URL, so the browser installs it
      // instead of deciding the old one is still current, and any edge cache in front of the site
      // cannot answer for it.
      var _bmeta = document.querySelector('meta[name="jl-build"]');
      var _stamp = _bmeta ? String(_bmeta.getAttribute("content") || "").replace(/[^a-z0-9]/gi, "").slice(0, 24) : "";
      navigator.serviceWorker.register("/sw.js" + (_stamp ? "?v=" + _stamp : "")).catch(function () {});
    });
  }

  recall();
  paintAnswer();
  paintSteps();
  openScreenChannel();
  checkBottom();

  // ================================================================ the workspace shell
  // The refactor's own chrome, in one block so it reads on its own: the composer and its
  // attachments (item 1), the in-place live-voice strip (item 2) and the header and the drawer
  // (item 5). Everything above this line is the surface that was already here; nothing in it is
  // touched, and every control the engine owns keeps its own id and its own handler.
  (function () {
    var body = document.body;

    // --- the field: it is always up, and it grows to four lines --------------------------------
    var q = $("q"), fb = $("fallback");
    if (fb) fb.classList.add("show");
    function autosize() {
      if (!q) return;
      q.style.height = "auto";
      var cs = window.getComputedStyle(q);
      var lh = parseFloat(cs.lineHeight) || 20;
      var pad = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
      // Eight lines, and the padding is part of the box: a cap that leaves the padding out is always
      // short by exactly that much, so a message that filled the box scrolled by its own padding and
      // clipped the last line. Past the ceiling it scrolls rather than hides, and the scroll is
      // contained so a flick inside the field does not move the canvas behind it.
      var max = lh * 8 + pad;
      var h = Math.min(q.scrollHeight + 2, max);
      q.style.height = h + "px";
      q.style.overflowY = q.scrollHeight > max + 1 ? "auto" : "hidden";
      // The field is part of the dock's height, so the dock's measurement is taken here rather than
      // left to a resize that will not come: reading the rect forces the layout the new height needs.
      publishBarHeight();
    }

    // --- the staged attachments ----------------------------------------------------------------
    var chips = $("chips");
    var staged = [];
    function attachmentText() {
      var parts = [];
      staged.forEach(function (it) {
        if (it.state === "busy") return;
        if (it.kind === "link") parts.push("- the link " + it.url);
        else if (it.kind === "file" && it.path) parts.push("- the file " + it.name + ", saved on this machine at " + it.path);
      });
      if (!parts.length) return "";
      return "[Mohammad attached the following to this message. Read them before answering.]\n" +
             parts.join("\n") + "\n\n";
    }
    function swap() {
      var hasText = !!(q && q.value.trim()) || staged.length > 0;
      body.classList.toggle("has-text", hasText);
      if (hasText) { try { window.__jarvisHideHero && window.__jarvisHideHero(); } catch (e) {} }
    }
    function chipEl(it) {
      var el = document.createElement("span");
      var marked = it.kind === "link" || it.kind === "web" || it.kind === "think";
      el.className = "chip" + (marked ? " web" : "") +
                     (it.state === "busy" ? " busy" : (it.state === "bad" ? " bad" : ""));
      if (marked) {
        // A pasted link is context, not text, so the chip says so at a glance; an armed search is
        // marked with a globe, which is the one thing a search is looked for by, and names itself
        // "Force Search"; a changed reasoning level is marked with a brain and states the level.
        // The glyphs differ because any two of them can be staged together.
        var g = document.createElement("span");
        g.className = "cg";
        g.setAttribute("aria-hidden", "true");
        g.textContent = it.kind === "web" ? "\uD83C\uDF10"
                      : (it.kind === "think" ? "\uD83E\uDDE0" : "\uD83D\uDD17");
        el.appendChild(g);
      }
      var n = document.createElement("span");
      n.className = "cn"; n.textContent = it.name;
      var x = document.createElement("button");
      x.type = "button"; x.className = "cx";
      x.setAttribute("aria-label", "Remove " + it.name);
      x.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>';
      x.addEventListener("click", function () { removeChip(it.id); });
      el.appendChild(n); el.appendChild(x);
      return el;
    }
    function paintChips() {
      if (chips) {
        chips.textContent = "";
        staged.forEach(function (it) { chips.appendChild(chipEl(it)); });
        chips.classList.toggle("on", staged.length > 0);
        publishBarHeight();            // the band is part of the dock's height, so the reserve follows it
      }
      // A chip changes the bar's own height, and the menu hanging above it is measured from the top
      // of that stack: without this the sheet keeps a position from before the chip existed and sits
      // down over it.
      placePop();
      swap();
    }
    function removeChip(id) {
      var gone = null;
      staged = staged.filter(function (it) { if (it.id === id) gone = it; return it.id !== id; });
      if (gone && gone.kind === "web") webArmed = false;     // the chip IS the request
      // A reasoning badge staged by an older build is the level it named: taking it back is asking
      // for the default again.
      if (gone && gone.kind === "think") setReasonLevel("auto");
      paintChips(); autosize();
    }
    function uid(p) { return p + Date.now() + Math.random().toString(36).slice(2, 6); }
    function addLink(raw) {
      var v = String(raw || "").trim().replace(/[.,;:!?)\]]+$/, "");
      if (!v) return false;
      if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(v)) v = "https://" + v;
      var u; try { u = new URL(v); } catch (e) { return false; }
      if (u.protocol !== "http:" && u.protocol !== "https:") return false;
      var href = u.href;
      for (var i = 0; i < staged.length; i++) if (staged[i].url === href) return false;
      staged.push({ id: uid("l"), kind: "link", state: "ok",
                    name: u.hostname + (u.pathname && u.pathname !== "/" ? u.pathname : ""),
                    url: href });
      paintChips();
      return true;
    }

    // A pasted link never lands as raw text. It is context, so it arrives as a chip he can take
    // back, and the words around it keep their place in the field.
    var URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>"'`)\]]+|\b[a-z0-9][a-z0-9-]{1,62}\.(?:com|org|net|io|dev|ai|co|ug|uk|info|biz|me|app|xyz|gov|edu|news|blog|shop|site|online|tech|store|live|tv|fm)(?:\/[^\s<>"'`)\]]*)?/gi;

    function insertAtCaret(el, text) {
      try { el.focus(); } catch (e) {}
      if (document.execCommand) {
        try { document.execCommand("insertText", false, text); return; } catch (e) {}
      }
      var s = el.selectionStart || 0, e2 = el.selectionEnd || s;
      el.value = el.value.slice(0, s) + text + el.value.slice(e2);
      el.selectionStart = el.selectionEnd = s + text.length;
    }

    function pasteIntoField(e) {
      var cb = e.clipboardData || window.clipboardData;
      if (!cb || !q) return;
      var text = cb.getData("text/plain") || "";
      if (!text) return;
      var hits = text.match(URL_RE);
      if (!hits || !hits.length) return;
      e.preventDefault();
      var n = 0;
      hits.forEach(function (u) { if (addLink(u)) n++; });
      var rest = text.replace(URL_RE, "").replace(/[ \t]{2,}/g, " ")
                     .replace(/\n{3,}/g, "\n\n").trim();
      if (rest) insertAtCaret(q, (q.value ? " " : "") + rest);
      autosize(); swap();
      if (n) toast(n === 1 ? "Link kept as context" : n + " links kept as context");
    }
    if (q) q.addEventListener("paste", pasteIntoField);

    // Backspace on an empty field takes the last chip back, which is the gesture that makes a chip
    // worth having on a phone.
    if (q) q.addEventListener("keydown", function (e) {
      if (e.key === "Backspace" && !q.value && staged.length) {
        e.preventDefault();
        removeChip(staged[staged.length - 1].id);
      }
    }, true);
    function addFile(file) {
      if (!file) return;
      // Any kind of file goes: the door does not decide what he may send himself.
      var it = { id: uid("f"), kind: "file", name: file.name, state: "busy" };
      staged.push(it); paintChips();
      fetch("/attach?name=" + encodeURIComponent(file.name), { method: "POST", body: file })
        .then(function (r) {
          return r.ok ? r.json() : r.text().then(function (t) { throw new Error(t || String(r.status)); });
        })
        .then(function (j) { it.path = j.path; it.name = j.name || it.name; it.state = "ok"; paintChips(); })
        .catch(function () { it.state = "bad"; it.name = it.name + " (failed)"; paintChips(); });
    }
    function clearStaged() {
      // A staged search or attachment belongs to the turn being sent. The reasoning badge does not:
      // it reports a setting that stays set, so it survives the send and is cleared by its own ✕.
      staged = staged.filter(function (it) { return it.kind === "think"; });
      webArmed = false;
      paintChips();
    }

    // The send carries the attachments. The engine's own send reads the field, so the block is
    // written into the field on the way in, in the capture phase, before that handler runs.
    document.addEventListener("click", function (e) {
      var t = e.target;
      if (!t || !t.closest || !t.closest("#send")) return;
      var pre = attachmentText();
      if (pre && q) q.value = pre + q.value;
    }, true);

    // A newline inside a four-line field. The engine sends on a bare Enter, so Shift+Enter keeps
    // its meaning and stops the engine's own key handler from seeing the key at all.
    document.addEventListener("keydown", function (e) {
      if (e.key === "Enter" && e.shiftKey && e.target === q) e.stopPropagation();
    }, true);
    if (q) q.addEventListener("input", function () { autosize(); swap(); });
    if (q) q.addEventListener("keydown", function () { setTimeout(swap, 0); });

    // The engine clears the field itself after a send, so the swap and the chips follow the turn.
    var origTurnStart = window.__jarvisTurnStart;
    if (typeof origTurnStart === "function") {
      window.__jarvisTurnStart = function () {
        // Read what this turn is asking for before the composer is emptied: the reasoning level and
        // an armed web search both have to survive into the request the engine builds a moment later.
        // The engine hands the question to this hook and clears the field on the way past, so the
        // argument is the text, and the field is only the fallback for a turn that arrives without
        // one. Reading the field alone named every conversation "New conversation".
        var arg = arguments.length ? String(arguments[0] == null ? "" : arguments[0]).trim() : "";
        var asked = arg || (q ? String(q.value || "").trim() : "");
        var opening = threadEmpty();       // asked before the engine paints anything of its own
        captureTurnOpts();
        clearStaged();
        if (q) q.value = "";
        autosize(); swap();
        hideEmpty();
        // The first message is what turns a blank canvas into a conversation: it gets a name and a
        // row in the drawer's list at that moment. Waiting for the machine to list it would leave a
        // chat he is looking at missing from Recents for the length of an answer, and a chat with no
        // row is indistinguishable from one that was lost.
        if (opening && asked && !activeId) {
          activeId = sessionId || "current";        // the machine calls an unnamed window "current"
          var title = concTitle(asked) || "New conversation";
          pending = { id: activeId, title: title,
                      started: Date.now() / 1000, updated: Date.now() / 1000,
                      turns: 1, live: true, pending: true };
          // The session object exists on the device from the first message, not from the first answer:
          // its id, its name and the moment it started, so a reload in the middle of an answer still
          // finds the conversation it was in, with the answer that has not been written yet.
          if (!devGet(activeId)) {
            devPut({ id: activeId, title: title, started: pending.started,
                     updated: pending.updated, turns: [] });
          }
          if (nav && !nav.hidden) paintNavSessions();
        }
        return origTurnStart.apply(this, arguments);
      };
    }
    autosize(); swap();

    // --- the '+' and its popover ------------------------------------------------------------------
    // A menu of four rows, floating just above the button that opened it, over a dimmed and locked
    // canvas. The link field that used to live in the bottom sheet is gone: a pasted link is context,
    // and context belongs in the field it was pasted into.
    var attach = $("attach"), aScrim = $("attachscrim"), plus = $("plus"), pop = $("attachpop"),
        aRows = $("attachrows"), aTools = $("attachtools"), aBack = $("attachback"),
        aReason = $("reasonpanel"), aReasonBack = $("reasonback"),
        attachReasonBtn = $("attachreason"), reasonLevelEl = $("reasonlevel"),
        rvRows = ["auto", "none", "medium", "high", "max"].map(function (lv) {
          return document.querySelector('#reasonpanel .arow[data-rv="' + lv + '"]');
        }),
        fileInput = $("fileinput"), imageInput = $("imageinput"), camInput = $("caminput"),
        attachFileBtn = $("attachfile"), attachImageBtn = $("attachimage"), attachCamBtn = $("attachcam"),
        attachToolsBtn = $("attachtoolsbtn"),
        qtWeb = $("qtweb"), qtMemory = $("qtmemory"), qtConnectors = $("qtconnectors");

    function attachOpen() { return !!(attach && !attach.hidden); }

    function placePop() {
      // Nothing to place any more. This menu used to be a 220px popup anchored to the '+', positioned
      // from the button's own rect (and re-positioned whenever a sub-panel changed its width). It is
      // a full-width sheet pinned to the foot of the screen now, so every measurement here is moot;
      // it is kept as a no-op rather than removed, because four call sites still invoke it.
      return;
      /* eslint-disable no-unreachable */
      if (!pop || !plus || !attachOpen()) return;
      var r = plus.getBoundingClientRect();
      var bar = $("bar");
      // Measured from the bar's own top edge, not the button's: the button lives inside the bar, so
      // hanging off the button alone leaves the menu sitting over the staged chips.
      var ceiling = bar ? bar.getBoundingClientRect().top : r.top;
      // The staged chips sit inside the bar, above the field, so the bar's top edge is not the
      // highest thing this menu has to clear: measured from there it still landed on the chip it was
      // describing while the panel that armed it was open. The chips row is the ceiling when it is
      // showing.
      if (chips) {
        var cr = chips.getBoundingClientRect();
        if (cr.height > 0 && cr.top < ceiling) ceiling = cr.top;
      }
      var w = pop.offsetWidth || 220;
      var left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8));
      pop.style.left = Math.round(left) + "px";
      pop.style.bottom = Math.round(window.innerHeight - ceiling + 10) + "px";
      // The room this sheet actually has is the space above the dock — or above the staged chips,
      // which sit higher — and not the whole viewport. On a short landscape phone that difference is
      // the entire five-level panel: measured 314px of sheet in 270px of room, so its first rows
      // were above the top of the screen. Capped here, it scrolls instead, and 160px is the floor
      // that keeps it usable on any screen.
      pop.style.maxHeight = Math.max(160, Math.round(ceiling - 16)) + "px";
      pop.style.transformOrigin = Math.round(r.left + r.width / 2 - left) + "px calc(100% + 10px)";
    }

    function showRows(el) {
      var tools = el === "tools", reason = el === "reason";
      if (aRows) aRows.hidden = !!(tools || reason);
      if (aTools) aTools.hidden = !tools;
      if (aReason) aReason.hidden = !reason;
      // Both sub-panels carry longer sentences and a control on the right, so they take a wider
      // sheet. It is re-placed after the width lands, because placePop reads it.
      if (pop) pop.classList.toggle("tools", tools || reason);
      if (tools) { paintTurnSwitches(); placePop(); }
      if (reason) { paintReason(); placePop(); }
    }

    function openAttach() {
      if (!attach) return;
      attach.hidden = false;
      if (pop) { pop.style.animation = ""; pop.style.transform = ""; pop.style.transition = ""; }
      if (plus) plus.setAttribute("aria-expanded", "true");
      showRows("rows");
      placePop();
      lockScroll();
    }
    function closeAttach() {
      if (!attach || attach.hidden) return;
      attach.hidden = true;
      if (plus) plus.setAttribute("aria-expanded", "false");
      unlockScroll();
      canvasReleased();
    }
    if (plus) plus.addEventListener("click", function () { attachOpen() ? closeAttach() : openAttach(); });
    if (aScrim) aScrim.addEventListener("click", closeAttach);
    window.addEventListener("resize", placePop);
    window.addEventListener("orientationchange", placePop);

    function pickFrom(input) {
      if (!input) return;
      closeAttach();
      input.click();
    }
    if (attachFileBtn) attachFileBtn.addEventListener("click", function () { pickFrom(fileInput); });
    if (attachImageBtn) attachImageBtn.addEventListener("click", function () { pickFrom(imageInput); });
    if (attachCamBtn) attachCamBtn.addEventListener("click", function () { pickFrom(camInput); });
    if (attachToolsBtn) attachToolsBtn.addEventListener("click", function () { showRows("tools"); });
    if (aBack) aBack.addEventListener("click", function () { showRows("rows"); });

    // --- the runtime overrides this panel holds (10 October 2026) ----------------------------------
    // Web search stages a chip in the composer: that chip is what the turn asks for, and the server
    // hands a searching turn to the layer that holds the tools. Memory off is the opposite kind of
    // setting: the fast layer preloads his memory file and profile into its own prompt, so a turn
    // that refuses them cannot be answered there either and the server sends it to the agent with
    // the instruction to leave them alone. System connectors is a destination, opened through the
    // drawer's own view so the two ways in can never drift apart.
    function paintTurnSwitches() {
      [[$("attachweb"), webArmed], [qtWeb, webArmed], [qtMemory, memOn]].forEach(function (pair) {
        var row = pair[0];
        if (!row) return;
        row.setAttribute("aria-checked", pair[1] ? "true" : "false");
        var sw = row.querySelector(".xswitch");
        if (sw) sw.classList.toggle("on", !!pair[1]);
      });
    }
    function setWebArmed(on) {
      if (!!on === webArmed) return;
      webArmed = !!on;
      var it = null;
      for (var i = 0; i < staged.length; i++) if (staged[i].kind === "web") it = staged[i];
      if (webArmed) {
        staged.push({ id: uid("web"), kind: "web", name: "Force Search", state: "ok" });
        // Arming is a prelude to typing, so the field takes the caret and the keyboard follows.
        if (q) { try { q.focus(); } catch (e) {} }
        toast("The next question will search the web");
      } else if (it) {
        removeChip(it.id);                          // clears the chip, and with it the arming
      }
      paintChips(); autosize(); paintTurnSwitches();
    }
    // The panel stays open while a switch is flipped: two settings in one visit is the whole reason
    // they share a sheet, and a toggle that closes its own menu cannot be read back at a glance.
    if (qtWeb) qtWeb.addEventListener("click", function () { setWebArmed(!webArmed); });


    // --- per-chat turn settings: web search (auto|always|off) and memory (on|off) ------------------
    // Stored on the server beside the Permissions mode, so a reload, a new phone or the guard all see
    // the same answer. The page paints what the server holds; it never keeps its own copy.
    var webState = "auto", memState = "on", lastConvSeen = "";
    function convNow() { try { return String(window.__jarvisConvId ? window.__jarvisConvId() : ""); } catch (e) { return ""; } }
    function optsUrl() { return "/api/chat/" + encodeURIComponent(convNow()) + "/turnopts"; }
    function postOpts(patch) {
      if (!convNow()) return;
      fetch(optsUrl(), { method: "POST", credentials: "same-origin",
                         headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch) }).catch(function () {});
    }
    function paintWebRow() {
      var row = $("attachweb");
      if (!row) return;
      var sub = row.querySelector("i");
      if (sub) sub.textContent = webState === "always" ? "searches before every answer"
                              : "JARVIS searches when it needs to";
      row.setAttribute("aria-checked", webState === "always" ? "true" : "false");
      var sw = row.querySelector(".xswitch");
      if (sw) sw.classList.toggle("on", webState === "always");
    }
    function paintMemRow() {
      var row = $("qtmemory");
      if (!row) return;
      row.setAttribute("aria-checked", memState === "on" ? "true" : "false");
      var sw = row.querySelector(".xswitch");
      if (sw) sw.classList.toggle("on", memState === "on");
      var sub = row.querySelector("i");
      if (sub) sub.textContent = memState === "on" ? "remembers things from other chats" : "ignores past chats";
    }
    function loadTurnOpts() {
      var c = convNow();
      if (!c) return;
      fetch("/api/chat/" + encodeURIComponent(c) + "/turnopts", { credentials: "same-origin" })
        .then(function (r) { return r.json(); })
        .then(function (d) {
          if (!d || !d.ok) return;
          webState = d.web || "auto";
          memState = d.memory === "off" ? "off" : "on";
          memOn = memState === "on";
          setWebArmed(webState === "always");
          paintWebRow(); paintMemRow(); paintTurnSwitches();
        }).catch(function () {});
    }
    setInterval(function () {
      var c = convNow();
      if (c && c !== lastConvSeen) { lastConvSeen = c; loadTurnOpts(); }
    }, 2000);

    // --- the sheet's own controls -----------------------------------------------------------------
    var attachx = $("attachx");
    if (attachx) attachx.addEventListener("click", function () { closeAttach(); });
    var attachweb = $("attachweb");
    if (attachweb) attachweb.addEventListener("click", function () {
      webState = webState === "always" ? "auto" : "always";
      setWebArmed(webState === "always");
      paintWebRow();
      paintTurnSwitches();
      postOpts({ web: webState });
      if (typeof toast === "function") toast(webState === "always"
        ? "Web search: must search first, with citations"
        : "Web search: the model decides");
    });

    // Drag the sheet down to dismiss it, which is what a finger will try on sight. Only the grabber
    // and the title row start a drag: a finger scrolling the list inside the sheet must never be
    // read as a dismissal. The animation holds its end state (fill: both), so it is switched off for
    // the duration of the drag or the inline transform would be ignored.
    (function () {
      if (!pop) return;
      var grips = [pop.querySelector(".grab"), $("atthead")].filter(Boolean);
      var y0 = 0, dy = 0, dragging = false;
      function pointOf(e) { return (e.touches && e.touches[0]) || e; }
      function start(e) {
        dragging = true; dy = 0; y0 = pointOf(e).clientY;
        pop.style.animation = "none"; pop.style.transition = "none";
      }
      function move(e) {
        if (!dragging) return;
        dy = Math.max(0, pointOf(e).clientY - y0);
        pop.style.transform = "translateY(" + dy + "px)";
        if (dy > 6 && e.cancelable) e.preventDefault();
      }
      function end() {
        if (!dragging) return;
        dragging = false;
        pop.style.transition = "transform .24s cubic-bezier(.16,1,.3,1)";
        pop.style.transform = "";
        if (dy > 70) { closeAttach(); }
      }
      grips.forEach(function (el) {
        el.addEventListener("touchstart", start, { passive: true });
        el.addEventListener("touchmove", move, { passive: false });
        el.addEventListener("touchend", end);
        el.addEventListener("touchcancel", end);
        el.addEventListener("mousedown", start);
      });
      document.addEventListener("mousemove", move);
      document.addEventListener("mouseup", end);
    })();
    if (qtMemory) qtMemory.addEventListener("click", function () {
      memState = memState === "on" ? "off" : "on";
      memOn = memState === "on";
      paintMemRow();
      paintTurnSwitches();
      postOpts({ memory: memState });
      toast(memOn ? "Stored memory is back on" : "Stored memory is off for this chat");
    });
    if (qtConnectors) qtConnectors.addEventListener("click", function () {
      closeAttach();
      openNav();
      openNavView("extensions");
    });

    // --- the reasoning row, its panel and its badge (10 October 2026) -------------------------------
    // One setting drawn in two places: the row in the sheet names the level that is set, and any
    // level other than the default also stages a chip above the field, because a setting he cannot
    // see is a setting he forgets he changed. Auto stages nothing: it is the default, and the row
    // already says so.
    function paintReason() {
      var lv = reasonLevel();
      if (reasonLevelEl) reasonLevelEl.textContent = RVLABEL[lv] + (lv === "auto" ? " \u00b7 low" : "");
      rvRows.forEach(function (row) {
        if (row) row.setAttribute("aria-checked", row.getAttribute("data-rv") === lv ? "true" : "false");
      });
    }
    function syncReasonChip(lv) {
      var at = -1;
      for (var i = 0; i < staged.length; i++) if (staged[i].kind === "think") at = i;
      if (lv === "auto") {
        if (at > -1) staged.splice(at, 1);
      } else if (at > -1) {
        staged[at].name = "Think: " + RVLABEL[lv];       // the badge follows the level
      } else {
        staged.push({ id: uid("think"), kind: "think", name: "Think: " + RVLABEL[lv], state: "ok" });
      }
      paintChips(); autosize();
    }
    onReasonPaint(function (lv) { paintReason(); syncReasonChip(lv); });

    if (attachReasonBtn) attachReasonBtn.addEventListener("click", function () { showRows("reason"); });
    if (aReasonBack) aReasonBack.addEventListener("click", function () { showRows("rows"); });
    rvRows.forEach(function (row) {
      if (!row) return;
      row.addEventListener("click", function () {
        var lv = setReasonLevel(row.getAttribute("data-rv"));
        closeAttach();                                  // the badge is the confirmation, so show it
        toast(lv === "auto" ? "Reasoning back to Auto" : "Reasoning: " + RVLABEL[lv]);
      });
    });

    [[fileInput], [imageInput], [camInput]].forEach(function (pair) {
      var input = pair[0];
      if (!input) return;
      input.addEventListener("change", function () {
        var fs = input.files || [];
        for (var i = 0; i < fs.length; i++) addFile(fs[i]);
        input.value = "";
      });
    });

    // --- the live-voice strip, in the composer's own row ------------------------------------------
    var live = $("live"), strip = $("voicestrip"), vwave = $("vwave"), vtime = $("vtime"),
        vmute = $("vmute"), vend = $("vend");
    var liveOn = false, muted = false, liveT0 = 0, liveTick = null;
    var bars = vwave ? vwave.getElementsByTagName("i") : null;

    function paintLive() {
      if (!vtime) return;
      if (!liveOn) { vtime.textContent = "Live"; return; }
      var s = Math.max(0, Math.round((Date.now() - liveT0) / 1000));
      vtime.textContent = muted ? "Muted" : "Live \u00b7 " + s + "s";
    }
    function applyMute() {
      try { if (window.__jarvisOut && window.__jarvisOut.gain) window.__jarvisOut.gain.value = muted ? 0 : 1; } catch (e) {}
      if (vmute) vmute.setAttribute("aria-pressed", muted ? "true" : "false");
      paintLive();
    }
    function enterLive() {
      if (liveOn) return;
      liveOn = true; body.classList.add("live");
      if (strip) strip.hidden = false;
      var st = {};
      try { st = window.__jarvisState ? window.__jarvisState() : {}; } catch (e) {}
      if (!st.earArmed) { var m = $("mic"); if (m) m.click(); }
      liveT0 = Date.now();
      if (liveTick) clearInterval(liveTick);
      liveTick = setInterval(paintLive, 1000);
      paintLive();
    }
    function exitLive() {
      if (!liveOn) return;
      liveOn = false; body.classList.remove("live");
      if (strip) strip.hidden = true;
      if (liveTick) { clearInterval(liveTick); liveTick = null; }
      try { if (window.__jarvisEar) window.__jarvisEar(false); } catch (e) {}
      if (muted) { muted = false; applyMute(); }
    }
    if (live) live.addEventListener("click", function () { liveOn ? exitLive() : enterLive(); });
    if (vend) vend.addEventListener("click", exitLive);
    if (vmute) vmute.addEventListener("click", function () { muted = !muted; applyMute(); });

    // The waveform reads the same level the state ring does, off the engine's own analyser.
    var origLevel = window.__jarvisLevel;
    window.__jarvisLevel = function (buf, dir) {
      try { if (origLevel) origLevel(buf, dir); } catch (e) {}
      if (!liveOn || !bars || !buf || !buf.length) return;
      var n = Math.min(buf.length, 64), s = 0, i;
      for (i = 2; i < n; i++) s += buf[i];
      var v = Math.min(1, (s / Math.max(1, n - 2)) / 170);
      var now = Date.now() / 240;
      for (i = 0; i < bars.length; i++) {
        var w = v * (0.55 + 0.45 * Math.abs(Math.sin(i * 1.7 + now)));
        bars[i].style.height = (5 + Math.round(w * 21)) + "px";
        bars[i].style.opacity = (0.4 + w * 0.6).toFixed(2);
      }
    };

    // --- the header: the drawer, and a new conversation -------------------------------------------
    // The drawer moves on a CSS transition (280ms, cubic-bezier(.16,1,.3,1)), so opening and
    // closing are one motion run in opposite directions. That needs the closed frame on screen
    // before the open class lands — hence the forced reflow — and it needs the panel left mounted
    // until the exit has run, hence the timer rather than a bare `hidden`.
    var nav = $("nav"), navPanel = $("navpanel"), navScrim = $("navscrim"), menuBtn = $("menu");
    var navLast = null, navTimer = 0;
    // Every row in the drawer is a destination now (`data-go`). The Conversation section's two rows
    // were the only `data-act` rows and they are gone: the reply mode has a control in the header and
    // a setting on the Profile page, and the steps sheet opens from the status pill on the dock.
    function openNav() {
      if (!nav) return;
      navLast = document.activeElement;
      if (navTimer) { clearTimeout(navTimer); navTimer = 0; }
      resetNavView();                                // the drawer always opens on the menu itself
      nav.hidden = false;
      if (navPanel) void navPanel.offsetWidth;      // paint the closed frame before the class lands
      nav.classList.add("on");
      if (menuBtn) menuBtn.setAttribute("aria-expanded", "true");
      if (navPanel) { try { navPanel.setAttribute("tabindex", "-1"); navPanel.focus(); } catch (e) {} }
      // No `updateNavPill()` here. Nothing in this file ever defined it, so the call threw at the end of
      // opening the drawer -- after it was open and before anything in it was drawn -- which is why the
      // menu came up with "Nothing yet" under Recents while the conversations were sitting on the machine.
    }
    function closeNav() {
      if (!nav || nav.hidden) return;
      nav.classList.remove("on");
      if (menuBtn) menuBtn.setAttribute("aria-expanded", "false");
      var settle = function () {
        if (nav.classList.contains("on")) return;
        nav.hidden = true;
        resetNavView();                              // no page survives a closed drawer
      };
      if (reduced()) settle(); else navTimer = setTimeout(settle, 320);
      if (navLast && navLast.focus) try { navLast.focus(); } catch (e) {}
    }
    if (menuBtn) menuBtn.addEventListener("click", function () { nav.hidden ? openNav() : closeNav(); });
    if (navScrim) navScrim.addEventListener("click", closeNav);
    if (navPanel) navPanel.addEventListener("click", function (e) {
      var row = e.target && e.target.closest && e.target.closest(".navrow");
      if (!row) return;
      var go = row.getAttribute("data-go");
      if (!go) return;
      // One sheet is left: the gateway restart, which is an action to confirm rather than a page to
      // read, so it asks over the drawer instead of becoming one of its pages.
      if (go === "restart") { closeNav(); openSheetMode("restart"); return; }
      // Three destinations are pages rather than panels: a form is wider than a sidebar, so
      // Settings, Persona & Memory and User Profile take the whole viewport. The drawer stays open
      // underneath, so Back returns to exactly the menu he left.
      if (PAGES[go]) { openPage(go); return; }
      // Everything else drills in: the drawer keeps its own viewport, the destination slides in
      // from the right and Back is that motion reversed. Custom Persona & Memory reaches the agent
      // for its own persona and memory; Settings is the page's own size and appearance. Every row
      // opens something real; none is decorative.
      openNavView(go);
    });

    // --- the empty screen (item 2) ----------------------------------------------------------------
    // Shown only when there is genuinely nothing to read: no ask, no answer, no panel, and no turn
    // running. It is the page saying "start", rather than a blank canvas that looks broken.
    var emptyEl = $("empty"), suggests = $("suggests"), sessionId = "";
    function showEmpty() { if (emptyEl) emptyEl.hidden = false; body.classList.add("empty-screen"); }
    function hideEmpty() { if (emptyEl) emptyEl.hidden = true; body.classList.remove("empty-screen"); }
    function syncEmpty() {
      if (threadEmpty()) showEmpty(); else hideEmpty();
    }
    // --- the conversation skeleton ---------------------------------------------------------------
    // A promise about layout, not a spinner. What he is about to read is his question on the right
    // in a bubble and the answer's own lines on the left, so that is what stands there while the
    // record is fetched: the same shapes, in the same places, at the same widths. Nothing here
    // invents a control, and a read that answers in under 180ms never shows it at all.
    var skDelay = 0;
    function clearThreadSkeleton() {
      if (skDelay) { clearTimeout(skDelay); skDelay = 0; }
      var th = document.getElementById("thread");
      if (!th) return;
      Array.prototype.forEach.call(th.querySelectorAll(".sk-turn"), function (n) {
        if (n.parentNode) n.parentNode.removeChild(n);
      });
      th.removeAttribute("data-sk");
    }
    window.__jarvisClearThreadSkeleton = clearThreadSkeleton;
    // Open-session lives in another closure and cannot see these; it reaches them here.
    window.__jarvisArmThreadSkeleton = function () {
      clearThreadSkeleton();
      skDelay = setTimeout(showThreadSkeleton, 180);
    };
    window.__jarvisShowThreadSkeleton = showThreadSkeleton;   // read-only probe hook, no product path
    window.__jarvisPaintSkeletons = function () { try { paintSkeletons(); } catch (e) {} };
    window.__jarvisPaintSuggest = function () { try { paintSuggest(); return "ok"; } catch (e) { return String(e && (e.stack || e.message)); } };
    function showThreadSkeleton() {
      var th = document.getElementById("thread");
      if (!th) return;
      clearThreadSkeleton();
      th.setAttribute("data-sk", "1");
      for (var i = 0; i < 2; i++) {
        var turn = document.createElement("div"); turn.className = "sk-turn";
        var q = document.createElement("div"); q.className = "sk-q";
        q.style.width = (i ? 72 : 56) + "%";
        turn.appendChild(q);
        var a = document.createElement("div"); a.className = "sk-a";
        [100, 96, 88, 58].forEach(function (w) {
          var line = document.createElement("i"); line.style.width = w + "%"; a.appendChild(line);
        });
        turn.appendChild(a);
        th.appendChild(turn);
      }
      syncEmpty();                    // the landing must not sit over the shape of the chat
    }
    // One rule instead of three renderers each remembering to call in. Turns reach #thread from more
    // than one scope (the live renderer, the history rehydrate), and the landing hero must never sit
    // over any of them; watching the thread makes the rule hold for renderers that do not exist yet.
    (function watchThread() {
      var th = document.getElementById("thread");
      if (!th || !window.MutationObserver) return;
      var settle = function () {
        try {
          // Once the thread holds drawn turns this is not a fresh chat any more.
          if (th && th.childElementCount) body.removeAttribute("data-fresh");
          syncEmpty();
        } catch (e) {}
      };
      new MutationObserver(settle).observe(th, { childList: true, subtree: true });
      settle();
    })();
    // A landing row is one of two things, and the difference is whether it is already a whole
    // request. A row that names its own subject is sent the way a question he typed is sent: into
    // the field, then the engine's own send, which arms text mode and posts the turn. A row that is
    // only a capability ("Search the web") carries the OPENING of the sentence instead, and the tap
    // hands the box those words with the cursor after them. That is what stops a tap from spending
    // a turn on a request he never finished, which is the one thing a suggestion must never do.
    // --- the landing rows, read off the machine rather than written into the markup -----------------
    // One row per capability this box actually has, composed server-side from its own numbers, the
    // newest thing he has been building, the newest script and the hour of the day. The rows in the
    // markup are the fallback: if the machine cannot be reached the landing screen still offers
    // something real, which is also what a cold start with no network gets.
    var suggestSeq = 0;
    var suggestMarkup = null;      // the rows written into the markup, kept so they can come back
    function restoreSuggestions() {
      if (suggests && !suggests.querySelector("button") && suggestMarkup !== null) {
        suggests.innerHTML = suggestMarkup;
      }
    }
    // The landing rows speak the page's icon language: a chip names its kind, and the kind owns a
    // glyph and a line. An unknown kind keeps the machine's mark and no second line, so a new kind
    // on the server never lands as an empty frame.
    var WEB_GLYPH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3c2.6 2.7 4 5.7 4 9s-1.4 6.3-4 9c-2.6-2.7-4-5.7-4-9s1.4-6.3 4-9z"/></svg>';
    var SUGGEST_GLYPH = {
      telemetry: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 12h4.2l2.1-5.6 3.3 11.2 2.4-5.6h7"/></svg>',
      system:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="12" rx="1.6"/><path d="M7 20h10"/><path d="M12 16v4"/></svg>',
      code:      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4.5" width="18" height="12" rx="1.6"/><path d="M2 20h20"/></svg>',
      day:       '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/><path d="M9 12h6M9 16h6"/></svg>',
      web:       WEB_GLYPH,
      search:    WEB_GLYPH,
      audit:     '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20V9M10 20V4M16 20v-7M22 20H2"/></svg>',
      project:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="3.5" width="17" height="17" rx="3"/><path d="M12 8.4v7.2M8.4 12h7.2"/></svg>'
    };
    // A kind the page has not met yet still gets a mark, so a row never loses its column.
    var SUGGEST_FALLBACK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4"><circle cx="12" cy="12" r="3.4"/><circle cx="12" cy="12" r="8.6" opacity=".45"/></svg>';
    var SUGGEST_SUB = {
      telemetry: "Check on your progress",
      system:    "Check on your progress",
      code:      "Review and suggest improvements",
      day:       "Uganda first, then the world",
      audit:     "What is unfinished, and what comes next",
      web:       "Find anything, with live sources",
      search:    "Find anything, with live sources",
      project:   "Name it, then we build it"
    };
    function paintSkeletons() {
      if (!suggests) return;
      if (suggestMarkup === null) suggestMarkup = suggests.innerHTML;
      // The shape the rows will take, shimmering while the machine is read. Widths vary so it reads
      // as text rather than as one loading bar, and it is the page's own skeleton pair, not a second
      // style: the panel already has this, and two skeletons on one page is one too many.
      // A row here is an icon, a title and a line of description under it, so that is what stands in
      // for one: the same column, the same two lines, the same divided rows. One bar per row promised
      // a layout the landing does not have, which is the difference between a skeleton and a shrug.
      var widths = [62, 48, 54, 44, 58];
      suggests.textContent = "";
      widths.forEach(function (w) {
        var row = document.createElement("div"); row.className = "skrow";
        var ic = document.createElement("span"); ic.className = "si sk-ic"; ic.setAttribute("aria-hidden", "true");
        var tx = document.createElement("span"); tx.className = "sk-tx";
        var t1 = document.createElement("span"); t1.className = "skbar"; t1.style.width = w + "%";
        var t2 = document.createElement("span"); t2.className = "skbar sk-sub"; t2.style.width = Math.round(w * 0.72) + "%";
        tx.appendChild(t1); tx.appendChild(t2);
        row.appendChild(ic); row.appendChild(tx); suggests.appendChild(row);
      });
    }
    function paintSuggest() {
      if (!suggests) return;
      var mine = ++suggestSeq;
      var done = false;
      // Only if the read is slow. A landing that answers in 40ms must not blink a skeleton at him.
      var slow = setTimeout(function () { if (mine === suggestSeq && !done) paintSkeletons(); }, 140);
      fetch("/suggest", { credentials: "same-origin" })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (j) {
          done = true; clearTimeout(slow);
          if (mine !== suggestSeq) return;                    // a newer landing has already painted
          var chips = (j && j.chips) || [];
          if (!chips.length) { restoreSuggestions(); return; }
          suggests.textContent = "";
          chips.forEach(function (c) {
            if (!c) return;
            var label = String(c.label || "").trim();
            var fill = c.mode === "fill";
            var text = String((fill ? c.prefix : c.ask) || "").trim();
            if (!label || !text) return;
            var b = document.createElement("button");
            b.type = "button";
            b.setAttribute("data-mode", fill ? "fill" : "send");
            b.setAttribute("data-ask", text);
            // The mark leads the row and is decoration: the label is the row's name, so a screen
            // reader reads the prompt rather than the picture standing in front of it.
            // The glyph is the page's own line icon for the chip's kind, so a row belongs to the
            // instrument rather than the device's emoji font. A kind the page does not know keeps
            // the machine's mark, and a chip with no known kind stays a plain row.
            var si = document.createElement("span");
            si.className = "si"; si.setAttribute("aria-hidden", "true");
            var glyph = SUGGEST_GLYPH[c.kind];
            if (glyph) si.innerHTML = glyph;
            else if (!c.icon) si.innerHTML = SUGGEST_FALLBACK;
            else si.textContent = String(c.icon || "");
            var tx = document.createElement("span");
            tx.className = "tx";
            var st = document.createElement("span");
            st.className = "st"; st.textContent = label;
            tx.appendChild(st);
            // The row's own line wins: the machine knows why this row exists right now (the hour it
            // is briefing for, the day it is summarising), and a fixed per-kind description does not.
            var sub = c.sub || SUGGEST_SUB[c.kind];
            if (sub) {
              var sd = document.createElement("span");
              sd.className = "sd"; sd.textContent = sub;
              tx.appendChild(sd);
            }
            b.appendChild(si); b.appendChild(tx);
            b.title = fill ? "Puts the opening words in the box" : text;    // what the tap does
            suggests.appendChild(b);
          });
        })
        .catch(function () { done = true; clearTimeout(slow); restoreSuggestions(); });
    }
    paintSuggest();

    if (suggests) suggests.addEventListener("click", function (e) {
      var b = e.target && e.target.closest && e.target.closest("button[data-ask]");
      if (!b || !q) return;
      var text = b.getAttribute("data-ask") || "";
      if (!text) return;
      q.value = text;
      q.dispatchEvent(new Event("input", { bubbles: true }));
      if (b.getAttribute("data-mode") === "fill") {
        // A handover, not a send: the box keeps the opening words, the cursor lands after them, and
        // the landing rows stay up because he has not asked anything yet. Focus inside the tap's own
        // gesture is what opens the keyboard on a phone.
        try {
          q.focus();
          var n = q.value.length;
          if (q.setSelectionRange) q.setSelectionRange(n, n);
        } catch (err) {}
        return;
      }
      hideEmpty();
      var s = $("send");
      if (s) s.click();
    });

    // --- the header's pen: a new conversation, and a new session behind it -------------------------
    // One tap. The two-tap dance belongs to the dimmed reset button in the dock, where a mistap is
    // easy; the header's control is deliberate — and now that it is a pen rather than a second '+',
    // it also says which of the two it is. POST /reset mints the session UUID server-side, so the
    // message history, the panel log and the turn counter all start from nothing, and the agent
    // starts on a session of its own instead of continuing the thread this conversation was using.
    //
    // Tapping it in a session that is already new is not an error and not a no-op with no answer: it
    // says so and leaves everything alone, rather than minting a session nobody asked for.
    // "Already new" is the same test that decides whether the empty screen is up — nothing painted,
    // nothing running — so the two can never drift apart: if the page is showing him the empty state,
    // the header's pen has nothing to start. A staged file counts as an intent and gets cleared as
    // one; the level chip is a setting that outlives a turn, so on its own it does not count.
    function threadEmpty() {
      // Read the thread off the document: `threadEl` is closed over inside an earlier IIFE and is not
      // in scope here, so reaching for it threw and the guard never decided anything at all.
      var th = document.getElementById("thread");
      // A child of the thread only counts when it has words in it. Counting bare nodes is what hid the
      // greeting on a screen that had nothing on it: a leftover empty block read as a committed turn.
      var kids = 0;
      if (th) kids = Array.prototype.filter.call(th.children, function (el) {
        return String(el.textContent || "").trim().length > 0;
      }).length;
      // And the decision is not made from `lastQ`, the answer text or the artifact panel: those carry
      // whatever the last conversation left there, which is how the greeting could sit over a new chat or
      // hide on a blank screen. What decides it is whether a conversation is on the screen at all, and
      // whether the thread has real turns in it.
      // A chat is given its id the moment it is created, before it holds anything, so "no id" can
      // never be the test for a blank canvas. The flag below says "this is a chat that has not been
      // used yet", and it is cleared as soon as another conversation is opened or the first turn is
      // drawn — so a real conversation that is still loading never flashes the landing over itself.
      var none = !String(activeId || sessionId || "").trim();
      var fresh = body.getAttribute("data-fresh") === "1";
      // A turn running in a conversation he has left must not keep the new chat blank.
      var running = !!body.getAttribute("data-phase") && !fresh;
      // A conversation being read shows its own shape: the landing must not paint over the skeleton.
      var loading = !!(th && th.getAttribute("data-sk") === "1");
      return !kids && !running && !loading && (none || fresh);
    }
    // The header button and the drawer's action share this: the toast is for a canvas that is
    // genuinely blank, never for one that is showing a conversation the user opened.
    function freshSession() { return threadEmpty(); }
    // Back to a blank workspace, from inside this module and from the drawer's history purge, which
    // is outside it. `newSession` is the server's freshly minted id when the caller has one.
    function resetSurface(newSession, keepTurn) {
      // The blank canvas is blank. No status pill, no badge claiming work, and the dock back to Send / Mic /
      // Plus the moment it is opened — the conversation that is still running is elsewhere, and the page's
      // job is to let him start the next one while it finishes.
      try { if (window.__jarvisWorkingDone) window.__jarvisWorkingDone(); } catch (e) {}
      try { if (window.__jarvisUnlockDock) window.__jarvisUnlockDock(); } catch (e) {}
      if (liveOn) exitLive();
      // Clearing the screen is not the same act as stopping the work. A turn in flight belongs to the
      // conversation being left: it goes on being written down there, and that conversation keeps its
      // answer. Only a caller that means "stop" — clearing everything, the stop button — asks for that,
      // and they call the engine directly; this default is only here so that no path silently gains a
      // way to end a turn it did not mean to end.
      if (!keepTurn) { try { if (typeof window.interrupt === "function") window.interrupt(); } catch (e) {} }
      try { clearView(); } catch (e) {}
      clearStaged();
      if (attach && !attach.hidden) closeAttach();
      if (newSession) sessionId = newSession;
      // A blank canvas belongs to no conversation, and the row for one that is no longer running
      // would otherwise sit in the drawer pointing at a chat that has been filed away.
      activeId = "";
      pending = null;
      syncEmpty();
      paintSuggest();                            // a new session gets its own three, from the box
    }
    window.__jarvisResetSurface = resetSurface;
    // The machine names the conversation a running turn belongs to; the page adopts it, so the row he sees
    // and the record being written are the same conversation rather than two.
    window.__jarvisAdoptConversation = function (id) {
      var name = String(id || "");
      if (!name || name === "current") return;
      if (activeId === name && sessionId === name) return;
      // The conversation has just been given its real name by the machine. Anything this device filed
      // under the placeholder it was using — the first turn of a brand new chat, saved before the name
      // existed — is that same conversation's work and moves with it. Left behind, it became a second row
      // holding half the chat, and the real row opened with its first turn missing: which is exactly the
      // answer that could not be found.
      try {
        var was = String(activeId || sessionId || "");
        if (was && was !== name && !REAL_NAME.test(was)) {
          var held = devGet(was);
          if (held && (held.turns || []).length) {
            var moved = { id: name, title: held.title || "", started: held.started, updated: held.updated,
                          turns: held.turns };
            var here = devGet(name);
            if (here && (here.turns || []).length) {
              // Both names hold turns: they are one conversation, so it is one record, joined on the
              // question each turn was asked — never on a title, which two chats can share.
              var have = {};
              (here.turns || []).forEach(function (t) { have[String(t.q || "")] = true; });
              moved.turns = (here.turns || []).concat((held.turns || []).filter(function (t) {
                return !have[String(t.q || "")];
              }));
              moved.title = here.title || moved.title;
            }
            moved.turns.sort(function (a, b) { return (a.t || 0) - (b.t || 0); });
            devPut(moved); devDrop(was);
          }
          if (turnQ[was]) { turnQ[name] = turnQ[was]; }
        }
      } catch (e) {}
      activeId = name;
      sessionId = name;
      if (pending) pending.id = name;
      paintNavSessions();
    };
    window.__jarvisGone = gone;
    // Which conversation this page is showing, for the engine's one piece of bookkeeping it cannot do
    // itself: whether the turn in flight belongs to the conversation on the screen. The live window's
    // id is minted here and lives in this closure, so this is the only place that can answer.
    window.__jarvisConvId = function () { return String(activeId || sessionId || "current"); };
    // The staged chips are this module's own state, and the conversation code outside it opens a saved
    // conversation with them cleared: a name from this closure is a ReferenceError out there, which is
    // what made every open from Recents fail. Published, like resetSurface above, for exactly that.
    window.__jarvisClearStaged = clearStaged;
    // The machine's half of starting over, on its own: POST /reset files the window away and mints
    // the next id. Kept apart from blanking the screen because forgetting the running conversation
    // must not take a different conversation off the canvas with it.
    function postReset(keepId) {
      // The machine is told to start a fresh window, and for one reason only: the agent's own memory of
      // the old conversation must not bleed into the new one. The NAME of the conversation is this
      // page's to give, and it keeps it — adopting the machine's window key here would leave the canvas
      // and the record with two different names for one chat, which is how a turn got filed into a
      // conversation that was not the one on screen.
      var warmTarget = textMode && /^[0-9a-f]{32}$/.test(String(keepId || "")) ? "?prestart=" + keepId : "";
      return fetch("/reset" + warmTarget, { method: "POST" })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function () { return keepId || sessionId; })
        .catch(function () { return keepId || sessionId; });
    }
    // The conversation on the screen is put where it survives BEFORE the screen is emptied. The device
    // copy is written first and its result is the answer to "is this thread safe" with no network in
    // the way; the machine's copy follows on its own, and if that one is lost the device's is still
    // there and the next save carries it again. A canvas with nothing answered yet has nothing to
    // lose and returns true. This is not decoration: emptying the canvas wipes the device's turn
    // history, so without this step "+ New chat" was the one control that could destroy a thread.
    function flushSession() {
      var s = sessionObject(activeId || sessionId, pending ? pending.title : null);
      if (!s || !s.turns.length) return true;
      return saveConversation(s);
    }
    window.__jarvisFlushSession = flushSession;
    // The drawer's list subscribes to the session store: anything written while the drawer is on screen
    // is on screen at once, without a reload and without closing and reopening it.
    window.__jarvisSessionsChanged = function () {
      if (nav && !nav.hidden) paintNavSessions();
    };
    // The engine's own reset control has to come through here, or it starts a conversation the page does
    // not know about: the canvas empties, the page keeps the last conversation's id, the dock keeps its
    // running state, and the next question is refused as "still answering the last one".
    window.__jarvisNewChat = function () { return startNewConversation(); };
    // Opening a stored conversation by name, for anything that drives this page programmatically.
    window.__jarvisOpenSession = function (id, title) { return openSession(String(id || ""), title || ""); };
    function startNewConversation(flush) {
      if (flush !== false && !flushSession()) {
        // Nothing was stored, so nothing leaves the screen: a chat that cannot be kept is worse than a
        // chat that was not started, and saying so is better than a blank page over a lost thread.
        toast("This chat is not stored yet, so it was kept.", 2600);
        return Promise.resolve(null);
      }
      // A turn still being written belongs to the conversation being left: the engine stops drawing it
      // and keeps reading it, and the page records it where it belongs when it ends. Nothing is
      // cancelled here — starting a new chat is a move, not a stop.
      try { window.__jarvisViewChanged && window.__jarvisViewChanged(null); } catch (e) {}
      // Named here, at once, before anything is typed: the chat exists from this line onwards, with a
      // row in the drawer and a name of its own. Nothing about it depends on the machine answering,
      // which is what made a new chat nameless and its first turn filable into the one he left.
      var id = newConvId();
      sessionId = id;
      activeId = id;
      provPut(id, "New chat");
      pending = { id: id, title: "New chat", at: Math.floor(Date.now() / 1000), turns: [] };
      // The landing is what a new chat looks like. Without this the canvas was cleared and left blank,
      // because the brand-new id made the page believe a conversation was already on screen.
      body.setAttribute("data-fresh", "1");
      // `true`: the turn in flight is kept. The screen is being cleared, not the work stopped.
      resetSurface(null, true);
      try { window.__jarvisSessionsChanged && window.__jarvisSessionsChanged(); } catch (e) {}
      // The machine clears its window in the background; the page does not wait for it and does not
      // take its name.
      try { postReset(id); } catch (e) {}
      return Promise.resolve(id);
    }
    var newChat = $("newchat");
    if (newChat) newChat.addEventListener("click", function () {
      if (freshSession()) { toast("You are already in a new chat", 2000); return; }
      // No toast: the landing is the confirmation, and a pill over it says nothing he cannot see.
      startNewConversation();
    });

    var prestartedTextConv = "", preparedTextConv = "";
    function prestartTextChat() {
      if (!textMode || !q) return;
      if (freshSession() && !pending) {
        var typed = q.value;
        startNewConversation(false);
        q.value = typed;
      }
      var id = String(window.__jarvisConvId ? window.__jarvisConvId() : "");
      if (!/^[0-9a-f]{32}$/.test(id)) return;
      if (freshSession()) preparedTextConv = id;
      // Inline text does not prewarm a task agent; actual handoffs prepare their agent.

    }
    if (q) ["pointerdown", "focus", "input"].forEach(function (event) { q.addEventListener(event, prestartTextChat); });

    // --- a question asked on a blank canvas starts its own conversation ------------------------------
    // Without this, a send from the landing canvas was answered inside whatever window the machine was
    // still holding — the previous conversation — so asking the same thing twice put two identical
    // questions in one chat and two unrelated subjects in one record. A canvas showing a conversation is
    // a follow-up and goes through untouched: only the blank one starts over.
    (function () {
      var btn = $("send");
      if (!btn || !q) return;
      var turning = false, allow = false;
      // The landing goes the moment he sends, not when the thread's own watcher next settles. Asked for by
      // a greeting left standing over the answer it was standing in front of.
      btn.addEventListener("click", function () { try { hideEmpty(); } catch (e) {} }, true);
      btn.addEventListener("click", function (ev) {
        if (allow) { allow = false; return; }        // the re-issued tap is the real send
        // Blank, or a conversation the page put there itself: either way this ask starts its own chat.
        // A conversation he opened is left alone — asking again there is a follow-up.
        if (turning || (!freshSession() && !autoBound)) return;
        if (textMode && freshSession() && preparedTextConv === String(sessionId || "")) {
          setAutoBound(false);
          return;
        }
        var typed = q.value;
        if (!typed || !typed.trim()) return;
        turning = true;
        // The engine sends the moment it is tapped, and the conversation has to exist first. The text is
        // carried across the reset and put back before the tap is re-issued.
        ev.preventDefault(); ev.stopImmediatePropagation();
        var go = (typeof startNewConversation === "function") ? startNewConversation(false) : postReset();
        Promise.resolve(go).catch(function () {}).then(function () {
          turning = false; allow = true; setAutoBound(false);
          try { q.value = typed; q.dispatchEvent(new Event("input", { bubbles: true })); } catch (e) {}
          btn.click();
        });
      }, true);
    })();

    // --- the drawer's own zones (15 October 2026) -------------------------------------------------
    // The action at the top runs the SAME two steps the header button runs, so the two can never
    // drift: one guard, one reset, one toast.
    // The card carries both doors: the identity half opens his profile, the gear opens Settings.
    var navProfile = $("navprofile"), navGear = $("navgear");
    if (navProfile) navProfile.addEventListener("click", function () { openPage("profile"); });
    if (navGear) navGear.addEventListener("click", function () { openPage("settings"); });

    var navNew = $("navnewchat");
    if (navNew) navNew.addEventListener("click", function () {
      closeNav();                        // fold the drawer away on the tap, whatever comes next
      if (freshSession()) { toast("You are already in a new chat", 2000); return; }
      // No toast: the landing is the confirmation, and a pill over it says nothing he cannot see.
      startNewConversation();
    });

    // Conversations in the drawer, from the endpoint the Sessions pane already reads. Pinned ids
    // live in this device's own storage: a pin is a bookmark, and a bookmark that needs a server
    // round trip is a bookmark that disappears when the network does.
    var PINS = "jarvis.v1.pins";
    // Which row is armed for deletion, and which rows he has deleted here that the machine never had. Both
    // outlive a repaint, because the list repaints on its own whenever anything is saved.
    var armedId = "";
    // A pin stores the id AND the title it had: the sessions endpoint may not list that
    // conversation any more (cleared, archived, or simply not returned), and a pin that vanishes
    // silently is worse than no pin at all. Plain strings from an older shape are still read.
    var GONE = "jarvis.v1.gone";
    function gone() {
      try { var v = JSON.parse(localStorage.getItem(GONE) || "[]"); return Array.isArray(v) ? v : []; }
      catch (e) { return []; }
    }
    function goneAdd(id) {
      id = String(id || "");
      if (!id) return;
      try {
        var list = gone().filter(function (x) { return x !== id; });
        list.push(id);
        localStorage.setItem(GONE, JSON.stringify(list.slice(-60)));
      } catch (e) {}
    }
    // Readable from the half of the page that merges the machine's rows with this device's. Published
    // beside the function it publishes: doing it from another scope is a ReferenceError, and that one
    // took the whole drawer's setup down with it.
    window.__jarvisGone = gone;

    // A turn refused because this chat was deleted somewhere else: this device's copy goes too.
    window.__jarvisChatGone = function (id) {
      id = String(id || "");
      if (!id) return;
      try { goneAdd(id); } catch (e) {}
      try { if (window.__jarvisDevDrop) window.__jarvisDevDrop(id); } catch (e) {}
      try { toast("That chat was deleted"); } catch (e) {}
      try { paintNavSessions(); } catch (e) {}
    };

    function pins() {
      try {
        var v = JSON.parse(localStorage.getItem(PINS) || "[]");
        if (!(v instanceof Array)) return [];
        return v.map(function (e) {
          return typeof e === "string" ? { id: e, title: "" } : { id: e && e.id, title: (e && e.title) || "" };
        }).filter(function (e) { return e.id; });
      } catch (err) { return []; }
    }
    function setPins(list) { try { localStorage.setItem(PINS, JSON.stringify(list)); } catch (e) {} }
    function isPinned(id) {
      return pins().some(function (e) { return e.id === id; });
    }
    // ---- the row menu: rename, pin, delete ------------------------------------------------
    // One control on every row, three verbs. Deleting sat on the row as its own bin, so the only thing
    // a conversation could be given from this list was its end.
    function navCloseMenu() {
      var m = document.getElementById("nmenu");
      if (m && m.parentNode) m.parentNode.removeChild(m);
    }
    function navMenuItem(menu, label, danger, fn) {
      var b = document.createElement("button");
      b.type = "button";
      b.className = "nmenu-i" + (danger ? " danger" : "");
      b.setAttribute("role", "menuitem");
      b.textContent = label;
      // An item whose work happens inside the menu (the delete confirmation) keeps it open by
      // returning false; anything else closes it first, so the action runs on a live page.
      b.addEventListener("click", function (ev) {
        ev.stopPropagation();
        if (fn() === false) return;
        navCloseMenu();
      });
      menu.appendChild(b);
      return b;
    }
    function openNavMenu(anchor, s, row) {
      navCloseMenu();
      var m = document.createElement("div");
      m.id = "nmenu"; m.className = "nmenu"; m.setAttribute("role", "menu");
      navMenuItem(m, "Rename", false, function () { navRename(s, row); });
      // A pin lives on the machine, not in this browser: the same chat is on top on every device and
      // after a cleared cache. The device list stays as the fast copy, and as the only record for a chat
      // the endpoint does not list yet.
      navMenuItem(m, (s.pinned || isPinned(String(s.id))) ? "Unpin" : "Pin to top", false, function () {
        var next = !(s.pinned || isPinned(String(s.id)));
        var list = pins().filter(function (e) { return String(e.id) !== String(s.id); });
        if (next) list.push({ id: s.id, title: String(s.title || "Untitled").slice(0, 120) });
        setPins(list);
        s.pinned = next;
        paintNavSessions();
        fetch("/api/sessions/" + encodeURIComponent(s.id) + "/meta", {
          method: "POST", credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ pinned: next })
        }).then(function (r) { return r.json(); }).then(function (d) {
          if (!d || !d.ok) toast("That change did not stick.");
          if (typeof window.__jarvisSessionsChanged === "function") window.__jarvisSessionsChanged();
        }).catch(function () { toast("That change did not stick."); });
      });
      // Deleting is destructive, so the menu asks once in its own surface rather than arming the row.
      navMenuItem(m, "Delete chat", true, function () {
        // Asks in its own surface: the question replaces the three items, and the menu stays where it is.
        m.textContent = "";
        var q = document.createElement("div"); q.className = "nmenu-q"; q.textContent = "Delete this chat?";
        m.appendChild(q);
        navMenuItem(m, "Delete", true, function () { navDelete(s); });
        navMenuItem(m, "Cancel", false, function () {});
        var r2 = m.getBoundingClientRect();
        if (r2.bottom > window.innerHeight - 10) m.style.top = Math.round(Math.max(10, window.innerHeight - r2.height - 10)) + "px";
        return false;
      });
      document.body.appendChild(m);
      var r = anchor.getBoundingClientRect();
      var w = m.offsetWidth, h = m.offsetHeight;
      // An anchor with no box (a row inside a drawer that is not laid out yet) would clamp the menu into
      // the corner of the screen. Fall back to the right edge under the header instead.
      if (!r.width && !r.height) { r = { right: window.innerWidth - 12, bottom: 64, top: 40 }; }
      var left = Math.min(window.innerWidth - w - 10, Math.max(10, r.right - w));
      var top = r.bottom + 6 + h > window.innerHeight - 10 ? Math.max(10, r.top - h - 6) : r.bottom + 6;
      m.style.left = Math.round(left) + "px";
      m.style.top = Math.round(top) + "px";
      setTimeout(function () {
        var off = function (ev) {
          if (!m.contains(ev.target)) { navCloseMenu(); document.removeEventListener("pointerdown", off, true); }
        };
        var esc = function (ev) {
          if (ev.key === "Escape") { navCloseMenu(); document.removeEventListener("keydown", esc, true); }
        };
        document.addEventListener("pointerdown", off, true);
        document.addEventListener("keydown", esc, true);
      }, 0);
    }
    function navDelete(s) {
      // A conversation that is being answered is not deleted through the endpoint: that record is the
      // live window and the box refuses it. It takes the other road, which stops it first.
      if (s.pending || (activeId && String(s.id) === String(activeId))) { dropRunning(s); return; }
      fetch("/api/sessions/" + encodeURIComponent(s.id), {
        method: "DELETE", credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirm: "forget-this-chat" })
      }).then(function (r) {
        return r.json().then(function (b2) { return { status: r.status, body: b2 }; })
                       .catch(function () { return { status: r.status, body: null }; });
      }).then(function (res) {
        if (res.status === 409) { dropRunning(s); return; }
        if (res.status !== 200 || !res.body || !res.body.ok) {
          devDrop(s.id); goneAdd(s.id);
          toast("Removed that chat from this device");
          paintNavSessions();
          return;
        }
        devDrop(s.id);
        // The server's record is what stops a late save reviving the chat; this list keeps it out of
        // the drawer before the next list arrives.
        goneAdd(s.id);
        toast("Deleted " + (res.body.turns || 0) + " turns \u00b7 " + res.body.left + " left");
        paintNavSessions();
      }).catch(function () { toast("Could not delete that conversation", 2500); });
    }
    function navRename(s, row) {
      var open = row ? row.querySelector(".nt") : null;
      if (!open) return;
      var old = String(s.title || "");
      var inp = document.createElement("input");
      inp.type = "text"; inp.className = "nin"; inp.value = old; inp.maxLength = 60;
      inp.setAttribute("aria-label", "Name this conversation");
      var holder = document.createElement("span"); holder.className = "nt";
      holder.appendChild(inp);
      open.parentNode.replaceChild(holder, open);
      inp.focus(); inp.select();
      var done = false;
      function save() {
        if (done) return; done = true;
        var name = String(inp.value || "").trim();
        if (!name || name === old) { paintNavSessions(); return; }
        fetch("/api/sessions/" + encodeURIComponent(s.id) + "/meta", {
          method: "POST", credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: name })
        }).then(function (r) { return r.json(); }).then(function (d) {
          if (!d || !d.ok) toast("That change did not stick.");
          paintNavSessions();
        }).catch(function () { toast("That change did not stick."); paintNavSessions(); });
      }
      inp.addEventListener("keydown", function (ev) {
        ev.stopPropagation();
        if (ev.key === "Enter") { ev.preventDefault(); save(); }
        else if (ev.key === "Escape") { done = true; paintNavSessions(); }
      });
      inp.addEventListener("blur", save);
      inp.addEventListener("click", function (ev) { ev.stopPropagation(); });
    }

    function navRow(s, pinned) {
      var row = document.createElement("div");
      row.className = "nrow";
      // The row names the conversation it stands for, so a tap, a probe or a repaint can always point at
      // the same chat without guessing from its title.
      row.setAttribute("data-id", String(s.id || ""));
      // The dot marks the conversation on the canvas — the one a tap on this row would do nothing for.
      var live = !!activeId && String(s.id) === String(activeId);
      row.setAttribute("data-live", live ? "1" : "0");
      row.setAttribute("data-pinned", pinned ? "1" : "0");
      var full = String(s.title || "Untitled");
      var shown = full.length > 28 ? full.slice(0, 27).replace(/[\s,;:.\-]+$/, "") + "\u2026" : full;
      var t = document.createElement("span");
      t.className = "nt"; t.textContent = shown;
      var dot = document.createElement("span");
      dot.className = "ndot"; dot.setAttribute("aria-hidden", "true");
      var open = document.createElement("button");
      open.type = "button"; open.className = "nt"; open.style.cssText =
        "border:0;background:none;font:inherit;color:inherit;text-align:left;padding:0;cursor:pointer";
      open.textContent = t.textContent;
      // Work in flight on this row: the bin steps aside for a golden pulse and comes back when the answer
      // lands. Deleting a conversation mid-answer would throw away the record of what it is doing.
      if (navBusy[String(s.id)]) row.setAttribute("data-busy", "1");
      var spin = document.createElement("span");
      spin.className = "nspin"; spin.setAttribute("aria-hidden", "true");
      spin.setAttribute("title", "Working in the background");
      // His row control: three dots, and the three things a conversation can be given. The bin used to
      // sit here and was the only action, so renaming and pinning were reachable from the other list and
      // invisible from this one.
      var more = document.createElement("button");
      more.type = "button"; more.className = "nmore";
      more.setAttribute("aria-label", "More for " + full);
      more.setAttribute("aria-haspopup", "menu");
      more.textContent = "";
      more.addEventListener("click", function (ev) { ev.stopPropagation(); openNavMenu(more, s, row); });
      // His layout: the dot first (invisible while the conversation is not the live one, but it
      // keeps its place so titles line up), then the title, then the actions hard against the right.
      row.appendChild(dot); row.appendChild(open); row.appendChild(spin); row.appendChild(more);
      open.addEventListener("click", function () {
        // The conversation already on the canvas: the drawer closes and nothing is fetched. Reading
        // it back would throw away the live turn on screen and, before its first answer was saved,
        // would report a chat he is sitting in as an empty one. Closing is the whole of the meaning.
        if (activeId && String(s.id) === String(activeId)) { closeNav(); return; }
        closeNav();
        // A chat that is still running carries no id the page can trust, so it asks by name instead.
        if (s.pending) { resumeLive(s); return; }
        openSession(s.id, s.title);
      });
      // The row itself is the tap target, not just the words in it. A row that is being answered is opened
      // the same way as any other — the golden pulse is a status, not a door that is shut — and a tap that
      // lands on the dot, the pulse or the space beside the title opens the conversation too. The two
      // controls keep their own jobs and are left to handle their own taps.
      row.addEventListener("click", function (ev) {
        var tgt = ev.target;
        if (tgt === open || (open.contains && open.contains(tgt))) return;
        if (tgt && tgt.closest && tgt.closest(".nbin, .npin")) return;
        if (activeId && String(s.id) === String(activeId)) { closeNav(); return; }
        closeNav();
        if (s.pending) { resumeLive(s); return; }
        openSession(s.id, s.title);
      });
      return row;
    }
    function fillNav(el, list, isPins) {
      el.textContent = "";
      if (!list.length) {
        if (!isPins) {
          var e = document.createElement("div");
          e.className = "nempty";
          e.textContent = "Nothing yet.";
          el.appendChild(e);
        }
        return 0;                                   // an unpinned drawer says nothing about pins
      }
      list.forEach(function (s) { el.appendChild(navRow(s, isPins)); });
      return list.length;
    }
    var navGen = 0;
    // Whether the page put this conversation on the canvas itself (a reload re-binding to the machine's
    // window) or he opened it deliberately from the drawer. A question asked on a canvas the page chose
    // belongs to a new conversation; a question asked on one he opened is a follow-up to that chat.
    var autoBound = false;
    function setAutoBound(v) { autoBound = !!v; try { window.__jarvisAutoBound = !!v; } catch (e) {} }
    var navBusy = {}, navBusyTimer = 0, statusAt = 0;
    // Ground truth, without a socket: the machine is asked which conversations are actually being answered,
    // and every ring that is not one of them is taken down. A reader can die mid-turn — the phone sleeps, the
    // tunnel drops — and without this the drawer keeps pulsing for work that finished minutes ago.
    function statusSync() {
      statusAt = Date.now();
      fetch("/api/sessions/status", { credentials: "same-origin" })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (d) {
          if (!d) return;
          var live = {};
          (d.running || []).forEach(function (id) { live[String(id)] = true; });
          var changed = false;
          Object.keys(navBusy).forEach(function (id) { if (!live[id]) { delete navBusy[id]; changed = true; } });
          try {
            var t = window.__jarvisLiveTurn && window.__jarvisLiveTurn();
            if (t && t.conv && !live[String(t.conv)] && t.alive === false) {
              if (window.__jarvisWorkingDone) window.__jarvisWorkingDone();
            }
          } catch (e) {}
          if (changed) paintNavSessions();
        })
        .catch(function () {});
    }
    window.__jarvisStatusSync = statusSync;
    // A wake, a return to the tab and opening the drawer are the three moments the page has been out of
    // touch: each one asks the machine what is really running.
    document.addEventListener("visibilitychange", function () { if (!document.hidden) statusSync(); });
    window.addEventListener("focus", function () { statusSync(); });
    function paintNavSessions() {
      var rec = $("navrecents"), pn = $("navpins");
      if (!rec && !pn) return;
      var mine = ++navGen;
      fetch("/api/sessions", { credentials: "same-origin" })
        .then(function (r) { return r.ok ? r.json() : Promise.reject(r.status); })
        .then(function (d) {
          try { window.__jarvisApplyPurge && window.__jarvisApplyPurge(d); } catch (e) {}
          return mergedSessions((d && d.sessions) || []);
        })
        .catch(function () { return localSessions(); })
        .then(function (all) {
          if (mine !== navGen) return;
          // What the machine says about the conversation that is running, taken before the list is
          // split: "current" is only what a window is called before an id has been minted for it,
          // and the page must not go on tapping a name the machine has moved on from.
          var live = (all || []).filter(function (s) { return s.live; })[0];
          if (live) {
            live.id = String(live.id);
            if (!sessionId) sessionId = live.id;
            // The placeholder has done its job: the conversation is listed now, and if the canvas is
            // on it, the id the row was drawn with is corrected here.
            if (pending) {
              if (activeId && String(activeId) === String(pending.id)) activeId = live.id;
              pending = null;
            }
            // A canvas with a conversation on it that the page cannot name is the live window.
            if (!activeId && !threadEmpty()) activeId = live.id;
            // A reload, or a first look at a conversation the machine is still answering: nothing in
            // this page is reading that turn, so the canvas re-binds to it instead of sitting empty
            // until it ends and reporting the missing half as a dropped link.
            if (live.turn && !activeId && threadEmpty() &&
                !(window.__jarvisLiveTurn && window.__jarvisLiveTurn())) {
              activeId = live.id;
              setAutoBound(true);          // the page bound this, not him
              try { window.__jarvisAttachTurn && window.__jarvisAttachTurn(live.turn, live.id, 0); } catch (e) {}
            }
          }
          // Which conversations have work in flight. The machine marks the rows it knows about and the
          // engine knows the turn this page is reading — a chat being answered while he looks elsewhere is
          // exactly the one the drawer has to show as busy.
          navBusy = {};
          // Busy means work in flight, not "this is the window he is in": marking the live window busy
          // left its row pulsing with nothing running, and the pulse is a claim about the machine.
          // The machine names the turn it is answering (turn) or flags a conversation it is running.
          (all || []).forEach(function (s) {
            if (s.running || (s.turn !== undefined && s.turn !== null)) navBusy[String(s.id)] = true;
          });
          try {
            var lt = window.__jarvisLiveTurn && window.__jarvisLiveTurn();
            if (lt && lt.alive) navBusy[String(lt.conv)] = true;
          } catch (e) {}
          var anyBusy = Object.keys(navBusy).length > 0;
          if (anyBusy && Date.now() - statusAt > 4000) statusSync();
          if (anyBusy && !navBusyTimer) {
            // While something is being answered the list is repainted on a slow beat, so the golden pulse
            // goes back to being the bin the moment the work ends — no tap, no reload, nothing to notice.
            navBusyTimer = setInterval(function () {
              if (!document.hidden) paintNavSessions();
            }, 4000);
          } else if (!anyBusy && navBusyTimer) {
            clearInterval(navBusyTimer); navBusyTimer = 0;
          }
          all = withPending(byNewest(all));
          // What is pinned is what the MACHINE says is pinned, for every conversation it lists. The device
          // copy is only the record for a chat the endpoint does not carry. Reading the device copy first
          // is why a pin did not survive a cleared cache or a second browser.
          var ids = [];
          all.forEach(function (s) { if (s.pinned) ids.push({ id: s.id, title: s.title || "Untitled" }); });
          pins().forEach(function (e) {
            var known = all.some(function (s) { return String(s.id) === String(e.id); });
            if (!known && !ids.some(function (x) { return String(x.id) === String(e.id); })) ids.push(e);
          });
          setPins(ids.map(function (e) { return { id: e.id, title: e.title || "" }; }));
          var pinned = ids.map(function (e) {
            var live = all.filter(function (s) { return s.id === e.id; })[0];
            return { id: e.id, title: (live && live.title) || e.title || "Untitled",
                     live: !!(live && live.live), missing: !live };
          });
          // Every conversation, not the first eight: a list that stops at eight hides the rest of
          // his chats with nothing on screen saying so. The drawer scrolls; the endpoint already
          // bounds the list.
          var rest = all.filter(function (s) {
            return !ids.some(function (e) { return e.id === s.id; });
          });
          var np = pn ? fillNav(pn, pinned, true) : 0;
          var nr = rec ? fillNav(rec, rest, false) : 0;
          var ps = $("navpinssec"), rs = $("navrecsec");
          if (ps) ps.hidden = !np;
          if (rs) rs.hidden = false;
        });
    }

    // Going back to the chat that is still running. Its row carries no id the page can be sure of —
    // the machine mints the id, and it rotates the window when an idle one closes — so the row asks
    // who the live conversation is by name, and writes back the id it learns.
    function resumeLive(s) {
      fetch("/api/sessions", { credentials: "same-origin" })
        .then(function (r) { return r.ok ? r.json() : null; })
        .catch(function () { return null; })
        .then(function (d) {
          var live = ((d && d.sessions) || []).filter(function (x) { return x.live; })[0];
          var id = String((d && d.live_id) || (live && live.id) || "");
          if (!id || id === "current") {
            // Nothing of it has been filed away yet, so the turns this device kept are the record.
            activeId = String((s && s.id) || "current");
            var cut = resetAt();
            var list = history().filter(function (h) { return !cut || (h.t || 0) > cut; })
                                .slice().reverse().map(function (h) {
              return { q: h.q, a: h.a, t: (h.t || 0) / 1000 };
            });
            if (list.length) rehydrate(list, (s && s.title) || "");
            else toast("That chat is already on screen", 2000);
            return;
          }
          sessionId = id;
          if (pending) pending.id = id;
          openSession(id, (live && live.title) || (s && s.title) || "");
        });
    }

    // Deleting the conversation that is running, which is the one on the canvas as often as not. The
    // endpoint refuses that record outright: the live window is assembled rather than stored. So the
    // window is closed first, which files it away under its own id, and the kept copy is then deleted
    // by name. A canvas showing that conversation goes back to a blank chat, which is the only honest
    // outcome of deleting the chat you are reading.
    function dropRunning(s) {
      var dropId = String((s && s.id) || activeId || "");
      armedId = "";
      var wasCanvas = !activeId || dropId === String(activeId);
      if (wasCanvas) activeId = "";
      pending = null;
      // The device's copy goes at the same moment as the machine's, so a deleted conversation cannot
      // come back through the device store on the next paint.
      devDrop(dropId);
      // `false`: this is a delete, and flushing what is being deleted would put it straight back.
      var go = wasCanvas ? startNewConversation(false) : postReset();
      go.then(function () {
        return fetch("/api/sessions/" + encodeURIComponent(dropId), {
          method: "DELETE", credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ confirm: "forget-this-chat" })
        }).then(function (r) { return r.json().catch(function () { return null; }); });
      }).then(function (j) {
        if (j && j.ok) {
          toast("Deleted that conversation" +
                (typeof j.left === "number" ? "  \u00b7  " + j.left + " left" : ""), 2400);
        } else if (j && j.error === "not found") {
          toast("That chat is fresh now", 2000);
        } else {
          toast("Could not delete that conversation", 2500);
        }
        paintNavSessions();
      }).catch(function () {
        toast("Could not delete that conversation", 2500);
        paintNavSessions();
      });
    }
    if (menuBtn) menuBtn.addEventListener("click", function () {
      // The toggle above has already flipped `hidden` by the time this listener runs, so the guard
      // that used to stand here ("only while hidden") was never true: the list was only ever the one
      // painted when the page loaded, and a conversation started after that did not appear in Recents
      // until a reload. It refreshes on the way in, either way.
      setTimeout(paintNavSessions, 0);
    });
    paintNavSessions();
    // On the way up the canvas holds what this page kept — usually only the last answer — while the machine
    // holds the conversation. The rest of it is asked for once, so a chat does not come back as its newest
    // answer with nothing above it. Once, at load, and never while a turn is being written: then the canvas
    // is a live surface, not a record.
    (function () {
      var asked = false;
      function hydrateOnce() {
        if (asked) return; asked = true;
        fetch("/api/sessions", { credentials: "same-origin" })
          .then(function (r) { return r.ok ? r.json() : null; })
          .then(function (d) {
            var id = String((d && d.live_id) || "");
            if (!id || id === "current") return null;
            if (typeof window.__jarvisLiveTurn === "function") {
              var t = null;
              try { t = window.__jarvisLiveTurn(); } catch (e) {}
              if (t && t.alive) return null;
            }
            return fetch("/api/sessions/" + encodeURIComponent(id), { credentials: "same-origin" })
              .then(function (r) { return r.ok ? r.json() : null; })
              .then(function (one) {
                if (!one || !one.turns || !one.turns.length) return;
                try { window.__jarvisHydrate && window.__jarvisHydrate(one.turns, one.title || ""); } catch (e) {}
              });
          })
          .catch(function () {});
      }
      if (document.readyState === "complete") setTimeout(hydrateOnce, 600);
      else window.addEventListener("load", function () { setTimeout(hydrateOnce, 600); });
    })();
    // The dock's own reset walks the same extra steps, so neither button can leave a chip or a
    // panel behind that the other would have taken down.
    var resetBtn = $("reset");
    if (resetBtn) resetBtn.addEventListener("click", function () {
      clearStaged();
      if (attach && !attach.hidden) closeAttach();
      closeNav();
      syncEmpty();
    });
    syncEmpty();

    document.addEventListener("keydown", function (e) {
      if (e.key !== "Escape") return;
      // A full-screen page sits above the drawer, so it is the first thing to leave.
      if (pageOpen()) { closePage(); return; }
      if (nav && !nav.hidden) {
        // Escape walks back one step at a time: out of a page first, then out of the drawer.
        if (navViewOpen()) closeNavView(); else closeNav();
        return;
      }
      if (attach && !attach.hidden) { closeAttach(); return; }
      if (liveOn) exitLive();
    });

    // The full-screen pages are built outside this module and need exactly one thing from it: the
    // way out of the drawer when they dismiss to the workspace.
    window.__jarvisCloseDrawer = closeNav;

    // What the DOM checks read: the surface's own state, in one call.
    window.__jarvisWorkspace = function () {
      return {
        staged: staged.map(function (it) { return { kind: it.kind, name: it.name, state: it.state }; }),
        live: liveOn, muted: muted,
        nav: !!(nav && !nav.hidden), attach: !!(attach && !attach.hidden),
        field: q ? q.value.slice(0, 80) : "", fieldPx: q ? Math.round(q.getBoundingClientRect().height) : 0,
        hasText: body.classList.contains("has-text"),
        empty: !!(emptyEl && !emptyEl.hidden),
        session: sessionId,
        background: (function () {
          var ks = Object.keys(backgroundBy);
          if (!ks.length) return null;
          return ks.map(function (k) { var b = backgroundBy[k];
            return { conv: b.conv, turn: b.turn, text: (b.text || "").length, steps: (b.steps || []).length }; });
        })()
      };
    };
  })();

  // ====================================================== the full-screen pages: the machine's own
  // Settings, Persona & Memory and User Profile are not drawer-sized ideas. Each one is a page of
  // its own, full width with a sticky header, because a form that is wider than a sidebar should
  // not be squeezed into one. They arrive from the right edge over the drawer, so the motion is the
  // same going in and coming out, and Back leaves the drawer exactly where he found it.
  var pageMode = "", pageGen = 0;
  var pageErr = {};
  var settingsData = null, personaData = null, personaEntries = [], profileData = null;
  var personaDraft = null;

  function pageOpen() { return !!(pageEl && !pageEl.hidden); }

  var PAGES = {
    settings: { title: "Settings", act: "Done", paint: paintSettings, load: loadSettings,
                actFn: function () { closePageAll(); } },
    profile:  { title: "Account", act: "Done", paint: paintProfile, load: loadProfile,
                actFn: function () { closePageAll(); } },
    persona:  { title: "Persona & Memory", act: "Done", paint: paintPersona, load: loadPersonaPage,
                // The label and the deed are the same thing: resting it dismisses, dirty it saves.
                actFn: function () {
                  var ta = pageBody && pageBody.querySelector(".p-textarea");
                  if (ta && personaData && ta.value.trim() !== personaData.system) { savePersona(null); return; }
                  closePageAll();
                } }
  };

  function openPage(mode) {
    var pg = PAGES[mode];
    if (!pg || !pageEl || !pageBody) return;
    pageMode = mode;
    if (pageTitle) pageTitle.textContent = pg.title;
    if (pageActBtn) {
      pageActBtn.textContent = pg.act;
      pageActBtn.className = "p-actbtn";
      pageActBtn.disabled = false;
    }
    try { pageEl.inert = false; } catch (e) {}
    pageEl.removeAttribute("aria-hidden");
    pageEl.hidden = false;
    pageBody.dataset.mode = mode;
    pageBody.textContent = "";
    pageBody.scrollTop = 0;
    // Every open is a fresh read of the machine: what is dropped here is what the skeleton stands
    // in for. A remembered value would draw stale settings with no sign they were stale.
    if (mode === "settings") settingsData = null;
    if (mode === "profile") profileData = null;
    if (mode === "persona") { personaData = null; personaEntries = []; personaDraft = null; }
    var mine = ++pageGen;
    pg.paint(pageBody);                  // the shape lands before the slide begins, never after it
    void pageEl.offsetWidth;             // commit the off-screen start state, then travel
    pageEl.classList.add("in");
    if (pg.load) pg.load(mine);
  }

  function closePage() {
    if (!pageEl || pageEl.hidden) return;
    pageEl.classList.remove("in");
    try { pageEl.inert = true; } catch (e) {}
    pageEl.setAttribute("aria-hidden", "true");
    var mine = ++pageGen;
    var settle = function () {
      if (mine !== pageGen || pageEl.classList.contains("in")) return;
      pageEl.hidden = true;
    };
    pageEl.addEventListener("transitionend", function (e) {
      // transitionend bubbles from children; only the page's own travel ends the page.
      if (e.target === pageEl && e.propertyName === "transform") settle();
    });
    setTimeout(settle, 520);             // a hidden tab fires no transitionend and throttles timers
  }

  // Dismissing to the workspace: the drawer goes with the page, so there is nothing left open.
  function closePageAll() {
    closePage();
    if (window.__jarvisCloseDrawer) window.__jarvisCloseDrawer();
  }

  // The 200ms fade that hands a view over from its skeleton to the live data. On the content root,
  // so the panel arrives as one piece instead of line by line.
  function pageLive(out) {
    out.classList.remove("p-fade");
    void out.offsetWidth;
    out.classList.add("p-fade");
  }

  // --- skeletons: each one mirrors the shape of the panel it stands in for -----------------------
  // A skeleton is a promise about layout. Handing over to different geometry is what makes a panel
  // jump, so every one of these carries the real thing's boxes: same count, same places, same width.
  function skTelGrid(out) {
    var wrap = document.createElement("div");
    wrap.className = "p-grid";
    for (var i = 0; i < 4; i++) {
      var c = document.createElement("div");
      c.className = "p-card sk-square";
      c.innerHTML = '<i class="sk-l w1"></i><i class="sk-l wv"></i><i class="sk-l w3"></i>';
      wrap.appendChild(c);
    }
    out.appendChild(wrap);
  }

  function skPersona(out) {
    var block = document.createElement("i");
    block.className = "sk-block sk-l";
    out.appendChild(block);
    var chips = document.createElement("div");
    chips.className = "sk-chips";
    var w = [76, 54, 68, 42, 84, 60, 48, 72];
    for (var i = 0; i < w.length; i++) {
      var p = document.createElement("i");
      p.className = "sk-l";
      p.style.width = w[i] + "%";
      chips.appendChild(p);
    }
    out.appendChild(chips);
  }

  function skHistory(out) {
    var wrap = document.createElement("div");
    wrap.className = "sk-timeline";
    var w = [72, 60, 80, 66, 62, 78];
    for (var i = 0; i < w.length; i++) {
      var r = document.createElement("div");
      r.className = "sk-tl";
      r.innerHTML = '<i class="sk-dot sk-l"></i><span class="sk-tx">' +
                    '<i class="sk-l" style="width:' + w[i] + '%"></i><i class="sk-l w2"></i></span>';
      wrap.appendChild(r);
    }
    out.appendChild(wrap);
  }

  // Settings and the Profile page are forms of rows rather than lists, so their skeleton is a row
  // of label-plus-control. It is the same idea as the others, shaped for what they draw.
  function skForm(out) {
    var wrap = document.createElement("div");
    wrap.className = "sk-form";
    for (var i = 0; i < 4; i++) {
      var r = document.createElement("div");
      r.className = "sk-frow";
      r.innerHTML = '<i class="sk-l sk-flab"></i><i class="sk-l sk-fctl"></i>';
      wrap.appendChild(r);
    }
    out.appendChild(wrap);
  }

  // --- Settings: the voice he hears, the rate it speaks at, and the machine's own two buttons ---
  function loadSettings(mine) {
    sysGet("/sys/settings").then(function (j) {
      if (mine !== pageGen || pageMode !== "settings") return;
      if (j && j.ok) { settingsData = j.settings; pageErr.settings = ""; }
      else { settingsData = null; pageErr.settings = (j && j.error) || "unreachable"; }
      if (pageBody) paintSettings(pageBody);
    });
  }

  function actionBtn(label, fn) {
    var b = document.createElement("button");
    b.type = "button";
    b.className = "p-btn";
    b.textContent = label;
    b.addEventListener("click", function () {
      b.disabled = true;
      fn(function (msg) { b.disabled = false; toast(msg); });
    });
    return b;
  }

  function paintSettings(out) {
    out.textContent = "";
    out.dataset.mode = "settings";
    if (!settingsData) {
      if (pageErr.settings) {
        panelEmpty(out, "Settings Unreachable",
                   "Could not read this machine's settings: " + pageErr.settings, "chip");
        return;
      }
      skForm(out);
      return;
    }
    var s = settingsData;
    pageLive(out);

    // ---- DOMAIN: Appearance ----------------------------------------------------------------------
    panelHead(out, "Appearance", true);
    segRow(out, [["device", "System"], ["light", "Light"], ["dark", "Dark"]], theme(),
           function (v) { setTheme(v); nodeUi("mode", v); paintSettings(out); });
    segRow(out, [["ink", "Ink"], ["frost", "Frost"]], material(),
           function (v) { setMaterial(v); nodeUi("material", v); paintSettings(out); });
    segRow(out, [["compact", "Compact"], ["normal", "Normal"], ["roomy", "Roomy"]], density(),
           function (v) { setDensity(v); nodeUi("density", v); paintSettings(out); });

    // ---- DOMAIN: Speech --------------------------------------------------------------------------
    panelHead(out, "Speech");
    var ui = s.ui || {};
    var sel = document.createElement("select");
    sel.className = "p-select";
    sel.setAttribute("aria-label", "Active voice");
    (s.voices || []).forEach(function (v) {
      var o = document.createElement("option");
      o.value = v.id;
      o.textContent = v.title + (v.id === s.voice ? "  \u00b7  in use" : "");
      if (v.id === s.voice) o.selected = true;
      sel.appendChild(o);
    });
    sel.addEventListener("change", function () {
      sel.disabled = true;
      sysPost("/sys/settings/voice", { voice: sel.value }).then(function (j) {
        sel.disabled = false;
        if (j && j.ok) { toast("Voice: " + (j.title || "changed")); settingsData = null; loadSettings(pageGen); }
        else { toast((j && j.error) || "That voice did not take"); sel.value = s.voice; }
      });
    });
    out.appendChild(sel);

    var rateWrap = document.createElement("div");
    rateWrap.className = "p-slider";
    var rate = document.createElement("input");
    rate.type = "range";
    rate.min = "0.75"; rate.max = "1.50"; rate.step = "0.05";
    rate.value = Number(s.speed || 1).toFixed(2);
    rate.setAttribute("aria-label", "Speech rate");
    var now = document.createElement("span");
    now.className = "p-now";
    now.textContent = Number(rate.value).toFixed(2) + "\u00d7";
    rate.addEventListener("input", function () { now.textContent = Number(rate.value).toFixed(2) + "\u00d7"; });
    rate.addEventListener("change", function () {
      sysPost("/sys/settings/speed", { speed: Number(rate.value) }).then(function (j) {
        if (!j || !j.ok) toast((j && j.error) || "That rate did not take");
      });
    });
    rateWrap.appendChild(rate);
    rateWrap.appendChild(now);
    out.appendChild(rateWrap);

    // Autoplay is a boolean, so it is the switch, not a pair of words.
    (function () {
      var row = document.createElement("div");
      row.className = "p-toggle";
      var lab = document.createElement("span");
      lab.className = "p-tlabel";
      lab.textContent = "Autoplay answers";
      var sw = document.createElement("button");
      sw.type = "button";
      sw.className = "iossw" + (ui.autoplay ? " on" : "");
      sw.setAttribute("role", "switch");
      sw.setAttribute("aria-checked", ui.autoplay ? "true" : "false");
      sw.setAttribute("aria-label", "Autoplay answers");
      var sl = document.createElement("span");
      sl.className = "slider";
      sw.appendChild(sl);
      sw.addEventListener("click", function () {
        var on = !ui.autoplay;
        ui.autoplay = on;
        sw.classList.toggle("on", on);
        sw.setAttribute("aria-checked", on ? "true" : "false");
        try { if (window.__jarvisSetAudio) window.__jarvisSetAudio(on); else window.__jarvisAutoPlay = on; } catch (e) {}
        nodeUi("autoplay", on);
      });
      row.appendChild(lab);
      row.appendChild(sw);
      out.appendChild(row);
    })();

    // ---- DOMAIN: Agent ---------------------------------------------------------------------------
    panelHead(out, "Agent");
    segRow(out, [["10", "10 turns"], ["25", "25 turns"], ["0", "All"]],
           String(ui.transcript_turns === 0 ? 0 : (ui.transcript_turns || 25)),
           function (v) { nodeUi("transcript_turns", Number(v)); trimTranscript(); paintSettings(out); });
    if (s.scope !== "master") {
      // A browser carrying the machine's own key has nothing to restrict, so the segment is simply not
      // drawn there. No status line either: the absence of a control says it without a sentence.
    segRow(out, [["voice", "Require approval"], ["full", "Full autonomy"]],
           (s.scope === "voice" ? "voice" : "full"),
           function (v) {
             sysPost("/sys/settings/scope", { scope: v }).then(function (j) {
               if (j && j.ok) {
                 toast(v === "full" ? "This device may hand work to JARVIS" : "This device answers only");
                 settingsData = null; loadSettings(pageGen);
               } else {
                 toast((j && j.error) || "That did not take");
                 paintSettings(out);
               }
             });
           });
    }


    // ---- DOMAIN: Maintenance ---------------------------------------------------------------------
    panelHead(out, "Maintenance");
    var row = document.createElement("div");
    row.className = "p-btnrow";
    row.appendChild(actionBtn("Clear client cache", function (done) {
      var gone = 0;
      try {
        var kills = [], i, k;
        for (i = 0; i < localStorage.length; i++) {
          k = localStorage.key(i);
          if (!k || k.indexOf("jarvis.") !== 0) continue;
          if (k.indexOf("image") >= 0 || k.indexOf("panelcache") >= 0 || k.indexOf("blob") >= 0) kills.push(k);
        }
        kills.forEach(function (kk) { localStorage.removeItem(kk); gone++; });
      } catch (e) {}
      done(gone + " cached item" + (gone === 1 ? "" : "s") + " cleared, history kept");
    }));
    row.appendChild(actionBtn("Re-sync node config", function (done) {
      sysPost("/api/v1/node/reload", {}).then(function (j) {
        if (j && j.ok) {
          settingsData = null; loadSettings(pageGen);
          done("Node re-read, " + j.dropped + " cached read" + (j.dropped === 1 ? "" : "s") + " dropped");
        } else done((j && j.error) || "Re-sync failed");
      });
    }));
    out.appendChild(row);
  }


  // --- Persona & Memory: the text the fast layer answers from, and the entries it keeps ---------
  function loadPersonaPage(mine) {
    sysGet("/sys/persona").then(function (a) {
      sysGet("/sys/memory").then(function (b) {
        if (mine !== pageGen || pageMode !== "persona") return;
        if (a && a.ok) {
          personaData = { system: a.system, chars: a.chars, source: a.source, revised: a.revised };
          pageErr.persona = "";
        } else {
          personaData = null;
          pageErr.persona = (a && a.error) || "unreachable";
        }
        personaEntries = (b && b.ok && b.entries) || [];
        personaDraft = null;
        if (pageBody) paintPersona(pageBody);
      });
    });
  }

  function paintPersona(out) {
    out.textContent = "";
    out.dataset.mode = "persona";
    if (!personaData) {
      if (pageErr.persona) {
        panelEmpty(out, "Persona Unreachable",
                   "Could not read the system instructions: " + pageErr.persona, "book");
        return;
      }
      skPersona(out);
      return;
    }
    var d = personaData;
    pageLive(out);

    panelHead(out, "System instructions", true);
    var ta = document.createElement("textarea");
    ta.className = "p-textarea";
    ta.spellcheck = false;
    ta.setAttribute("aria-label", "System instructions");
    ta.value = personaDraft === null ? d.system : personaDraft;
    personaDraft = ta.value;
    var count = document.createElement("p");
    count.className = "p-note";
    count.textContent = ta.value.length + " characters \u00b7 read on every reply.";
    var dirty = function () { return ta.value !== d.system && !!ta.value.trim(); };
    var save = document.createElement("button");
    save.type = "button";
    save.className = "p-btn primary";
    save.textContent = "Save system prompt";
    save.disabled = !dirty();
    ta.addEventListener("input", function () {
      personaDraft = ta.value;
      count.textContent = ta.value.length + " characters \u00b7 read on every reply.";
      save.disabled = !dirty();
      if (pageActBtn) {
        pageActBtn.textContent = dirty() ? "Save" : "Done";
        pageActBtn.className = "p-actbtn" + (dirty() ? " primary" : "");
      }
    });
    save.addEventListener("click", function () { savePersona(save); });
    out.appendChild(ta);
    out.appendChild(count);
    out.appendChild(save);

    var GROUPS = [["memory", "What JARVIS remembers", "kept by the agent"],
                  ["profile", "What it knows about you", "your profile"]];
    var total = personaEntries.length;
    panelHead(out, "Stored memory", true);
    if (!total) {
      panelEmpty(out, "No Memory Entries", "Nothing is stored about you yet.", "box");
    } else {
      GROUPS.forEach(function (g) {
        var mine = personaEntries.filter(function (e) { return e.kind === g[0]; });
        if (!mine.length) return;
        var sub = document.createElement("p");
        sub.className = "p-sub";
        sub.textContent = g[1] + " \u00b7 " + mine.length + " \u00b7 " + g[2];
        out.appendChild(sub);
        var chips = document.createElement("div");
        chips.className = "p-chips";
        mine.forEach(function (en) { chips.appendChild(memChip(en, ta)); });
        out.appendChild(chips);
      });
    }
    panelNote(out, total + " entries across the agent's own two memory files. A tap reads one in " +
                   "full; the \u2715 removes it. Every change copies the file aside first, so one " +
                   "tap is one file away from undone.");
  }

  // A passcode living in the memory file should not be the first thing a shoulder reads. Entries
  // shaped like a secret render masked and open on a tap; nothing is hidden from him, only from the
  // room. The files themselves are unchanged.
  var SECRET_RE = /secret\s*word|passcode|password|api[\s_-]?key|private key|credential|\bbearer\b|\btoken\b/i;

  function memChip(en, ta) {
    var full = en.text.replace(/\s+/g, " ").trim();
    var secret=[REDACTED](full);
    var c = document.createElement("span");
    c.className = "mem-chip";
    var t = document.createElement("span");
    t.className = "mem-text" + (secret ? " masked" : "");
    var shown = full.length > 180 ? full.slice(0, 180) + "\u2026" : full;
    t.textContent = secret ? maskSecret(full) : shown;
    if (!secret) t.title = full;
    t.addEventListener("click", function () {
      if (t.classList.contains("masked")) {
        t.textContent = full;
        t.classList.remove("masked");
        t.classList.add("open");
        return;
      }
      t.classList.toggle("open");
    });
    var x = document.createElement("button");
    x.type = "button";
    x.className = "mem-x";
    x.textContent = "\u2715";
    x.setAttribute("aria-label", secret ? "Delete memory entry" : "Delete memory: " + full.slice(0, 50));
    x.addEventListener("click", function () {
      x.disabled = true;
      sysPost("/sys/memory/delete", { id: en.id }).then(function (j) {
        if (j && j.ok) {
          toast("Memory removed \u00b7 " + j.kept + " left");
          if (ta) personaDraft = ta.value;
          loadPersonaPage(pageGen);
        } else {
          x.disabled = false;
          toast((j && j.error) || "Not removed");
        }
      });
    });
    c.appendChild(t);
    c.appendChild(x);
    return c;
  }

  function maskSecret(full) {
    var head = full.split(":")[0];
    if (head && head.length <= 48 && full.indexOf(":") > 0) return head + ": \u2022\u2022\u2022\u2022\u2022\u2022  \u00b7  tap to read";
    return "\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022  \u00b7  tap to read";
  }

  function savePersona(btn) {
    var ta = pageBody && pageBody.querySelector(".p-textarea");
    if (!ta) return;
    var text = ta.value.trim();
    if (!text) { toast("Nothing to save"); return; }
    if (btn) btn.disabled = true;
    if (pageActBtn) pageActBtn.disabled = true;
    sysPost("/sys/persona", { system: text }).then(function (j) {
      if (btn) btn.disabled = false;
      if (pageActBtn) pageActBtn.disabled = false;
      if (j && j.ok) {
        personaDraft = text;
        if (personaData) { personaData.system = text; personaData.chars = j.chars; }
        toast("System prompt saved \u00b7 " + j.chars + " characters");
        if (pageBody) paintPersona(pageBody);
      } else {
        toast((j && j.error) || "Not saved");
      }
    });
  }

  // --- User Profile: the session, the node he is on, and whether the agent is actually there ----
  function loadProfile(mine) {
    sysGet("/api/account").then(function (j) {
      if (mine !== pageGen || pageMode !== "profile") return;
      if (j && j.ok) { profileData = j; pageErr.profile = ""; }
      else { profileData = null; pageErr.profile = (j && j.error) || "unreachable"; }
      if (pageBody) paintProfile(pageBody);
    });
  }

  function statRow(out, k, v, tone) {
    var r = document.createElement("div");
    r.className = "p-stat";
    var a = document.createElement("span");
    a.className = "ps-k";
    a.textContent = k;
    var b = document.createElement("span");
    b.className = "ps-v" + (tone ? " " + tone : "");
    b.textContent = v;
    r.appendChild(a);
    r.appendChild(b);
    out.appendChild(r);
    return r;
  }

  function accRow(out, label, value, badge, tone) {
    var r = document.createElement("div"); r.className = "acc-row";
    var l = document.createElement("div"); l.className = "acc-l";
    var t = document.createElement("div"); t.className = "acc-t"; t.textContent = label;
    var v = document.createElement("div"); v.className = "acc-v"; v.textContent = value || "";
    l.appendChild(t); l.appendChild(v); r.appendChild(l);
    if (badge) {
      var b = document.createElement("span");
      b.className = "acc-badge" + (tone ? " " + tone : "");
      b.textContent = badge; r.appendChild(b);
    }
    out.appendChild(r);
    return r;
  }
  function accAct(out, text, cls, fn) {
    var b = document.createElement("button");
    b.type = "button"; b.className = "acc-act" + (cls ? " " + cls : "");
    b.textContent = text;
    b.addEventListener("click", fn);
    out.appendChild(b);
    return b;
  }
  // One action, two reaches. Logging out here forgets this device's token and takes the page back to the
  // door; logging out everywhere revokes the other paired sessions and keeps this one -- a control that
  // locked the hand pressing it would be a trap. Both are asked for twice.
  function accountLogout(out, all) {
    if (all && out.getAttribute("data-armed") !== "1") {
      out.setAttribute("data-armed", "1");
      toast("Tap again to revoke every other session", 2800);
      setTimeout(function () { try { out.removeAttribute("data-armed"); } catch (e) {} }, 6000);
      return;
    }
    out.removeAttribute("data-armed");
    var url = all ? "/api/account/logout-all" : "/api/account/logout";
    sysPost(url, all ? { confirm: "revoke-other-devices" } : {}).then(function (j) {
      if (!j || !j.ok) { toast((j && j.error) || "Not done"); return; }
      if (all) {
        toast(j.revoked + " other session" + (j.revoked === 1 ? "" : "s") + " revoked");
        loadProfile(pageGen);
        return;
      }
      toast("Signed out on this device");
      try { if (window.JarvisResponses) window.JarvisResponses.signOut(); if (window.JarvisOpenUI) window.JarvisOpenUI.signOut(); } catch (e) {}
      try { localStorage.removeItem("jarvis.v1.sessionstore"); } catch (e) {}
      setTimeout(function () { location.reload(); }, 800);
    });
  }
  function paintProfile(out) {
    out.textContent = "";
    out.dataset.mode = "account";
    if (!profileData) {
      if (pageErr.profile) {
        panelEmpty(out, "Account Unreachable",
                   "Could not read this account: " + pageErr.profile, "chip");
        return;
      }
      skForm(out);
      return;
    }
    var d = profileData, td = d.this_device || {};
    pageLive(out);

    // 1. the identity: an avatar, the name, the role. Nothing else about him.
    var idw = document.createElement("div"); idw.className = "acc-id";
    var av = document.createElement("div"); av.className = "acc-av"; av.textContent = "M";
    var meta = document.createElement("div"); meta.className = "acc-meta";
    var nm = document.createElement("div"); nm.className = "acc-name"; nm.textContent = d.name || "Mohammad";
    var rw = document.createElement("div"); rw.className = "acc-subline";
    var rl = document.createElement("span"); rl.className = "acc-role"; rl.textContent = d.role || "Admin";
    rw.appendChild(rl); meta.appendChild(nm); meta.appendChild(rw);
    idw.appendChild(av); idw.appendChild(meta); out.appendChild(idw);

    // 2. the bindings that exist on this node, each with what it is and whether it is there.
    panelHead(out, "Authentication methods");
    (d.bindings || []).forEach(function (b) {
      var bound = b.status === "Bound";
      accRow(out, b.label, b.value, b.status + (b.primary ? "  \u00b7  Primary" : ""),
             bound ? "ok" : "off");
    });

    // 3. the devices holding access -- an account has devices, a device has sessions -- and the two ways
    //    out. The same phone is one device whichever surface it arrived from; its sessions are counted,
    //    never listed one per load.
    panelHead(out, "Devices & security");
    var devs = d.device_list || [];
    if (!devs.length) {
      accRow(out, "No devices signed in", "this session only", "", "off");
    }
    devs.forEach(function (dv) {
      var meta = (dv.sessions === 1 ? "1 session" : (dv.sessions || 0) + " sessions") +
                 (dv.last ? "  \u00b7  last used " + String(dv.last).slice(0, 16) : "");
      accRow(out, dv.display || dv.name || "unknown device", meta,
             dv.current ? "this device" : "", dv.current ? "ok" : "");
    });
    if (d.account && d.account.id) {
      accRow(out, "Account", (d.account.email || "") + "  \u00b7  " + (d.account.role || "Admin"), "", "off");
    }
    accAct(out, "Log Out", "primary", function () { accountLogout(out, false); });
    accAct(out, "Log Out of All Devices", "link", function () { accountLogout(out, true); });
    panelNote(out, "Logging out here forgets this device's token and returns the page to the door. " +
                   "Logging out everywhere revokes every other paired session on this node and keeps this one.");

  }

  // --- the page's own chrome ---------------------------------------------------------------------
  if (pageBackBtn) pageBackBtn.addEventListener("click", closePage);
  if (pageActBtn) pageActBtn.addEventListener("click", function () {
    var pg = PAGES[pageMode];
    if (pg && pg.actFn) pg.actFn();
  });

  // The reasoning level used to be a pill in this header with a menu of its own. It lives in the
  // attach sheet now, next to the other runtime overrides, and any level other than Auto stages a
  // badge above the field. Nothing needs wiring here: the setting and its painters are set up near
  // the top of this file, and the sheet's own module is what draws it.

  // A stored startup mode is honoured once per page load, and only when nothing is running. After
  // that the header's switch owns the session; the preference owns the next one.
  setTimeout(function () {
    sysGet("/sys/profile").then(function (j) {
      if (!j || !j.ok) return;
      var want = j.default_mode;
      if (want !== "text" && want !== "voice") return;
      if (document.body.getAttribute("data-phase")) return;
      var cur = "voice";
      try { cur = (window.__jarvisModes && window.__jarvisModes().mode) || "voice"; } catch (e) { return; }
      if (cur === want) return;
      var m = $("modeBtn");
      if (m) m.click();
    });
  }, 1400);
})();

  // A page loaded days ago keeps running inside the app long after the server has moved on, and
  // everything it draws is then judged as if it were current - a fixed header still looks broken.
  // Compare the build this page was made from with the one being served; when they differ, take
  // the new one. Silent, once, and only when nothing is in flight.
  (function () {
    try {
      var meta = document.querySelector('meta[name="jl-build"]');
      var mine = meta ? String(meta.getAttribute("content") || "") : "";
      if (!mine) return;
      function check() {
        fetch("/build", { cache: "no-store", credentials: "same-origin" })
          .then(function (r) { return r.ok ? r.json() : null; })
          .then(function (j) {
            var served = j.build || ((j.css && j.js) ? (j.css + "|" + j.js + "|") : "");
            if (!served || served === mine) return;
            var busy = document.querySelector('[data-running="1"]');
            if (busy) return;                       // never reload over a turn he is watching
            location.reload();
          })
          .catch(function () {});
      }
      setTimeout(check, 2500);
      setInterval(check, 45000);
      document.addEventListener("visibilitychange", function () {
        if (document.visibilityState === "visible") check();
      });
    } catch (e) {}
  })();

/* response-assets: 79adfde7d789e0f76ac4ff0bcae1b1e199bb35b75e3fc665809fa3fe41f03033 */
