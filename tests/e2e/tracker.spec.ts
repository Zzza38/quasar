import { test, expect, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { encode } from 'next-auth/jwt';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../../src/server/db';
import { Service } from '../../src/server/service';
import { DirectoryService } from '../../src/server/directory';
import { CalendarService } from '../../src/server/calendar';
import { exampleSchedule } from '../../src/domain/example';

function seed(email = `${randomUUID()}@example.com`, joined = true, schedule = exampleSchedule) {
  const db = openDatabase(process.env.E2E_DATABASE_PATH!);
  try {
    const id = randomUUID();
    db.prepare('INSERT INTO users(id,google_sub,email,display_name,full_name,created_at) VALUES(?,?,?,?,?,?)')
      .run(id, id, email, 'Browser Student', 'Browser Test Student', new Date().toISOString());
    const service = new Service(db, 'browser-owner@example.com');
    const school = service.createSchool(id, { name: `Browser High ${id.slice(0, 6)}`, location: 'Boston, MA', schedule });
    if (joined) service.join(id, { schoolId: school.id, choice: 'community' });
    return { id, school };
  } finally { db.close(); }
}

async function authenticate(context: BrowserContext, id: string) {
  // Test fixture issues a normal encrypted session. The application has no test-auth endpoint.
  const token = await encode({ secret: process.env.E2E_AUTH_SECRET!, token: { userId: id }, maxAge: 3600 });
  await context.addCookies([{ name: 'next-auth.session-token', value: token, domain: 'localhost', path: '/', httpOnly: true, sameSite: 'Lax', expires: Date.now() / 1000 + 3600 }]);
}

const saved = (page: Page) => page.getByRole('status').filter({ hasText: /^Saved$/ }).first();
const dialog = (page: Page) => page.getByRole('dialog');
/** Pick an option from a shadcn/ui Select by its visible label. */
async function choose(select: Locator, option: string) {
  await select.click();
  await select.page().getByRole('option', { name: option, exact: true }).click();
}

test('countdown reveals live seconds on hover and keyboard focus', async ({ page, context }) => {
  const fixture = seed(); await authenticate(context, fixture.id);
  await page.clock.setFixedTime(new Date('2026-09-17T12:51:37Z'));
  await page.goto('/');
  const countdown = page.getByRole('button', { name: /^Ends in/ });
  const tails = countdown.locator(':scope > span').filter({ has: page.locator('span') });
  await expect(countdown).toBeVisible();
  await expect(countdown).toHaveAccessibleName('Ends in 8 min');
  await expect.poll(async () => (await tails.last().boundingBox())?.width).toBe(0);
  await countdown.hover();
  await expect(countdown).toHaveAccessibleName('Ends in 8:23 (minutes and seconds)');
  await expect.poll(async () => (await tails.first().boundingBox())?.width).toBe(0);
  await expect.poll(async () => (await tails.last().boundingBox())?.width ?? 0).toBeGreaterThan(10);
  await page.clock.setFixedTime(new Date('2026-09-17T12:51:38Z'));
  await expect(countdown).toHaveAccessibleName('Ends in 8:22 (minutes and seconds)');
  await page.mouse.move(0, 0);
  await expect.poll(async () => (await tails.last().boundingBox())?.width).toBe(0);
  await page.keyboard.press('Tab');
  await countdown.focus();
  await expect(countdown).toHaveAccessibleName('Ends in 8:22 (minutes and seconds)');
  await page.keyboard.press('Tab');
  await expect.poll(async () => (await tails.last().boundingBox())?.width).toBe(0);
});

test.describe('touch countdown', () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });

  test('tapping toggles seconds and respects reduced motion', async ({ page, context }) => {
    const fixture = seed(); await authenticate(context, fixture.id);
    await page.clock.setFixedTime(new Date('2026-09-17T12:51:37Z'));
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/');
    const countdown = page.getByRole('button', { name: /^Ends in/ });
    await expect(countdown).toHaveAccessibleName('Ends in 8 min');
    await countdown.tap();
    await expect(countdown).toHaveAccessibleName('Ends in 8:23 (minutes and seconds)');
    await expect(countdown).toHaveAttribute('aria-pressed', 'true');
    await expect(countdown.locator(':scope > span').last()).toHaveCSS('transition-duration', '0s');
    await countdown.tap();
    await expect(countdown).toHaveAccessibleName('Ends in 8 min');
    await expect(countdown).toHaveAttribute('aria-pressed', 'false');
  });
});

async function quickAdd(page: Page, title: string) {
  await page.getByLabel('New task').fill(title);
  await page.getByLabel('New task').press('Enter');
  await expect(page.getByLabel(`Mark ${title} complete`)).toBeVisible();
}

test('requires sign-in, denies anonymous APIs and rejects cross-origin mutations', async ({ page, request }) => {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Continue with Google' })).toBeVisible();
  const response = await request.get('/api/trpc/workspace');
  expect(response.status()).toBe(401);
  const cross = await request.post('/api/trpc/profile.save', { headers: { origin: 'https://elsewhere.example' }, data: { displayName: 'No', fullName: 'No' } });
  expect(cross.status()).toBe(403);
});

test('explicit community choice, class and task persistence, offline reload and upload', async ({ page, context }) => {
  const fixture = seed(undefined, false); await authenticate(context, fixture.id);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Find your school' })).toBeVisible();
  await page.getByLabel('School name or location').fill(fixture.school.name);
  await page.getByRole('button', { name: fixture.school.name }).click();
  await expect(page.getByRole('heading', { name: 'Which schedule should Quasar follow?' })).toBeVisible();
  const join = page.getByRole('button', { name: `Join ${fixture.school.name}` });
  await expect(join).toBeDisabled();
  await choose(page.getByLabel('Your grade', { exact: true }), 'Grade 9');
  await page.getByRole('radio', { name: /Use the community schedule/ }).click();
  await join.click();
  // The wizard continues with the classes step; adding one here proves it lands in the synced personal schedule.
  await expect(page.getByRole('heading', { name: 'Add your classes' })).toBeVisible();
  await page.getByLabel('Class', { exact: true }).fill('Setup Chemistry');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.getByRole('group', { name: 'Periods for Setup Chemistry' })).toBeVisible();
  await page.getByRole('button', { name: 'Next: homework' }).click();
  // The homework calendar step explains Schoology first and rejects links that are not real feeds.
  await expect(page.getByRole('heading', { name: 'Get homework in automatically' })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Schoology' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByText(/Share Calendar/)).toBeVisible();
  await page.getByLabel('iCal link').fill('http://localhost/not-a-feed');
  await page.getByRole('button', { name: 'Connect calendar' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'HTTPS iCalendar feed' })).toBeVisible();
  await page.getByRole('button', { name: 'Skip for now' }).click();
  await expect(page.getByRole('heading', { name: /Browser Student/ })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Finish setting up' })).toBeVisible();
  await expect(page.getByText('Connect your homework calendar')).toBeVisible();
  await page.getByRole('button', { name: 'Hide setup checklist' }).click();
  await expect(page.getByRole('heading', { name: 'Finish setting up' })).toHaveCount(0);

  await page.getByRole('link', { name: 'Classes' }).click();
  await page.getByRole('button', { name: 'Add class', exact: true }).click();
  await dialog(page).getByLabel('Class name').fill('Biology');
  await dialog(page).getByRole('button', { name: 'Add class' }).click();
  await expect(page.getByRole('button', { name: 'Edit Biology' })).toBeVisible();
  await expect(saved(page)).toBeVisible();
  await page.getByRole('link', { name: 'Tasks' }).click();
  await quickAdd(page, 'Read biology chapter');
  await expect(saved(page)).toBeVisible();

  await page.reload();
  await expect(page.getByLabel('Mark Read biology chapter complete')).toBeVisible();
  await page.getByRole('link', { name: 'Classes' }).click();
  await expect(page.getByRole('button', { name: 'Edit Biology' })).toBeVisible();
  await page.waitForFunction(async () => {
    if (!navigator.serviceWorker.controller) return false;
    const names = await caches.keys();
    for (const name of names) if (name.startsWith('quasar-public-shell-') && await (await caches.open(name)).match('/')) return true;
    return false;
  });
  await context.setOffline(true);
  await page.goto('/#tasks');
  await page.reload();
  await expect(page.getByText('You’re offline.', { exact: false })).toBeVisible();
  // Completion moves the row into the collapsed completed section after IndexedDB commits.
  await page.getByLabel('Mark Read biology chapter complete').click();
  await expect(page.getByRole('button', { name: /Completed · 1/ })).toBeVisible();
  await quickAdd(page, 'Offline task');
  await page.reload();
  await expect(page.getByLabel('Mark Offline task complete')).toBeVisible();
  await page.getByRole('button', { name: /Completed · 1/ }).click();
  await expect(page.getByLabel('Mark Read biology chapter incomplete')).toBeChecked();
  await context.setOffline(false);
  await expect(saved(page)).toBeVisible({ timeout: 30000 });
  await page.reload();
  await expect(page.getByLabel('Mark Offline task complete')).toBeVisible();
  const db = openDatabase(process.env.E2E_DATABASE_PATH!);
  try {
    const rows = new Service(db).workspace(fixture.id).entities.filter((e) => e.kind === 'task' && !e.deleted);
    expect(rows).toHaveLength(2);
    expect(rows.find((e) => e.data.title === 'Read biology chapter')?.data.completed).toBe(true);
    expect(new Service(db).workspace(fixture.id).entities.find((e) => e.kind === 'personal')?.data).toMatchObject({ classes: expect.arrayContaining([expect.objectContaining({ id: 'Biology', name: 'Biology' }), expect.objectContaining({ name: 'Setup Chemistry' })]) });
  } finally { db.close(); }
});

