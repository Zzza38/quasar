import { test, expect } from './fixtures';
import type { BrowserContext, Page } from '@playwright/test';
import { encode } from 'next-auth/jwt';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { openDatabase } from '../../src/server/db';
import { createBeta, readBetaRegistry, writeBetaRegistry } from '../../src/server/beta-registry';
import { BetaService } from '../../src/server/betas';
import { Service } from '../../src/server/service';
import { exampleSchedule } from '../../src/domain/example';

/**
 * A student in a ten-member school (so changes go through proposals), with four classes on the example rotation
 * and three closures on the calendar. `beta` joins the school-redesign beta.
 */
function seed(beta: boolean) {
  const db = openDatabase(process.env.E2E_DATABASE_PATH!);
  try {
    const service = new Service(db, 'browser-owner@example.com');
    const user = (name: string) => {
      const id = randomUUID();
      db.prepare('INSERT INTO users(id,google_sub,email,display_name,full_name,created_at) VALUES(?,?,?,?,?,?)').run(id, id, `${randomUUID()}@example.com`, name, `${name} Tester`, new Date().toISOString());
      return id;
    };
    const id = user('Maya');
    const closure = (date: string) => ({ date, kind: 'closure' as const, advanceCycle: false });
    const name = `Hub High ${id.slice(0, 6)}`;
    const school = service.createSchool(id, { name, location: 'Boston, MA', schedule: { ...exampleSchedule, exceptions: [closure('2026-10-12'), closure('2026-11-26'), closure('2026-11-27')] } });
    service.join(id, { schoolId: school.id, choice: 'community', grade: '10' });
    for (let index = 0; index < 9; index += 1) service.join(user(`Member ${index}`), { schoolId: school.id, choice: 'community', grade: '10' });
    // Through sync, so the saved revision is one the client may build on (a raw UPDATE leaves the history stale).
    const saved = service.sync(id, { mutationId: randomUUID(), id: 'personal', kind: 'personal', base: service.entity(id, 'personal'), data: {
      classes: [
        { id: 'alg2', name: 'Algebra II', room: '204', teacher: 'Ms. Rivera', color: '#2563eb' },
        { id: 'chem', name: 'Chemistry', room: 'Lab 3', teacher: 'Dr. Okafor', color: '#16a34a' },
        { id: 'eng10', name: 'English 10', room: '112', teacher: 'Mr. Hale', color: '#db2777' },
        { id: 'ushist', name: 'US History', room: '305', teacher: 'Mrs. Lin', color: '#d97706' },
      ],
      assignments: { A: 'alg2', B: 'chem', C: 'eng10', D: 'ushist' }, cycleDayOverrides: [], dateOverrides: [], customSchedule: null, grade: '10',
    } } as never);
    if (saved.status !== 'applied') throw new Error(`The classes were not saved: ${JSON.stringify(saved)}`);
    if (beta) {
      // What `npm run beta -- create` writes, then the student joins with the code.
      const key = 'school-redesign';
      const code = `HUB-${id.slice(0, 4)}`;
      const listPath = join(dirname(process.env.E2E_DATABASE_PATH!), 'betas.json');
      const registry = readBetaRegistry(listPath);
      writeBetaRegistry(createBeta({ ...registry, betas: registry.betas.filter((entry) => entry.key !== key) }, { key, name: 'New School page', code }), listPath);
      // The service in this process resolves the list beside DATABASE_PATH, like the server's.
      const previous = process.env.DATABASE_PATH;
      process.env.DATABASE_PATH = process.env.E2E_DATABASE_PATH;
      try { new BetaService(service).join(id, { code }); } finally { if (previous === undefined) delete process.env.DATABASE_PATH; else process.env.DATABASE_PATH = previous; }
    }
    return { id, name };
  } finally { db.close(); }
}

async function open(page: Page, context: BrowserContext, id: string, path = '/school') {
  const token = await encode({ secret: process.env.E2E_AUTH_SECRET!, token: { userId: id, authAt: Date.now() }, maxAge: 3600 });
  await context.addCookies([{ name: 'next-auth.session-token', value: token, domain: 'localhost', path: '/', httpOnly: true, sameSite: 'Lax', expires: Date.now() / 1000 + 3600 }]);
  await context.addInitScript(() => { try { localStorage.setItem('quasar.appearance', 'dark'); } catch { /* ignore */ } });
  // Thursday 2026-09-17, 8:51 AM in the school's zone: Day 8 of the example rotation.
  await page.clock.setFixedTime(new Date('2026-09-17T12:51:37Z'));
  await page.goto(path);
}

