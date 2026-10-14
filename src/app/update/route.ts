export const dynamic = 'force-dynamic';

// This recovery page deliberately has no application bundles. It can run even
// when an older offline shell references JavaScript from a previous deployment.
export function GET() {
  return new Response(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Updating Quasar</title>
<style>body{font:16px system-ui,sans-serif;background:#0b0d12;color:#f4f5f9;max-width:32rem;margin:15vh auto;padding:24px}a{color:#67d8ec}</style></head>
<body><h1>Updating Quasar</h1><p id="status">Fetching the latest app. Your account and saved work stay on this device.</p><noscript><p>Enable JavaScript, then reload this page.</p></noscript>
<script>
(async () => {
  try {
    if ('caches' in window) {
      const names = await caches.keys();
      await Promise.all(names.filter(name => name.startsWith('quasar-public-shell-') || name.startsWith('whatsnext-public-shell-')).map(name => caches.delete(name)));
    }
    if ('serviceWorker' in navigator) {
      // Keep the registration and push subscription; check for fresh worker code.
      await Promise.race([
        navigator.serviceWorker.getRegistration('/').then(registration => registration?.update()).catch(() => {}),
        new Promise(resolve => setTimeout(resolve, 5000))
      ]);
    }
  } catch {
    // Browsers may restrict cache access. A new document request still bypasses
    // the old page and its in-memory router cache.
  }
  location.replace('/today?quasar-update=' + Date.now());
})();
</script></body></html>`, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store, max-age=0',
    },
  });
}
