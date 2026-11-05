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
import sharp from 'sharp';

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

/** Whether a complete line has slid into place ("1") or out of the clipped number ("0"). */
const placed = (form: Locator) => form.evaluate((line) => getComputedStyle(line).translate === 'none' ? '1' : '0');

async function whitePixels(number: Locator, path?: string): Promise<number> {
  const { data, info } = await sharp(await number.screenshot({ path })).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  let count = 0;
  for (let i = 0; i < data.length; i += info.channels)
    if (data[i] > 220 && data[i + 1] > 220 && data[i + 2] > 220) count++;
  return count;
}

for (const width of [390, 1000]) {
  test(`countdown stays visible throughout slides and reversals at ${width}px`, async ({ page, context }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await authenticate(context, seed());
    await page.clock.setFixedTime(new Date('2026-09-17T12:35:37Z'));
    await page.goto('/');
    await page.getByRole('button', { name: 'Hide setup checklist' }).click();
    await page.mouse.move(0, 0);
    const countdown = page.getByRole('button', { name: /^Ends in/ });
    const number = countdown.locator(':scope > span');
    const lines = number.locator('[data-shown]');
    await expect(countdown).toHaveAccessibleName('Ends in 25 min');
    const baseline = await whitePixels(number);

    for (const enter of [true, false, true, false]) {
      if (enter) await countdown.hover();
      else await page.mouse.move(0, 0);
      await number.evaluate(element => element.getAnimations({ subtree: true }).forEach(animation => animation.pause()));
      for (const time of [0, 30, 60, 90, 120, 180, 240]) {
        await number.evaluate((element, time) => element.getAnimations({ subtree: true }).forEach(animation => { animation.currentTime = time; }), time);
        const [minutes, seconds] = await Promise.all([lines.nth(0).boundingBox(), lines.nth(1).boundingBox()]);
        // Adjacent complete lines cannot leave the empty strip caused by staggered 130% slides.
        expect(Math.abs(seconds!.y - minutes!.y - minutes!.height)).toBeLessThan(1);
        // Revealing seconds keeps the first digit anchored beside the label.
        expect(Math.abs(seconds!.x - minutes!.x)).toBeLessThan(1);
        expect(await whitePixels(number, testInfo.outputPath(`${enter ? 'enter' : 'leave'}-${time}.png`)), `visible digits at ${time}ms, entering=${enter}`).toBeGreaterThan(baseline * 0.4);
      }
      await number.evaluate(element => element.getAnimations({ subtree: true }).forEach(animation => animation.finish()));
    }

    // Reverse before a slide finishes, including a timer tick during the reversal.
    await countdown.hover();
    await page.waitForTimeout(60);
    await page.mouse.move(0, 0);
    await page.clock.setFixedTime(new Date('2026-09-17T12:36:00Z'));
    await countdown.hover();
    await expect(countdown).toHaveAccessibleName('Ends in 24:00 (minutes and seconds)');
    await expect.poll(() => placed(lines.last())).toBe('1');
    expect(await whitePixels(number)).toBeGreaterThan(baseline * 0.4);

    await page.clock.setFixedTime(new Date('2026-09-17T12:36:01Z'));
    await expect(countdown).toHaveAccessibleName('Ends in 23:59 (minutes and seconds)');
    await number.evaluate(element => element.getAnimations({ subtree: true }).forEach(animation => animation.pause()));
    for (const time of [0, 60, 120, 180, 240, 300, 360]) {
      await number.evaluate((element, time) => element.getAnimations({ subtree: true }).forEach(animation => { animation.currentTime = time; }), time);
      expect(await whitePixels(number, testInfo.outputPath(`roll-${time}.png`)), `visible digits during rollover at ${time}ms`).toBeGreaterThan(baseline * 0.4);
    }
    await number.evaluate(element => element.getAnimations({ subtree: true }).forEach(animation => animation.finish()));
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.mouse.move(0, 0);
    await expect(countdown).toHaveAccessibleName('Ends in 24 min');
    await countdown.hover();
    await expect(countdown).toHaveAccessibleName('Ends in 23:59 (minutes and seconds)');
    expect(await whitePixels(number)).toBeGreaterThan(baseline * 0.4);
  });
}

test('countdown minutes keep up with seconds while the parent clock has not ticked', async ({ page, context }) => {
  await authenticate(context, seed());
  const start = new Date('2026-09-17T12:35:37Z');
  await page.clock.install({ time: new Date(start.getTime() - 60_000) });
  await page.clock.pauseAt(start);
  await page.goto('/');
  const countdown = page.getByRole('button', { name: /^Ends in/ });
  await expect(countdown).toHaveAccessibleName('Ends in 25 min');

  // Simulate a delayed browser timer. Only the countdown's one-second timer runs;
  // the parent's 30-second refresh still holds the original 25-minute value.
  await page.clock.setFixedTime(new Date('2026-09-17T12:36:37Z'));
  await page.clock.runFor(1000);
  await expect(countdown).toHaveAccessibleName('Ends in 24 min');
  await countdown.hover();
  await expect(countdown).toHaveAccessibleName('Ends in 23:23 (minutes and seconds)');
  await page.mouse.move(0, 0);
  await expect(countdown).toHaveAccessibleName('Ends in 24 min');
  await expect(countdown.locator('[data-shown="true"]')).toHaveText('24 min');
});

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
  // The old digit only rides along for the 360ms roll, so watch for it every frame from before the tick.
  const rolled = page.waitForFunction(() => [...document.querySelectorAll('[data-shown="true"] .countdown-roll')].some((char) => char.textContent === '32'), undefined, { polling: 'raf' });
  await page.clock.setFixedTime(new Date('2026-09-17T12:51:38Z'));
  await expect(countdown).toHaveAccessibleName('Ends in 8:22 (minutes and seconds)');
  await rolled;
  await page.mouse.move(0, 0);
  await expect.poll(() => placed(secondsForm)).toBe('0');
  await expect(countdown).toHaveAccessibleName('Ends in 9 min');
  // The hidden form keeps time without rolling: Chrome paints a digit mid-roll outside the clip, under the minutes.
  await page.clock.setFixedTime(new Date('2026-09-17T12:51:39Z'));
  await expect.poll(() => secondsForm.textContent()).toBe('8:21');
  await expect(secondsForm.locator('.countdown-roll')).toHaveCount(0);
});
