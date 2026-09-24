/* This cache contains public application code only. Private data lives in the
 * account-scoped IndexedDB store; API responses and authentication never enter it. */
const CACHE = "quasar-public-shell-v5";
const SHELL_PATHS = new Set(["/", "/admin", "/help"]);

function publicShell(response, expectedPath) {
  if (!response.ok || response.redirected) return false;
  const finalUrl = new URL(response.url);
  return finalUrl.origin === self.location.origin && finalUrl.pathname === expectedPath &&
    (response.headers.get("content-type") || "").includes("text/html");
}

async function refreshShell(path) {
  // Credentials are deliberately omitted: even a future authenticated server
  // page cannot accidentally be cached by visiting it while signed in.
  const response = await fetch(path, { credentials: "omit", cache: "reload" });
  if (!publicShell(response, path)) return;
  const cache = await caches.open(CACHE);
  // Registration happens after the first page's scripts have loaded. Precache
  // its referenced bundles so the very first offline reload can boot too.
  const html = await response.clone().text();
  const assets = new Set([...html.matchAll(/(?:src|href)="([^"]+)"/g)]
    .map((match) => new URL(match[1].replaceAll("&amp;", "&"), self.location.origin))
    .filter((url) => url.origin === self.location.origin && url.pathname.startsWith("/_next/static/"))
    .map((url) => url.href));
  await Promise.all([...assets].map(async (url) => {
    if (await cache.match(url)) return;
    const asset = await fetch(url, { credentials: "omit" });
    if (!asset.ok || asset.redirected) throw new Error("An application asset could not be saved");
    await cache.put(url, asset);
  }));
  await cache.put(path, response);
}

self.addEventListener("install", (event) => {
  event.waitUntil(Promise.allSettled([...SHELL_PATHS].map(refreshShell)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    // Remove obsolete public shells from before the Quasar rebrand as well.
    await Promise.all(names.filter((name) => (name.startsWith("quasar-public-shell-") || name.startsWith("whatsnext-public-shell-")) && name !== CACHE)
      .map((name) => caches.delete(name)));
    await self.clients.claim();
  })());
});

self.addEventListener("message", (event) => {
  if (event.data?.type !== "OFFLINE_STATUS" && event.data?.type !== "PREPARE_OFFLINE") return;
  event.waitUntil((async () => {
    try {
      if (event.data.type === "PREPARE_OFFLINE") await Promise.allSettled([...SHELL_PATHS].map(refreshShell));
      const cache = await caches.open(CACHE);
      event.ports[0]?.postMessage({ ready: !!await cache.match("/"), adminReady: !!await cache.match("/admin") });
    } catch (error) {
      event.ports[0]?.postMessage({ ready: false, adminReady: false, error: error instanceof Error ? error.message : "Offline preparation failed" });
    }
  })());
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin) return;

  if (request.mode === "navigate" && SHELL_PATHS.has(url.pathname)) {
    event.respondWith((async () => {
      try {
        const response = await fetch(request);
        // Refresh with a separate anonymous request, never the signed-in HTML.
        if (response.ok && !response.redirected) event.waitUntil(refreshShell(url.pathname).catch(() => undefined));
        return response;
      } catch {
        const cache = await caches.open(CACHE);
        return await cache.match(url.pathname) ?? await cache.match("/") ??
          new Response("Connect to the internet once to save Quasar for offline use.", {
            status: 503, headers: { "Content-Type": "text/plain; charset=utf-8" },
          });
      }
    })());
    return;
  }

  // Next's content-addressed bundles are public. Do not intercept RSC requests,
  // API routes, OAuth redirects, external resources, or arbitrary user content.
  // Network first so a fresh deployment (or a dev bundle that is not content-addressed)
  // never hydrates against stale JavaScript; the cached copy only serves offline.
  if (url.pathname.startsWith("/_next/static/") || url.pathname === "/manifest.webmanifest" || url.pathname === "/icon.svg") {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);
      try {
        const response = await fetch(request);
        if (response.ok && !response.redirected && response.type === "basic") await cache.put(request, response.clone());
        else if (!response.ok) { const cached = await cache.match(request); if (cached) return cached; }
        return response;
      } catch (error) {
        const cached = await cache.match(request);
        if (cached) return cached;
        throw error;
      }
    })());
  }
});

// Notification payloads carry no names, task content, message or request text: the shown text comes from this
// fixed table keyed by payload.kind. Anything unknown, including reminder payloads, shows the reminder text.
// A fixed `tag` ignores the payload's; otherwise the payload tag is used, or `fallbackTag` without one.
const REMINDER_NOTICE = { title: "Quasar reminder", body: "You have a task reminder. Open Quasar to view it.", url: "/#tasks", fallbackTag: "quasar-reminder" };
const NOTICES = {
  chat: { title: "Quasar", body: "You have new messages. Open Quasar to read them.", url: "/#messages", tag: "quasar-chat", renotify: true },
  // Sent to the owner's browsers only, when a new support item arrives.
  support: { title: "Quasar support", body: "A new support request is waiting. Open the support page to review it.", url: "/admin", fallbackTag: "quasar-support", renotify: true },
};
// Navigation stays on this origin and on these views only.
const OPEN_URLS = new Set(["/#tasks", "/#messages", "/admin"]);

self.addEventListener("push", (event) => {
  let payload = {};
  try { payload = event.data?.json() || {}; } catch { /* Show a generic reminder. */ }
  const kind = payload && typeof payload.kind === "string" && Object.prototype.hasOwnProperty.call(NOTICES, payload.kind) ? payload.kind : null;
  const notice = kind ? NOTICES[kind] : REMINDER_NOTICE;
  const shown = self.registration.showNotification(notice.title, {
    body: notice.body,
    icon: "/icon.svg", badge: "/icon.svg",
    tag: notice.tag || (payload && typeof payload.tag === "string" && payload.tag ? payload.tag.slice(0, 200) : notice.fallbackTag),
    // A chat or support push replacing an older one still alerts (chat pushes are capped at one per 10 minutes).
    ...(notice.renotify ? { renotify: true } : {}),
    data: { url: notice.url },
  });
  // Open tabs refresh the Messages badge (and any visible chat) at once instead of waiting for their next poll.
  const told = kind === "chat"
    ? self.clients.matchAll({ type: "window" }).then((windows) => { for (const client of windows) client.postMessage({ type: "CHAT_ACTIVITY" }); }).catch(() => undefined)
    : Promise.resolve();
  event.waitUntil(Promise.all([shown, told]));
});
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const requested = event.notification.data?.url;
    const path = typeof requested === "string" && OPEN_URLS.has(requested) ? requested : "/#tasks";
    const target = new URL(path, self.location.origin).href;
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const existing = windows.find(client => new URL(client.url).origin === self.location.origin);
    if (existing) {
      await existing.navigate(target);
      await existing.focus();
    } else await self.clients.openWindow(target);
  })());
});
