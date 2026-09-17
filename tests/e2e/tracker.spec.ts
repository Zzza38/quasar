import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { encode } from 'next-auth/jwt';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../../src/server/db';
import { Service } from '../../src/server/service';
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
  await page.getByRole('radio', { name: /Use the community schedule/ }).click();
  await join.click();
  await expect(page.getByRole('heading', { name: /Browser Student/ })).toBeVisible();

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
    for (const name of names) if (name.startsWith('whatsnext-public-shell-') && await (await caches.open(name)).match('/')) return true;
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
    expect(new Service(db).workspace(fixture.id).entities.find((e) => e.kind === 'personal')?.data).toMatchObject({ classes: [{ id: 'Biology', name: 'Biology' }] });
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
  await dialog(page).getByRole('button', { name: /^Periods/ }).click();
  await dialog(page).getByLabel('Period 1 name').fill('Advisory');
  await dialog(page).getByRole('button', { name: 'Publish revision' }).click();
  await expect(dialog(page)).toBeHidden();
  await expect(page.getByText('Revision 2')).toBeVisible();
  const db = openDatabase(process.env.E2E_DATABASE_PATH!);
  try { expect(new Service(db).school(fixture.school.id).schedule.periods[0].label).toBe('Advisory'); }
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
  await page.getByRole('button', { name: 'Place in Day 1 at 8:00 AM', exact: true }).click();
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
    await dialog(page).getByRole('button', { name: /^Days/ }).click();
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
  await dialog(page).getByRole('button', { name: 'Dark' }).click();
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
  await expect(page.getByRole('heading', { name: 'Screenshot High schedule' })).toBeVisible();
  await fits();
  await page.screenshot({ path: testInfo.outputPath('onboarding-create.png'), fullPage: true });

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

test('time canvas fits desktop, groups weeks, and drags and resizes freely timed blocks', async ({ page, context }) => {
  const fixture = seed(); await authenticate(context, fixture.id);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/#school');
  await page.getByRole('button', { name: 'Edit shared schedule' }).click();
  await dialog(page).getByRole('group', { name: 'School days', exact: true }).getByRole('button', { name: 'Sat', exact: true }).click();
  await dialog(page).getByRole('button', { name: /Days ·/ }).click();
  await dialog(page).getByRole('button', { name: 'Add rotation day' }).click();
  await dialog(page).getByRole('button', { name: 'Add rotation day' }).click();
  await expect(dialog(page).getByRole('region', { name: /Rotation week/ })).toHaveCount(2);
  expect(await dialog(page).locator('.time-canvas-scroll').first().evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  const day = dialog(page).getByRole('group', { name: 'Day 1 time canvas', exact: true });
  await dialog(page).getByRole('button', { name: 'Place D', exact: true }).dragTo(day, { targetPosition: { x: 40, y: 468 } });
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
  await dialog(page).getByRole('button', { name: /Days ·/ }).click();
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
  const block = day.getByRole('button', { name: 'Day 1, 8:30–9:15 AM: Spanish 2H', exact: true });
  await expect(block).toBeVisible();
  await expect(saved(page)).toBeVisible();
  await day.getByRole('button', { name: 'Resize Day 1 Spanish 2H end', exact: true }).press('ArrowDown');
  await expect(day.getByRole('button', { name: 'Day 1, 8:30–9:20 AM: Spanish 2H', exact: true })).toBeVisible();
  await expect(saved(page)).toBeVisible();
  await page.reload();
  await expect(day.getByRole('button', { name: 'Day 1, 8:30–9:20 AM: Spanish 2H', exact: true })).toHaveCount(1);
  await page.setViewportSize({ width: 390, height: 844 });
  await palette.click();
  await page.getByRole('button', { name: 'Place in Day 1 at 1:00 PM', exact: true }).click();
  await expect(day.getByRole('button', { name: 'Day 1, 1:00–1:45 PM: Spanish 2H', exact: true })).toHaveCount(1);
  await expect(saved(page)).toBeVisible();
});


test('large period palette stays beside the canvas on desktop', async ({ page, context }) => {
  const schedule = structuredClone(exampleSchedule);
  schedule.periods.push(...Array.from({ length: 22 }, (_, index) => ({ id: `extra-${index}`, label: `Long class name ${index + 1} / Study Hall`, kind: 'class' as const })));
  const fixture = seed(undefined, true, schedule); await authenticate(context, fixture.id);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/#school');
  await page.getByRole('button', { name: 'Edit shared schedule' }).click();
  await dialog(page).getByRole('button', { name: /Days ·/ }).click();
  const palette = dialog(page).locator('.timetable-palette');
  const canvas = dialog(page).locator('.time-canvas-scroll').first();
  const paletteBox = (await palette.boundingBox())!;
  const canvasBox = (await canvas.boundingBox())!;
  expect(paletteBox.x + paletteBox.width).toBeLessThan(canvasBox.x);
  expect(paletteBox.height).toBeLessThan(600);
  expect(await canvas.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  await page.screenshot({ path: '/tmp/quasar-time-canvas-desktop.png' });
});
