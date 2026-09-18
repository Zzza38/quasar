import { test, expect, type BrowserContext } from '@playwright/test';
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
  await page.goto('/#classes');
  await expect(page.getByRole('heading', { name: 'Classes', exact: true })).toBeVisible();
  // Hold every API response so only the device cache can paint the screen.
  await page.route('**/api/trpc/**', async (route) => { await new Promise((resolve) => setTimeout(resolve, 3000)); await route.continue(); });
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Classes', exact: true })).toBeVisible({ timeout: 1500 });
  await expect(page.getByText('Opening your schedule')).toHaveCount(0);
});

test('the saved theme is applied before the first paint', async ({ page }) => {
  await page.addInitScript(() => { localStorage.setItem('quasar.appearance', 'dark'); });
  await page.goto('/', { waitUntil: 'commit' });
  await page.waitForLoadState('domcontentloaded');
  expect(await page.evaluate(() => document.documentElement.dataset.appearance)).toBe('dark');
});
