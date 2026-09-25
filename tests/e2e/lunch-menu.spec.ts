import { test, expect } from './fixtures';
import { type BrowserContext } from '@playwright/test';
import { encode } from 'next-auth/jwt';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../../src/server/db';
import { Service } from '../../src/server/service';
import { exampleSchedule } from '../../src/domain/example';

/**
 * A member of a small open school whose school follows a Nutrislice menu, with the week of 2026-09-17 already in
 * the server's cache (fetched just now, so it is served without reaching the provider). The browser clock is
 * fixed to that Thursday in the tests.
 */
function seed() {
  const db = openDatabase(process.env.E2E_DATABASE_PATH!);
  try {
    const id = randomUUID();
    db.prepare('INSERT INTO users(id,google_sub,email,display_name,full_name,created_at) VALUES(?,?,?,?,?,?)')
      .run(id, id, `${randomUUID()}@example.com`, 'Browser Student', 'Browser Test Student', new Date().toISOString());
    const service = new Service(db, 'browser-owner@example.com');
    const school = service.createSchool(id, { name: `Browser High ${id.slice(0, 6)}`, location: 'Boston, MA', schedule: exampleSchedule });
    service.join(id, { schoolId: school.id, choice: 'community' });
    const source = { org: 'browserhigh', domain: 'nutrislice.com', school: 'upper-school', menu: 'lunch', name: 'Upper School Lunch' };
    db.prepare('UPDATE schools SET menu_source=? WHERE id=?').run(JSON.stringify(source), school.id);
    const days = [
      { date: '2026-09-14', notes: [], sections: [{ title: 'Entree', items: ['Chicken Parmesan', 'Garlic Bread'] }] },
      { date: '2026-09-17', notes: [], sections: [{ title: 'Soup', items: ['Tomato Basil'] }, { title: 'Entree', items: ['Lemon Herb Cod', 'Baked Tater Tots'] }, { title: 'Grill', items: ['Grilled Cheese'] }] },
      { date: '2026-09-18', notes: ['Early dismissal'], sections: [] },
    ];
    db.prepare('INSERT INTO menu_weeks(school_id,week_start,source,days,fetched_at) VALUES(?,?,?,?,?)').run(school.id, '2026-09-13', JSON.stringify(source), JSON.stringify(days), new Date().toISOString());
    return { id, school };
  } finally { db.close(); }
}

async function authenticate(context: BrowserContext, id: string) {
  const token = await encode({ secret: process.env.E2E_AUTH_SECRET!, token: { userId: id, authAt: Date.now() }, maxAge: 3600 });
  await context.addCookies([{ name: 'next-auth.session-token', value: token, domain: 'localhost', path: '/', httpOnly: true, sameSite: 'Lax', expires: Date.now() / 1000 + 3600 }]);
}

test('today’s lunch shows under the timeline and the School view lists the week', async ({ page, context }, testInfo) => {
  const fixture = seed(); await authenticate(context, fixture.id);
  // Smooth scrolling does not progress under a fixed clock, so the jump to the menu card is checked with reduced motion.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.clock.setFixedTime(new Date('2026-09-17T12:51:37Z'));
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.goto('/');
  const lunch = page.getByRole('region', { name: 'Lunch today' });
  await expect(lunch).toBeVisible();
  await expect(lunch).toContainText('Lemon Herb Cod · Baked Tater Tots');
  await expect(lunch).toContainText('Grilled Cheese');
  await lunch.scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('today-lunch.png') });
  // "Full week" lands on the School view's menu card, scrolled into view, with the one-shot param stripped.
  await lunch.getByRole('button', { name: 'Full week' }).click();
  await expect(page).toHaveURL(/\/school$/);
  const card = page.getByRole('region', { name: 'Lunch menu' });
  await expect(card).toBeInViewport();
  await expect(card).toContainText('Upper School Lunch');
  await expect(card.getByRole('listitem').filter({ hasText: 'Monday' })).toContainText('Chicken Parmesan');
  await expect(card.getByRole('listitem').filter({ hasText: 'Thursday' })).toContainText('Today');
  await expect(card.getByRole('listitem').filter({ hasText: 'Friday' })).toContainText('Early dismissal');
  await expect(card.getByRole('listitem').filter({ hasText: 'Tuesday' })).toContainText('No menu posted');
  await expect(card.getByRole('link', { name: /Open menu site/ })).toHaveAttribute('href', 'https://browserhigh.nutrislice.com/menu/upper-school/lunch');
  await card.screenshot({ path: testInfo.outputPath('school-lunch-menu.png') });
  // The Schedule view shows the browsed day's lunch too.
  await page.goto('/schedule?date=2026-09-14');
  await expect(page.getByRole('region', { name: /^Lunch Monday/ })).toContainText('Chicken Parmesan · Garlic Bread');
});

test('members of an open school can change the menu, and a link off Nutrislice is refused before any fetch', async ({ page, context }) => {
  const fixture = seed(); await authenticate(context, fixture.id);
  await page.clock.setFixedTime(new Date('2026-09-17T12:51:37Z'));
  await page.goto('/school');
  const card = page.getByRole('region', { name: 'Lunch menu' });
  await card.getByRole('button', { name: 'Change' }).click();
  const dialog = page.getByRole('dialog', { name: 'Change the lunch menu' });
  await expect(dialog.getByLabel('Menu site address')).toHaveValue('https://browserhigh.nutrislice.com/menu/upper-school/lunch');
  await dialog.getByLabel('Menu site address').fill('https://example.com/lunch.pdf');
  await dialog.getByRole('button', { name: 'Find menus' }).click();
  await expect(dialog.getByRole('alert')).toContainText('Nutrislice');
  // Removing the menu needs an in-dialog confirmation and then empties the card for everyone.
  await dialog.getByRole('button', { name: 'Remove menu' }).click();
  await dialog.getByRole('button', { name: 'Remove', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(card).toContainText('No lunch menu yet');
  await page.goto('/');
  await expect(page.getByRole('region', { name: 'Next class' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Lunch today' })).toHaveCount(0);
});
