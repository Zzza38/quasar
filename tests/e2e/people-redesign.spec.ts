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
 * A student with four friends. During period A (the first class on Tuesday 2026-09-08), Evan and Maya are in the
 * student's Digital Design class, Nora is in Spanish, Ian marked period A free, and Theo left it empty.
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
    const me = user('Zed'), evan = user('Evan'), maya = user('Maya'), ian = user('Ian'), nora = user('Nora'), theo = user('Theo');
    const school = service.createSchool(me, { name: `People High ${me.slice(0, 6)}`, location: 'Boston, MA', schedule: exampleSchedule });
    for (const id of [me, evan, maya, ian, nora, theo]) service.join(id, { schoolId: school.id, choice: 'community', grade: '9' });
    const art: StudentClass = { id: 'art', name: 'Digital Design', room: 'STU 4', teacher: 'Ms. Park' };
    const setClasses = (id: string, classes: StudentClass[], assignments: Record<string, string>, freePeriods?: string[]) =>
      service.sync(id, { mutationId: randomUUID(), id: 'personal', kind: 'personal', base: service.entity(id, 'personal'), data: { grade: '9', classes, assignments, ...(freePeriods ? { freePeriods } : {}), cycleDayOverrides: [], dateOverrides: [], customSchedule: null } });
    setClasses(me, [art, { id: 'chem', name: 'Chemistry' }], { A: 'art', C: 'chem' });
    setClasses(evan, [art, { id: 'bio', name: 'Biology', room: 'STU 2' }], { A: 'art', B: 'bio' });
    setClasses(maya, [art], { A: 'art' });
    setClasses(ian, [{ id: 'chem', name: 'Chemistry' }], { C: 'chem' }, ['A']);
    setClasses(theo, [{ id: 'chem', name: 'Chemistry' }], { C: 'chem' });
    setClasses(nora, [{ id: 'span', name: 'Spanish 2', room: 'LANG 1' }], { A: 'span' });
    const community = new CommunityService(service);
    for (const id of [evan, maya, ian, nora, theo]) { community.request(me, id); community.respond(id, me, true); }
    return { me, service, db };
  } catch (error) { db.close(); throw error; }
}

async function authenticate(context: BrowserContext, id: string) {
  const token = await encode({ secret: process.env.E2E_AUTH_SECRET!, token: { userId: id, authAt: Date.now() }, maxAge: 3600 });
  await context.addCookies([{ name: 'next-auth.session-token', value: token, domain: 'localhost', path: '/', httpOnly: true, sameSite: 'Lax', expires: Date.now() / 1000 + 3600 }]);
}

test('people redesign beta: friends are grouped by the class they are in right now', async ({ page, context }, testInfo) => {
  const fixture = seed();
  try {
    // What `npm run beta -- create` writes, then the student joins with the code.
    const key = 'people-redesign';
    const code = `PEOPLE-${fixture.me.slice(0, 4)}`;
    const listPath = join(dirname(process.env.E2E_DATABASE_PATH!), 'betas.json');
    const registry = readBetaRegistry(listPath);
    writeBetaRegistry(createBeta({ ...registry, betas: registry.betas.filter((beta) => beta.key !== key) }, { key, name: 'People page redesign', description: 'Where your friends are.', code }), listPath);
    // The service in this process resolves the list beside DATABASE_PATH, like the server's.
    const previous = process.env.DATABASE_PATH;
    process.env.DATABASE_PATH = process.env.E2E_DATABASE_PATH;
    try { new BetaService(fixture.service).join(fixture.me, { code }); } finally { if (previous === undefined) delete process.env.DATABASE_PATH; else process.env.DATABASE_PATH = previous; }

    await authenticate(context, fixture.me);
    // 8:30 AM in New York: the middle of period A.
    await page.clock.setFixedTime(new Date('2026-09-08T12:30:00Z'));
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/people');

    await expect(page.getByRole('heading', { name: 'Where your friends are' })).toBeVisible();
    const now = page.getByRole('list', { name: 'Classes now' });
    // The student's own class comes first, marked "You too".
    const first = now.getByRole('listitem').filter({ hasText: 'Digital Design' });
    await expect(first).toContainText('You too');
    await expect(first).toContainText('STU 4 · Ms. Park');
    const mates = first.getByRole('list', { name: 'Friends in Digital Design' }).getByRole('button');
    await expect(mates).toHaveCount(2);
    for (const [index, name] of ['Evan', 'Maya'].entries()) await expect(mates.nth(index)).toHaveAccessibleName(`Open ${name}’s profile`);
    await expect(now.getByRole('list', { name: 'Friends in Spanish 2' })).toContainText('Nora');
    await expect(now.getByRole('list', { name: 'Friends in Free' })).toContainText('Ian');
    await expect(now.getByRole('list', { name: 'Friends in No class set' })).toContainText('Theo');
    await expect(page.getByText('Beta layout')).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath('people-redesign-phone.png'), fullPage: true });

    await page.setViewportSize({ width: 1280, height: 900 });
    await page.screenshot({ path: testInfo.outputPath('people-redesign-desktop.png'), fullPage: true });

    await first.getByRole('button', { name: 'Evan' }).click();
    await expect(page.getByRole('dialog')).toContainText('Evan');
  } finally { fixture.db.close(); }
});
