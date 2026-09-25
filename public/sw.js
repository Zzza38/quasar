/* This cache contains public application code only. Private data lives in the
 * account-scoped IndexedDB store; API responses and authentication never enter it. */
const CACHE = "quasar-public-shell-v6";
const OFFLINE_SHELL = "/offline";
const SHELL_PATHS = new Set([OFFLINE_SHELL, "/admin", "/help"]);
// The app's views share one client app. The neutral offline shell restores the saved account without first
// painting the signed-out landing page.
const VIEW_PATHS = new Set(["/today", "/schedule", "/tasks", "/classes", "/school", "/people", "/messages"]);
const shellFor = (pathname) => (pathname === "/" || VIEW_PATHS.has(pathname) ? OFFLINE_SHELL : pathname);
// Public artwork under /brand is not content-hashed, so it is precached by name and served network first.
const BRAND_ASSETS = ["/brand/quasar-full.svg", "/brand/quasar-full-dark.svg"];

function publicShell(response, expectedPath) {
  if (!response.ok || response.redirected) return false;
  const finalUrl = new URL(response.url);
  return finalUrl.origin === self.location.origin && finalUrl.pathname === expectedPath &&
    (response.headers.get("content-type") || "").includes("text/html");
}

function shellAssets(html) {
  return new Set([...html.matchAll(/(?:src|href)="([^"]+)"/g)]
    .map((match) => new URL(match[1].replaceAll("&amp;", "&"), self.location.origin))
    .filter((url) => url.origin === self.location.origin && url.pathname.startsWith("/_next/static/"))
    .map((url) => url.href));
}

/** Resolves true when the stored shell references a different bundle set than before (a new deployment). */
async function refreshShell(path) {
  // Credentials are deliberately omitted: even a future authenticated server
  // page cannot accidentally be cached by visiting it while signed in.
  const response = await fetch(path, { credentials: "omit", cache: "reload" });
  if (!publicShell(response, path)) return false;
  const cache = await caches.open(CACHE);
  // Registration happens after the first page's scripts have loaded. Precache
  // its referenced bundles so the very first offline reload can boot too.
  const assets = shellAssets(await response.clone().text());
  await Promise.all([...assets].map(async (url) => {
    if (await cache.match(url)) return;
    const asset = await fetch(url, { credentials: "omit" });
    if (!asset.ok || asset.redirected) throw new Error("An application asset could not be saved");
    await cache.put(url, asset);
  }));
  const previous = await cache.match(path);
  const before = previous ? shellAssets(await previous.text()) : new Set();
  await cache.put(path, response);
  return before.size !== assets.size || [...assets].some((url) => !before.has(url));
}

