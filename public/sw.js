/* This cache contains public application code only. Private data lives in the
 * account-scoped IndexedDB store; API responses and authentication never enter it. */
const CACHE = "whatsnext-public-shell-v3";
const SHELL_PATHS = new Set(["/", "/admin"]);

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
    await Promise.all(names.filter((name) => name.startsWith("whatsnext-public-shell-") && name !== CACHE)
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
  if (url.pathname.startsWith("/_next/static/") || url.pathname === "/manifest.webmanifest" || url.pathname === "/icon.svg") {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);
      const cached = await cache.match(request);
      if (cached) return cached;
      const response = await fetch(request);
      if (response.ok && !response.redirected && response.type === "basic") await cache.put(request, response.clone());
      return response;
    })());
  }
});

// Notification payloads contain no task content. Navigation stays on this origin.
self.addEventListener("push", (event) => {
  let payload = {};
  try { payload = event.data?.json() || {}; } catch { /* Show a generic reminder. */ }
  event.waitUntil(self.registration.showNotification("Quasar reminder", {
    body: "You have a task reminder. Open Quasar to view it.",
    icon: "/icon.svg", badge: "/icon.svg",
    tag: typeof payload.tag === "string" ? payload.tag.slice(0, 200) : "quasar-reminder",
    data: { url: "/#tasks" },
  }));
});
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const target = new URL("/#tasks", self.location.origin).href;
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const existing = windows.find(client => new URL(client.url).origin === self.location.origin);
    if (existing) {
      await existing.navigate(target);
      await existing.focus();
    } else await self.clients.openWindow(target);
  })());
});
