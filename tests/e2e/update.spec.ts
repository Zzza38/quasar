import { test, expect } from './fixtures';

test('force update removes stale app code and preserves device data and sign-in cookies', async ({ page, context }) => {
  await page.goto('/');
  await context.addCookies([{ name: 'update-test-cookie', value: 'preserve-me', domain: 'localhost', path: '/', httpOnly: true }]);
  await page.evaluate(async () => {
    await navigator.serviceWorker.register('/sw.js');
    const registration = await navigator.serviceWorker.ready;
    const worker = registration.active!;
    if (worker.state !== 'activated') await new Promise<void>(resolve => {
      const activated = () => {
        if (worker.state !== 'activated') return;
        worker.removeEventListener('statechange', activated);
        resolve();
      };
      worker.addEventListener('statechange', activated);
      activated();
    });
    localStorage.setItem('update-test-setting', 'preserve-me');
    for (const name of ['quasar-public-shell-old', 'whatsnext-public-shell-old', 'unrelated-cache']) {
      const cache = await caches.open(name);
      await cache.put('/update-test-asset', new Response('old code'));
    }
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open('update-test-work', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('work');
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;
        const transaction = db.transaction('work', 'readwrite');
        transaction.objectStore('work').put('preserve-me', 'draft');
        transaction.oncomplete = () => { db.close(); resolve(); };
        transaction.onerror = () => { db.close(); reject(transaction.error); };
      };
    });
  });
  const response = await page.request.get('/update');
  expect(response.headers()['cache-control']).toContain('no-store');
  expect(await response.text()).not.toContain('/_next/static/');
  expect(await page.evaluate(() => caches.keys())).toEqual(expect.arrayContaining(['quasar-public-shell-old', 'whatsnext-public-shell-old']));
  await page.goto('/update');
  await expect(page).toHaveURL(/\/today\?quasar-update=\d+/);
  await expect(page.locator('html[data-hydrated]')).toBeAttached();
  const result = await page.evaluate(async () => ({
    caches: await caches.keys(),
    setting: localStorage.getItem('update-test-setting'),
    draft: await new Promise<unknown>((resolve, reject) => {
      const request = indexedDB.open('update-test-work');
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;
        const read = db.transaction('work').objectStore('work').get('draft');
        read.onsuccess = () => { db.close(); resolve(read.result); };
        read.onerror = () => { db.close(); reject(read.error); };
      };
    }),
    registration: !!await navigator.serviceWorker.getRegistration('/'),
  }));
  expect(result.caches).not.toContain('quasar-public-shell-old');
  expect(result.caches).not.toContain('whatsnext-public-shell-old');
  expect(result.caches).toContain('unrelated-cache');
  expect(result).toMatchObject({ setting: 'preserve-me', draft: 'preserve-me', registration: true });
  expect(await context.cookies()).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'update-test-cookie', value: 'preserve-me' })]));
});
