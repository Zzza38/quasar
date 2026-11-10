import { test, expect } from './fixtures';
import type { BrowserContext, Locator, Page } from '@playwright/test';
import { encode } from 'next-auth/jwt';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { openDatabase } from '../../src/server/db';
import { createBeta, readBetaRegistry, writeBetaRegistry } from '../../src/server/beta-registry';
import { BetaService } from '../../src/server/betas';
import { Service } from '../../src/server/service';
import { exampleSchedule } from '../../src/domain/example';
import type { StudentClass } from '../../src/domain/schedule';

const KEY = 'now-card-split';

/**
 * A student with a class in every block of the example schedule, joined to the now-card-split beta unless `beta` is
 * false. Tuesday 2026-09-08 is Day 1: Digital Design 8:00-9:00, Biology 9:10-10:10, Lunch 10:15-10:45 and
 * Pre-Calculus Honors 10:50-11:50, Eastern time.
 */
function seed(beta = true) {
  const db = openDatabase(process.env.E2E_DATABASE_PATH!);
  try {
    const service = new Service(db, 'browser-owner@example.com');
    const id = randomUUID();
    db.prepare('INSERT INTO users(id,google_sub,email,display_name,full_name,created_at) VALUES(?,?,?,?,?,?)').run(id, id, `${randomUUID()}@example.com`, 'Remy', 'Remy Tester', new Date().toISOString());
    const school = service.createSchool(id, { name: `Split High ${id.slice(0, 6)}`, location: 'Boston, MA', schedule: exampleSchedule });
    service.join(id, { schoolId: school.id, choice: 'community', grade: '10' });
    const classes: StudentClass[] = [
      { id: 'art', name: 'Digital Design', room: 'STU 4', teacher: 'Ms. Rivera', color: '#4f46e5' },
      { id: 'bio', name: 'Biology', room: '214', teacher: 'Mr. Okafor', color: '#0f766e' },
      { id: 'math', name: 'Pre-Calculus Honors', room: '108', teacher: 'Dr. Lindqvist', color: '#c2410c' },
      { id: 'hist', name: 'US History', room: '12', color: '#be185d' },
    ];
    service.sync(id, { mutationId: randomUUID(), id: 'personal', kind: 'personal', base: service.entity(id, 'personal'),
      data: { grade: '10', classes, assignments: { A: 'art', B: 'bio', C: 'math', D: 'hist' }, cycleDayOverrides: [], dateOverrides: [], customSchedule: null } });
    if (beta) {
      // What `npm run beta -- create` writes, then the student joins with the code.
      const code = `SPLIT-${id.slice(0, 4)}`;
      const listPath = join(dirname(process.env.E2E_DATABASE_PATH!), 'betas.json');
      const registry = readBetaRegistry(listPath);
      writeBetaRegistry(createBeta({ ...registry, betas: registry.betas.filter((entry) => entry.key !== KEY) }, { key: KEY, name: 'Next class on the Now card', code }), listPath);
      // The service in this process resolves the list beside DATABASE_PATH, like the server's.
      const previous = process.env.DATABASE_PATH;
      process.env.DATABASE_PATH = process.env.E2E_DATABASE_PATH;
      try { new BetaService(service).join(id, { code }); } finally { if (previous === undefined) delete process.env.DATABASE_PATH; else process.env.DATABASE_PATH = previous; }
    }
    return id;
  } finally { db.close(); }
}

async function authenticate(context: BrowserContext, id: string) {
  const token = await encode({ secret: process.env.E2E_AUTH_SECRET!, token: { userId: id, authAt: Date.now() }, maxAge: 3600 });
  await context.addCookies([{ name: 'next-auth.session-token', value: token, domain: 'localhost', path: '/', httpOnly: true, sameSite: 'Lax', expires: Date.now() / 1000 + 3600 }]);
}

/** Eastern daylight time on 2026-09-08, as an instant. */
const at = (time: string) => new Date(`2026-09-08T${time}:00-04:00`);

