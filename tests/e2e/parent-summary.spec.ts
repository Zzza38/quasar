import { test, expect, hydrating } from './fixtures';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import { encode } from 'next-auth/jwt';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { openDatabase } from '../../src/server/db';
import { createBeta, readBetaRegistry, writeBetaRegistry } from '../../src/server/beta-registry';
import { Service } from '../../src/server/service';
import { exampleSchedule } from '../../src/domain/example';
import { AI_BETA } from '../../src/domain/ai';
import { addDays, instantParts, weekdayOf } from '../../src/lib/format';

/**
 * The weekly parent summary (src/server/parent-summary.ts). Billing isn't configured on the test server, so every
 * ai-tasks beta member has the Plus features.
 */

const spanish = randomUUID(), biology = randomUUID();
const today = instantParts(new Date().toISOString(), exampleSchedule.timeZone).date;
const weekStart = addDays(today, 1 - weekdayOf(today));

function seed() {
  const listPath = join(dirname(process.env.E2E_DATABASE_PATH!), 'betas.json');
  const registry = readBetaRegistry(listPath);
  if (!registry.betas.some(beta => beta.key === AI_BETA)) writeBetaRegistry(createBeta(registry, { key: AI_BETA, name: 'AI tasks', code: 'AI-TASKS-E2E' }), listPath);
  const db = openDatabase(process.env.E2E_DATABASE_PATH!);
  try {
    const id = randomUUID();
    db.prepare('INSERT INTO users(id,google_sub,email,display_name,full_name,created_at) VALUES(?,?,?,?,?,?)').run(id, id, `${id}@example.com`, 'Ada', 'Ada Tester', new Date().toISOString());
    const service = new Service(db, 'browser-owner@example.com');
    const school = service.createSchool(id, { name: `Summary High ${id.slice(0, 6)}`, location: 'Boston, MA', schedule: exampleSchedule });
    service.join(id, { schoolId: school.id, choice: 'community', grade: '9' });
    const base = service.entity(id, 'personal')!;
    service.sync(id, { mutationId: randomUUID(), id: 'personal', kind: 'personal', base, data: { ...base.data, classes: [{ id: spanish, name: 'Spanish 2' }, { id: biology, name: 'Biology' }] } });
    const task = (title: string, extra: Record<string, unknown> = {}) => service.sync(id, { mutationId: randomUUID(), id: randomUUID(), kind: 'task', base: null,
      data: { title, dueDate: null, dueTime: null, classId: null, notes: '', completed: false, ...extra } });
    task('Lab write-up', { dueDate: weekStart, dueTime: '08:00', classId: biology, notes: 'Private note: ask Sam for the data' });
    task('Read chapter 6', { dueDate: addDays(weekStart, 6), classId: spanish });
    task('Vocabulary worksheet', { dueDate: addDays(weekStart, 1), classId: spanish, completed: true });
    task('Unit 3 test', { dueDate: addDays(today, 3), classId: biology });
    task('Long-ago essay', { dueDate: addDays(weekStart, -10) });
    db.prepare('INSERT INTO beta_members(beta_key,user_id,joined_at) VALUES(?,?,?)').run(AI_BETA, id, new Date().toISOString());
    return { id };
  } finally { db.close(); }
}
const sections = (id: string) => {
  const db = openDatabase(process.env.E2E_DATABASE_PATH!);
  try { return JSON.parse((db.prepare('SELECT sections FROM parent_summary_shares WHERE user_id=?').get(id) as { sections: string } | undefined)?.sections ?? 'null'); }
  finally { db.close(); }
};

const contexts: BrowserContext[] = [];
test.afterEach(async () => { await Promise.all(contexts.splice(0).map((context) => context.close())); });
async function signedIn(browser: Browser, id: string): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  contexts.push(context);
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const token = await encode({ secret: process.env.E2E_AUTH_SECRET!, token: { userId: id, authAt: Date.now() }, maxAge: 3600 });
  await context.addCookies([{ name: 'next-auth.session-token', value: token, domain: 'localhost', path: '/', httpOnly: true, sameSite: 'Lax', expires: Date.now() / 1000 + 3600 }]);
  return hydrating(await context.newPage());
}
/** A parent's phone: a separate browser with no Quasar cookies at all. */
async function parent(browser: Browser, width = 390): Promise<Page> {
  const context = await browser.newContext({ viewport: { width, height: 844 }, hasTouch: true, isMobile: true });
  contexts.push(context);
  return hydrating(await context.newPage());
}
async function openAccount(page: Page) {
  await page.getByRole('button', { name: 'Account', exact: true }).click();
  return page.getByRole('dialog', { name: 'Account', exact: true });
}

