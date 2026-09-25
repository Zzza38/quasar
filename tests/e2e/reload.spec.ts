import { test, expect, type BrowserContext, type Request } from '@playwright/test';
import { encode } from 'next-auth/jwt';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../../src/server/db';
import { Service } from '../../src/server/service';
import { exampleSchedule } from '../../src/domain/example';

function seed() {
  const db = openDatabase(process.env.E2E_DATABASE_PATH!);
  try {
    const id = randomUUID();
    db.prepare('INSERT INTO users(id,google_sub,email,display_name,full_name,created_at) VALUES(?,?,?,?,?,?)').run(id, id, `${id}@example.com`, 'Browser Student', 'Browser Test Student', new Date().toISOString());
    const service = new Service(db, 'browser-owner@example.com');
    const school = service.createSchool(id, { name: `Reload High ${id.slice(0, 6)}`, location: 'Boston, MA', schedule: exampleSchedule });
    service.join(id, { schoolId: school.id, choice: 'community', grade: '9' });
    return id;
  } finally { db.close(); }
}
async function authenticate(context: BrowserContext, id: string) {
  const token = await encode({ secret: process.env.E2E_AUTH_SECRET!, token: { userId: id }, maxAge: 3600 });
  await context.addCookies([{ name: 'next-auth.session-token', value: token, domain: 'localhost', path: '/', httpOnly: true, sameSite: 'Lax', expires: Date.now() / 1000 + 3600 }]);
}

test('a reload paints the saved workspace at once and refreshes in the background', async ({ page, context }) => {
  await authenticate(context, seed());
  await page.goto('/classes');
  await expect(page.getByRole('heading', { name: 'Classes', exact: true })).toBeVisible();
  // Hold every API request for 3 s so only the device cache can paint the screen. Only requests from the
  // reloaded document count: the page being replaced may still be firing its own (scan status, chat inbox),
  // and the reload cancels those, but their held handlers would otherwise still count them.
  let reloaded = false;
  const fromReloaded = new Set<Request>();
  page.on('framenavigated', (frame) => { if (frame === page.mainFrame()) reloaded = true; });
  let released = 0;
  await page.route('**/api/trpc/**', async (route) => {
    const counted = reloaded;
    if (counted) fromReloaded.add(route.request());
    await new Promise((resolve) => setTimeout(resolve, 3000));
    if (counted) released += 1;
    await route.continue().catch(() => {});
  });
  await page.reload();
  const heading = page.getByRole('heading', { name: 'Classes', exact: true });
  await expect(heading).toBeVisible({ timeout: 1500 });
  // The screen painted before any API request reached the server, so it came from the device cache.
  expect(released).toBe(0);
  // The background refresh then reloads the workspace itself (not just any request, such as scan status),
  // and the refreshed workspace replaces the cached one without blanking the screen.
  const procedures = (url: string) => decodeURIComponent(new URL(url).pathname.replace(/^\/api\/trpc\//, '')).split(',');
  const refresh = await page.waitForResponse((response) => fromReloaded.has(response.request()) && procedures(response.url()).includes('workspace'), { timeout: 8000 });
  expect(refresh.ok()).toBe(true);
  await refresh.finished();
  // Give the client a moment to apply the refreshed workspace before checking the screen still shows it.
  await page.waitForTimeout(500);
  await expect(heading).toBeVisible();
});

test('the first visit is rendered by the server: the landing page signed out, the workspace signed in, before any API reply', async ({ page, context }) => {
  // Signed out, the HTML itself carries the landing page (no client round trip decides it).
  const anonymous = await page.request.get('/');
  expect(anonymous.ok()).toBe(true);
  expect(await anonymous.text()).toContain('Continue with Google');
  await authenticate(context, seed());
  // Signed in, the HTML carries the workspace, and it is never cached by the browser.
  const signedIn = await context.request.get('/');
  expect(signedIn.headers()['cache-control']).toMatch(/no-store/);
  const html = await signedIn.text();
  expect(html).not.toContain('Continue with Google');
  expect(html).toContain('Reload High');
  // Held API replies cannot delay the paint: the screen comes from the server-rendered page on a device with no cache.
  let released = 0;
  await page.route('**/api/trpc/**', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    released += 1;
    await route.continue().catch(() => {});
  });
  await page.goto('/classes');
  await expect(page.getByRole('heading', { name: 'Classes', exact: true })).toBeVisible({ timeout: 1500 });
  expect(released).toBe(0);
});

test('the saved theme is applied before the first paint', async ({ page }) => {
  await page.addInitScript(() => { localStorage.setItem('quasar.appearance', 'dark'); });
  await page.goto('/', { waitUntil: 'commit' });
  await page.waitForLoadState('domcontentloaded');
  expect(await page.evaluate(() => document.documentElement.dataset.appearance)).toBe('dark');
});