test('admin UI enforces owner authorization and publishes locked approved revisions', async ({ page, context }) => {
  const student = seed(); await authenticate(context, student.id);
  await page.goto('/admin');
  await expect(page.getByText('This page is available to the project owner.')).toBeVisible();
  const owner = seed('browser-owner@example.com'); await authenticate(context, owner.id);
  await page.reload();
  const schoolRow = page.getByRole('row').filter({ hasText: owner.school.name });
  await schoolRow.getByRole('button', { name: `Review ${owner.school.name}` }).click();
  const approved = dialog(page).getByRole('switch', { name: 'Approved default schedule' });
  const locked = dialog(page).getByRole('switch', { name: 'Lock shared edits to support' });
  await approved.click(); await expect(approved).toHaveAttribute('aria-checked', 'true');
  await locked.click(); await expect(locked).toHaveAttribute('aria-checked', 'true');
  await dialog(page).getByRole('button', { name: 'Save school revision' }).click();
  await expect(dialog(page).getByText('Published')).toBeVisible();
  await dialog(page).getByRole('button', { name: 'Done', exact: true }).click();
  await expect(schoolRow).toContainText('Support locked');
  await expect(schoolRow).toContainText('Approved');
  const db = openDatabase(process.env.E2E_DATABASE_PATH!);
  try { expect(new Service(db).school(owner.school.id)).toMatchObject({ approved: true, supportLocked: true, version: 2 }); }
  finally { db.close(); }
});

test('competing device edits require a visible choice and sign-out clears the account cache', async ({ page, context, browser }) => {
  const fixture = seed(); await authenticate(context, fixture.id);
  await page.goto('/#tasks');
  await quickAdd(page, 'Original task');
  await expect(saved(page)).toBeVisible();
  const laptop = await browser.newContext(); await authenticate(laptop, fixture.id);
  try {
    const other = await laptop.newPage(); await other.goto('http://localhost:3100/#tasks');
    await expect(other.getByRole('button', { name: 'Edit Original task' })).toBeVisible();
    await context.setOffline(true);
    await page.getByRole('button', { name: 'Edit Original task' }).click();
    await dialog(page).getByLabel('Task', { exact: true }).fill('Phone title');
    await dialog(page).getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Edit Phone title' })).toBeVisible();
    await other.getByRole('button', { name: 'Edit Original task' }).click();
    await dialog(other).getByLabel('Task', { exact: true }).fill('Laptop title');
    await dialog(other).getByRole('button', { name: 'Save', exact: true }).click();
    await expect(saved(other)).toBeVisible();
    await context.setOffline(false);
    await expect(page.getByRole('heading', { name: 'Choose which changes to keep' })).toBeVisible({ timeout: 30000 });
    await expect(page.getByRole('cell', { name: 'Phone title' })).toBeVisible();
    await expect(page.getByRole('cell', { name: 'Laptop title' })).toBeVisible();
    await page.getByRole('button', { name: 'Keep my changes', exact: true }).click();
    await expect(saved(page)).toBeVisible();
    const db = openDatabase(process.env.E2E_DATABASE_PATH!);
    try { expect(new Service(db).workspace(fixture.id).entities.find((e) => e.kind === 'task')?.data.title).toBe('Phone title'); }
    finally { db.close(); }
    await page.getByRole('button', { name: /Browser Student/ }).click();
    await dialog(page).getByRole('button', { name: 'Sign out', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Continue with Google' })).toBeVisible();
    const cached = await page.evaluate(async (accountId) => {
      return await new Promise<boolean>((resolve, reject) => {
        const request = indexedDB.open('whatsnext-offline-v1');
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          const get = db.transaction('workspaces').objectStore('workspaces').get(accountId);
          get.onsuccess = () => { db.close(); resolve(Boolean(get.result)); };
          get.onerror = () => { db.close(); reject(get.error); };
        };
      });
    }, fixture.id);
    expect(cached).toBe(false);
    expect((await context.cookies()).some((cookie) => cookie.name === 'next-auth.session-token')).toBe(false);
  } finally { await laptop.close(); }
});

test('shared schedule edits use the structured editor and appear as a reviewable correction', async ({ page, context }) => {
  const fixture = seed(); await authenticate(context, fixture.id);
  await page.goto('/#school');
  await page.getByRole('button', { name: 'Edit shared schedule' }).click();
  await dialog(page).getByRole('tab', { name: /^Periods/ }).click();
  await dialog(page).getByLabel('Period 1 name').fill('Advisory');
  await dialog(page).getByRole('button', { name: 'Publish revision' }).click();
  await expect(dialog(page)).toBeHidden();
  await expect(page.getByText('Revision 2')).toBeVisible();
  const db = openDatabase(process.env.E2E_DATABASE_PATH!);
  try { expect(new Service(db).school(fixture.school.id).schedule.gradeSchedules?.['9']?.periods[0].label).toBe('Advisory'); }
  finally { db.close(); }
});

test('planner navigation, date browsing and mobile layout remain usable', async ({ page, context }, testInfo) => {
  const fixture = seed(); await authenticate(context, fixture.id);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/#classes');
  await page.getByRole('button', { name: 'Add class', exact: true }).click();
  await dialog(page).getByLabel('Class name').fill('Biology');
  await dialog(page).getByLabel('Room').fill('Lab 2');
  await dialog(page).getByRole('button', { name: 'Add class' }).click();
  await page.getByRole('button', { name: 'Place Biology', exact: true }).click();
  await page.getByRole('button', { name: 'Day 1, 8:00–9:00 AM: A', exact: true }).click();
  await expect(saved(page)).toBeVisible();
  await page.getByRole('link', { name: 'Today' }).click();
  await quickAdd(page, 'Read the next chapter');
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: testInfo.outputPath('today-desktop.png'), fullPage: true });
  await page.getByRole('link', { name: 'Schedule' }).click();
  const date = page.getByLabel('Go to date');
  await expect(date).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('schedule-desktop.png'), fullPage: true });

  await page.setViewportSize({ width: 390, height: 844 });
  await date.fill('2026-09-12');
  await expect(page.getByText('No periods on this date.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Today', exact: true }).click();
  await expect(date).not.toHaveValue('2026-09-12');
  await page.getByRole('link', { name: 'Tasks' }).click();
  await expect(page.getByRole('heading', { name: 'Tasks', exact: true })).toBeInViewport();
  await page.getByLabel('Mark Read the next chapter complete').click();
  await expect(page.getByRole('button', { name: /Completed · 1/ })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByRole('link', { name: 'Today' }).click();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: testInfo.outputPath('today-mobile.png'), fullPage: true });
  await page.getByRole('link', { name: 'Schedule' }).click();
  await page.screenshot({ path: testInfo.outputPath('schedule-mobile.png'), fullPage: true });
});

