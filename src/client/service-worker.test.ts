import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

const ORIGIN = "https://quasar.example";
const source = readFileSync(new URL("../../public/sw.js", import.meta.url), "utf8");
const address = (value: string | { url: string }) => new URL(typeof value === "string" ? value : value.url, ORIGIN).href;
function response(body: string, path: string, options: { redirected?: boolean; html?: boolean; status?: number } = {}) {
  const result = new Response(body, { status: options.status ?? 200, headers: { "content-type": options.html ? "text/html" : "text/javascript" } });
  Object.defineProperties(result, { url: { value: address(path) }, redirected: { value: options.redirected ?? false }, type: { value: "basic" } });
  return result;
}

function worker() {
  const cache = new Map<string, Response>();
  const events = new Map<string, (event: any) => void>();
  const requests: Array<{ path: string; credentials?: string }> = [];
  const notifications: Array<{ title: string; options: any }> = [];
  const opened: string[] = [];
  const posted: Array<{ client: string; message: unknown }> = [];
  const navigated: string[] = [];
  // An uncontrolled tab (opened with a hard reload) is only listed with includeUncontrolled, and cannot be navigated.
  let windows: Array<{ url: string; controlled: boolean }> = [];
  const focused: string[] = [];
  let navigationFails = false;
  const deletedCaches: string[] = [];
  let offline = false;
  let anonymousRedirect = false;
  let brokenBundle = false;
  let brokenBrand = false;
  let personalizedNavigation = false;
  let fullStorage = false;
  let bundle = "app";
  const fetch = async (request: string | { url: string }, options?: { credentials?: string }) => {
    if (offline) throw new TypeError("Failed to fetch");
    const path = new URL(address(request)).pathname;
    requests.push({ path, credentials: options?.credentials });
    // Like Next's CSS, each stylesheet names its font subsets with url(); the browser fetches them lazily.
    const stylesheet = /^\/_next\/static\/([^/]+)\.css$/.exec(path);
    if (stylesheet && !brokenBundle) return response(`@font-face{src:url(/_next/static/media/${stylesheet[1]}-ext.woff2)}@font-face{src:url("media/${stylesheet[1]}-cyrillic.woff2")}`, path);
    if (path.startsWith("/_next/static/")) return response("app bundle", path, { status: brokenBundle ? 503 : 200 });
    if (anonymousRedirect && options?.credentials === "omit") return response("Sign in", "/api/auth/signin", { redirected: true, html: true });
    if (path.startsWith("/brand/")) return response(`<svg>${path}</svg>`, path, { status: brokenBrand ? 503 : 200 });
    if (personalizedNavigation && !options) return response("PRIVATE ACCOUNT DATA", path, { html: true });
    return response(`<html>Public shell<script src="/_next/static/${bundle}.js"></script><link href="/_next/static/${bundle}.css" rel="stylesheet"></html>`, path, { html: true });
  };
  runInNewContext(source, {
    URL, Response, fetch,
    caches: {
      open: async () => ({
        match: async (key: string | { url: string }) => cache.get(address(key))?.clone(),
        put: async (key: string | { url: string }, value: Response) => {
          if (fullStorage) throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
          cache.set(address(key), value.clone());
        },
        keys: async () => [...cache.keys()].map((url) => ({ url })),
        delete: async (key: string | { url: string }) => cache.delete(address(key)),
      }),
      keys: async () => ["whatsnext-public-shell-v3", "quasar-public-shell-v2", "quasar-public-shell-v3", "quasar-public-shell-v4", "quasar-public-shell-v5", "quasar-public-shell-v6", "unrelated-cache"],
      delete: async (name: string) => { deletedCaches.push(name); return true; },
    },
    self: {
      location: { origin: ORIGIN },
      addEventListener: (type: string, handler: (event: any) => void) => { events.set(type, handler); },
      registration: { showNotification: async (title: string, options: any) => { notifications.push({ title, options }); } },
      skipWaiting: async () => undefined, clients: {
        claim: async () => undefined,
        matchAll: async (options?: { includeUncontrolled?: boolean }) => windows.filter((client) => client.controlled || options?.includeUncontrolled).map((client) => ({
          url: client.url,
          postMessage: (message: unknown) => { posted.push({ client: client.url, message }); },
          navigate: async (url: string) => {
            if (!client.controlled || navigationFails) throw new TypeError("This service worker is not the client's active service worker.");
            navigated.push(url);
          },
          focus: async () => { focused.push(client.url); },
        })),
        openWindow: async (url: string) => { opened.push(url); },
      },
    },
  });
  async function dispatch(type: string, properties: Record<string, unknown> = {}) {
    const pending: Promise<unknown>[] = [];
    let result: Promise<Response> | undefined;
    events.get(type)!({
      ...properties,
      waitUntil: (promise: Promise<unknown>) => { pending.push(promise); },
      respondWith: (promise: Promise<Response>) => { result = promise; },
    });
    const resolved = await result;
    await Promise.all(pending);
    return resolved;
  }
  return {
    cache, requests, dispatch, notifications, opened, deletedCaches, posted, navigated, focused,
    openTabs: (...urls: string[]) => { windows = urls.map((url) => ({ url: address(url), controlled: true })); },
    openUncontrolledTab: (url: string) => { windows.unshift({ url: address(url), controlled: false }); },
    failNavigation: () => { navigationFails = true; },
    push: (payload: unknown) => dispatch("push", { data: { json: () => payload } }),
    click: (url: unknown) => dispatch("notificationclick", { notification: { data: { url }, close: () => undefined } }),
    offline: () => { offline = true; },
    redirect: () => { anonymousRedirect = true; },
    breakBundle: () => { brokenBundle = true; },
    breakBrand: () => { brokenBrand = true; },
    personalize: () => { personalizedNavigation = true; },
    fillStorage: () => { fullStorage = true; },
    deploy: (name: string) => { bundle = name; },
    navigate: (path: string) => dispatch("fetch", { request: { method: "GET", url: address(path), mode: "navigate" } }),
    fetch: (path: string) => dispatch("fetch", { request: { method: "GET", url: address(path), mode: "cors" } }),
  };
}

