import { test, expect, hydrating } from './fixtures';
import type { BrowserContext, Page } from '@playwright/test';
import { encode } from 'next-auth/jwt';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { openDatabase } from '../../src/server/db';
import { createBeta, readBetaRegistry, writeBetaRegistry } from '../../src/server/beta-registry';
import { BetaService } from '../../src/server/betas';
import { Service } from '../../src/server/service';
import { SchoolLogoService } from '../../src/server/school-logos';
import sharp from 'sharp';
import { exampleSchedule } from '../../src/domain/example';

/**
 * A student in a ten-member school (so changes go through proposals), with four classes on the example rotation
 * and three closures on the calendar. `beta` joins the school-hub beta, the key the School redesign is gated on.
 */
function seed(beta: boolean, menu = false) {
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
    const members = [id];
    for (let index = 0; index < 9; index += 1) { const member = user(`Member ${index}`); members.push(member); service.join(member, { schoolId: school.id, choice: 'community', grade: '10' }); }
    // Every member is verified, so they can vote: the threshold is three.
    for (const member of members) db.prepare('INSERT INTO school_verifications(user_id,school_id,method,verified_at) VALUES(?,?,?,?)').run(member, school.id, 'support', new Date().toISOString());
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
    if (menu) {
      // The week of 2026-09-17, already in the server's cache so nothing reaches a menu site. Station names differ by
      // school, so the fixture has no "Entree": one station has no name, and one dish is long enough to wrap.
      const source = { org: 'hubhigh', domain: 'nutrislice.com', school: 'upper-school', menu: 'lunch', name: 'Upper School Lunch' };
      db.prepare('UPDATE schools SET menu_source=? WHERE id=?').run(JSON.stringify(source), school.id);
      const days = [
        { date: '2026-09-14', notes: [], sections: [{ title: 'Create', items: ['Orange Chicken', 'Brown Rice'] }, { title: 'Grill', items: ['Classic Hamburger'] }] },
        { date: '2026-09-15', notes: ['Picture day'], sections: [{ title: '', items: ['Chicken Nuggets', 'Dinner Roll', 'Fresh Apple'] }] },
        { date: '2026-09-17', notes: [], sections: [
          { title: 'Soup Kettle', items: ['Tomato Basil'] },
          { title: 'Global Kitchen', items: ['Korean BBQ Beef Bowl with Kimchi, Pickled Vegetables and Steamed Jasmine Rice', 'Vegetable Japchae'] },
          { title: 'Milk & Condiments', items: ['Low Fat Milk', 'Ketchup Packet', 'Ranch Dressing'] }] },
        { date: '2026-09-18', notes: ['Early dismissal'], sections: [] },
      ];
      db.prepare('INSERT INTO menu_weeks(school_id,week_start,source,days,fetched_at) VALUES(?,?,?,?,?)').run(school.id, '2026-09-13', JSON.stringify(source), JSON.stringify(days), new Date().toISOString());
    }
    if (beta) {
      // What `npm run beta -- create` writes, then the student joins with the code.
      const key = 'school-hub';
      const code = `HUB-${id.slice(0, 4)}`;
      const listPath = join(dirname(process.env.E2E_DATABASE_PATH!), 'betas.json');
      const registry = readBetaRegistry(listPath);
      writeBetaRegistry(createBeta({ ...registry, betas: registry.betas.filter((entry) => entry.key !== key) }, { key, name: 'New School page', code }), listPath);
      // The service in this process resolves the list beside DATABASE_PATH, like the server's.
      const previous = process.env.DATABASE_PATH;
      process.env.DATABASE_PATH = process.env.E2E_DATABASE_PATH;
      try { new BetaService(service).join(id, { code }); } finally { if (previous === undefined) delete process.env.DATABASE_PATH; else process.env.DATABASE_PATH = previous; }
    }
    return { id, name, members, schoolId: school.id };
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
  // The day's name starts on the same line as the timeline's times.
  const headingLeft = (await rotation.getByRole('heading', { level: 3 }).boundingBox())!.x;
  const timeLeft = (await rotation.getByRole('listitem').first().getByText('8:00 AM').boundingBox())!.x;
  expect(Math.abs(headingLeft - timeLeft)).toBeLessThanOrEqual(1);
  await page.screenshot({ path: testInfo.outputPath('rotation-desktop.png'), fullPage: true });

  await days.getByRole('radio', { name: /^Day 2, next/ }).click();
  await expect(rotation.getByRole('heading', { level: 3 })).toContainText('Day 2');
  await expect(rotation.getByRole('listitem')).toHaveText([/Chemistry/, /English 10/, /Lunch/, /US History/]);
  await expect(rotation.getByRole('button', { name: 'Adjust Day 2' })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('rotation-desktop-other-day.png') });

  // Closures on back-to-back school days read as one run.
  const comingUp = page.getByRole('region', { name: 'Coming up' });
  await expect(comingUp.getByRole('button')).toHaveText([/Mon, Oct 12.*No school/, /Nov 26 – Nov 27.*No school/]);

  // The shared schedule's chips skip what every member knows: that there is a lunch, and the school's time zone.
  const shared = page.getByRole('region', { name: 'Shared schedule' });
  await expect(shared).toContainText('10-day rotation');
  await expect(shared).toContainText('4 class periods');
  await expect(shared).toContainText('3 exceptions');
  await expect(shared).not.toContainText('Lunch');
  await expect(shared).not.toContainText('Eastern Time');

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

