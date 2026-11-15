/* SYB's service worker — idea 53 (I-53.1).
 *
 * It does two things and nothing else:
 *   push               shows the few words the server sent, at once. Safari
 *                      revokes push permission from a site whose push shows
 *                      nothing (Apple's web push guide), and Chrome requires
 *                      userVisibleOnly, so every push becomes a notification.
 *   notificationclick  opens the proposal's card (/proposals/<id>), or the
 *                      queue for a grouped push.
 *
 * It has no fetch handler and caches nothing: the app's pages carry a
 * business's private numbers, and an offline cache on a phone is a copy of
 * them nobody asked for. The notification has no action buttons. It never
 * approves anything: the yes is given on the card, signed in, through the
 * same decision path as the queue (rule 12).
 */
"use strict";

var FALLBACK = { title: "ScaleX", body: "Something waits for your yes.", url: "/proposals" };
var CARD_PATH = /^\/proposals(\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?$/;

/* Only our own queue or one of its cards; anything else opens the queue. */
function safePath(raw) {
  try {
    var url = new URL(String(raw || ""), self.location.origin);
    if (url.origin !== self.location.origin || !CARD_PATH.test(url.pathname)) return "/proposals";
    return url.pathname;
  } catch (e) {
    return "/proposals";
  }
}

self.addEventListener("install", function () {
  self.skipWaiting();
});

self.addEventListener("activate", function (event) {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", function (event) {
  var shown = FALLBACK;
  var tag = "syb-waiting";
  try {
    var data = event.data ? event.data.json() : null;
    if (data && typeof data.title === "string" && typeof data.body === "string") {
      shown = { title: data.title, body: data.body, url: safePath(data.url) };
      if (typeof data.tag === "string" && data.tag !== "") tag = data.tag;
    }
  } catch (e) {
    /* an unreadable push still shows the fallback words */
  }
  event.waitUntil(
    self.registration.showNotification(shown.title, {
      body: shown.body,
      tag: tag,
      renotify: true,
      icon: "/icon/192",
      data: { url: shown.url },
    }),
  );
});

self.addEventListener("notificationclick", function (event) {
  event.notification.close();
  var path = safePath(event.notification.data && event.notification.data.url);
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(function (open) {
      for (var i = 0; i < open.length; i++) {
        var client = open[i];
        if (new URL(client.url).origin === self.location.origin && "navigate" in client) {
          return client
            .navigate(path)
            .then(function (c) {
              return (c || client).focus();
            })
            .catch(function () {
              return self.clients.openWindow(path);
            });
        }
      }
      return self.clients.openWindow(path);
    }),
  );
});
