import { test, expect } from './fixtures';
import type { BrowserContext, Locator } from '@playwright/test';
import { encode } from 'next-auth/jwt';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { openDatabase } from '../../src/server/db';
import { createBeta, readBetaRegistry, writeBetaRegistry } from '../../src/server/beta-registry';
import { BetaService } from '../../src/server/betas';
import { Service } from '../../src/server/service';
import { exampleSchedule } from '../../src/domain/example';

/** A student in a school, joined to the countdown-slide beta. */
function seed() {
  const db = openDatabase(process.env.E2E_DATABASE_PATH!);
  try {
    const service = new Service(db, 'browser-owner@example.com');
    const id = randomUUID();
    db.prepare('INSERT INTO users(id,google_sub,email,display_name,full_name,created_at) VALUES(?,?,?,?,?,?)').run(id, id, `${randomUUID()}@example.com`, 'Cass', 'Cass Tester', new Date().toISOString());
    const school = service.createSchool(id, { name: `Countdown High ${id.slice(0, 6)}`, location: 'Boston, MA', schedule: exampleSchedule });
    service.join(id, { schoolId: school.id, choice: 'community', grade: '10' });
    // What `npm run beta -- create` writes, then the student joins with the code.
    const key = 'countdown-slide';
    const code = `TICK-${id.slice(0, 4)}`;
    const listPath = join(dirname(process.env.E2E_DATABASE_PATH!), 'betas.json');
    const registry = readBetaRegistry(listPath);
    writeBetaRegistry(createBeta({ ...registry, betas: registry.betas.filter((beta) => beta.key !== key) }, { key, name: 'Countdown slide', code }), listPath);
    // The service in this process resolves the list beside DATABASE_PATH, like the server's.
    const previous = process.env.DATABASE_PATH;
    process.env.DATABASE_PATH = process.env.E2E_DATABASE_PATH;
    try { new BetaService(service).join(id, { code }); } finally { if (previous === undefined) delete process.env.DATABASE_PATH; else process.env.DATABASE_PATH = previous; }
    return id;
  } finally { db.close(); }
}

async function authenticate(context: BrowserContext, id: string) {
  const token = await encode({ secret: process.env.E2E_AUTH_SECRET!, token: { userId: id, authAt: Date.now() }, maxAge: 3600 });
  await context.addCookies([{ name: 'next-auth.session-token', value: token, domain: 'localhost', path: '/', httpOnly: true, sameSite: 'Lax', expires: Date.now() / 1000 + 3600 }]);
}

/** Whether a form's first character has slid into place ("1") or out of the clipped number ("0"). */
const placed = (form: Locator) => form.locator('span').first().evaluate((char) => getComputedStyle(char).translate === 'none' ? '1' : '0');

test('countdown slide beta: the forms slide without fading, digits roll, and the number\'s edge never flickers the hover', async ({ page, context }) => {
  await authenticate(context, seed());
  await page.clock.setFixedTime(new Date('2026-09-17T12:51:37Z'));
  await page.goto('/');
  const countdown = page.getByRole('button', { name: /^Ends in/ });
  const minutesForm = countdown.locator('[data-shown]').first();
  const secondsForm = countdown.locator('[data-shown]').last();
  await expect(countdown).toHaveAccessibleName('Ends in 9 min');
  await expect.poll(() => placed(secondsForm)).toBe('0');
  // Nothing fades: the hidden form is clipped out of view at full opacity.
  expect(await secondsForm.locator('span').first().evaluate((char) => getComputedStyle(char).opacity)).toBe('1');
  const box = (await countdown.boundingBox())!;
  const number = (await minutesForm.boundingBox())!;
  // Just below the number, where the hidden form's characters used to catch the pointer and toggle the hover.
  await countdown.hover({ position: { x: number.x - box.x + 4, y: box.height - 2 } });
  await expect(countdown).toHaveAccessibleName('Ends in 8:23 (minutes and seconds)');
  for (let check = 0; check < 20; check++) {
    await page.waitForTimeout(50);
    expect(await countdown.getAttribute('aria-label')).toBe('Ends in 8:23 (minutes and seconds)');
  }
  await expect.poll(() => placed(minutesForm)).toBe('0');
  await expect.poll(() => placed(secondsForm)).toBe('1');
  expect((await countdown.boundingBox())!.width).toBe(box.width);
  // The changed digit rolls up, with the old one riding above it.
  await page.clock.setFixedTime(new Date('2026-09-17T12:51:38Z'));
  await expect(countdown).toHaveAccessibleName('Ends in 8:22 (minutes and seconds)');
  await expect(secondsForm.locator('.countdown-roll')).toHaveText('32');
  await page.mouse.move(0, 0);
  await expect.poll(() => placed(secondsForm)).toBe('0');
  await expect(countdown).toHaveAccessibleName('Ends in 9 min');
});