test('a member proposes a school logo and the school votes it in; support can force a vote and revert a logo', async ({ page, context, browser }, testInfo) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1280, height: 900 });
  const { id, name, members, schoolId } = seed(true);
  await open(page, context, id, '/school?section=logo');
  const card = page.getByRole('region', { name: 'School logo' });
  const header = page.locator('header').filter({ has: page.getByRole('heading', { name, level: 1 }) });
  // Until there is a logo the school shows its initials on a shield, and its status sits on one line.
  await expect(card).toContainText('No logo yet');
  await expect(header.locator('svg text')).toHaveText('HH');
  await expect(header.locator('img')).toHaveCount(0);
  const status = header.getByRole('listitem');
  await expect(status).toHaveText(['Not reviewed', 'Locked at 10 members']);
  const tops = await status.evaluateAll((items) => items.map((item) => Math.round(item.getBoundingClientRect().top)));
  expect(new Set(tops).size).toBe(1);
  await header.screenshot({ path: testInfo.outputPath('card-initials.png') });

  // A wide picture is fitted inside a square, not cropped, and the proposer's vote counts.
  const picture = await sharp({ create: { width: 640, height: 360, channels: 4, background: { r: 196, g: 30, b: 58, alpha: 1 } } }).png().toBuffer();
  await card.locator('input[type="file"]').setInputFiles({ name: 'crest.png', mimeType: 'image/png', buffer: picture });
  const proposal = card.getByRole('listitem').filter({ hasText: 'Your proposal' });
  await expect(proposal).toContainText('1 for, 0 against · passes at 3');
  await expect(proposal.getByRole('button', { name: 'For' })).toHaveAttribute('aria-pressed', 'true');
  const shown = await proposal.getByRole('img', { name: 'Proposed logo' }).evaluate((image: HTMLImageElement) => [image.naturalWidth, image.naturalHeight]);
  expect(shown).toEqual([256, 256]);
  await card.screenshot({ path: testInfo.outputPath('logo-voting.png') });

  // Two classmates vote for it. Passing the vote publishes the logo; nobody approves it first.
  const db = openDatabase(process.env.E2E_DATABASE_PATH!);
  const ownerId = randomUUID();
  const rival = { mime: 'image/png' as const, data: (await sharp({ create: { width: 64, height: 64, channels: 4, background: { r: 20, g: 90, b: 200, alpha: 1 } } }).png().toBuffer()).toString('base64') };
  try {
    const service = new Service(db, 'browser-owner@example.com');
    const logos = new SchoolLogoService(service);
    const proposalId = logos.list(id).proposals[0].id;
    for (const member of members.slice(1, 3)) logos.vote(member, { proposalId, vote: 'for' });
    // A second logo goes up for a vote afterwards, for support to force.
    logos.propose(members[3], { schoolId, ...rival });
    db.prepare('INSERT INTO users(id,google_sub,email,display_name,full_name,created_at) VALUES(?,?,?,?,?,?)').run(ownerId, ownerId, 'browser-owner@example.com', 'Logo Owner', 'Logo Test Owner', new Date().toISOString());
  } finally { db.close(); }
  await page.reload();
  await expect(header.locator('img')).toHaveAttribute('src', `/api/school-logos/${schoolId}?v=1`);
  await expect(header.locator('svg text')).toHaveCount(0);
  await expect(card).toContainText('The school’s logo');
  await expect(proposal).toHaveCount(0);
  const response = await page.request.get(`/api/school-logos/${schoolId}?v=1`);
  expect(response.status()).toBe(200);
  expect(response.headers()['content-type']).toBe('image/png');
  // A member has no staff controls.
  for (const label of ['Force win', 'Force loss', 'Revert last change', 'Set as support']) await expect(card.getByRole('button', { name: label })).toHaveCount(0);
  await header.screenshot({ path: testInfo.outputPath('card-logo.png') });
  await page.screenshot({ path: testInfo.outputPath('logo-published.png'), fullPage: true });

  // Support forces the second vote to lose from the /admin inbox.
  const support = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const token = await encode({ secret: process.env.E2E_AUTH_SECRET!, token: { userId: ownerId, authAt: Date.now() }, maxAge: 3600 });
  await support.addCookies([{ name: 'next-auth.session-token', value: token, domain: 'localhost', path: '/', httpOnly: true, sameSite: 'Lax', expires: Date.now() / 1000 + 3600 }]);
  const admin = hydrating(await support.newPage());
  await admin.goto('/admin');
  const queue = admin.getByRole('region', { name: 'School logo votes' });
  await expect(queue).toContainText('1 for, 0 against, passes at 3');
  await queue.getByRole('button', { name: `Force the logo for ${name} to lose` }).click();
  await expect(queue).toContainText('No open votes');

  // In the school's review sheet support reverts the published logo, and the school shows its initials again.
  await admin.getByRole('tab', { name: 'Schools', exact: true }).click();
  await admin.getByRole('textbox', { name: 'Filter schools', exact: true }).fill(name);
  await admin.getByRole('button', { name: `Review ${name}`, exact: true }).click();
  const sheet = admin.getByRole('dialog', { name: `Review ${name}` });
  const votes = sheet.getByRole('list', { name: 'Logo votes' }).getByRole('listitem');
  await expect(votes).toHaveCount(2);
  await expect(votes.filter({ hasText: 'Stopped by support' })).toHaveCount(1);
  await sheet.getByRole('button', { name: 'Revert last change' }).click();
  await expect(votes.filter({ hasText: 'Reverted by support' })).toHaveCount(1);
  await expect(sheet.getByRole('button', { name: 'Revert last change' })).toHaveCount(0);
  await admin.screenshot({ path: testInfo.outputPath('admin-logo-reverted.png') });
  await page.reload();
  await expect(header.locator('svg text')).toHaveText('HH');
  await expect(card).toContainText('No logo yet');

  // Support then forces the vote that lost to win: its logo shows, at a new address.
  await votes.filter({ hasText: 'Stopped by support' }).getByRole('button', { name: 'Force win' }).click();
  await expect(votes.filter({ hasText: 'Published by support' })).toHaveCount(1);
  await support.close();
  await page.reload();
  await expect(header.locator('img')).toHaveAttribute('src', `/api/school-logos/${schoolId}?v=3`);
  await card.getByRole('button', { name: /earlier logos \(2\)/ }).click();
  await expect(card).toContainText('Published by support');
  await expect(card).toContainText('Reverted by support');
  await card.screenshot({ path: testInfo.outputPath('logo-history.png') });
});

