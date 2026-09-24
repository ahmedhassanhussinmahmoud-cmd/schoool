// sw.js — Service Worker (نسخة v4)
const CACHE_VERSION = "school-shell-v4";

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
    caches.open(CACHE_VERSION).then((cache) => {
      // تخزين كل ملف على حدة — إذا فشل واحد لا يفشل الباقي
      return Promise.all(
        APP_SHELL.map((url) =>
          cache.add(url).catch((err) => {
            console.warn("[SW] Failed to cache:", url, err.message);
          })
        )
      );
    }).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => k !== CACHE_VERSION)
          .map((k) => {
            console.log("[SW] Deleting old cache:", k);
            return caches.delete(k);
          })
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;

  // تجاهل الطلبات غير GET
  if (req.method !== "GET") return;

  const url = new URL(req.url);

  // تجاوز مخططات غير مدعومة (file://, chrome-extension:// إلخ)
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return;
  }

  // لا نخزّن طلبات Supabase API
  if (url.hostname.includes("supabase.co")) {
    return;
  }

  // لا نخزّن ملفات Storage
  if (url.pathname.includes("/storage/v1/object/")) {
    return;
  }

  // صفحات التنقل → Network First ثم Cache
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE_VERSION).then((c) => c.put(req, copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match("./index.html"))
    );
    return;
  }

  // موارد ثابتة → Cache First
  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req)
        .then((res) => {
          if (res.ok && url.origin === location.origin) {
            const copy = res.clone();
            caches.open(CACHE_VERSION).then((c) => c.put(req, copy)).catch(() => {});
          }
          return res;
        })
        .catch(() => cached);
    })
  );
});

/* ===== Push Notifications ===== */
self.addEventListener("push", (event) => {
  let data = { title: "تنبيه", body: "", url: "/" };
  try {
    data = event.data?.json() || data;
  } catch (_) {}

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
  const targetUrl = event.notification.data?.url || "/";
  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if (c.url.includes(location.origin) && "focus" in c) {
          return c.navigate(targetUrl).then(() => c.focus());
        }
      }
      if (clients.openWindow) return clients.openWindow(targetUrl);
    })
  );
});

/* ===== رسائل من الصفحة الرئيسية ===== */
self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});