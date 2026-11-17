import { test, expect, hydrating } from './fixtures';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import { encode } from 'next-auth/jwt';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { openDatabase } from '../../src/server/db';
import { createBeta, readBetaRegistry, writeBetaRegistry } from '../../src/server/beta-registry';
import { BetaService } from '../../src/server/betas';
import { Service } from '../../src/server/service';
import { exampleSchedule } from '../../src/domain/example';

const KEY = 'classes-board';

/** A student with six classes, four of them on the example timetable. `beta` joins them to the classes-board beta. */
function seed({ beta }: { beta: boolean }) {
  const db = openDatabase(process.env.E2E_DATABASE_PATH!);
  try {
    const service = new Service(db, 'browser-owner@example.com');
    const id = randomUUID();
    db.prepare('INSERT INTO users(id,google_sub,email,display_name,full_name,created_at) VALUES(?,?,?,?,?,?)').run(id, id, `${randomUUID()}@example.com`, 'Maya', 'Maya Tester', new Date().toISOString());
    const school = service.createSchool(id, { name: `Board High ${id.slice(0, 6)}`, location: 'Boston, MA', schedule: exampleSchedule });
    service.join(id, { schoolId: school.id, choice: 'community', grade: '10' });
    const result = service.sync(id, { mutationId: randomUUID(), id: 'personal', kind: 'personal', base: service.entity(id, 'personal'), data: {
      grade: '10', cycleDayOverrides: [], dateOverrides: [], customSchedule: null,
      classes: [
        { id: 'alg2', name: 'Algebra II', room: '204', teacher: 'Ms. Rivera', color: '#2563eb' },
        { id: 'chem', name: 'Chemistry', room: 'Lab 3', teacher: 'Dr. Okafor', color: '#16a34a' },
        { id: 'eng10', name: 'English 10', room: '112', teacher: 'Mr. Hale', color: '#db2777' },
        { id: 'ushist', name: 'US History', room: '305', teacher: 'Mrs. Lin', color: '#d97706' },
        { id: 'cs', name: 'Introduction to Computer Science and Programming', room: '118', teacher: 'Mr. Patel', color: '#dc2626' },
        { id: 'jazz', name: 'Jazz Ensemble' },
      ],
      assignments: { A: 'alg2', B: 'chem', C: 'eng10', D: 'ushist' },
    } } as never);
    if (result.status !== 'applied') throw new Error(`The personal schedule was not saved: ${JSON.stringify(result)}`);
    if (beta) {
      // What `npm run beta -- create classes-board --public` writes; the student then joins it with a tap.
      const listPath = join(dirname(process.env.E2E_DATABASE_PATH!), 'betas.json');
      const registry = readBetaRegistry(listPath);
      if (!registry.betas.some((entry) => entry.key === KEY)) writeBetaRegistry(createBeta(registry, { key: KEY, name: 'Classes board', public: true }), listPath);
      // The service in this process resolves the list beside DATABASE_PATH, like the server's.
      const previous = process.env.DATABASE_PATH;
      process.env.DATABASE_PATH = process.env.E2E_DATABASE_PATH;
      try { new BetaService(service).enroll(id, { key: KEY }); } finally { if (previous === undefined) delete process.env.DATABASE_PATH; else process.env.DATABASE_PATH = previous; }
    }
    return id;
  } finally { db.close(); }
}

const contexts: BrowserContext[] = [];
test.afterEach(async () => { await Promise.all(contexts.splice(0).map((context) => context.close())); });
async function signedIn(browser: Browser, id: string, phone = false): Promise<Page> {
  // The phone runs in the dark theme, so both themes get drawn.
  const context = await browser.newContext(phone ? { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, colorScheme: 'dark' } : { viewport: { width: 1280, height: 900 } });
  contexts.push(context);
  const token = await encode({ secret: process.env.E2E_AUTH_SECRET!, token: { userId: id, authAt: Date.now() }, maxAge: 3600 });
  await context.addCookies([{ name: 'next-auth.session-token', value: token, domain: 'localhost', path: '/', httpOnly: true, sameSite: 'Lax', expires: Date.now() / 1000 + 3600 }]);
  return hydrating(await context.newPage());
}

async function unlock(page: Page) {
  await page.getByRole('button', { name: 'Unlock schedule', exact: true }).click();
  await page.getByRole('dialog', { name: 'Unlock schedule?' }).getByRole('button', { name: 'Unlock schedule' }).click();
  await expect(page.getByRole('button', { name: 'Lock schedule', exact: true })).toBeVisible();
}

