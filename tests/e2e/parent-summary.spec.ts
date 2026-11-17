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

function seed() {
  const today = instantParts(new Date().toISOString(), exampleSchedule.timeZone).date;
  const weekStart = addDays(today, 1 - weekdayOf(today));
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

test('parent summary: settings omit sharing, while legacy API links remain private and revocable', async ({ browser }) => {
  test.setTimeout(120_000);
  const f = seed();
  const page = await signedIn(browser, f.id);
  // Show the real Plus pitch without configuring Stripe or changing server entitlements.
  await page.route(/\/api\/trpc\/.*billing\.status/, async route => {
    const response = await route.fetch();
    const json = await response.json();
    const billing = { result: { data: { enabled: true, plan: 'free', status: null, renewsAt: null, cancelAtPeriodEnd: false, hasCustomer: false, prices: [] } } };
    const methods = new URL(route.request().url()).pathname.split('/').pop()!.split(',');
    if (Array.isArray(json)) json[methods.indexOf('billing.status')] = billing;
    await route.fulfill({ response, json: Array.isArray(json) ? json : billing });
  });
  await page.goto('/tasks');
  const account = await openAccount(page);
  await expect(account.getByRole('list', { name: 'What Plus adds' })).toContainText('Plan my week');
  await expect(account.getByRole('list', { name: 'What Plus adds' })).not.toContainText(/parent|summary/i);
  await expect(account.getByRole('switch', { name: 'Share a weekly summary with a parent' })).toHaveCount(0);
  await expect(account.getByRole('textbox', { name: 'Summary link' })).toHaveCount(0);
  await expect(account.getByText('A weekly summary for a parent')).toHaveCount(0);
  expect(sections(f.id)).toBeNull();

  // Exercise the legacy API without bringing its removed settings back.
  const mutate = async (method: string, extra = {}) => page.evaluate(async ({ method, input }) => {
    const response = await fetch(`/api/trpc/parentSummary.${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) });
    if (!response.ok) throw new Error(await response.text());
    return (await response.json()).result.data;
  }, { method, input: { accountId: f.id, ...extra } });
  const enabled = await mutate('enable');
  const link = new URL(`/summary/${enabled.token}`, page.url()).href;
  await mutate('setSections', { sections: { dueThisWeek: true, overdue: false, assessments: true, completed: false } });
  expect(sections(f.id)).toEqual({ dueThisWeek: true, overdue: false, assessments: true, completed: false });

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

  // A new link kills the old one.
  const regenerated = await mutate('regenerate');
  const fresh = new URL(`/summary/${regenerated.token}`, page.url()).href;
  expect(fresh).not.toBe(link);
  await mom.goto(link);
  await expect(mom.getByRole('heading', { name: 'This link doesn’t work' })).toBeVisible();
  await expect(mom.getByText('Ada')).toHaveCount(0);
  await mom.goto(fresh);
  await expect(mom.getByRole('heading', { level: 1, name: 'Ada’s week' })).toBeVisible();

  // Turning it off kills the link.
  await mutate('disable');
  await expect.poll(() => sections(f.id)).toBeNull();
  await mom.goto(fresh);
  await expect(mom.getByRole('heading', { name: 'This link doesn’t work' })).toBeVisible();
  await mom.emulateMedia({ colorScheme: 'light' });
  await mom.screenshot({ path: test.info().outputPath('parent-revoked.png') });
});