for (const width of [1280, 390]) {
  test(`the redesigned lunch menu is a week of rows that open into a menu card at ${width}px`, async ({ page, context }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    const { id } = seed(true, true);
    await open(page, context, id, '/school?section=lunch');
    const card = page.getByRole('region', { name: 'Lunch menu' });
    await expect(card).toContainText('Upper School Lunch');
    // The section list names today's lunch by its main course: "Global Kitchen" here, not the soup listed first.
    if (width === 1280) {
      const row = page.getByRole('navigation', { name: 'School sections' }).getByRole('button', { name: /^Lunch menu/ });
      await expect(row).toContainText('Korean BBQ Beef Bowl');
      await expect(row).not.toContainText('Tomato Basil');
    }
    const days = card.locator('ul').first().locator(':scope > li');
    await expect(days).toHaveCount(5);

    // Today starts open: each station is a heading with its dishes listed under it, whatever the school calls it.
    const thursday = days.nth(3);
    await expect(thursday.getByRole('button', { name: /Thursday/ })).toHaveAttribute('aria-expanded', 'true');
    await expect(thursday).toContainText('Today');
    await expect(thursday).toContainText('3 stations · 6 dishes');
    await expect(thursday.getByRole('heading', { level: 3 })).toHaveText(['Soup Kettle', 'Global Kitchen', 'Milk & Condiments']);
    await expect(thursday.getByRole('region', { name: 'Global Kitchen' }).getByRole('listitem')).toHaveText(['Korean BBQ Beef Bowl with Kimchi, Pickled Vegetables and Steamed Jasmine Rice', 'Vegetable Japchae']);

    // A closed day previews one dish from each station; a note rides along with the count.
    const monday = days.nth(0);
    await expect(monday.getByRole('button')).toHaveAttribute('aria-expanded', 'false');
    await expect(monday).toContainText('Orange Chicken · Classic Hamburger');
    await expect(monday).toContainText('2 stations · 3 dishes');
    await expect(days.nth(1)).toContainText('Picture day · 1 station · 3 dishes');
    // A day with only a note, and a day with nothing, do not open.
    await expect(days.nth(2)).toContainText('No menu posted.');
    await expect(days.nth(2).getByRole('button')).toHaveCount(0);
    await expect(days.nth(4)).toContainText('Early dismissal');
    await expect(days.nth(4).getByRole('button')).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    await page.screenshot({ path: testInfo.outputPath(`lunch-${width}.png`), fullPage: true });

    // Opening another day closes the first; a station with no name lists its dishes without a heading.
    await days.nth(1).getByRole('button').click();
    await expect(thursday.getByRole('button')).toHaveAttribute('aria-expanded', 'false');
    // The preview leads with the main course, not the soup the menu site lists first.
    await expect(thursday).toContainText('Korean BBQ Beef Bowl with Kimchi, Pickled Vegetables and Steamed Jasmine Rice · Tomato Basil · Low Fat Milk');
    await expect(days.nth(1).getByRole('heading', { level: 3 })).toHaveCount(0);
    await expect(days.nth(1)).toContainText('Picture day');
    await expect(days.nth(1).getByRole('listitem')).toHaveText(['Chicken Nuggets', 'Dinner Roll', 'Fresh Apple']);
    await page.screenshot({ path: testInfo.outputPath(`lunch-${width}-unnamed.png`), fullPage: true });
    await days.nth(1).getByRole('button').click();
    await expect(days.nth(1).getByRole('button')).toHaveAttribute('aria-expanded', 'false');
  });
}

test('without the beta the School page keeps its single column of cards', async ({ page, context }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const { id, name } = seed(false);
  await open(page, context, id);
  await expect(page.getByRole('heading', { name, level: 1 })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'School sections' })).toHaveCount(0);
  for (const title of ['How this schedule is managed', 'Your schedule source', 'Shared schedule', 'Rotation', 'Lunch menu', 'Proposed changes', 'School class directory', 'Request a correction'])
    await expect(page.getByRole('region', { name: title })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Rotation' }).locator('button[aria-expanded]')).toHaveCount(10);
  await expect(page.getByRole('region', { name: 'Shared schedule' })).toContainText('Eastern Time');
});
