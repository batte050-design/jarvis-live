/* Permissions — one row in the Add-to-chat sheet, and the badge it puts on a chat.
 *
 * The server owns the mode. This file only reads it, shows it, and asks the server to change it.
 * Nothing here decides whether an action runs.
 */
(function () {
  "use strict";

  var MODE = null, CHAT = "";

  function $(id) { return document.getElementById(id); }

  function conv() {
    if (window.__jarvisCurrentConv) return String(window.__jarvisCurrentConv);
    try {
      var m = location.hash.match(/[0-9a-f]{8,40}/i);
      if (m) return m[0];
    } catch (e) {}
    try {
      var store = JSON.parse(localStorage.getItem("jarvis.v1.sessionstore") || "{}");
      var ids = Object.keys(store || {}).sort(function (a, b) {
        return ((store[b] || {}).updated || 0) - ((store[a] || {}).updated || 0);
      });
      if (ids.length) return String(ids[0]);
    } catch (e) {}
    return "";
  }

  function api(path, method, body) {
    return fetch(path, {
      method: method || "GET",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) { return { status: r.status, body: j }; });
    });
  }

  function paint() {
    var row = $("qtpermissions");
    if (row) {
      var sub = row.querySelector("i");
      if (sub) sub.textContent = MODE === "auto" ? "runs routine tasks, asks before risky ones"
                                                 : "asks before making changes";
      row.setAttribute("aria-checked", MODE === "auto" ? "true" : "false");
      var sw = row.querySelector(".xswitch");
      if (sw) sw.classList.toggle("on", MODE === "auto");
    }
    var badge = $("autobadge");
    if (!badge) {
      var host = document.querySelector(".hdr, header.hdr, #hdr") || document.body;
      if (host) {
        badge = document.createElement("button");
        badge.id = "autobadge";
        badge.type = "button";
        badge.className = "autobadge";
        badge.textContent = "Auto-approve";
        badge.addEventListener("click", toggle);
        host.appendChild(badge);
      }
    }
    if (badge) badge.hidden = MODE !== "auto";
  }

  function serverChat() {
    return api("/api/sessions").then(function (r) {
      var j = r.body || {};
      var list = j.sessions || j.chats || (Array.isArray(j) ? j : []);
      var first = list[0] || {};
      return String(first.id || first.conv || first.chat || "");
    }).catch(function () { return ""; });
  }

  function load() {
    var c = conv();
    if (!c) {
      return serverChat().then(function (id) {
        CHAT = id || "";
        if (!CHAT) { MODE = "ask"; paint(); return; }
        return api("/api/chat/" + CHAT + "/permissions").then(function (r) {
          MODE = (r.body && r.body.mode) || "ask"; paint();
        });
      });
    }
    CHAT = c;
    if (!CHAT) { MODE = "ask"; paint(); return Promise.resolve(); }
    return api("/api/chat/" + CHAT + "/permissions").then(function (r) {
      MODE = (r.body && r.body.mode) || "ask";
      paint();
    }).catch(function () { MODE = "ask"; paint(); });
  }

  function toggle() {
    var want = MODE === "auto" ? "ask" : "auto";
    var target = conv() || CHAT;
    if (!target) { return serverChat().then(function (id) { CHAT = id; return toggle(); }); }
    return api("/api/chat/" + target + "/permissions", "POST", { mode: want }).then(function (r) {
      if (r.status === 409) { MODE = "ask"; paint(); return; }
      MODE = (r.body && r.body.mode) || want;
      paint();
    }).catch(function () {});
  }


  /* --- the question card: one per pending question, in the chat that owns it --- */
  var CARD_ID = "askcard";

  /* Why the card is asking, in plain words. This table was referenced but never defined, so the
     card threw before it could be built and a question could not be shown at all: the turn then
     waited out its two minutes for an answer that had no way of arriving. */
  var PLAIN_REASON = {
    external_send: "This sends something off this machine.",
    irreversible_delete: "There is no way back from this one.",
    spend: "This commits money or credit.",
    secret_read: "This reads a secret.",
    secrets_exposure: "This would expose a stored secret.",
    credential_access: "This reaches for a stored credential.",
    persistent_change: "This changes something that stays changed.",
    obfuscated_execution: "The command is assembled as it runs, so I cannot read it first.",
    unverifiable: "I cannot tell what this does until it has already run.",
    unclassified: "I do not recognise this command.",
    always_ask: "This kind of action always asks.",
    safe: "Nothing here needs a decision.",
    medium: "Reversible, but worth a look before it runs."
  };


  // Some questions were stored before the card spoke plainly, and they still hold the command. This
  // keeps a shell line off the screen whatever the record says.
  function looksLikeCommand(t) {
    var x = String(t || "");
    return /(^|\s)(-{1,2}[a-z]|&&|\|\||\|\s|>\s|\$\()/i.test(x) || /^\s*[a-z_]+\s+\/[\w.\/-]+/i.test(x) || x.length > 160;
  }
  function plainAct(it) {
    var a = String((it && it.action) || "");
    if (!a || looksLikeCommand(a)) return String((it && it.question) || "Something needs your approval.");
    return a;
  }

  function cardHtml(it, left) {
    var cls = (it["class"] || "unclassified").replace(/_/g, " ");
    var tier = (it["tier"] || "high");
    return '<div class="askcard" data-id="' + it.id + '">' +
      '<div class="askhead"><span class="asktitle">Needs your approval</span>' +
      '<span class="askcls">' + tier.toUpperCase() + ' \u00b7 ' + cls + '</span>' +
      '<span class="askleft" data-left="' + it.id + '">' + left + '</span></div>' +
      // Never the command. A card that prints a shell line asks him to review code he did not write
      // to make a decision about an action. If a stored question still carries one, the plain reason
      // stands in for it.
      '<div class="askact">' + plainAct(it) + '</div>' +
      (it.action ? '<div class="askwhy">' + (PLAIN_REASON[it["class"]] || it.question || "") + '</div>' : "") +
      '<div class="askbtn"><button class="allow" data-allow="' + it.id + '">Allow</button>' +
      '<button class="deny" data-deny="' + it.id + '">Deny</button></div></div>';
  }

  function paintCards(items) {
    var host = document.getElementById("thread") || document.body;
    var existing = {};
    [].forEach.call(host.querySelectorAll(".askcard"), function (el) { existing[el.getAttribute("data-id")] = el; });
    items.forEach(function (it) {
      if (!existing[it.id]) {
        var d = document.createElement("div");
        d.innerHTML = cardHtml(it, "10:00");
        host.appendChild(d.firstChild);
      }
    });
    Object.keys(existing).forEach(function (id) {
      if (!items.some(function (i) { return i.id === id; })) existing[id].remove();
    });
    /* A thread that is being rebuilt under the card takes it with it, and the question then
       sits unanswered with nothing on screen to answer. One docked above the composer is the
       floor: it is drawn whether or not the chat has a place to put it. */
    if (items.length && !document.querySelector(".askcard")) {
      var dock = document.getElementById("askdock");
      if (!dock) {
        dock = document.createElement("div");
        dock.id = "askdock";
        document.body.appendChild(dock);
      }
      items.forEach(function (it) {
        var d = document.createElement("div");
        d.innerHTML = cardHtml(it, "10:00");
        dock.appendChild(d.firstChild);
      });
      [].forEach.call(dock.querySelectorAll("[data-allow]"), function (b) {
        if (!b.__w) { b.__w = 1; b.addEventListener("click", function () { answer(b.getAttribute("data-allow"), "allow"); }); }
      });
      [].forEach.call(dock.querySelectorAll("[data-deny]"), function (b) {
        if (!b.__w) { b.__w = 1; b.addEventListener("click", function () { answer(b.getAttribute("data-deny"), "deny"); }); }
      });
    } else if (!items.length) {
      var old = document.getElementById("askdock");
      if (old) old.remove();
    }
    [].forEach.call(host.querySelectorAll("[data-allow]"), function (b) {
      if (!b.__w) { b.__w = 1; b.addEventListener("click", function () { answer(b.getAttribute("data-allow"), "allow"); }); }
    });
    [].forEach.call(host.querySelectorAll("[data-deny]"), function (b) {
      if (!b.__w) { b.__w = 1; b.addEventListener("click", function () { answer(b.getAttribute("data-deny"), "deny"); }); }
    });
  }

  var ASKED = {};

  function answer(id, verdict) {
    /* The answer travels to the question's own chat and turn, not to whatever the page happens to
       be showing. Sent with the page's current conversation it was refused as belonging to another
       chat, and the card then sat there as though the press had not happened. */
    var it = ASKED[id] || {};
    return api("/api/turn/answer", "POST",
      { id: id, conv: String(it.chat == null ? (CHAT || conv()) : it.chat),
        turn: String(it.turn == null ? "" : it.turn), allow: verdict === "allow" })
      .then(function () { delete ASKED[id]; return pollCards(); }).catch(function () {});
  }

  function pollCards() {
    /* Every waiting question, whatever chat asked it.
       A page that has just opened has no conversation name yet, so asking by chat alone hid the
       card of the very first turn, and that turn then waited out its two minutes for an answer
       nobody was ever shown. Both lists are merged, and a failed lookup on either side is simply
       an empty list rather than an error that stops the paint. */
    var c = CHAT || conv();
    var one = c ? api("/api/chat/" + c + "/pending").catch(function () { return {}; })
                : Promise.resolve({});
    var all = api("/api/pending").catch(function () { return {}; });
    return Promise.all([one, all]).then(function (rs) {
      var items = [], seen = {}, ttl = 120;
      rs.forEach(function (r) {
        var b = (r && r.body) || {};
        if (b.ttl) ttl = Number(b.ttl) || ttl;
        var list = b.pending || b.items || [];
        list.forEach(function (it) { if (it && it.id && !seen[it.id]) { seen[it.id] = 1; items.push(it); } });
      });
      items.forEach(function (it) {
        // The card counts the same window the machine will actually wait. It used to count ten
        // minutes against a question that was refused after two, so the timer told him he had time
        // he did not have.
        var left = Math.max(0, Math.round((it.asked || 0) + ttl - Date.now() / 1000));
        var el = document.querySelector('[data-left="' + it.id + '"]');
        if (el) { var m = Math.floor(left / 60), sec = left % 60; el.textContent = m + ":" + (sec < 10 ? "0" : "") + sec; }
      });
      ASKED = {};
      items.forEach(function (it) { ASKED[it.id] = it; });
      paintCards(items);
    }).catch(function () {});
  }

  function paintDrawer() {
    return api("/api/sessions").then(function (r) {
      var j = r.body || {};
      var list = j.sessions || j.chats || (Array.isArray(j) ? j : []);
      return Promise.all(list.map(function (s) {
        var id = String(s.id || s.conv || "");
        if (!id) return null;
        return api("/api/chat/" + id + "/pending").then(function (q) {
          var n = ((q.body && (q.body.pending || q.body.items)) || []).length;
          var row = document.querySelector('[data-id="' + id + '"]') ||
                    document.querySelector('[data-conv="' + id + '"]');
          if (!row) return null;
          var dot = row.querySelector(".drawerdot");
          if (n > 0 && !dot) {
            dot = document.createElement("span");
            dot.className = "drawerdot";
            dot.title = "needs your approval";
            row.appendChild(dot);
          } else if (n === 0 && dot) { dot.remove(); }
          return null;
        }).catch(function () { return null; });
      }));
    }).catch(function () {});
  }

  function wire() {
    var row = $("qtpermissions");
    if (row && !row.__wired) {
      row.__wired = true;
      row.addEventListener("click", function (ev) { ev.preventDefault(); toggle(); });
    }
    load();
  }

  // A chat opening is the moment the mode can differ, so the badge follows the chat, not the tab.
  function wrapOpen() {
    if (!window.__jarvisOpenSession || window.__jarvisOpenSession.__permWrapped) return;
    var inner = window.__jarvisOpenSession;
    var wrapped = function () {
      try { window.__jarvisCurrentConv = String(arguments[0] || ""); } catch (e) {}
      var out = inner.apply(this, arguments);
      setTimeout(load, 60);
      return out;
    };
    wrapped.__permWrapped = true;
    window.__jarvisOpenSession = wrapped;
  }

  document.addEventListener("DOMContentLoaded", function () {
    wrapOpen();
    wire();
    setInterval(function () { wrapOpen(); if (conv() !== CHAT) load(); }, 1500);
    setInterval(pollCards, 2000);
    setTimeout(paintDrawer, 1500);
    setInterval(paintDrawer, 12000);
  });
  window.addEventListener("load", function () { wrapOpen(); wire(); });
})();