test('collapsed navigation centers icons and retains accessible links', async ({ page, context }, testInfo) => {
  const fixture = seed(); await authenticate(context, fixture.id);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: 'dark' });
  await page.goto('/#classes');
  await page.getByRole('button', { name: 'Collapse navigation sidebar' }).click();
  const sidebar = page.locator('.app-sidebar');
  const verify = async () => {
    const rail = (await sidebar.boundingBox())!;
    expect(rail.width).toBe(56);
    for (const name of ['Today', 'Schedule', 'Tasks', 'Classes', 'School']) {
      const link = sidebar.getByRole('link', { name, exact: true });
      await expect(link).toBeVisible();
      await expect(link.locator('span')).toBeHidden();
      const icon = (await link.locator('svg').boundingBox())!;
      expect(Math.abs(icon.x + icon.width / 2 - (rail.x + rail.width / 2))).toBeLessThanOrEqual(1);
    }
  };
  await verify();
  await sidebar.getByRole('link', { name: 'School', exact: true }).click();
  await expect(page.getByRole('heading', { name: fixture.school.name })).toBeVisible();
  await page.reload();
  const openSidebar = page.getByRole('button', { name: 'Open sidebar', exact: true });
  await expect(openSidebar).toBeVisible();
  await verify();
  await page.mouse.move(600, 400);
  await page.screenshot({ path: testInfo.outputPath('collapsed-sidebar.png') });
  await expect(openSidebar.locator('[data-slot="sidebar-logo"]')).toBeVisible();
  await expect(openSidebar.locator('[data-slot="sidebar-open-icon"]')).toBeHidden();
  await expect(sidebar.locator('[data-slot="sidebar-header"] button')).toHaveCount(1);
  await openSidebar.hover();
  await expect(openSidebar.locator('[data-slot="sidebar-logo"]')).toBeHidden();
  await expect(openSidebar.locator('[data-slot="sidebar-open-icon"]')).toBeVisible();
  await expect(page.getByRole('tooltip', { name: 'Open sidebar' })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('collapsed-sidebar-hover.png') });
  await openSidebar.click();
  await expect(sidebar.getByRole('link', { name: 'Classes', exact: true }).locator('span')).toBeVisible();
});

test('empty tasks fill the available width with one responsive navigation shell', async ({ page, context }, testInfo) => {
  const fixture = seed(); await authenticate(context, fixture.id);
  await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: 'dark' });
  await page.goto('/#tasks');
  await expect(page.getByRole('heading', { name: 'All clear', exact: true })).toBeVisible();
  for (const width of [2048, 1280, 1024, 1023, 390]) {
    await page.setViewportSize({ width, height: 900 });
    const desktop = width >= 1024;
    await expect(page.locator('.app-sidebar')).toBeVisible({ visible: desktop });
    await expect(page.locator('.app-topbar')).toBeVisible({ visible: !desktop });
    await expect(page.locator('.tabbar')).toBeVisible({ visible: !desktop });
    await expect(page.getByRole('link', { name: 'Quasar home' })).toHaveCount(1);
    const main = await page.locator('.app-main').boundingBox();
    expect(main!.width).toBe(Math.min(1120, width - (desktop ? 240 : 0)));
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`tasks-${width}.png`), fullPage: true });
  }
});

test('remaining screens render without horizontal overflow on desktop and mobile', async ({ page, context }, testInfo) => {
  const fixture = seed(); await authenticate(context, fixture.id);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const fits = async () => expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  for (const [name, width] of [['desktop', 1280], ['mobile', 390]] as const) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/#classes');
    await expect(page.getByRole('heading', { name: 'Classes', exact: true })).toBeVisible();
    await fits();
    await page.screenshot({ path: testInfo.outputPath(`classes-${name}.png`), fullPage: true });
    await page.getByRole('link', { name: 'School' }).click();
    await expect(page.getByRole('heading', { name: fixture.school.name })).toBeVisible();
    await fits();
    await page.screenshot({ path: testInfo.outputPath(`school-${name}.png`), fullPage: true });
    await page.getByRole('button', { name: 'Edit shared schedule' }).click();
    await dialog(page).getByRole('tab', { name: /^Days/ }).click();
    await page.screenshot({ path: testInfo.outputPath(`editor-${name}.png`) });
    await page.keyboard.press('Escape');
  }
  // Theme preferences: chosen in the account sheet, applied immediately, and persisted across reloads.
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/#today');
  await expect(page.getByRole('heading', { name: /Browser Student/ })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-accent', 'ocean');
  await page.getByRole('button', { name: /Browser Student/ }).click();
  await dialog(page).getByRole('radio', { name: 'Indigo' }).click();
  await dialog(page).getByRole('radio', { name: 'Dark' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-accent', 'indigo');
  await expect(page.locator('html')).toHaveAttribute('data-appearance', 'dark');
  await page.screenshot({ path: testInfo.outputPath('theme-picker.png') });
  await page.keyboard.press('Escape');
  await page.reload();
  await expect(page.getByRole('heading', { name: /Browser Student/ })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-accent', 'indigo');
  await expect(page.locator('html')).toHaveAttribute('data-appearance', 'dark');
  await page.screenshot({ path: testInfo.outputPath('today-dark-indigo.png') });
  await page.evaluate(() => { localStorage.removeItem('quasar.accent'); localStorage.removeItem('quasar.appearance'); });

  const newcomer = seed(undefined, false); await authenticate(context, newcomer.id);
  await page.goto('/');
  await page.getByLabel('School name or location').fill(newcomer.school.name);
  await page.getByRole('button', { name: newcomer.school.name }).click();
  await expect(page.getByRole('heading', { name: 'Which schedule should Quasar follow?' })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('onboarding-choice.png'), fullPage: true });
  await page.getByRole('button', { name: 'Back' }).click();
  await page.getByRole('button', { name: 'Add a school' }).click();
  await page.getByLabel('School name').fill('Screenshot High');
  await page.getByLabel('City and state').fill('Austin, TX');
  await page.getByRole('button', { name: 'Set up the schedule' }).click();
  await expect(page.getByRole('heading', { name: 'What are the periods called?' })).toBeVisible();
  await fits();
  await page.screenshot({ path: testInfo.outputPath('onboarding-create-periods.png'), fullPage: true });
  await page.getByRole('button', { name: 'Next: bell times' }).click();
  await expect(page.getByRole('heading', { name: 'Bell times on a normal day' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Next: rotation days' })).toBeDisabled();
  await fits();
  await page.screenshot({ path: testInfo.outputPath('onboarding-create-times.png'), fullPage: true });

  const owner = seed('browser-owner@example.com'); await authenticate(context, owner.id);
  await page.goto('/admin');
  await page.getByRole('button', { name: `Review ${owner.school.name}` }).click();
  await expect(dialog(page)).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('admin-review.png') });
});

test('sign-in page fits desktop and mobile screens', async ({ page }, testInfo) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/');
    await expect(page.getByRole('button', { name: 'Continue with Google' })).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`sign-in-${width}.png`), fullPage: true });
  }
});