async function open(page: Page, context: BrowserContext, time: string, width: number, beta = true) {
  await page.setViewportSize({ width, height: 900 });
  // The grey part has its own shade in the dark theme.
  await page.emulateMedia({ colorScheme: 'dark' });
  await authenticate(context, seed(beta));
  await page.clock.setFixedTime(at(time));
  await page.goto('/');
  return page.getByRole('region', { name: 'Next class' });
}

const box = async (locator: Locator) => (await locator.boundingBox())!;

/** Moves the browser's clock. The page re-reads it every 30 seconds and whenever its tab becomes visible. */
async function setTime(page: Page, time: string) {
  await page.clock.setFixedTime(at(time));
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
}

/** A screenshot for a person to look at: the test's own output, and NOW_SPLIT_SHOTS when it names a directory. */
async function shoot(card: Locator, name: string, testInfo: { outputPath: (name: string) => string }) {
  await card.screenshot({ path: testInfo.outputPath(`${name}.png`) });
  if (process.env.NOW_SPLIT_SHOTS) await card.screenshot({ path: join(process.env.NOW_SPLIT_SHOTS, `${name}.png`) });
}

for (const width of [390, 1280]) {
  const wide = width > 600;
  /** Length along the split: left to right when the card is wide, top to bottom on a phone. */
  const along = (rect: { width: number; height: number }) => wide ? rect.width : rect.height;
  const startOf = (rect: { x: number; y: number }) => wide ? rect.x : rect.y;

  test(`the next class is a sliver as the period begins and takes its share of the card as the clock runs, at ${width}px`, async ({ page, context }, testInfo) => {
    const card = await open(page, context, '08:01', width);
    await expect(card).toHaveAttribute('data-phase', 'class');
    const now = card.locator('.ns-seg.ns-now'), gap = card.locator('.ns-seg.ns-gap'), next = card.locator('.ns-seg.ns-next');
    await expect(now.getByRole('heading', { name: 'Digital Design' })).toBeVisible();
    await expect(now.getByRole('button', { name: 'Ends in 59 min' })).toBeVisible();
    // 8:00 to 9:10 is 70 minutes, 10 of them between the two classes.
    const total = along(await box(card));
    // The parts glide to a new size, so every measurement waits for them to settle.
    await expect.poll(async () => along(await box(next)) / total).toBeCloseTo(0.025, 2);
    expect(along(await box(gap)) / total).toBeCloseTo(10 / 70, 2);
    // Too small for words, so nothing of the next class is drawn, but a screen reader still gets it.
    await expect(next.getByRole('heading', { name: 'Biology' })).toBeHidden();
    await expect(next.getByText('Then Biology at 9:10 AM, Room 214')).toBeAttached();
    const bar = card.getByRole('progressbar', { name: 'Period progress' });
    await expect(bar).toHaveAttribute('aria-valuetext', '1 of 60 minutes');
    await shoot(card, `split-${width}-0801`, testInfo);

    await setTime(page, '08:36');
    await expect(now.getByRole('button', { name: 'Ends in 24 min' })).toBeVisible();
    await expect(next.getByRole('heading', { name: 'Biology' })).toBeVisible();
    await expect(next.locator('.ns-pill')).toBeVisible();
    await expect(next.locator('.ns-pill')).toHaveText('Room 214');
    await expect(next.getByRole('button', { name: 'Starts in 34 min' })).toBeVisible();
    // 36 of the period's 60 minutes are gone, so the next class has 60% of what the grey part leaves.
    await expect.poll(async () => along(await box(next)) / total).toBeCloseTo(0.6 * 60 / 70, 2);
    expect(along(await box(gap)) / total).toBeCloseTo(10 / 70, 2);
    // The bar runs the length of the card and is 60% full.
    const fill = bar.locator('.ns-fill');
    await expect.poll(async () => along(await box(fill)) / along(await box(bar))).toBeCloseTo(0.6, 2);
    expect(along(await box(bar))).toBeGreaterThan(total * 0.85);
    // Its three colours change exactly where the card's parts meet.
    for (const part of ['now', 'gap', 'next']) {
      const [seam, paint] = [await box(card.locator(`.ns-seg.ns-${part}`)), await box(bar.locator(`.ns-paint > .ns-${part}`))];
      expect(Math.abs(startOf(seam) - startOf(paint)), `${part} starts at the same place in the bar`).toBeLessThan(0.75);
      expect(Math.abs(along(seam) - along(paint)), `${part} is the same length in the bar`).toBeLessThan(0.75);
    }
    const colours = await bar.locator('.ns-paint > *').evaluateAll((parts) => parts.map((part) => getComputedStyle(part).backgroundColor));
    expect(new Set(colours).size).toBe(3);
    await shoot(card, `split-${width}-0836`, testInfo);

    // Near the end the current class keeps room for its own countdown.
    await setTime(page, '08:58');
    await expect(now.getByRole('button', { name: 'Ends in 2 min' })).toBeVisible();
    await expect.poll(async () => along(await box(now))).toBeCloseTo(wide ? 132 : 44, 0);
    await shoot(card, `split-${width}-0858`, testInfo);
  });

  test(`between periods the grey part shrinks and the next class has the rest, at ${width}px`, async ({ page, context }, testInfo) => {
    const card = await open(page, context, '09:04', width);
    await expect(card).toHaveAttribute('data-phase', 'passing');
    await expect(card.locator('.ns-seg.ns-now')).toHaveCount(0);
    await expect(card.getByRole('progressbar')).toHaveCount(0);
    await expect(card.getByRole('heading', { level: 2, name: 'Biology' })).toBeVisible();
    await expect(card.getByText('Up next · 9:10 AM')).toBeVisible();
    await expect(card.getByRole('button', { name: 'Starts in 6 min' })).toBeVisible();
    // 6 of the 70 minutes from 8:00 to 9:10 are left.
    await expect.poll(async () => along(await box(card.locator('.ns-seg.ns-gap'))) / along(await box(card))).toBeCloseTo(6 / 70, 2);
    await shoot(card, `split-${width}-0904`, testInfo);
  });

  test(`a long class name fits its part at ${width}px`, async ({ page, context }, testInfo) => {
    // Lunch 10:15-10:45, then Pre-Calculus Honors at 10:50.
    const card = await open(page, context, '10:30', width);
    await expect(card.getByRole('heading', { name: 'Pre-Calculus Honors' })).toBeVisible();
    await expect.poll(async () => along(await box(card.locator('.ns-seg.ns-next'))) / along(await box(card))).toBeCloseTo(0.5 * 30 / 35, 2);
    await shoot(card, `split-${width}-1030`, testInfo);
    for (const part of [card.locator('.ns-seg.ns-now'), card.locator('.ns-seg.ns-next')]) {
      const outer = await box(part);
      for (const inner of await part.locator('.ns-name, .ns-count, .ns-meta').all()) {
        if (!await inner.isVisible()) continue;
        const rect = await box(inner);
        expect(rect.x + rect.width, 'stays inside its part').toBeLessThanOrEqual(outer.x + outer.width + 0.5);
        expect(rect.y + rect.height, 'stays inside its part').toBeLessThanOrEqual(outer.y + outer.height + 0.5);
      }
    }
  });
}

test('the last period of the day keeps the card whole, and so does everyone outside the beta', async ({ page, context, browser }) => {
  const card = await open(page, context, '11:00', 1280);
  await expect(card.getByText('Then Biology at 8:00 AM Tomorrow')).toBeVisible();
  await expect(page.locator('.ns-card')).toHaveCount(0);

  const other = await browser.newContext();
  try {
    const visitor = await other.newPage();
    const regular = await open(visitor, other, '08:36', 1280, false);
    await visitor.locator('html[data-hydrated]').waitFor({ state: 'attached' });
    await expect(regular.getByText('Then Biology at 9:10 AM')).toBeVisible();
    await expect(visitor.locator('.ns-card')).toHaveCount(0);
  } finally { await other.close(); }
});
