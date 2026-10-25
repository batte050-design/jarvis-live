/* Retired: this path used to hold the offline shell.
 *
 * A worker already installed on a phone keeps answering the page from its own cache, and an old
 * page cannot be relied on to ask for anything newer. So this file's only job now is to remove
 * that worker and everything it stored: install, clear, unregister, and let the page come from the
 * network. No caching, no offline copy, nothing to go stale.
 */
self.addEventListener("install", function () { self.skipWaiting(); });

self.addEventListener("activate", function (event) {
  event.waitUntil((async function () {
    try {
      var keys = await caches.keys();
      await Promise.all(keys.map(function (k) { return caches.delete(k); }));
    } catch (e) {}
    try { await self.registration.unregister(); } catch (e) {}
    try {
      var list = await self.clients.matchAll({ type: "window" });
      for (var i = 0; i < list.length; i++) {
        try { await list[i].navigate(list[i].url); } catch (e) {}
      }
    } catch (e) {}
  })());
});

self.addEventListener("fetch", function () { /* never answer from here */ });