test('classes board: the classes are a list beside one week of the timetable, a class is found, edited in place and placed from the list', async ({ browser }, info) => {
  test.setTimeout(120_000);
  const page = await signedIn(browser, seed({ beta: true }));
  await page.goto('/classes');
  const list = page.getByRole('list', { name: 'Your classes' });
  await expect(list.getByRole('listitem')).toHaveCount(6);
  // The cards, the lock panel and the second palette are gone: each class is listed once.
  await expect(page.getByRole('heading', { name: 'Your class timetable' })).toHaveCount(0);
  await expect(page.getByRole('group', { name: 'Available periods' })).toHaveCount(0);
  await expect(list.getByRole('listitem').filter({ hasText: 'Jazz Ensemble' }).getByText('Not placed')).toBeVisible();
  await expect(list.getByRole('listitem').filter({ hasText: 'Algebra II' }).getByText(/^\d+ of 10$/)).toBeVisible();

  // One week shows at a time; the week maps switch it.
  const weeks = page.getByRole('radiogroup', { name: 'Rotation week' });
  await expect(weeks.getByRole('radio')).toHaveCount(2);
  await expect(weeks.getByRole('radio', { name: /^Week 1/ })).toBeChecked();
  await expect(page.getByRole('region', { name: 'Rotation week 1' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Rotation week 2' })).toHaveCount(0);
  // Lunch is at the same time all week, so it is one band rather than five blocks.
  const band = page.locator('.time-band-fill');
  await expect(band).toHaveCount(1);
  await expect(band).toContainText('Lunch');
  const column = (await page.getByRole('group', { name: 'Day 1 time canvas' }).boundingBox())!;
  expect((await band.boundingBox())!.width).toBeGreaterThan(column.width * 4.5);
  await weeks.getByRole('radio', { name: /^Week 2/ }).click();
  await expect(page.getByRole('region', { name: 'Rotation week 2' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Rotation week 1' })).toHaveCount(0);
  await weeks.getByRole('radio', { name: /^Week 1/ }).click();

  // Locked: tapping a class lights its blocks, and nothing can be dragged or cleared.
  await expect(page.locator('.time-block-lit')).toHaveCount(0);
  await list.getByRole('button', { name: /^Find Chemistry/ }).click();
  await expect(page.locator('.time-block-lit').first()).toContainText('Chemistry');
  await expect(page.locator('.board-note')).toContainText('Chemistry');
  await expect(page.locator('.time-block-clear').first()).toBeHidden();
  await page.screenshot({ path: info.outputPath('board-locked.png'), fullPage: true });

  // A class opens in the list, not in a dialog.
  await unlock(page);
  await list.getByRole('button', { name: 'Edit US History' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const row = list.getByRole('listitem').filter({ hasText: 'US History' });
  await expect(row.getByLabel('Class name')).toHaveValue('US History');
  await page.screenshot({ path: info.outputPath('board-edit.png'), fullPage: true });
  await row.getByLabel('Room (optional)').fill('Annex 2');
  await row.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(row.getByLabel('Class name')).toHaveCount(0);
  await expect(row).toContainText('Annex 2');

  // Placing from the list: tap the class, then the block.
  await list.getByRole('button', { name: /^Place Jazz Ensemble/ }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Jazz Ensemble selected' })).toBeVisible();
  await page.screenshot({ path: info.outputPath('board-place.png'), fullPage: true });
  await page.getByRole('button', { name: /^Day 1, .*: Algebra II$/ }).first().click();
  await expect(page.getByRole('status').filter({ hasText: 'Jazz Ensemble replaced Algebra II' })).toBeVisible();
  await expect(list.getByRole('listitem').filter({ hasText: 'Jazz Ensemble' }).getByText('Not placed')).toHaveCount(0);
  await expect(list.getByRole('listitem').filter({ hasText: 'Algebra II' }).getByText('Not placed')).toBeVisible();

  // It survives a reload, and adding a class still uses the dialog.
  await page.reload();
  await expect(list.getByRole('listitem').filter({ hasText: 'US History' })).toContainText('Annex 2');
  await page.getByRole('button', { name: 'Add class', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Add a class' })).toBeVisible();
});

test('classes board: on a phone the timetable comes first and the classes to place ride along as chips', async ({ browser }, info) => {
  test.setTimeout(120_000);
  const page = await signedIn(browser, seed({ beta: true }), true);
  await page.goto('/classes');
  const list = page.getByRole('list', { name: 'Your classes' });
  const week = page.getByRole('region', { name: 'Rotation week 1' });
  await expect(week).toBeVisible();
  expect((await week.boundingBox())!.y).toBeLessThan((await list.boundingBox())!.y);
  await expect(page.getByRole('group', { name: 'Available periods' })).toHaveCount(0);
  await page.screenshot({ path: info.outputPath('board-phone-locked.png'), fullPage: true });
  await unlock(page);
  const chips = page.getByRole('group', { name: 'Available periods' });
  await expect(chips.getByRole('button', { name: 'Place Chemistry' })).toBeVisible();
  await chips.getByRole('button', { name: 'Place Chemistry' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Chemistry selected' })).toBeVisible();
  await page.screenshot({ path: info.outputPath('board-phone-place.png'), fullPage: true });
  // Nothing spills past the screen.
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
});

test('classes board: a student outside the beta keeps the class cards and the stacked timetable', async ({ browser }) => {
  const page = await signedIn(browser, seed({ beta: false }));
  await page.goto('/classes');
  await expect(page.getByRole('heading', { name: 'Your class timetable' })).toBeVisible();
  await expect(page.getByRole('radiogroup', { name: 'Rotation week' })).toHaveCount(0);
  await expect(page.locator('.time-band-fill')).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Rotation week 2' })).toBeVisible();
});