describe("public offline service worker", () => {
  it("cleans up pre-rebrand and outdated shells while preserving current and unrelated caches", async () => {
    const sw = worker();
    await sw.dispatch("activate");
    expect(sw.deletedCaches).toEqual(["whatsnext-public-shell-v3", "quasar-public-shell-v2", "quasar-public-shell-v3", "quasar-public-shell-v4", "quasar-public-shell-v5"]);
  });

  it("precaches the brand lockup so offline notices do not show an empty box", async () => {
    const sw = worker();
    await sw.dispatch("install");
    expect(sw.requests).toContainEqual({ path: "/brand/quasar-full.svg", credentials: "omit" });
    expect(sw.requests).toContainEqual({ path: "/brand/quasar-full-dark.svg", credentials: "omit" });
    sw.offline();
    expect(await (await sw.fetch("/brand/quasar-full.svg"))?.text()).toBe("<svg>/brand/quasar-full.svg</svg>");
    expect(await (await sw.fetch("/brand/quasar-full-dark.svg"))?.text()).toBe("<svg>/brand/quasar-full-dark.svg</svg>");
  });

  it("still installs the shell when the brand artwork cannot be fetched", async () => {
    const sw = worker();
    sw.breakBrand();
    await sw.dispatch("install");
    expect(sw.cache.has(address("/brand/quasar-full.svg"))).toBe(false);
    expect(sw.cache.has(address("/offline"))).toBe(true);
  });

  it("prepares the shell and bundles for the first offline reload", async () => {
    const sw = worker();
    await sw.dispatch("install");
    expect(sw.requests).toContainEqual({ path: "/offline", credentials: "omit" });
    expect(sw.requests).not.toContainEqual({ path: "/", credentials: "omit" });
    expect(sw.requests).toContainEqual({ path: "/help", credentials: "omit" });
    expect(sw.cache.has(address("/_next/static/app.js"))).toBe(true);
    expect(sw.cache.has(address("/_next/static/app.css"))).toBe(true);
    sw.offline();
    expect(await (await sw.navigate("/"))?.text()).toContain("Public shell");
    expect(await (await sw.navigate("/admin"))?.text()).toContain("Public shell");
    expect(await (await sw.navigate("/help"))?.text()).toContain("Public shell");
    // The views live at their own paths but are one app: the neutral shell opens any of them offline.
    expect(await (await sw.navigate("/tasks"))?.text()).toContain("Public shell");
    expect(await (await sw.navigate("/messages"))?.text()).toContain("Public shell");
  });

  it("serves fresh bundles from the network and falls back to the cache offline", async () => {
    const sw = worker();
    await sw.dispatch("install");
    const stale = new Response("stale bundle", { headers: { "content-type": "text/javascript" } });
    sw.cache.set(address("/_next/static/app.js"), stale);
    expect(await (await sw.fetch("/_next/static/app.js"))?.text()).toBe("app bundle");
    sw.offline();
    expect(await (await sw.fetch("/_next/static/app.js"))?.text()).toBe("app bundle");
  });

  it("still serves a fetched bundle when saving the copy fails", async () => {
    const sw = worker();
    sw.fillStorage();
    const fetched = await sw.fetch("/_next/static/new-deploy.js");
    expect(fetched?.status).toBe(200);
    expect(await fetched?.text()).toBe("app bundle");
    expect(sw.cache.has(address("/_next/static/new-deploy.js"))).toBe(false);
  });

  it("drops bundles no saved shell references after a new deployment", async () => {
    const sw = worker();
    await sw.dispatch("install");
    sw.deploy("next");
    await sw.navigate("/");
    expect(sw.cache.has(address("/_next/static/next.js"))).toBe(true);
    // The /admin and /help shells still reference the previous bundles, so they stay available offline.
    expect(sw.cache.has(address("/_next/static/app.js"))).toBe(true);
    await sw.dispatch("message", { data: { type: "PREPARE_OFFLINE" }, ports: [] });
    expect([...sw.cache.keys()].filter((key) => key.includes("/_next/static/")).sort())
      .toEqual([address("/_next/static/next.css"), address("/_next/static/next.js")]);
    sw.offline();
    expect(await (await sw.navigate("/help"))?.text()).toContain("next.js");
  });

  it("keeps font subsets a saved stylesheet still uses when pruning after a deployment", async () => {
    const sw = worker();
    await sw.dispatch("install");
    // The browser loaded two lazily picked subsets of the current stylesheet, plus a file nothing uses anymore.
    await sw.fetch("/_next/static/media/app-ext.woff2");
    await sw.fetch("/_next/static/media/app-cyrillic.woff2");
    await sw.fetch("/_next/static/media/retired.woff2");
    sw.deploy("next");
    await sw.navigate("/");
    // /admin and /help still use app.css, so its fonts stay available offline.
    expect(sw.cache.has(address("/_next/static/media/app-ext.woff2"))).toBe(true);
    expect(sw.cache.has(address("/_next/static/media/app-cyrillic.woff2"))).toBe(true);
    expect(sw.cache.has(address("/_next/static/media/retired.woff2"))).toBe(false);
    await sw.dispatch("message", { data: { type: "PREPARE_OFFLINE" }, ports: [] });
    // Once no saved shell uses app.css, its fonts go with it.
    expect(sw.cache.has(address("/_next/static/media/app-ext.woff2"))).toBe(false);
    expect(sw.cache.has(address("/_next/static/media/app-cyrillic.woff2"))).toBe(false);
  });

  it("never caches authenticated HTML, authentication redirects, or API responses", async () => {
    const sw = worker();
    await sw.dispatch("install");
    sw.personalize();
    expect(await (await sw.navigate("/"))?.text()).toBe("PRIVATE ACCOUNT DATA");
    expect(await sw.cache.get(address("/offline"))?.clone().text()).toContain("Public shell");
    expect(await sw.navigate("/api/auth/signin")).toBeUndefined();
    expect(await sw.dispatch("fetch", { request: { method: "GET", url: address("/api/trpc/workspace"), mode: "cors" } })).toBeUndefined();
    expect(await sw.dispatch("fetch", { request: { method: "GET", url: address("/?_rsc=private"), mode: "cors" } })).toBeUndefined();
    const redirected = worker();
    redirected.redirect();
    await redirected.dispatch("install");
    expect(redirected.cache.size).toBe(0);
  });

  it("does not claim offline readiness when a necessary bundle cannot be cached", async () => {
    const sw = worker();
    sw.breakBundle();
    await sw.dispatch("install");
    let status: unknown;
    await sw.dispatch("message", { data: { type: "OFFLINE_STATUS" }, ports: [{ postMessage: (value: unknown) => { status = value; } }] });
    expect(status).toEqual({ ready: false, adminReady: false });
    expect(sw.cache.has(address("/offline"))).toBe(false);
    sw.offline();
    expect((await sw.navigate("/"))?.status).toBe(503);
  });
});


