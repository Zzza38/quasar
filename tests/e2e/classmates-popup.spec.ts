import { test, expect } from './fixtures';
import type { BrowserContext } from '@playwright/test';
import { encode } from 'next-auth/jwt';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { openDatabase } from '../../src/server/db';
import { createBeta, readBetaRegistry, writeBetaRegistry } from '../../src/server/beta-registry';
import { BetaService } from '../../src/server/betas';
import { CommunityService } from '../../src/server/community';
import { Service } from '../../src/server/service';
import { exampleSchedule } from '../../src/domain/example';
import type { StudentClass } from '../../src/domain/schedule';

/**
 * A student with three friends in their period A class. Evan and Maya have Biology in STU 2 next; Ian has nothing
 * in period B, so it is his free period. The browser clock is fixed to Tuesday 2026-09-08 before school.
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
    const setClasses = (id: string, classes: StudentClass[], assignments: Record<string, string>) =>
      service.sync(id, { mutationId: randomUUID(), id: 'personal', kind: 'personal', base: service.entity(id, 'personal'), data: { grade: '9', classes, assignments, cycleDayOverrides: [], dateOverrides: [], customSchedule: null } });
    setClasses(me, [art], { A: 'art' });
    setClasses(evan, [art, { id: 'bio', name: 'Biology', room: 'STU 2' }], { A: 'art', B: 'bio' });
    setClasses(maya, [art, { id: 'bio', name: 'Biology', room: 'STU 2' }], { A: 'art', B: 'bio' });
    setClasses(ian, [art, { id: 'chem', name: 'Chemistry' }], { A: 'art', C: 'chem' });
    const community = new CommunityService(service);
    for (const id of [evan, maya, ian]) { community.request(me, id); community.respond(id, me, true); }
    return { me, evan, service, db };
  } catch (error) { db.close(); throw error; }
}

async function authenticate(context: BrowserContext, id: string) {
  const token = await encode({ secret: process.env.E2E_AUTH_SECRET!, token: { userId: id, authAt: Date.now() }, maxAge: 3600 });
  await context.addCookies([{ name: 'next-auth.session-token', value: token, domain: 'localhost', path: '/', httpOnly: true, sameSite: 'Lax', expires: Date.now() / 1000 + 3600 }]);
}

test('classmates popup beta: the chip shows faces and opens every friend in the class with where they go next', async ({ page, context }, testInfo) => {
  const fixture = seed();
  try {
    await authenticate(context, fixture.me);
    await page.clock.setFixedTime(new Date('2026-09-08T11:30:00Z'));
    await page.setViewportSize({ width: 390, height: 844 });

    // Outside the beta the chip still names friends and links to People.
    await page.goto('/');
    await expect(page.getByRole('button', { name: /With Evan, Ian and 1 more/ })).toBeVisible();
    await expect(page.getByRole('button', { name: 'In this class with Evan, Ian and Maya' })).toHaveCount(0);

    // What `npm run beta -- create` writes, then the student joins with the code.
    const key = 'classmates-popup';
    const code = `FACES-${fixture.me.slice(0, 4)}`;
    const listPath = join(dirname(process.env.E2E_DATABASE_PATH!), 'betas.json');
    const registry = readBetaRegistry(listPath);
    writeBetaRegistry(createBeta({ ...registry, betas: registry.betas.filter((beta) => beta.key !== key) }, { key, name: 'Classmates popup', description: 'See who is in each class with you.', code }), listPath);
    // The service in this process resolves the list beside DATABASE_PATH, like the server's.
    const previous = process.env.DATABASE_PATH;
    process.env.DATABASE_PATH = process.env.E2E_DATABASE_PATH;
    try { new BetaService(fixture.service).join(fixture.me, { code }); } finally { if (previous === undefined) delete process.env.DATABASE_PATH; else process.env.DATABASE_PATH = previous; }
    await page.reload();

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
