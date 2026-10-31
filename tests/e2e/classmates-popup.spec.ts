import { test, expect } from './fixtures';
import type { BrowserContext } from '@playwright/test';
import { encode } from 'next-auth/jwt';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../../src/server/db';
import { CommunityService } from '../../src/server/community';
import { Service } from '../../src/server/service';
import { exampleSchedule } from '../../src/domain/example';
import type { StudentClass } from '../../src/domain/schedule';

/**
 * A student with three friends in their period A class. Evan and Maya have Biology in STU 2 next; Ian has nothing
 * in period B and marked it free. Ian alone also shares period C, the last of the day. The browser clock is
 * fixed to Tuesday 2026-09-08 before school.
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
    const me = user('Zed'), evan = user('Evan'), maya = user('Maya'), ian = user('Ian');
    const school = service.createSchool(me, { name: `Friends High ${me.slice(0, 6)}`, location: 'Boston, MA', schedule: exampleSchedule });
    for (const id of [me, evan, maya, ian]) service.join(id, { schoolId: school.id, choice: 'community', grade: '9' });
    const art: StudentClass = { id: 'art', name: 'Digital Design', room: 'STU 4' };
    const setClasses = (id: string, classes: StudentClass[], assignments: Record<string, string>, freePeriods?: string[]) =>
      service.sync(id, { mutationId: randomUUID(), id: 'personal', kind: 'personal', base: service.entity(id, 'personal'), data: { grade: '9', classes, assignments, ...(freePeriods ? { freePeriods } : {}), cycleDayOverrides: [], dateOverrides: [], customSchedule: null } });
    setClasses(me, [art, { id: 'chem', name: 'Chemistry' }], { A: 'art', C: 'chem' });
    setClasses(evan, [art, { id: 'bio', name: 'Biology', room: 'STU 2' }], { A: 'art', B: 'bio' });
    setClasses(maya, [art, { id: 'bio', name: 'Biology', room: 'STU 2' }], { A: 'art', B: 'bio' });
    setClasses(ian, [art, { id: 'chem', name: 'Chemistry' }], { A: 'art', C: 'chem' }, ['B']);
    const community = new CommunityService(service);
    for (const id of [evan, maya, ian]) { community.request(me, id); community.respond(id, me, true); }
    return { me, evan, service, db };
  } catch (error) { db.close(); throw error; }
}

async function authenticate(context: BrowserContext, id: string) {
  const token = await encode({ secret: process.env.E2E_AUTH_SECRET!, token: { userId: id, authAt: Date.now() }, maxAge: 3600 });
  await context.addCookies([{ name: 'next-auth.session-token', value: token, domain: 'localhost', path: '/', httpOnly: true, sameSite: 'Lax', expires: Date.now() / 1000 + 3600 }]);
}

test('classmates popup: the chip shows faces and opens every friend in the class with where they go next', async ({ page, context }, testInfo) => {
  const fixture = seed();
  try {
    await authenticate(context, fixture.me);
    await page.clock.setFixedTime(new Date('2026-09-08T11:30:00Z'));
    await page.setViewportSize({ width: 390, height: 844 });

    await page.goto('/');

    const chip = page.getByRole('button', { name: 'In this class with Evan, Ian and Maya' });
    await expect(chip).toContainText('3 friends');
    await chip.click();
    const popup = page.getByRole('dialog');
    const faces = popup.getByRole('list', { name: 'Friends in this class' });
    // The faces' initials are hidden from assistive tech, so each button is named by the first name alone.
    await expect(faces.getByRole('listitem')).toHaveCount(3);
    for (const [index, name] of ['Evan', 'Ian', 'Maya'].entries()) await expect(faces.getByRole('button').nth(index)).toHaveAccessibleName(name);
    const after = popup.getByRole('region', { name: 'After class' });
    await expect(after.getByRole('listitem')).toHaveCount(2);
    await expect(after.getByRole('listitem').nth(0)).toContainText('Biology');
    await expect(after.getByRole('listitem').nth(0)).toContainText('Evan, Maya · STU 2');
    await expect(after.getByRole('listitem').nth(1)).toContainText('Free');
    await expect(after.getByRole('listitem').nth(1)).toContainText('Ian');
    await page.screenshot({ path: testInfo.outputPath('classmates-popup-phone.png') });

    // One friend gets a single row: face, name and where they go next. The first popup has to finish closing
    // before the next opens, or both dialogs (and both Ians) are on screen at once.
    await page.keyboard.press('Escape');
    await expect(popup).toHaveCount(0);
    const single = page.getByRole('button', { name: 'In this class with Ian', exact: true });
    await expect(single).toContainText('With Ian');
    await single.click();
    await expect(popup.getByRole('button', { name: 'Ian' })).toContainText('Done for today');
    await expect(popup.getByRole('region', { name: 'After class' })).toHaveCount(0);
    await expect(popup.getByRole('button', { name: 'Open People' })).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath('classmates-popup-single.png') });

    // Escape closes it; a face opens that friend on People.
    await page.keyboard.press('Escape');
    await expect(popup).toHaveCount(0);
    await chip.click();
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.screenshot({ path: testInfo.outputPath('classmates-popup-desktop.png') });
    await faces.getByRole('button', { name: 'Evan' }).click();
    await expect(page).toHaveURL(/\/people/);
    await expect(page.getByRole('dialog')).toContainText('Evan');
  } finally { fixture.db.close(); }
});