describe("push notifications", () => {
  it("shows a generic reminder without exposing payload content", async () => {
    const sw = worker();
    await sw.dispatch("push", { data: { json: () => ({ title: "Private title", body: "Private task", tag: "task-1", url: "https://evil.example" }) } });
    expect(sw.notifications[0].title).toBe("Quasar reminder");
    expect(sw.notifications[0].options.body).not.toContain("Private");
    expect(sw.notifications[0].options.data.url).toBe("/tasks");
    expect(sw.notifications[0].options.tag).toBe("task-1");
  });
  it("handles malformed payloads and only opens the local tasks view", async () => {
    const sw = worker();
    await sw.dispatch("push", { data: { json: () => { throw new Error("bad payload"); } } });
    expect(sw.notifications).toHaveLength(1);
    let closed = false;
    await sw.dispatch("notificationclick", { notification: { data: { url: "https://evil.example" }, close: () => { closed = true; } } });
    expect(closed).toBe(true);
    expect(sw.opened).toEqual([ORIGIN + "/tasks"]);
  });
  it("shows fixed chat text with no names or messages, and tells open tabs to refresh", async () => {
    const sw = worker();
    sw.openTabs("/", "/messages?with=abc");
    await sw.push({ kind: "chat", tag: "attacker-tag", title: "Bob", body: "ZX-SECRET-42", url: "https://evil.example" });
    expect(sw.notifications).toHaveLength(1);
    const [shown] = sw.notifications;
    expect(shown.title).toBe("Quasar");
    expect(shown.options.body).toBe("You have new messages. Open Quasar to read them.");
    expect(shown.options.tag).toBe("quasar-chat");
    expect(shown.options.renotify).toBe(true);
    expect(shown.options.data).toEqual({ url: "/messages" });
    expect(JSON.stringify(shown)).not.toMatch(/Bob|ZX-SECRET-42|evil/);
    expect(sw.posted).toEqual([
      { client: ORIGIN + "/", message: { type: "CHAT_ACTIVITY" } },
      { client: ORIGIN + "/messages?with=abc", message: { type: "CHAT_ACTIVITY" } },
    ]);
  });
  it("shows fixed support text with no request content, opens the support page, and posts no chat activity", async () => {
    const sw = worker();
    sw.openTabs("/");
    await sw.push({ kind: "support", tag: "quasar-support", url: "/admin" });
    await sw.push({ kind: "support", title: "Report about Bob", body: "ZX-SECRET-42", url: "https://evil.example" });
    expect(sw.notifications).toHaveLength(2);
    for (const shown of sw.notifications) {
      expect(shown.title).toBe("Quasar support");
      expect(shown.options.body).toBe("A new support request is waiting. Open the support page to review it.");
      expect(shown.options.tag).toBe("quasar-support");
      expect(shown.options.renotify).toBe(true);
      expect(shown.options.data).toEqual({ url: "/admin" });
    }
    expect(JSON.stringify(sw.notifications)).not.toMatch(/Bob|ZX-SECRET-42|evil/);
    expect(sw.posted).toEqual([]);
    await sw.click(sw.notifications[0].options.data.url);
    expect(sw.navigated).toEqual([ORIGIN + "/admin"]);
  });
  it("falls back to the reminder text for unknown kinds and never posts chat activity for reminders", async () => {
    const sw = worker();
    sw.openTabs("/");
    await sw.push({ kind: "toString", tag: "task-2" });
    await sw.push({ kind: "reminder", tag: "task-3" });
    await sw.push(null);
    expect(sw.notifications.map((entry) => entry.title)).toEqual(["Quasar reminder", "Quasar reminder", "Quasar reminder"]);
    expect(sw.notifications.map((entry) => entry.options.data.url)).toEqual(["/tasks", "/tasks", "/tasks"]);
    expect(sw.notifications.map((entry) => entry.options.tag)).toEqual(["task-2", "task-3", "quasar-reminder"]);
    expect(sw.notifications.every((entry) => entry.options.renotify === undefined)).toBe(true);
    expect(sw.posted).toEqual([]);
  });
  it("opens only the allowed views when a notification is clicked", async () => {
    const sw = worker();
    await sw.click("/messages");
    await sw.click("/tasks");
    await sw.click("/admin");
    await sw.click("/messages?with=abc");
    await sw.click("/admin/../api/trpc");
    await sw.click("javascript:alert(1)");
    await sw.click(undefined);
    expect(sw.opened).toEqual([ORIGIN + "/messages", ORIGIN + "/tasks", ORIGIN + "/admin", ORIGIN + "/tasks", ORIGIN + "/tasks", ORIGIN + "/tasks", ORIGIN + "/tasks"]);
    const open = worker();
    open.openTabs("/");
    await open.click("/messages");
    expect(open.navigated).toEqual([ORIGIN + "/messages"]);
    expect(open.opened).toEqual([]);
  });
  it("opens the app from a notification even when the open tab cannot be navigated", async () => {
    // A hard-reloaded tab is not controlled by the worker, so it is never picked over a controlled one.
    const mixed = worker();
    mixed.openTabs("/");
    mixed.openUncontrolledTab("/schedule");
    await mixed.click("/messages");
    expect(mixed.navigated).toEqual([ORIGIN + "/messages"]);
    expect(mixed.focused).toEqual([ORIGIN + "/"]);
    expect(mixed.opened).toEqual([]);
    // With only an uncontrolled tab, a new window opens at the target.
    const uncontrolled = worker();
    uncontrolled.openUncontrolledTab("/");
    await uncontrolled.click("/tasks");
    expect(uncontrolled.navigated).toEqual([]);
    expect(uncontrolled.opened).toEqual([ORIGIN + "/tasks"]);
    // A controlled tab whose navigation still fails also falls back to a new window.
    const failing = worker();
    failing.openTabs("/");
    failing.failNavigation();
    await failing.click("/messages");
    expect(failing.opened).toEqual([ORIGIN + "/messages"]);
  });
});