test('parent summary: the student shares chosen sections through a private link, and turning it off kills it', async ({ browser }) => {
  test.setTimeout(120_000);
  const f = seed();
  const page = await signedIn(browser, f.id);
  await page.goto('/tasks');
  let account = await openAccount(page);
  // Billing is off on the test server, so there is no Plus pitch and the summary is unlocked.
  await expect(account.getByText('A weekly summary for a parent')).toHaveCount(0);
  const toggle = account.getByRole('switch', { name: 'Share a weekly summary with a parent' });
  await toggle.scrollIntoViewIfNeeded();
  await expect(toggle).not.toBeChecked();
  await toggle.click();
  const field = account.getByRole('textbox', { name: 'Summary link' });
  await expect(field).toHaveValue(/\/summary\/[A-Za-z0-9_-]{43}$/);
  const link = await field.inputValue();
  // Only the first section starts ticked.
  await expect(account.getByRole('checkbox', { name: /Tasks due this week/ })).toBeChecked();
  for (const name of [/How many tasks are overdue/, /Upcoming tests and quizzes/, /What you finished this week/]) await expect(account.getByRole('checkbox', { name })).not.toBeChecked();
  await account.getByRole('checkbox', { name: /Upcoming tests and quizzes/ }).click();
  await expect.poll(() => sections(f.id)).toEqual({ dueThisWeek: true, overdue: false, assessments: true, completed: false });
  await account.getByRole('button', { name: 'Copy' }).click();
  await expect(account.getByRole('button', { name: 'Copied' })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(link);
  await expect(account.getByText('Nobody has opened this link yet.')).toBeVisible();
  await account.getByRole('group', { name: 'What the link shows' }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: test.info().outputPath('settings-light.png') });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.screenshot({ path: test.info().outputPath('settings-dark.png') });
  await page.emulateMedia({ colorScheme: 'light' });

  // The preview is the parent's page.
  await account.getByRole('button', { name: 'Preview' }).click();
  const preview = page.getByRole('dialog', { name: 'What your parent sees' });
  await expect(preview.getByRole('heading', { name: 'Ada’s week' })).toBeVisible();
  await expect(preview.getByRole('region', { name: 'Upcoming tests and quizzes' })).toContainText('Unit 3 test');
  await expect(preview.getByRole('region', { name: 'Overdue' })).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath('preview-light.png') });
  await preview.getByRole('button', { name: 'Done' }).click();

  // A logged-out browser sees only the chosen sections, the first name, and no notes.
  const mom = await parent(browser);
  const response = await mom.goto(link);
  expect(response!.status()).toBe(200);
  const headers = response!.headers();
  expect(headers['referrer-policy']).toBe('no-referrer');
  expect(headers['x-robots-tag']).toContain('noindex');
  expect(headers['cache-control']).toContain('no-store');
  await expect(mom.locator('meta[name="robots"]')).toHaveAttribute('content', /noindex/);
  await expect(mom.locator('meta[name="referrer"]')).toHaveAttribute('content', 'no-referrer');
  await expect(mom).toHaveTitle('Weekly summary · Quasar');
  await expect(mom.getByRole('heading', { level: 1, name: 'Ada’s week' })).toBeVisible();
  const due = mom.getByRole('region', { name: 'Due this week' });
  await expect(due.getByRole('listitem').filter({ hasText: 'Vocabulary worksheet' })).toContainText('Done');
  await expect(due.getByRole('listitem').filter({ hasText: 'Read chapter 6' })).toContainText(/Not done yet|Overdue/);
  await expect(due).toContainText('Biology');
  await expect(mom.getByRole('region', { name: 'Upcoming tests and quizzes' }).getByRole('listitem').filter({ hasText: 'Unit 3 test' })).toContainText('Test');
  await expect(mom.getByRole('region', { name: 'Overdue' })).toHaveCount(0);
  await expect(mom.getByRole('region', { name: 'Completed this week' })).toHaveCount(0);
  const body = await mom.locator('body').innerText();
  for (const hidden of ['Private note', 'ask Sam', 'Tester', 'Long-ago essay']) expect(body).not.toContain(hidden);
  await mom.screenshot({ path: test.info().outputPath('parent-light.png'), fullPage: true });
  await mom.emulateMedia({ colorScheme: 'dark' });
  await mom.screenshot({ path: test.info().outputPath('parent-dark.png'), fullPage: true });
  const narrow = await parent(browser, 360);
  await narrow.goto(link);
  expect(await narrow.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);
  await narrow.screenshot({ path: test.info().outputPath('parent-360.png'), fullPage: true });

  // The student sees the views.
  await page.keyboard.press('Escape');
  await expect(account).toHaveCount(0);
  account = await openAccount(page);
  await expect(account.getByText(/^Last viewed .+ Opened 2 times since this link was made\.$/)).toBeVisible();
  // The link isn't shown again: the server keeps only its hash.
  await expect(account.getByRole('textbox', { name: 'Summary link' })).toHaveCount(0);

  // A new link kills the old one.
  await account.getByRole('button', { name: 'Make a new link' }).click();
  await page.getByRole('dialog', { name: 'Make a new link?' }).getByRole('button', { name: 'Make a new link' }).click();
  await expect(account.getByRole('textbox', { name: 'Summary link' })).toHaveValue(/\/summary\/[A-Za-z0-9_-]{43}$/);
  const fresh = await account.getByRole('textbox', { name: 'Summary link' }).inputValue();
  expect(fresh).not.toBe(link);
  await mom.goto(link);
  await expect(mom.getByRole('heading', { name: 'This link doesn’t work' })).toBeVisible();
  await expect(mom.getByText('Ada')).toHaveCount(0);
  await mom.goto(fresh);
  await expect(mom.getByRole('heading', { level: 1, name: 'Ada’s week' })).toBeVisible();

  // Turning it off kills the link.
  await account.getByRole('switch', { name: 'Share a weekly summary with a parent' }).click();
  await expect(account.getByRole('switch', { name: 'Share a weekly summary with a parent' })).not.toBeChecked();
  await expect.poll(() => sections(f.id)).toBeNull();
  await mom.goto(fresh);
  await expect(mom.getByRole('heading', { name: 'This link doesn’t work' })).toBeVisible();
  await mom.emulateMedia({ colorScheme: 'light' });
  await mom.screenshot({ path: test.info().outputPath('parent-revoked.png') });
});
