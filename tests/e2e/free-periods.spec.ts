import { declineFreePeriods, test, expect } from './fixtures';
import type { BrowserContext, Locator } from '@playwright/test';
import { encode } from 'next-auth/jwt';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../../src/server/db';
import { CommunityService } from '../../src/server/community';
import { Service } from '../../src/server/service';
import { exampleSchedule } from '../../src/domain/example';
import { personalScheduleSchema, type StudentClass } from '../../src/domain/schedule';

async function choose(select: Locator, option: string) {
  await select.click();
  await select.page().getByRole('option', { name: option, exact: true }).click();
}

/**
 * Zed and Ian share Digital Design in period A on Tuesday 2026-09-08. Ian has nothing in B; Zed has nothing in B
 * either. The browser clock is fixed before school.
 */
function seed() {
  const db = openDatabase(process.env.E2E_DATABASE_PATH!);
  try {
    const service = new Service(db, 'browser-owner@example.com');
    const user = (name: string) => {
      const id = randomUUID();
      db.prepare('INSERT INTO users(id,google_sub,email,display_name,full_name,created_at) VALUES(?,?,?,?,?,?)').run(id, id, `${randomUUID()}@example.com`, name, `${name} Tester`, new Date().toISOString());
      return id;
    };
    const me = user('Zed'), ian = user('Ian');
    const school = service.createSchool(me, { name: `Free High ${me.slice(0, 6)}`, location: 'Boston, MA', schedule: exampleSchedule });
    for (const id of [me, ian]) service.join(id, { schoolId: school.id, choice: 'community', grade: '9' });
    const art: StudentClass = { id: 'art', name: 'Digital Design', room: 'STU 4' };
    const setClasses = (id: string, classes: StudentClass[], assignments: Record<string, string>) =>
      service.sync(id, { mutationId: randomUUID(), id: 'personal', kind: 'personal', base: service.entity(id, 'personal'), data: { grade: '9', classes, assignments, cycleDayOverrides: [], dateOverrides: [], customSchedule: null } });
    setClasses(me, [art, { id: 'chem', name: 'Chemistry' }], { A: 'art', C: 'chem' });
    setClasses(ian, [art], { A: 'art' });
    const community = new CommunityService(service);
    community.request(me, ian); community.respond(ian, me, true);
    return { me, ian, service, db };
  } catch (error) { db.close(); throw error; }
}

async function authenticate(context: BrowserContext, id: string) {
  const token = await encode({ secret: process.env.E2E_AUTH_SECRET!, token: { userId: id, authAt: Date.now() }, maxAge: 3600 });
  await context.addCookies([{ name: 'next-auth.session-token', value: token, domain: 'localhost', path: '/', httpOnly: true, sameSite: 'Lax', expires: Date.now() / 1000 + 3600 }]);
}

test('free periods: a period marked free reads as free on Today and to friends, an empty one as not set', async ({ page, context }, testInfo) => {
  const fixture = seed();
  try {
    await authenticate(context, fixture.me);
    await page.clock.setFixedTime(new Date('2026-09-08T11:30:00Z'));
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/');
    // B and D are Zed's only empty blocks, so Today asks about them first; B stays empty here on purpose.
    await declineFreePeriods(page, ['B', 'D']);

    // Ian left B empty, so the classmates popup cannot say he is free.
    await page.getByRole('button', { name: 'In this class with Ian', exact: true }).click();
    await expect(page.getByRole('dialog').getByRole('button', { name: 'Ian' })).toContainText('No class set');
    await page.keyboard.press('Escape');

    const timeline = page.getByRole('main');
    await expect(timeline.getByText('No class assigned')).toBeVisible();
    await page.getByRole('button', { name: 'Change B' }).click();
    // New schedules start locked against accidental edits.
    await page.getByRole('button', { name: 'Unlock schedule' }).click();
    const sheet = page.getByRole('dialog');
    await choose(sheet.getByRole('combobox', { name: 'Class in B' }), 'Free period');
    await expect(sheet.getByRole('status')).toHaveText('Marked as a free period.');
    await expect(sheet).toHaveAccessibleName('B · Free');
    await page.screenshot({ path: testInfo.outputPath('free-period-sheet.png') });
    await sheet.getByRole('button', { name: 'Done' }).click();
    await expect(timeline.getByText('Free period')).toBeVisible();
    await expect(timeline.getByText('No class assigned')).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath('free-period-today.png'), fullPage: true });

    // Saved on the server, and choosing a class again clears the mark.
    await expect.poll(() => personalScheduleSchema.parse(fixture.service.entity(fixture.me, 'personal')!.data).freePeriods).toEqual(['B']);
    await page.getByRole('button', { name: 'Change B' }).click();
    await choose(sheet.getByRole('combobox', { name: 'Class in B' }), 'Chemistry');
    await expect(sheet.getByRole('status')).toHaveText('Class updated.');
    await expect.poll(() => personalScheduleSchema.parse(fixture.service.entity(fixture.me, 'personal')!.data).freePeriods).toBeUndefined();
  } finally { fixture.db.close(); }
});