test('rich tasks persist and completing a recurring checklist creates one fresh occurrence', async ({ page, context }) => {
  const fixture = seed(); await authenticate(context, fixture.id);
  await page.goto('/#tasks');
  await page.getByRole('button', { name: 'New task', exact: true }).click();
  await dialog(page).getByLabel('Task', { exact: true }).fill('Weekly lab preparation');
  await dialog(page).getByLabel('Due date', { exact: true }).fill('2026-09-14');
  await dialog(page).getByLabel('Due time', { exact: true }).fill('15:00');
  await choose(dialog(page).getByLabel('Priority', { exact: true }), 'High');
  await dialog(page).getByRole('button', { name: 'Add checklist item', exact: true }).click();
  await dialog(page).getByLabel('Checklist item 1', { exact: true }).fill('Read the safety notes');
  await dialog(page).getByLabel('Complete checklist item 1', { exact: true }).check();
  await dialog(page).getByRole('button', { name: 'Add checklist item', exact: true }).click();
  await dialog(page).getByLabel('Checklist item 2', { exact: true }).fill('Pack the notebook');
  await choose(dialog(page).getByLabel('Repeat', { exact: true }), 'Weekly');
  await choose(dialog(page).getByLabel('Reminder', { exact: true }), '30 minutes before');
  await dialog(page).getByRole('button', { name: 'Add task', exact: true }).click();
  await expect(saved(page)).toBeVisible();
  await page.reload();
  const row = page.getByRole('listitem').filter({ has: page.getByRole('button', { name: 'Edit Weekly lab preparation', exact: true }) });
  await expect(row).toContainText('High priority');
  await expect(row).toContainText('1/2 checklist');
  await expect(row).toContainText('Repeats weekly');
  await choose(page.getByLabel('Priority', { exact: true }), 'Low');
  await expect(page.getByRole('button', { name: 'Edit Weekly lab preparation', exact: true })).toBeHidden();
  await choose(page.getByLabel('Priority', { exact: true }), 'High');
  // Completing replaces this checkbox with the fresh successor, which is intentionally unchecked.
  await page.getByLabel('Mark Weekly lab preparation complete', { exact: true }).click();
  await expect(page.getByRole('button', { name: /Completed · 1/ })).toBeVisible();
  // The server-generated successor must arrive through sync without a page reload.
  await expect(page.getByLabel('Mark Weekly lab preparation complete', { exact: true })).toBeVisible({ timeout: 30000 });
  await expect(saved(page)).toBeVisible();
  await expect(row).toContainText('0/2 checklist');
  await page.getByRole('button', { name: 'Edit Weekly lab preparation', exact: true }).click();
  await expect(dialog(page).getByLabel('Due date', { exact: true })).toHaveValue('2026-09-21');
  await expect(dialog(page).getByLabel('Reminder', { exact: true })).toHaveText('30 minutes before');
  await expect(dialog(page).getByLabel('Complete checklist item 1', { exact: true })).not.toBeChecked();
  await page.keyboard.press('Escape');
  await page.reload();
  await expect(page.getByLabel('Mark Weekly lab preparation complete', { exact: true })).toHaveCount(1);
  const db = openDatabase(process.env.E2E_DATABASE_PATH!);
  try {
    const tasks = new Service(db).workspace(fixture.id).entities.filter(e => e.kind === 'task' && !e.deleted);
    expect(tasks).toHaveLength(2);
    expect(tasks.filter(e => e.data.completed)).toHaveLength(1);
    expect(tasks.find(e => !e.data.completed)?.data).toMatchObject({ dueDate: '2026-09-21', priority: 'high', subtasks: [{ completed: false }, { completed: false }], reminder: { minutesBefore: 30 } });
  } finally { db.close(); }
});

test('imported homework stays visible and grayed in the calendar after completion and refresh', async ({ page, context }) => {
  const fixture = seed();
  const db = openDatabase(process.env.E2E_DATABASE_PATH!);
  let now = new Date('2026-09-11T12:00:00Z');
  const calendars = new CalendarService(db, {
    secret: process.env.E2E_AUTH_SECRET!, now: () => now,
    fetcher: async () => ({ status: 200, text: [
      'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Quasar//Browser fixture//EN',
      'BEGIN:VEVENT', 'UID:browser-homework', 'DTSTAMP:20260911T120000Z',
      'DTSTART;VALUE=DATE:20260914', 'DTEND;VALUE=DATE:20260915',
      'SUMMARY:Imported biology worksheet', 'END:VEVENT', 'END:VCALENDAR', '',
    ].join('\r\n') }),
  });
  try {
    const feed = await calendars.subscribe(fixture.id, { name: 'Biology calendar', url: 'https://calendar.example.com/private-test-feed.ics', timeZone: 'America/New_York' });
    expect(feed.lastError).toBeNull();
    await authenticate(context, fixture.id);
    await page.goto('/#schedule');
    await page.getByLabel('Go to date').fill('2026-09-14');
    const entry = page.getByRole('listitem').filter({ has: page.getByRole('button', { name: 'Imported biology worksheet', exact: true }) });
    await expect(entry).toContainText('Biology calendar');
    await expect(entry).toContainText('All day');
    await page.getByLabel('Complete: Imported biology worksheet', { exact: true }).click();
    await expect(entry).toContainText('Completed');
    await expect(entry.getByRole('button', { name: 'Imported biology worksheet', exact: true })).toHaveCSS('text-decoration-line', 'line-through');
    await expect(entry).toHaveCSS('opacity', '0.6');
    await expect(saved(page)).toBeVisible();
    now = new Date('2026-09-11T13:00:00Z');
    await calendars.refresh(fixture.id, feed.id);
    await page.reload();
    await page.getByLabel('Go to date').fill('2026-09-14');
    await expect(page.getByLabel('Mark incomplete: Imported biology worksheet', { exact: true })).toBeChecked();
    await expect(entry).toHaveCSS('opacity', '0.6');
    await page.getByRole('link', { name: 'Tasks', exact: true }).click();
    await page.getByRole('button', { name: /Completed · 1/ }).click();
    await expect(page.getByLabel('Mark Imported biology worksheet incomplete', { exact: true })).toBeChecked();
    expect(new Service(db).workspace(fixture.id).entities.filter(e => e.kind === 'task' && !e.deleted)).toHaveLength(1);
  } finally { db.close(); }
});