test('the redesigned School page shows one section beside the school card, and the rotation as a Today-style timeline', async ({ page, context }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const { id, name } = seed(true);
  await open(page, context, id);
  await expect(page.getByRole('heading', { name, level: 1 })).toBeVisible();
  const menu = page.getByRole('navigation', { name: 'School sections' });
  await expect(menu.getByRole('button', { name: /^Rotation/ })).toHaveAttribute('aria-current', 'page');
  await expect(menu.getByRole('button', { name: /^Rotation/ })).toContainText('Day 8 today');

  // The rotation opens on today's cycle day; its periods are the Today timeline's rows, with no "now" row.
  const rotation = page.getByRole('region', { name: 'Rotation' });
  const days = rotation.getByRole('radiogroup', { name: 'Day of the rotation' });
  await expect(days.getByRole('radio', { name: 'Day 8, next Today' })).toBeChecked();
  await expect(rotation.getByRole('heading', { level: 3 })).toContainText('Day 8');
  await expect(rotation.getByRole('listitem')).toHaveText([/8:00 AM.*9:00 AM.*US History.*D · Room 305 · Mrs\. Lin/, /9:10 AM.*Algebra II/, /10:15 AM.*Lunch/, /10:50 AM.*Chemistry/]);
  await expect(rotation.getByText('Now', { exact: true })).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('rotation-desktop.png'), fullPage: true });

  await days.getByRole('radio', { name: /^Day 2, next/ }).click();
  await expect(rotation.getByRole('heading', { level: 3 })).toContainText('Day 2');
  await expect(rotation.getByRole('listitem')).toHaveText([/Chemistry/, /English 10/, /Lunch/, /US History/]);
  await expect(rotation.getByRole('button', { name: 'Adjust Day 2' })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('rotation-desktop-other-day.png') });

  // Closures on back-to-back school days read as one run.
  const comingUp = page.getByRole('region', { name: 'Coming up' });
  await expect(comingUp.getByRole('button')).toHaveText([/Mon, Oct 12.*No school/, /Nov 26 – Nov 27.*No school/]);

  // Choosing a section swaps the right side and is kept in the address.
  await menu.getByRole('button', { name: /^Lunch menu/ }).click();
  await expect(page.getByRole('region', { name: 'Lunch menu' })).toBeVisible();
  await expect(rotation).toHaveCount(0);
  await expect(page).toHaveURL(/section=lunch/);
  await menu.getByRole('button', { name: /^Proposed changes/ }).click();
  await expect(page.getByRole('region', { name: 'Proposed changes' })).toBeVisible();
  await menu.getByRole('button', { name: /^Your setup/ }).click();
  await expect(page.getByRole('region', { name: 'Your schedule source' })).toBeVisible();
  await page.goBack();
  await expect(page.getByRole('region', { name: 'Proposed changes' })).toBeVisible();

  // Today's "Full week" link lands on the lunch section.
  await page.goto('/school?menu=open');
  await expect(page.getByRole('region', { name: 'Lunch menu' })).toBeVisible();
  await expect(page).toHaveURL(/section=lunch/);
});

test('on a phone the redesigned School page is a list that opens one section at a time', async ({ page, context }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const { id, name } = seed(true);
  await open(page, context, id);
  const menu = page.getByRole('navigation', { name: 'School sections' });
  await expect(page.getByRole('heading', { name, level: 1 })).toBeVisible();
  await expect(menu).toBeVisible();
  await expect(page.getByRole('region', { name: 'Rotation' })).toBeHidden();
  await page.screenshot({ path: testInfo.outputPath('list-phone.png'), fullPage: true });

  await menu.getByRole('button', { name: /^Rotation/ }).click();
  const rotation = page.getByRole('region', { name: 'Rotation' });
  await expect(rotation).toBeVisible();
  await expect(menu).toBeHidden();
  await expect(rotation.getByRole('listitem')).toHaveCount(4);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: testInfo.outputPath('rotation-phone.png'), fullPage: true });

  await page.getByRole('button', { name: 'School', exact: true }).click();
  await expect(menu).toBeVisible();
  await expect(rotation).toBeHidden();
});

test('without the beta the School page keeps its single column of cards', async ({ page, context }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const { id, name } = seed(false);
  await open(page, context, id);
  await expect(page.getByRole('heading', { name, level: 1 })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'School sections' })).toHaveCount(0);
  for (const title of ['How this schedule is managed', 'Your schedule source', 'Shared schedule', 'Rotation', 'Lunch menu', 'Proposed changes', 'School class directory', 'Request a correction'])
    await expect(page.getByRole('region', { name: title })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Rotation' }).locator('button[aria-expanded]')).toHaveCount(10);
});