/** Same-origin /_next/static/ files a stylesheet loads through url(), such as font subsets picked by unicode-range. */
function stylesheetAssets(css, base) {
  return [...css.matchAll(/url\(\s*(["']?)([^"')]+)\1\s*\)/g)]
    .map((match) => new URL(match[2].trim(), base))
    .filter((url) => url.origin === self.location.origin && url.pathname.startsWith("/_next/static/"))
    .map((url) => url.href);
}

/** Content-hashed bundles pile up with every deployment. Keep only those a saved shell still references,
 * directly or through one of its saved stylesheets (fonts are fetched lazily, so the HTML only names one). */
async function pruneStatic() {
  const cache = await caches.open(CACHE);
  const referenced = new Set();
  for (const path of SHELL_PATHS) {
    const shell = await cache.match(path);
    if (shell) for (const url of shellAssets(await shell.text())) referenced.add(url);
  }
  if (!referenced.size) return;
  for (const url of [...referenced]) {
    if (!new URL(url).pathname.endsWith(".css")) continue;
    const stylesheet = await cache.match(url);
    if (stylesheet) for (const asset of stylesheetAssets(await stylesheet.text(), url)) referenced.add(asset);
  }
  const keys = await cache.keys();
  await Promise.all(keys.filter((request) => {
    const url = new URL(request.url);
    return url.pathname.startsWith("/_next/static/") && !referenced.has(url.href);
  }).map((request) => cache.delete(request)));
}

/** The brand lockup on the offline "Connect to get started" notices, fetched ahead so they are not an empty box. */
async function refreshBrand() {
  const cache = await caches.open(CACHE);
  await Promise.all(BRAND_ASSETS.map(async (path) => {
    const asset = await fetch(path, { credentials: "omit", cache: "reload" });
    if (asset.ok && !asset.redirected) await cache.put(path, asset);
  }));
}

async function refreshShells() {
  // The artwork is best effort: a failure there never fails the install or offline preparation.
  const [results] = await Promise.all([Promise.allSettled([...SHELL_PATHS].map(refreshShell)), refreshBrand().catch(() => undefined)]);
  if (results.some((result) => result.status === "fulfilled" && result.value)) await pruneStatic().catch(() => undefined);
}

self.addEventListener("install", (event) => {
  event.waitUntil(refreshShells().then(() => self.skipWaiting()));
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
      if (event.data.type === "PREPARE_OFFLINE") await refreshShells();
      const cache = await caches.open(CACHE);
      event.ports[0]?.postMessage({ ready: !!await cache.match(OFFLINE_SHELL), adminReady: !!await cache.match("/admin") });
    } catch (error) {
      event.ports[0]?.postMessage({ ready: false, adminReady: false, error: error instanceof Error ? error.message : "Offline preparation failed" });
    }
  })());
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin) return;

  if (request.mode === "navigate" && (url.pathname === "/" || SHELL_PATHS.has(url.pathname) || VIEW_PATHS.has(url.pathname))) {
    event.respondWith((async () => {
      try {
        const response = await fetch(request);
        // Refresh with a separate anonymous request, never the signed-in HTML.
        if (response.ok && !response.redirected) event.waitUntil(refreshShell(shellFor(url.pathname)).then((changed) => changed && pruneStatic()).catch(() => undefined));
        return response;
      } catch {
        const cache = await caches.open(CACHE);
        return await cache.match(shellFor(url.pathname)) ?? await cache.match(OFFLINE_SHELL) ??
          new Response("Connect to the internet once to save Quasar for offline use.", {
            status: 503, headers: { "Content-Type": "text/plain; charset=utf-8" },
          });
      }
    })());
    return;
  }

  // Next's content-addressed bundles and the /brand artwork are public. Do not intercept RSC requests,
  // API routes, OAuth redirects, external resources, or arbitrary user content.
  // Network first so a fresh deployment (or a dev bundle that is not content-addressed)
  // never hydrates against stale JavaScript; the cached copy only serves offline.
  if (url.pathname.startsWith("/_next/static/") || url.pathname.startsWith("/brand/") || url.pathname === "/manifest.webmanifest" || url.pathname === "/icon.svg") {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);
      let response;
      try {
        response = await fetch(request);
      } catch (error) {
        const cached = await cache.match(request);
        if (cached) return cached;
        throw error;
      }
      // Saving a copy is best effort: a full storage quota must not turn a good response into a network error.
      if (response.ok && !response.redirected && response.type === "basic") event.waitUntil(cache.put(request, response.clone()).catch(() => undefined));
      else if (!response.ok) { const cached = await cache.match(request); if (cached) return cached; }
      return response;
    })());
  }
});

// Notification payloads carry no names, task content, message or request text: the shown text comes from this
// fixed table keyed by payload.kind. Anything unknown, including reminder payloads, shows the reminder text.
// A fixed `tag` ignores the payload's; otherwise the payload tag is used, or `fallbackTag` without one.
const REMINDER_NOTICE = { title: "Quasar reminder", body: "You have a task reminder. Open Quasar to view it.", url: "/tasks", fallbackTag: "quasar-reminder" };
const NOTICES = {
  chat: { title: "Quasar", body: "You have new messages. Open Quasar to read them.", url: "/messages", tag: "quasar-chat", renotify: true },
  // Sent to the owner's browsers only, when a new support item arrives.
  support: { title: "Quasar support", body: "A new support request is waiting. Open the support page to review it.", url: "/admin", fallbackTag: "quasar-support", renotify: true },
};
// Navigation stays on this origin and on these views only.
const OPEN_URLS = new Set(["/tasks", "/messages", "/admin"]);

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
    const path = typeof requested === "string" && OPEN_URLS.has(requested) ? requested : "/tasks";
    const target = new URL(path, self.location.origin).href;
    // Only a tab this worker controls can be navigated (navigate() rejects for one opened with a hard reload),
    // so uncontrolled tabs are not candidates. If driving the tab still fails, a new window opens instead.
    const windows = await self.clients.matchAll({ type: "window" });
    const existing = windows.find(client => new URL(client.url).origin === self.location.origin);
    if (existing) {
      try {
        await existing.focus();
        await existing.navigate(target);
        return;
      } catch { /* Falls through to a new window. */ }
    }
    await self.clients.openWindow(target);
  })());
});
