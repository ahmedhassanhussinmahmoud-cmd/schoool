// sw.js — Service Worker
const CACHE_VERSION = "school-shell-v3";
const APP_SHELL = [
  "./",
  "./index.html",
  "./style.css",
  "./app.js",
  "./db.js",
  "./auth.js",
  "./sync.js",
  "./supabase.js",
  "./manifest.json"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then(cache => cache.addAll(APP_SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.filter(k => k !== CACHE_VERSION).map(k => caches.delete(k))
    )).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  if (url.hostname.includes("supabase.co")) return;
  if (url.pathname.includes("/storage/v1/object/")) return;

  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req).then(res => {
        const copy = res.clone();
        caches.open(CACHE_VERSION).then(c => c.put(req, copy));
        return res;
      }).catch(() => caches.match("./index.html"))
    );
    return;
  }

  event.respondWith(
    caches.match(req).then(cached => {
      if (cached) return cached;
      return fetch(req).then(res => {
        if (res.ok && url.origin === location.origin) {
          const copy = res.clone();
          caches.open(CACHE_VERSION).then(c => c.put(req, copy));
        }
        return res;
      }).catch(() => cached);
    })
  );
});

// Push notifications
self.addEventListener("push", (event) => {
  let data = { title: "تنبيه", body: "", url: "/" };
  try { data = event.data?.json() || data; } catch (_) {}
  event.waitUntil(
    self.registration.showNotification(data.title || "تنبيه", {
      body: data.body || "",
      icon: data.icon || "/icon-192.png",
      badge: data.badge || "/icon-192.png",
      dir: "rtl",
      lang: "ar",
      data: { url: data.url || "/" }
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = event.notification.data?.url || "/";
  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if (c.url.includes(location.origin) && "focus" in c) {
          return c.navigate(url).then(() => c.focus());
        }
      }
      if (clients.openWindow) return clients.openWindow(url);
    })
  );
});