test('edits one high-school grade and copies its schedule to other grades', async ({ page, context }) => {
  const fixture = seed(); await authenticate(context, fixture.id);
  await page.goto('/#school');
  await page.getByRole('button', { name: 'Edit shared schedule' }).click();
  const grades = dialog(page).getByRole('radiogroup', { name: 'Grade to edit', exact: true });
  await expect(grades.getByRole('radio', { name: 'Grade 9', exact: true })).toHaveAttribute('aria-checked', 'true');
  await expect(grades.getByRole('radio')).toHaveText(['Grade 9', 'Grade 10', 'Grade 11', 'Grade 12']);
  await expect(dialog(page).getByRole('group', { name: 'Copy to', exact: true }).getByRole('button', { name: 'Grade 9', exact: true })).toHaveCount(0);
  await dialog(page).getByRole('group', { name: 'Copy to', exact: true }).getByRole('button', { name: 'Grade 10', exact: true }).click();
  await dialog(page).getByRole('tab', { name: /Days ·/ }).click();
  await dialog(page).getByLabel('Day 1 name', { exact: true }).fill('Junior day');
  await grades.getByRole('radio', { name: 'Grade 11', exact: true }).click();
  await dialog(page).getByRole('tab', { name: /Days ·/ }).click();
  await expect(dialog(page).getByLabel('Day 1 name', { exact: true })).toHaveValue(fixture.school.schedule.cycleDays[0].label);
  await grades.getByRole('radio', { name: 'Grade 9 (edited)', exact: true }).click();
  await dialog(page).getByRole('tab', { name: /Days ·/ }).click();
  await expect(dialog(page).getByLabel('Day 1 name', { exact: true })).toHaveValue('Junior day');
  await dialog(page).getByRole('group', { name: 'Copy to', exact: true }).getByRole('button', { name: 'Grade 10', exact: true }).click();
  await dialog(page).getByRole('button', { name: 'Publish revision' }).click();
  await expect(dialog(page)).toHaveCount(0);
  await page.getByRole('radiogroup', { name: 'Your grade', exact: true }).getByRole('radio', { name: 'Grade 9', exact: true }).click();
  await expect(saved(page)).toBeVisible();
  await page.reload();
  await expect(page.getByRole('radiogroup', { name: 'Your grade', exact: true }).getByRole('radio', { name: 'Grade 9', exact: true })).toHaveAttribute('aria-checked', 'true');
  await page.getByRole('button', { name: 'Edit shared schedule' }).click();
  await dialog(page).getByRole('tab', { name: /Days ·/ }).click();
  await expect(dialog(page).getByLabel('Day 1 name', { exact: true })).toHaveValue('Junior day');
  await grades.getByRole('radio', { name: 'Grade 10', exact: true }).click();
  await dialog(page).getByRole('tab', { name: /Days ·/ }).click();
  await expect(dialog(page).getByLabel('Day 1 name', { exact: true })).toHaveValue('Junior day');
  await grades.getByRole('radio', { name: 'Grade 12', exact: true }).click();
  await dialog(page).getByRole('tab', { name: /Days ·/ }).click();
  await expect(dialog(page).getByLabel('Day 1 name', { exact: true })).toHaveValue(fixture.school.schedule.cycleDays[0].label);
  await dialog(page).getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('radiogroup', { name: 'Your grade', exact: true }).getByRole('radio', { name: 'Grade 11', exact: true }).click();
  await expect(saved(page)).toBeVisible();
  await page.getByRole('button', { name: 'Edit shared schedule' }).click();
  await dialog(page).getByRole('tab', { name: /Days ·/ }).click();
  await expect(dialog(page).getByLabel('Day 1 name', { exact: true })).toHaveValue(fixture.school.schedule.cycleDays[0].label);
  await dialog(page).getByRole('group', { name: 'Copy from', exact: true }).getByRole('button', { name: 'Grade 9', exact: true }).click();
  await expect(dialog(page).getByLabel('Day 1 name', { exact: true })).toHaveValue('Junior day');
  await dialog(page).getByRole('button', { name: 'Publish revision' }).click();
  await expect(dialog(page)).toHaveCount(0);
});

test('schedule times infer AM and PM while typing and allow manual overrides', async ({ page, context }) => {
  const fixture = seed(); await authenticate(context, fixture.id);
  await page.goto('/#school');
  await page.getByRole('button', { name: 'Edit shared schedule' }).click();
  await dialog(page).getByRole('tab', { name: /Days ·/ }).click();
  await dialog(page).getByRole('button', { name: `Edit times for ${fixture.school.schedule.cycleDays[0].label}`, exact: true }).click();
  const end = dialog(page).getByLabel('Slot 4 end', { exact: true });
  const meridiem = dialog(page).getByRole('button', { name: 'Slot 4 end AM/PM', exact: true });
  await end.fill('12:15');
  await expect(meridiem).toHaveText('PM');
  await end.fill('11:55');
  await expect(meridiem).toHaveText('AM');
  await end.fill('11:55 PM');
  await end.fill('');
  await end.pressSequentially('12:15');
  await expect(meridiem).toHaveText('AM');
  await end.fill('');
  await end.pressSequentially('11:55');
  await expect(meridiem).toHaveText('PM');
  await end.fill('9:15');
  await expect(meridiem).toHaveText('AM');
  await end.fill('1:30');
  await expect(meridiem).toHaveText('PM');
  await meridiem.click();
  await expect(meridiem).toHaveText('AM');
  await end.fill('1:45');
  await expect(meridiem).toHaveText('AM');
  await end.fill('1:45 PM');
  await expect(meridiem).toHaveText('PM');
  await end.fill('1:');
  await expect(dialog(page).getByRole('button', { name: 'Publish revision' })).toBeDisabled();
  await end.fill('1:30');
  await dialog(page).getByRole('button', { name: 'Publish revision' }).click();
  await expect(dialog(page)).toHaveCount(0);
  await page.reload();
  await page.getByRole('button', { name: 'Edit shared schedule' }).click();
  await dialog(page).getByRole('tab', { name: /Days ·/ }).click();
  await dialog(page).getByRole('button', { name: `Edit times for ${fixture.school.schedule.cycleDays[0].label}`, exact: true }).click();
  await expect(end).toHaveValue('1:30');
  await expect(meridiem).toHaveText('PM');
});

test('exception stays open while its date is typed and rejects a duplicate date', async ({ page, context }) => {
  const fixture = seed(); await authenticate(context, fixture.id);
  await page.goto('/#school');
  await page.getByRole('button', { name: 'Edit shared schedule' }).click();
  await dialog(page).getByRole('tab', { name: /Exceptions ·/ }).click();
  await dialog(page).getByRole('button', { name: 'Add exception' }).click();
  const date = dialog(page).getByLabel('Date', { exact: true });
  await expect(date).toBeVisible();
  // Keyboard entry passes through intermediate dates; the row must stay open and focused throughout.
  await date.focus();
  await date.pressSequentially('03152031');
  await expect(date).toBeFocused();
  await expect(date).toHaveValue('2031-03-15');
  await dialog(page).getByRole('radio', { name: 'Restart rotation' }).click();
  await expect(date).toHaveValue('2031-03-15');
  await expect(dialog(page).getByRole('button', { name: 'Remove exception on 2031-03-15' })).toBeVisible();
  await expect(dialog(page).getByLabel('Rotation day on this date')).toBeVisible();
  await dialog(page).getByRole('button', { name: 'Add exception' }).click();
  await expect(date).toHaveCount(1);
  await date.fill('2031-03-15');
  await expect(dialog(page).getByRole('alert').filter({ hasText: 'Another exception already uses this date.' })).toBeVisible();
  await date.blur();
  await expect(dialog(page).getByRole('button', { name: 'Remove exception on 2031-03-15' })).toHaveCount(1);
  await expect(date).not.toHaveValue('2031-03-15');
});

