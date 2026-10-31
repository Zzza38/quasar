import { declineFreePeriods, test, expect } from './fixtures';
import type { BrowserContext } from '@playwright/test';
import { encode } from 'next-auth/jwt';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../../src/server/db';
import { Service } from '../../src/server/service';
import { exampleSchedule } from '../../src/domain/example';
import { personalScheduleSchema } from '../../src/domain/schedule';

/** Zed has classes in A and C; B and D are empty, so Today asks about each. The schedule starts locked. */
function seed() {
  const db = openDatabase(process.env.E2E_DATABASE_PATH!);
  try {
    const service = new Service(db, 'browser-owner@example.com');
    const me = randomUUID();
    db.prepare('INSERT INTO users(id,google_sub,email,display_name,full_name,created_at) VALUES(?,?,?,?,?,?)').run(me, me, `${randomUUID()}@example.com`, 'Zed', 'Zed Tester', new Date().toISOString());
    const school = service.createSchool(me, { name: `Prompt High ${me.slice(0, 6)}`, location: 'Boston, MA', schedule: exampleSchedule });
    service.join(me, { schoolId: school.id, choice: 'community', grade: '9' });
    service.sync(me, { mutationId: randomUUID(), id: 'personal', kind: 'personal', base: service.entity(me, 'personal'), data: {
      grade: '9', classes: [{ id: 'art', name: 'Digital Design' }, { id: 'chem', name: 'Chemistry' }], assignments: { A: 'art', C: 'chem' }, cycleDayOverrides: [], dateOverrides: [], customSchedule: null,
    } });
    return { me, service, db };
  } catch (error) { db.close(); throw error; }
}

async function authenticate(context: BrowserContext, id: string) {
  const token = await encode({ secret: process.env.E2E_AUTH_SECRET!, token: { userId: id, authAt: Date.now() }, maxAge: 3600 });
  await context.addCookies([{ name: 'next-auth.session-token', value: token, domain: 'localhost', path: '/', httpOnly: true, sameSite: 'Lax', expires: Date.now() / 1000 + 3600 }]);
}

test('free period question: yes marks the block free without unlocking, no is not asked again', async ({ page, context }, testInfo) => {
  const fixture = seed();
  const saved = () => personalScheduleSchema.parse(fixture.service.entity(fixture.me, 'personal')!.data);
  try {
    await authenticate(context, fixture.me);
    await page.clock.setFixedTime(new Date('2026-09-08T11:30:00Z'));
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/');

    // No keeps B empty and moves on to D.
    await declineFreePeriods(page, ['B']);
    const question = page.getByRole('dialog', { name: 'Is D a free period?' });
    await expect(question).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('free-period-question.png') });

    // Yes saves the mark straight away: no unlock prompt, and the schedule stays locked.
    await question.getByRole('button', { name: 'Yes, it’s free' }).click();
    await expect(question).toHaveCount(0);
    await expect(page.getByRole('dialog', { name: 'Unlock schedule?' })).toHaveCount(0);
    await expect.poll(() => saved().freePeriods).toEqual(['D']);
    expect(saved().scheduleLocked).not.toBe(false);
    expect(saved().assignments).toEqual({ A: 'art', C: 'chem' });

    // B was answered on this device, so a reload asks nothing.
    await page.reload();
    await expect(page.getByRole('main').getByText('No class assigned')).toBeVisible();
    await expect(page.getByRole('dialog')).toHaveCount(0);
  } finally { fixture.db.close(); }
});