test('time canvas fits desktop, groups weeks, and drags and resizes freely timed blocks', async ({ page, context }) => {
  const fixture = seed(); await authenticate(context, fixture.id);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/#school');
  await page.getByRole('button', { name: 'Edit shared schedule' }).click();
  await dialog(page).getByRole('group', { name: 'School days', exact: true }).getByRole('button', { name: 'Sat', exact: true }).click();
  await dialog(page).getByRole('tab', { name: /Days ·/ }).click();
  await dialog(page).getByRole('button', { name: 'Add rotation day' }).click();
  await dialog(page).getByRole('button', { name: 'Add rotation day' }).click();
  await expect(dialog(page).getByRole('region', { name: /Rotation week/ })).toHaveCount(2);
  expect(await dialog(page).locator('.time-canvas-scroll').first().evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  const day = dialog(page).getByRole('group', { name: 'Day 1 time canvas', exact: true });
  await dialog(page).getByRole('button', { name: 'Place D', exact: true }).dragTo(day.getByRole('button', { name: 'Place in Day 1 at 2:00 PM', exact: true }), { targetPosition: { x: 40, y: 1 } });
  await expect(day.getByRole('button', { name: 'Day 1, 2:00–2:45 PM: D', exact: true })).toBeVisible();
  const edge = day.getByRole('button', { name: 'Resize Day 1 D end', exact: true });
  await edge.scrollIntoViewIfNeeded();
  const box = (await edge.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + 19.5, { steps: 5 });
  await page.mouse.up();
  await expect(day.getByRole('button', { name: 'Day 1, 2:00–3:00 PM: D', exact: true })).toBeVisible();
  await dialog(page).getByRole('button', { name: 'Publish revision' }).click();
  await expect(dialog(page)).toHaveCount(0);
  await page.reload();
  await page.getByRole('button', { name: 'Edit shared schedule' }).click();
  await dialog(page).getByRole('tab', { name: /Days ·/ }).click();
  await expect(day.getByRole('button', { name: 'Day 1, 2:00–3:00 PM: D', exact: true })).toHaveCount(1);
});

test('custom class color persists and appears on the class card', async ({ page, context }) => {
  const fixture = seed(); await authenticate(context, fixture.id);
  await page.goto('/#classes');
  await page.getByRole('button', { name: 'Add class', exact: true }).click();
  await dialog(page).getByLabel('Class name').fill('Biology');
  await dialog(page).getByLabel('Class color', { exact: true }).fill('#ff0088');
  await dialog(page).getByRole('button', { name: 'Add class', exact: true }).click();
  await expect(saved(page)).toBeVisible();
  await page.reload();
  const card = page.getByRole('listitem').filter({ has: page.getByRole('button', { name: 'Edit Biology' }) });
  await expect(card).toHaveCSS('border-top-color', 'rgb(255, 0, 136)');
  await page.getByRole('button', { name: 'Edit Biology' }).click();
  await expect(dialog(page).getByLabel('Class color', { exact: true })).toHaveValue('#ff0088');
  await dialog(page).getByRole('button', { name: 'Use automatic color' }).click();
  await dialog(page).getByRole('button', { name: 'Save', exact: true }).click();
  await expect(saved(page)).toBeVisible();
  await expect(card).not.toHaveCSS('border-top-color', 'rgb(255, 0, 136)');
});

test.describe('class color bar', () => {
  test.use({ hasTouch: true });

  test('hover, keyboard and touch expose persistent color controls', async ({ page, context }, testInfo) => {
    const fixture = seed(); await authenticate(context, fixture.id);
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto('/#classes');
    await page.getByRole('button', { name: 'Add class', exact: true }).click();
    await dialog(page).getByLabel('Class name').fill('Spanish 2H');
    await dialog(page).getByLabel('Room (optional)').fill('214');
    await dialog(page).getByRole('button', { name: 'Add class', exact: true }).click();
    const bar = page.getByRole('button', { name: 'Change color for Spanish 2H' });
    const picker = page.getByRole('dialog', { name: 'Color for Spanish 2H' });
    const card = page.getByRole('listitem').filter({ has: bar });
    const surface = card.locator('[data-slot="class-color-expansion"]');
    // The colored top strip is the mouse hover shortcut; the palette button is the visible trigger.
    const strip = card.locator('[data-slot="class-color-strip"]');
    await expect(surface).toHaveCSS('visibility', 'hidden');
    await card.screenshot({ path: testInfo.outputPath('color-edge-idle.png') });
    const before = (await card.boundingBox())!;
    // Slow the actual CSS transition so the intermediate state is observable.
    await page.addStyleTag({ content: '[data-slot="class-color-expansion"] { transition-duration: 1s; }' });
    await strip.hover();
    await expect(picker).toBeVisible();
    const controls = card.locator('[data-slot="class-color-controls"]');
    await expect(controls).toHaveCSS('visibility', 'hidden');
    await expect(picker.getByRole('group', { name: 'Saturation and brightness' })).toBeVisible();
    expect(await picker.evaluate((element) => element.getAnimations().filter((animation) => animation.playState === 'running').length)).toBe(0);
    await expect(picker.getByRole('slider', { name: 'Hue' })).toBeVisible();
    await expect(card).toHaveCSS('border-top-color', 'rgba(0, 0, 0, 0)');
    await expect(page.locator('input[type=color]')).toHaveCount(0);
    await expect.poll(async () => (await picker.boundingBox())!.y).toBeLessThan(before.y);
    expect(await card.boundingBox()).toEqual(before);
    expect((await picker.boundingBox())!.width).toBe(before.width);
    await picker.hover();
    await page.screenshot({ path: testInfo.outputPath('class-color-picker.png') });
    const spectrum = picker.getByRole('group', { name: 'Saturation and brightness' });
    const hex = picker.getByLabel('Custom color for Spanish 2H');
    // A focused input must not keep a mouse-hover panel pinned open.
    await hex.focus();
    await page.mouse.move(1250, 650);
    await expect(bar).toHaveAttribute('aria-expanded', 'false');
    await expect(controls).toHaveCSS('visibility', 'hidden');
    await expect(surface).toHaveCSS('visibility', 'hidden');
    await card.screenshot({ path: testInfo.outputPath('color-edge-collapsed.png') });
    await strip.hover();
    await expect(controls).toHaveCSS('visibility', 'visible');
    await spectrum.click({ position: { x: 70, y: 35 } });
    const selected = await hex.inputValue();
    await spectrum.press('ArrowLeft');
    await expect(hex).not.toHaveValue(selected);
    const beforeHue = await hex.inputValue();
    await picker.getByRole('slider', { name: 'Hue' }).press('Shift+ArrowRight');
    await expect(hex).not.toHaveValue(beforeHue);
    await picker.getByRole('button', { name: 'Use Pink' }).click();
    await picker.getByRole('button', { name: 'Save color' }).click();
    await expect(picker).toBeHidden();
    await expect(card).toHaveCSS('border-top-color', 'rgb(190, 24, 93)');
    await expect(saved(page)).toBeVisible();
    await page.reload();
    await expect(card).toHaveCSS('border-top-color', 'rgb(190, 24, 93)');
    await bar.focus();
    await page.keyboard.press('Enter');
    await expect(picker).toBeVisible();
    await picker.getByLabel('Custom color for Spanish 2H').fill('#123456');
    await picker.getByRole('button', { name: 'Save color' }).click();
    await expect(card).toHaveCSS('border-top-color', 'rgb(18, 52, 86)');
    await expect(saved(page)).toBeVisible();
    await page.getByRole('button', { name: 'Edit Spanish 2H' }).click();
    await expect(dialog(page).getByLabel('Class color', { exact: true })).toHaveValue('#123456');
    await expect(dialog(page).getByLabel('Room (optional)')).toHaveValue('214');
    await dialog(page).getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await bar.tap();
    await expect(picker).toBeVisible();
    await expect(picker).toBeInViewport({ ratio: 1 });
    await picker.getByRole('button', { name: 'Use automatic color' }).tap();
    await expect(card).not.toHaveCSS('border-top-color', 'rgb(18, 52, 86)');
    await expect(saved(page)).toBeVisible();
    await page.reload();
    await expect(card).not.toHaveCSS('border-top-color', 'rgb(18, 52, 86)');
  });
});

test('Classes page drops and resizes actual classes with persistence and touch alternative', async ({ page, context }) => {
  const fixture = seed(); await authenticate(context, fixture.id);
  await page.goto('/#classes');
  await page.getByRole('button', { name: 'Add class', exact: true }).click();
  await dialog(page).getByLabel('Class name').fill('Spanish 2H');
  await dialog(page).getByLabel('Class color', { exact: true }).fill('#cc3366');
  await dialog(page).getByRole('button', { name: 'Add class', exact: true }).click();
  await expect(saved(page)).toBeVisible();
  const palette = page.getByRole('button', { name: 'Place Spanish 2H', exact: true });
  const day = page.getByRole('group', { name: 'Day 1 time canvas', exact: true });
  await palette.dragTo(day, { targetPosition: { x: 35, y: 40 } });
  const block = day.getByRole('button', { name: 'Day 1, 8:00–9:00 AM: Spanish 2H', exact: true });
  await expect(block).toBeVisible();
  await expect(saved(page)).toBeVisible();
  await day.getByRole('button', { name: 'Resize Day 1 A end', exact: true }).press('ArrowUp');
  await expect(day.getByRole('button', { name: 'Day 1, 8:00–8:55 AM: Spanish 2H', exact: true })).toBeVisible();
  await expect(saved(page)).toBeVisible();
  await page.reload();
  await expect(day.getByRole('button', { name: 'Day 1, 8:00–8:55 AM: Spanish 2H', exact: true })).toHaveCount(1);
  await page.setViewportSize({ width: 390, height: 844 });
  await palette.click();
  await page.getByRole('button', { name: 'Place in Day 1 at 1:00 PM', exact: true }).click();
  await expect(day.getByRole('button', { name: 'Day 1, 1:00–1:45 PM: Spanish 2H', exact: true })).toHaveCount(1);
  await expect(saved(page)).toBeVisible();
  const db = openDatabase(process.env.E2E_DATABASE_PATH!);
  try {
    const personal = new Service(db).workspace(fixture.id).entities.find(entry => entry.kind === 'personal')!.data;
    expect(personal.customSchedule).toBeNull();
    expect(personal.assignments).toMatchObject({ A: 'Spanish-2H' });
    expect(personal.cycleDayOverrides).toHaveLength(1);
    expect(personal.cycleDayOverrides).toMatchObject([{ cycleDayId: 'day-1', slots: [{ start: '08:00', end: '08:55' }, {}, {}, {}, { start: '13:00', end: '13:45' }] }]);
    expect(new Service(db).school(fixture.school.id).schedule.cycleDays[0].slots[0].end).toBe('09:00');
  } finally { db.close(); }
  await day.getByRole('button', { name: 'Day 1, 1:00–1:45 PM: Spanish 2H', exact: true }).click();
  await day.getByRole('button', { name: 'Day 1, 9:10–10:10 AM: B', exact: true }).click();
  await expect(day.getByRole('button', { name: 'Day 1, 9:10–10:10 AM: Spanish 2H', exact: true })).toHaveCount(1);
  await expect(day.getByRole('button', { name: 'Day 1, 1:00–1:45 PM: Spanish 2H', exact: true })).toHaveCount(0);
  await expect(saved(page)).toBeVisible();
});


test('large period palette stays beside the canvas on desktop', async ({ page, context }) => {
  const schedule = structuredClone(exampleSchedule);
  schedule.periods.push(...Array.from({ length: 22 }, (_, index) => ({ id: `extra-${index}`, label: `Long class name ${index + 1} / Study Hall`, kind: 'class' as const })));
  const fixture = seed(undefined, true, schedule); await authenticate(context, fixture.id);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/#school');
  await page.getByRole('button', { name: 'Edit shared schedule' }).click();
  await dialog(page).getByRole('tab', { name: /Days ·/ }).click();
  const palette = dialog(page).locator('.timetable-palette');
  const canvas = dialog(page).locator('.time-canvas-scroll').first();
  const paletteBox = (await palette.boundingBox())!;
  const canvasBox = (await canvas.boundingBox())!;
  expect(paletteBox.x + paletteBox.width).toBeLessThan(canvasBox.x);
  expect(paletteBox.height).toBeLessThan(600);
  expect(await canvas.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  await page.screenshot({ path: '/tmp/quasar-time-canvas-desktop.png' });
});


test('short adjacent blocks have readable compact labels and full details', async ({ page, context }) => {
  const schedule = structuredClone(exampleSchedule);
  schedule.periods[0].label = 'Morning advisory and announcements';
  schedule.cycleDays[0].slots[0].end = '08:05';
  schedule.cycleDays[0].slots[1].start = '08:05';
  schedule.cycleDays[0].slots[1].end = '08:10';
  const fixture = seed(undefined, true, schedule); await authenticate(context, fixture.id);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/#school');
  await page.getByRole('button', { name: 'Edit shared schedule' }).click();
  await dialog(page).getByRole('tab', { name: /Days ·/ }).click();
  const day = dialog(page).getByRole('group', { name: 'Day 1 time canvas', exact: true });
  const first = day.getByRole('button', { name: 'Day 1, 8:00–8:05 AM: Morning advisory and announcements', exact: true });
  const second = day.getByRole('button', { name: 'Day 1, 8:05–8:10 AM: B', exact: true });
  await first.scrollIntoViewIfNeeded();
  const one = (await first.boundingBox())!;
  const two = (await second.boundingBox())!;
  expect(one.height).toBeGreaterThanOrEqual(22);
  expect(two.y).toBeGreaterThanOrEqual(one.y + one.height);
  await expect(first.locator('strong')).toHaveCSS('white-space', 'nowrap');
  await first.focus();
  await expect(day.locator('.time-block-detail').filter({ hasText: 'Morning advisory and announcements' })).toBeVisible();
  await page.screenshot({ path: '/tmp/quasar-short-blocks.png' });
});


test('school directory selection, personal edits, shared edits and period placement', async ({ page, context }) => {
  const fixture = seed(); await authenticate(context, fixture.id);
  const db = openDatabase(process.env.E2E_DATABASE_PATH!);
  let directoryId: string;
  try {
    const directory = new DirectoryService(new Service(db, 'browser-owner@example.com'));
    directoryId = directory.save(fixture.id, { schoolId: fixture.school.id, details: { name: 'Directory Biology', teacher: 'Dr Example', room: '204', grades: ['9'] } }).id;
  } finally { db.close(); }
  await page.goto('/#classes');
  await choose(page.getByLabel('Your grade', { exact: true }), 'Grade 9');
  await expect(saved(page)).toBeVisible();
  await page.getByRole('button', { name: 'Browse school classes' }).click();
  await dialog(page).getByLabel('Search classes').fill('Dr Example');
  await dialog(page).getByRole('checkbox', { name: 'Select Directory Biology' }).check();
  await dialog(page).getByRole('button', { name: 'Add selected classes (1)' }).click();
  await expect(page.getByRole('button', { name: 'Edit Directory Biology' })).toBeVisible();
  await expect(saved(page)).toBeVisible();
  const day = page.getByRole('group', { name: 'Day 1 time canvas', exact: true });
  await page.getByRole('button', { name: 'Place Directory Biology', exact: true }).dragTo(day, { targetPosition: { x: 35, y: 40 } });
  await expect(day.getByRole('button', { name: 'Day 1, 8:00–9:00 AM: Directory Biology', exact: true })).toBeVisible();
  await expect(saved(page)).toBeVisible();
  await page.getByRole('button', { name: 'Edit Directory Biology' }).click();
  await dialog(page).getByLabel('Room (optional)').fill('My room');
  await dialog(page).getByRole('button', { name: 'Save', exact: true }).click();
  await expect(saved(page)).toBeVisible();
  await page.getByRole('button', { name: 'Browse school classes' }).click();
  await expect(dialog(page).getByRole('checkbox', { name: 'Select Directory Biology' })).toBeDisabled();
  await expect(dialog(page).getByText('Room 204 · Dr Example')).toBeVisible();
  await dialog(page).getByRole('button', { name: 'Edit shared' }).click();
  await dialog(page).getByLabel('Room', { exact: true }).fill('305');
  await dialog(page).getByRole('button', { name: 'Save shared class' }).click();
  await expect(dialog(page).getByText('Shared class saved.')).toBeVisible();
  await dialog(page).getByRole('button', { name: 'Done', exact: true }).click();
  await page.reload();
  await expect(page.getByText('My room · Dr Example', { exact: true })).toBeVisible();
  const check = openDatabase(process.env.E2E_DATABASE_PATH!);
  try {
    const service = new Service(check, 'browser-owner@example.com');
    expect(new DirectoryService(service).list(fixture.id, fixture.school.id).classes[0].room).toBe('305');
    expect((service.entity(fixture.id, 'personal')!.data.classes as {directoryId:string}[])[0].directoryId).toBe(directoryId!);
  } finally { check.close(); }
});

test('existing students choose their grade and see lunch throughout the second rotation week', async ({ page, context }) => {
  const defaultSchedule = { ...exampleSchedule, cycleDays: exampleSchedule.cycleDays.map(day => ({ ...day, slots: day.slots.filter(slot => slot.periodId !== 'lunch') })) };
  const ninthGrade = { ...exampleSchedule, cycleDays: exampleSchedule.cycleDays.map(day => ({ ...day, slots: day.slots.map(slot => slot.periodId === 'lunch' ? { ...slot, start: '12:00', end: '12:40' } : slot).sort((a,b) => a.start.localeCompare(b.start)) })) };
  const fixture = seed(undefined, true, { ...defaultSchedule, gradeSchedules: { '9': ninthGrade, '10': exampleSchedule } });
  await authenticate(context, fixture.id);
  await page.goto('/#classes');
  await choose(page.getByLabel('Your grade', { exact: true }), 'Grade 9');
  await expect(saved(page)).toBeVisible();
  for (let day = 6; day <= 10; day++) {
    await expect(page.getByRole('group', { name: `Day ${day} time canvas`, exact: true }).getByRole('button', { name: `Day ${day}, 12:00–12:40 PM: Lunch`, exact: true })).toBeVisible();
  }
  await page.reload();
  await expect(page.getByRole('group', { name: 'Day 10 time canvas', exact: true }).getByRole('button', { name: 'Day 10, 12:00–12:40 PM: Lunch', exact: true })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Account', exact: true }).click();
  await choose(dialog(page).getByLabel('Your grade', { exact: true }), 'Grade 10');
  await expect(dialog(page).getByLabel('Your grade', { exact: true })).toHaveText('Grade 10');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('group', { name: 'Day 10 time canvas', exact: true }).getByRole('button', { name: 'Day 10, 10:15–10:45 AM: Lunch', exact: true })).toBeVisible();
});

test('guided school creation asks one question at a time and never saves example bell times', async ({ page, context }) => {
  const fixture = seed(undefined, false); await authenticate(context, fixture.id);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Find your school' })).toBeVisible();
  await page.getByRole('button', { name: 'Add a school' }).click();
  const name = `Guided Academy ${randomUUID().slice(0, 6)}`;
  await page.getByLabel('School name').fill(name);
  await page.getByLabel('City and state').fill('Denver, CO');
  await page.getByRole('radio', { name: /A \/ B days/ }).click();
  await page.getByRole('button', { name: 'Set up the schedule' }).click();

  // Periods: rename the first one, drop the last, keep lunch.
  await expect(page.getByRole('heading', { name: 'What are the periods called?' })).toBeVisible();
  await page.getByLabel('Period 1 name').fill('Block A');
  await page.getByRole('button', { name: 'Remove period Period 7' }).click();
  await page.getByRole('button', { name: 'Next: bell times' }).click();

  // Times start blank, so Continue stays disabled until every slot is filled in.
  await expect(page.getByRole('heading', { name: 'Bell times on a normal day' })).toBeVisible();
  const next = page.getByRole('button', { name: 'Next: rotation days' });
  await expect(next).toBeDisabled();
  const times = [['7:30 am', '8:15 am'], ['8:20 am', '9:05 am'], ['9:10 am', '9:55 am'], ['10:00 am', '10:45 am'], ['10:50 am', '11:20 am'], ['11:25 am', '12:10 pm'], ['12:15 pm', '1:00 pm']];
  for (const [index, [start, end]] of times.entries()) {
    await page.getByLabel(`Slot ${index + 1} start`, { exact: true }).fill(start);
    await page.getByLabel(`Slot ${index + 1} end`, { exact: true }).fill(end);
  }
  await expect(next).toBeEnabled();
  await next.click();

  await expect(page.getByRole('heading', { name: 'Do the days differ?' })).toBeVisible();
  await page.getByRole('radio', { name: /Same order and times every day/ }).click();
  await page.getByRole('button', { name: 'Next: today’s day' }).click();

  await expect(page.getByRole('heading', { name: 'Which rotation day is it?' })).toBeVisible();
  await choose(page.getByLabel('…the school is on'), 'B day');
  await page.getByRole('button', { name: 'Next: check it' }).click();

  await expect(page.getByRole('heading', { name: 'Does this look right?' })).toBeVisible();
  await expect(page.getByText('2-day rotation')).toBeVisible();
  await page.getByRole('button', { name: 'Create school' }).click();

  await expect(page.getByRole('heading', { name: 'Which schedule should Quasar follow?' })).toBeVisible();
  await expect(page.getByRole('radio', { name: /Use the community schedule/ })).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByText('Choose your grade to continue.')).toBeVisible();
  await choose(page.getByLabel('Your grade', { exact: true }), 'Grade 10');
  await page.getByRole('button', { name: `Join ${name}` }).click();
  await expect(page.getByRole('heading', { name: 'Add your classes' })).toBeVisible();
  await page.getByRole('button', { name: 'Skip for now' }).click();
  await expect(page.getByRole('heading', { name: 'Get homework in automatically' })).toBeVisible();
  await page.getByRole('button', { name: 'Skip for now' }).click();
  await expect(page.getByRole('heading', { name: /Browser Student/ })).toBeVisible();

  const db = openDatabase(process.env.E2E_DATABASE_PATH!);
  try {
    const school = new Service(db).workspace(fixture.id).school!;
    expect(school.name).toBe(name);
    expect(school.schedule.cycleDays.map((day) => day.slots.map((slot) => `${slot.periodId} ${slot.start}-${slot.end}`))).toEqual([
      ['p1 07:30-08:15', 'p2 08:20-09:05', 'p3 09:10-09:55', 'p4 10:00-10:45', 'lunch 10:50-11:20', 'p5 11:25-12:10', 'p6 12:15-13:00'],
      ['p1 07:30-08:15', 'p2 08:20-09:05', 'p3 09:10-09:55', 'p4 10:00-10:45', 'lunch 10:50-11:20', 'p5 11:25-12:10', 'p6 12:15-13:00'],
    ]);
    expect(school.schedule.periods[0]).toMatchObject({ id: 'p1', label: 'Block A' });
    expect(school.schedule.anchorCycleDayId).toBe('b');
  } finally { db.close(); }
});

test('help page answers questions and sends feedback to the support inbox before a school is chosen', async ({ page, context }) => {
  const fixture = seed(undefined, false); await authenticate(context, fixture.id);
  await page.goto('/help');
  await expect(page.getByRole('heading', { name: 'Help' })).toBeVisible();
  await page.getByText('My school is not in the list. What do I do?').click();
  await expect(page.getByText(/Tap “Add a school” on the school step/)).toBeVisible();
  await page.getByLabel('Your message').fill('I cannot tell which rotation day today is.');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Sent.' })).toBeVisible();
  const db = openDatabase(process.env.E2E_DATABASE_PATH!);
  try {
    const requests = new Service(db, 'browser-owner@example.com').requests(seedOwnerId(db));
    expect(requests.some((request) => request.message.includes('rotation day today') && request.schoolId === null)).toBe(true);
  } finally { db.close(); }
});

function seedOwnerId(db: ReturnType<typeof openDatabase>): string {
  const row = db.prepare('SELECT id FROM users WHERE email=?').get('browser-owner@example.com') as { id: string } | undefined;
  if (row) return row.id;
  const id = randomUUID();
  db.prepare('INSERT INTO users(id,google_sub,email,display_name,full_name,created_at) VALUES(?,?,?,?,?,?)').run(id, id, 'browser-owner@example.com', 'Owner', 'Owner Person', new Date().toISOString());
  return id;
}
